import { randomBytes } from "node:crypto";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { createClient, type Client } from "@/server/pg-driver";

/**
 * Exercises the real boot-time migration, not a stand-in for it.
 *
 * `init()` runs once per process behind a cached promise and the client is
 * module-scoped, so each scenario resets the module registry and points
 * `TEST_DATABASE_URL` at a database of its own before importing the database
 * module. A database rather than a schema: `init()` decides what to do by
 * reading `meta`, and a schema sharing a search path with the main test
 * database would read *its* version and conclude there was nothing to do.
 *
 * What this guards is not optional. A schema-version bump wipes and reseeds, and
 * the "operator wiped this on purpose" cases are the difference between a
 * restart leaving an emptied production database empty and one refilling it
 * with demo campaigns.
 */
const BASE_URL = process.env.TEST_DATABASE_URL ?? "";

/** Every database created here, so none outlives the run. */
const created: string[] = [];
const opened: Client[] = [];

function adminUrl() {
  if (!BASE_URL) throw new Error("TEST_DATABASE_URL is required for these tests");
  return BASE_URL;
}

/** The same endpoint and credentials, pointed at another database. */
function urlFor(name: string) {
  const url = new URL(adminUrl());
  url.pathname = `/${name}`;
  return url.toString();
}

/** A per-test database name, so no scenario reuses another's state. */
function unique(prefix: string) {
  // Hyphens are not legal in an unquoted identifier, and CREATE DATABASE cannot
  // take a parameter: "wiped-bump" produced a syntax error rather than a test.
  const safe = prefix.replace(/[^a-z0-9]+/gi, "_");
  return `mig_${safe}_${randomBytes(4).toString("hex")}`;
}

async function createDatabase(name: string) {
  const admin = createClient({ url: adminUrl() });
  try {
    // Not parameterisable: an identifier cannot be bound. The name is generated
    // here from a fixed prefix and hex, never from input.
    await admin.execute(`CREATE DATABASE ${name}`);
    created.push(name);
  } finally {
    await admin.close();
  }
}

async function bootAgainst(name: string) {
  vi.resetModules();
  process.env.TEST_DATABASE_URL = urlFor(name);
  const db = await import("@/server/db");
  // getDb() is what every request path calls; it triggers init() exactly once.
  const client = await db.getDb();
  opened.push(client);
  return { db, client };
}

function rawAt(name: string) {
  const client = createClient({ url: urlFor(name) });
  opened.push(client);
  return client;
}

/**
 * The v5 shape: pools/attempts/vouchers with no rarity, and the retired
 * expiry_type/expiry_value columns still present on pools.
 */
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
  const client = rawAt(name);
  const result = await client.execute({
    sql: `SELECT column_name FROM information_schema.columns
          WHERE table_schema = current_schema() AND table_name = ?`,
    args: [table],
  });
  return result.rows.map((row) => String((row as Record<string, unknown>).column_name));
}

/** The version this build ships; asserted so a bump cannot pass silently. */
const CURRENT_VERSION = "7";

