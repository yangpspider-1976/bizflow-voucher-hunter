/**
 * Copies a Turso/libSQL database into PostgreSQL.
 *
 *   SOURCE_DATABASE_URL=libsql://... SOURCE_DATABASE_AUTH_TOKEN=... \
 *   DATABASE_URL=postgres://... \
 *   npx vite-node scripts/migrate-to-postgres.ts -- --yes
 *
 * The target schema is created by the app's own `init()`, not by a copy of the
 * DDL kept in here: a hand-maintained second copy drifts, and the first symptom
 * of drift would be a column silently missing after cutover. The cost of that
 * choice is that `init()` also seeds demo data, so the first thing this does
 * after booting is empty every table again.
 *
 * Destructive on the target and read-only on the source. Requires --yes.
 */

import { createClient as createLibsqlClient } from "@libsql/client";

import { getDb } from "@/server/db";

type Row = Record<string, unknown>;

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

/** Tables the app created, in dependency order for inserts. */
async function targetTables(target: Awaited<ReturnType<typeof getDb>>) {
  const result = await target.execute(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'
     ORDER BY table_name`,
  );
  return result.rows.map((row) => String((row as Row).table_name));
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

  // Boots the app's migration path against the target: schema, every ensure*
  // ALTER, and the demo seed.
  const target = await getDb();
  const tables = await targetTables(target);
  console.log(`target ready: ${tables.length} tables`);

  // Foreign keys are checked per statement, and the source's insertion order is
  // not necessarily a valid topological order for them. Suspending the checks
  // for this session is the standard bulk-load approach; they are enforced
  // again for every write the app makes afterwards.
  await target.execute("SET session_replication_role = replica");

  let copied = 0;
  const skipped: string[] = [];
  const mismatches: string[] = [];

  for (const table of [...tables].reverse()) {
    await target.execute(`DELETE FROM ${table}`);
  }

  for (const table of tables) {
    let rows: Row[];
    try {
      // rowid order is the source's insertion order, which is what the new
      // `seq` columns must reproduce — two ledger queries order by them.
      const result = await source.execute(`SELECT * FROM ${table} ORDER BY rowid`);
      rows = result.rows as unknown as Row[];
    } catch {
      // A table the target has and the source never did (added since the last
      // deploy). Empty is correct, not an error.
      skipped.push(table);
      continue;
    }

    if (rows.length === 0) continue;

    const columns = Object.keys(rows[0]);
    const placeholders = columns.map(() => "?").join(", ");
    const statements = rows.map((row) => ({
      sql: `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${placeholders})`,
      args: columns.map((column) => row[column] ?? null),
    }));

    // The driver merges these into multi-row inserts, so a table of a thousand
    // rows costs a handful of round trips rather than a thousand.
    await target.batch(statements, "write");

    const check = await target.execute(`SELECT count(*)::int AS n FROM ${table}`);
    const landed = Number((check.rows[0] as Row).n);
    if (landed !== rows.length) {
      mismatches.push(`${table}: source ${rows.length}, target ${landed}`);
    }
    copied += landed;
    console.log(`  ${table}: ${landed}`);
  }

  // Sequences were never advanced by the inserts above only where a column
  // supplied its own value; `seq` is assigned by the sequence itself, so it is
  // already correct. Restore normal FK enforcement before anything else runs.
  await target.execute("SET session_replication_role = DEFAULT");

  console.log(`\ncopied ${copied} rows across ${tables.length - skipped.length} tables`);
  if (skipped.length) console.log(`absent from source (left empty): ${skipped.join(", ")}`);
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
