import { createClient, type Client } from "@/server/pg-driver";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Exercises the real boot-time migration, not a stand-in for it.
 *
 * `init()` runs once per process behind a cached promise, and the libSQL client
 * is module-scoped, so each scenario resets the module registry and points
 * DATABASE_PATH at its own file before importing the database module.
 */
// Outside the repo: Windows can hold a libSQL file locked past process exit, and
// a leftover .db under data/ would sit in `git status` (data/*.db does not match
// a subdirectory).
const DIR = join(tmpdir(), "bizflow-migration-test");

// Windows keeps a libSQL file locked until its client is closed, so every client
// opened here is tracked and closed before the directory is removed.
const opened: Client[] = [];

function dbPath(name: string) {
  return `${DIR}/${name}.db`;
}

async function bootAgainst(name: string) {
  vi.resetModules();
  process.env.DATABASE_PATH = dbPath(name);
  const db = await import("@/server/db");
  // getDb() is what every request path calls; it triggers init() exactly once.
  const client = await db.getDb();
  opened.push(client as Client);
  return { db, client };
}

function rawAt(name: string) {
  const client = createClient({ url: `file:${dbPath(name)}` });
  opened.push(client);
  return client;
}

/** A per-test file name, so no scenario reuses a still-locked database. */
function unique(prefix: string) {
  return `${prefix}-${randomBytes(4).toString("hex")}`;
}

/** The v5 shape: pools/attempts/vouchers with no rarity, and the retired
 *  expiry_type/expiry_value columns still present on pools. */