describe("schema migration", () => {
  afterEach(() => {
    process.env.TEST_DATABASE_URL = BASE_URL;
    vi.resetModules();
  });

  afterAll(async () => {
    for (const client of opened) await client.close().catch(() => undefined);

    const admin = createClient({ url: adminUrl() });
    for (const name of created) {
      // FORCE, because a pool may still be holding an idle socket open and a
      // leftover database would count against the project every run after.
      await admin
        .execute(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
        .catch(() => undefined);
    }
    await admin.close();
  });

  it("boots a brand new database into a seeded, rarity-bearing state", async () => {
    const name = unique("fresh");
    await createDatabase(name);
    const { client } = await bootAgainst(name);

    const pools = await client.execute("SELECT rarity, probability_weight FROM pools");
    expect(pools.rows.length).toBeGreaterThan(0);
    // NOT NULL is only a promise if the seed actually supplies a value.
    expect(
      pools.rows.every((row) => Boolean((row as Record<string, unknown>).rarity)),
    ).toBe(true);

    const version = await client.execute(
      "SELECT value FROM meta WHERE key = 'schema_version'",
    );
    expect((version.rows[0] as Record<string, unknown>).value).toBe(CURRENT_VERSION);
  });

  it("upgrades a v5 database: reshapes the tables and reseeds them", async () => {
    const name = unique("upgrade");
    await createDatabase(name);
    const raw = rawAt(name);
    await raw.executeMultiple(V5_SCHEMA);
    await raw.execute("INSERT INTO meta (key, value) VALUES ('schema_version', '5')");
    await raw.execute(
      `INSERT INTO pools (id, campaign_id, benefit_type, benefit_value, display_label,
         total_quantity, remaining_quantity, probability_weight, expiry_type, expiry_value, status)
       VALUES ('pool_legacy', 'camp_legacy', 'discount_percent', '90', '90% OFF', 5, 5, 3, 'days', 7, 'active')`,
    );
    await raw.execute(
      `INSERT INTO businesses (id, name, logo_text, industry)
       VALUES ('biz_operator_created', 'Operator Data', 'OD', 'restaurant')`,
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

    const version = await client.execute(
      "SELECT value FROM meta WHERE key = 'schema_version'",
    );
    expect((version.rows[0] as Record<string, unknown>).value).toBe(CURRENT_VERSION);
  });

  it("destroys operator-created rows outside the voucher tables", async () => {
    // Documents the cost of the bump rather than asserting it is harmless: the
    // migration DELETEs every table in DATA_TABLES, which includes Loyalty
    // Points wallets, deposit ledgers and settlements alongside businesses.
    const name = unique("wipe");
    await createDatabase(name);
    const raw = rawAt(name);
    await raw.executeMultiple(V5_SCHEMA);
    await raw.execute("INSERT INTO meta (key, value) VALUES ('schema_version', '5')");
    await raw.execute(
      `INSERT INTO businesses (id, name, logo_text, industry)
       VALUES ('biz_operator_created', 'Operator Data', 'OD', 'restaurant')`,
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
    await createDatabase(name);
    const { db } = await bootAgainst(name);
    await db.wipeDb();

    const { client } = await bootAgainst(name);
    const businesses = await client.execute("SELECT id FROM businesses");
    expect(businesses.rows).toHaveLength(0);
  });

  it("does not reseed a wiped database through a schema bump either", async () => {
    const name = unique("wiped-bump");
    await createDatabase(name);
    const { db } = await bootAgainst(name);
    await db.wipeDb();
    // Pretend this build carries a newer SCHEMA_VERSION than the database was
    // left at.
    await rawAt(name).execute(
      `INSERT INTO meta (key, value) VALUES ('schema_version', 'older')
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    );

    const { client } = await bootAgainst(name);
    const businesses = await client.execute("SELECT id FROM businesses");
    expect(businesses.rows).toHaveLength(0);
    const version = await client.execute(
      "SELECT value FROM meta WHERE key = 'schema_version'",
    );
    expect((version.rows[0] as Record<string, unknown>).value).toBe(CURRENT_VERSION);
  });

  it("leaves an already-current database alone instead of re-wiping it", async () => {
    // Every serverless cold start calls init(). If a matching version still
    // wiped, each boot would destroy live data.
    const name = unique("stable");
    await createDatabase(name);
    const { client: first } = await bootAgainst(name);
    await first.execute(
      `INSERT INTO businesses (id, name, logo_text, industry)
       VALUES ('biz_added_after_boot', 'Added Later', 'AL', 'retail')`,
    );

    const { client: second } = await bootAgainst(name);
    const survivor = await second.execute(
      "SELECT id FROM businesses WHERE id = 'biz_added_after_boot'",
    );
    expect(survivor.rows).toHaveLength(1);
  });
});
