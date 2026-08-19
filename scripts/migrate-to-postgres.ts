/**
 * Copies a Turso/libSQL database into PostgreSQL.
 *
 *   SOURCE_DATABASE_URL=libsql://... SOURCE_DATABASE_AUTH_TOKEN=... \
 *   DATABASE_URL=postgres://... \
 *   npx vite-node --config vitest.config.ts scripts/migrate-to-postgres.ts -- --yes
 *
 * The target schema is created by the app's own `init()`, not by a copy of the
 * DDL kept in here: a second copy drifts, and the first symptom of drift would
 * be a column silently missing after cutover. The cost of that choice is that
 * `init()` also seeds demo data, so the first thing this does after booting is
 * empty every table again.
 *
 * Destructive on the target, read-only on the source, and requires --yes.
 */

import { createClient as createLibsqlClient } from "@libsql/client";

import { getDb } from "@/server/db";

type Row = Record<string, unknown>;
type Target = Awaited<ReturnType<typeof getDb>>;

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

/**
 * Tables ordered so every table follows the ones it references.
 *
 * Managed Postgres will not grant `session_replication_role`, so foreign keys
 * cannot be suspended for the load and the order has to be right instead. It is
 * derived from the constraints themselves rather than hand-listed: a hand-list
 * is correct until someone adds a table.
 */
async function tablesInDependencyOrder(target: Target): Promise<string[]> {
  const tables = (
    await target.execute(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'
       ORDER BY table_name`,
    )
  ).rows.map((row) => String((row as Row).table_name));

  const edges = (
    await target.execute(
      `SELECT con.conrelid::regclass::text AS child,
              con.confrelid::regclass::text AS parent
       FROM pg_constraint con
       JOIN pg_class rel ON rel.oid = con.conrelid
       JOIN pg_namespace ns ON ns.oid = rel.relnamespace
       WHERE con.contype = 'f' AND ns.nspname = current_schema()`,
    )
  ).rows as Row[];

  const parents = new Map<string, Set<string>>(tables.map((t) => [t, new Set()]));
  for (const edge of edges) {
    const child = String(edge.child);
    const parent = String(edge.parent);
    // A self-reference cannot be satisfied by ordering; rows within one table
    // are inserted in source order, which is where the parent came from.
    if (child === parent) continue;
    parents.get(child)?.add(parent);
  }

  const ordered: string[] = [];
  const placed = new Set<string>();
  let progress = true;

  while (ordered.length < tables.length && progress) {
    progress = false;
    for (const table of tables) {
      if (placed.has(table)) continue;
      const blocked = [...(parents.get(table) ?? [])].some(
        (parent) => parents.has(parent) && !placed.has(parent),
      );
      if (blocked) continue;
      ordered.push(table);
      placed.add(table);
      progress = true;
    }
  }

  // A cycle would leave tables unplaced. Append them and let the database
  // object rather than silently copying a subset.
  for (const table of tables) if (!placed.has(table)) ordered.push(table);
  return ordered;
}

async function main() {
  if (!process.argv.includes("--yes")) {
    throw new Error("Refusing to run without --yes: this empties the target database.");
  }

  const sourceUrl = requireEnv("SOURCE_DATABASE_URL");
  const targetUrl = requireEnv("DATABASE_URL");
  if (!targetUrl.startsWith("postgres://") && !targetUrl.startsWith("postgresql://")) {
    throw new Error("DATABASE_URL must be the PostgreSQL target.");
  }

  const source = createLibsqlClient({
    url: sourceUrl,
    authToken: process.env.SOURCE_DATABASE_AUTH_TOKEN?.trim(),
  });

  // Boots the app's own migration path against the target: schema, every
  // ensure* ALTER, and the demo seed.
  const target = await getDb();
  const order = await tablesInDependencyOrder(target);
  console.log(`target ready: ${order.length} tables`);

  // Children first, so nothing is deleted out from under a reference.
  for (const table of [...order].reverse()) {
    await target.execute(`DELETE FROM ${table}`);
  }

  let copied = 0;
  const absent: string[] = [];
  const mismatches: string[] = [];

  for (const table of order) {
    let rows: Row[];
    try {
      // rowid is the source's insertion order, which the new `seq` columns must
      // reproduce: two ledger queries order by them.
      const result = await source.execute(`SELECT * FROM ${table} ORDER BY rowid`);
      rows = result.rows as unknown as Row[];
    } catch {
      // A table the target has and the source never did. Empty is correct.
      absent.push(table);
      continue;
    }

    if (rows.length === 0) continue;

    const columns = Object.keys(rows[0]);
    const placeholders = columns.map(() => "?").join(", ");
    const statements = rows.map((row) => ({
      sql: `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${placeholders})`,
      args: columns.map((column) => row[column] ?? null),
    }));

    // The driver merges these into multi-row inserts, so a thousand rows cost a
    // handful of round trips rather than a thousand.
    await target.batch(statements, "write");

    const landed = Number(
      (
        (await target.execute(`SELECT count(*)::int AS n FROM ${table}`)).rows[0] as Row
      ).n,
    );
    if (landed !== rows.length) {
      mismatches.push(`${table}: source ${rows.length}, target ${landed}`);
    }
    copied += landed;
    console.log(`  ${table}: ${landed}`);
  }

  console.log(`\ncopied ${copied} rows across ${order.length - absent.length} tables`);
  if (absent.length) console.log(`absent from source (left empty): ${absent.join(", ")}`);
  if (mismatches.length) {
    console.error(`\nROW COUNT MISMATCH:\n  ${mismatches.join("\n  ")}`);
    process.exitCode = 1;
    return;
  }
  console.log("row counts match on every table.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