const V5_SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS businesses (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, logo_text TEXT NOT NULL,
  industry TEXT NOT NULL, address TEXT, contact_number TEXT,
  latitude REAL, longitude REAL
);
CREATE TABLE IF NOT EXISTS pools (
  id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL, benefit_type TEXT NOT NULL,
  benefit_value TEXT NOT NULL, display_label TEXT NOT NULL,
  total_quantity INTEGER NOT NULL, remaining_quantity INTEGER NOT NULL,
  probability_weight INTEGER NOT NULL, expiry_type TEXT NOT NULL,
  expiry_value INTEGER NOT NULL, minimum_spend INTEGER, status TEXT NOT NULL,
  restriction TEXT
);
CREATE TABLE IF NOT EXISTS attempts (
  id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL, slot_id TEXT,
  user_id TEXT NOT NULL, attempt_number INTEGER NOT NULL,
  source_type TEXT NOT NULL, benefit_type TEXT NOT NULL,
  benefit_value TEXT NOT NULL, display_label TEXT NOT NULL,
  pool_id TEXT NOT NULL, status TEXT NOT NULL, expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS vouchers (
  id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL, slot_id TEXT NOT NULL,
  user_id TEXT NOT NULL, selected_attempt_id TEXT NOT NULL,
  voucher_code TEXT NOT NULL UNIQUE, qr_token TEXT NOT NULL UNIQUE,
  benefit_type TEXT NOT NULL, benefit_value TEXT NOT NULL,
  display_label TEXT NOT NULL, status TEXT NOT NULL, issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL, redeemed_at TEXT, UNIQUE (campaign_id, user_id)
);
`;

async function columnsOf(name: string, table: string) {
  const c = rawAt(name);
  const result = await c.execute(`PRAGMA table_info(${table})`);
  return result.rows.map((row) => String((row as Record<string, unknown>).name));
}

/** The version this build ships; asserted so a bump cannot pass silently. */
const CURRENT_VERSION = "7";

/**
 * PARKED FOR THE POSTGRES MIGRATION — do not delete, and do not treat green as
 * coverage.
 *
 * Every scenario below boots the app against a database file of its own
 * (`DATABASE_PATH`, `file:`), which is how it can exercise `init()` from a
 * cold, wrong-version, or deliberately-wiped starting state six times in one
 * run. Postgres has no file-per-database equivalent, so this needs rebuilding on
 * separate schemas or Neon branches before it means anything again.
 *
 * What it guards is not optional: a schema bump wipes and reseeds, and the
 * "operator wiped this on purpose" cases are the difference between a restart
 * that keeps an empty production database empty and one that refills it with
 * demo campaigns. Restore this before the cutover, not after.
 */
describe.skip("schema migration", () => {
  const originalPath = process.env.DATABASE_PATH;

  beforeAll(() => {
    mkdirSync(DIR, { recursive: true });
  });

  afterEach(() => {
    process.env.DATABASE_PATH = originalPath;
    vi.resetModules();
  });

  afterAll(() => {
    for (const client of opened) client.close();
    // Best effort: a lock that outlives the process must not fail the suite.
    try {
      rmSync(DIR, { force: true, recursive: true });
    } catch {
      /* leftover files are harmless; the directory is gitignored scratch */
    }
  });

  it("boots a brand new database into a seeded, rarity-bearing state", async () => {
    const name = unique("fresh");
    expect(existsSync(dbPath(name))).toBe(false);
    const { client } = await bootAgainst(name);

    const pools = await client.execute("SELECT rarity, probability_weight FROM pools");
    expect(pools.rows.length).toBeGreaterThan(0);
    // NOT NULL is only a promise if the seed actually supplies a value.
    expect(pools.rows.every((row) => Boolean((row as Record<string, unknown>).rarity))).toBe(true);

    const version = await client.execute("SELECT value FROM meta WHERE key = 'schema_version'");
    expect((version.rows[0] as Record<string, unknown>).value).toBe(CURRENT_VERSION);
  });

  it("upgrades a v5 database: reshapes the tables and reseeds them", async () => {
    const name = unique("upgrade");
    const raw = rawAt(name);
    await raw.executeMultiple(V5_SCHEMA);
    await raw.execute("INSERT INTO meta (key, value) VALUES ('schema_version', '5')");
    await raw.execute(
      `INSERT INTO pools (id, campaign_id, benefit_type, benefit_value, display_label,
         total_quantity, remaining_quantity, probability_weight, expiry_type, expiry_value, status)
       VALUES ('pool_legacy', 'camp_legacy', 'discount_percent', '90', '90% OFF', 5, 5, 3, 'days', 7, 'active')`
    );
    await raw.execute(
      `INSERT INTO businesses (id, name, logo_text, industry)
       VALUES ('biz_operator_created', 'Operator Data', 'OD', 'restaurant')`
    );
    expect(await columnsOf(name, "pools")).not.toContain("rarity");

    const { client } = await bootAgainst(name);

    // The retired expiry columns are gone from the reshaped table...
    expect(await columnsOf(name, "pools")).not.toContain("expiry_type");
    expect(await columnsOf(name, "pools")).not.toContain("expiry_value");
    // ...and the three reshaped tables carry the new column...
    for (const table of ["pools", "attempts", "vouchers"]) {
      expect(await columnsOf(name, table)).toContain("rarity");
    }
    // ...and the v5 rows are gone rather than migrated.
    const legacy = await client.execute("SELECT id FROM pools WHERE id = 'pool_legacy'");
    expect(legacy.rows).toHaveLength(0);

    const seeded = await client.execute("SELECT rarity FROM pools");
    expect(seeded.rows.length).toBeGreaterThan(0);
    expect(
      seeded.rows.every((row) => Boolean((row as Record<string, unknown>).rarity)),
    ).toBe(true);

    const version = await client.execute("SELECT value FROM meta WHERE key = 'schema_version'");
    expect((version.rows[0] as Record<string, unknown>).value).toBe(CURRENT_VERSION);
  });

  it("destroys operator-created rows outside the voucher tables", async () => {
    // Documents the cost of the bump rather than asserting it is harmless: the
    // migration DELETEs every table in DATA_TABLES, which includes Loyalty
    // Points wallets, deposit ledgers and settlements alongside businesses.
    const name = unique("wipe");
    const raw = rawAt(name);
    await raw.executeMultiple(V5_SCHEMA);
    await raw.execute("INSERT INTO meta (key, value) VALUES ('schema_version', '5')");
    await raw.execute(
      `INSERT INTO businesses (id, name, logo_text, industry)
       VALUES ('biz_operator_created', 'Operator Data', 'OD', 'restaurant')`
    );

    const { client } = await bootAgainst(name);

    const survivor = await client.execute(
      "SELECT id FROM businesses WHERE id = 'biz_operator_created'",
    );
    expect(survivor.rows).toHaveLength(0);
  });

  it("does not reseed a database the operator wiped on purpose", async () => {
    // The Danger Zone's wipe leaves the tables empty, which the self-heal would
    // otherwise read as damage and repair on the next cold start.
    const name = unique("wiped");
    const { db } = await bootAgainst(name);
    await db.wipeDb();

    const { client } = await bootAgainst(name);
    const businesses = await client.execute("SELECT id FROM businesses");
    expect(businesses.rows).toHaveLength(0);
  });

  it("does not reseed a wiped database through a schema bump either", async () => {
    const name = unique("wiped-bump");
    const { db } = await bootAgainst(name);
    await db.wipeDb();
    // Pretend this build carries a newer SCHEMA_VERSION than the file was left at.
    await rawAt(name).execute(
      "INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', 'older')",
    );

    const { client } = await bootAgainst(name);
    const businesses = await client.execute("SELECT id FROM businesses");
    expect(businesses.rows).toHaveLength(0);
    const version = await client.execute("SELECT value FROM meta WHERE key = 'schema_version'");
    expect((version.rows[0] as Record<string, unknown>).value).toBe(CURRENT_VERSION);
  });

  it("leaves an already-current database alone instead of re-wiping it", async () => {
    // Every serverless cold start calls init(). If a matching version still
    // wiped, each boot would destroy live data.
    const name = unique("stable");
    const { client: first } = await bootAgainst(name);
    await first.execute(
      `INSERT INTO businesses (id, name, logo_text, industry)
       VALUES ('biz_added_after_boot', 'Added Later', 'AL', 'retail')`
    );

    const { client: second } = await bootAgainst(name);
    const survivor = await second.execute(
      "SELECT id FROM businesses WHERE id = 'biz_added_after_boot'",
    );
    expect(survivor.rows).toHaveLength(1);
  });
});
