import { createClient, type Client, type InArgs, type InStatement, type Transaction } from "@libsql/client";
import type {
  AnalyticsEvent,
  Business,
  Campaign,
  CampaignSlot,
  EndUser,
  RedemptionLog,
  ReferralReward,
  Reservation,
  SmsLog,
  Voucher,
  VoucherAttempt,
  VoucherPool
} from "@/types/voucher";

// libSQL returns rows keyed by column name; mappers narrow them to domain types.
type Row = any;
export type Exec = Client | Transaction;

/**
 * Production and local development must never share a database:
 * - production requires Turso/libSQL via DATABASE_URL + DATABASE_AUTH_TOKEN
 * - development and tests always use DATABASE_PATH, even if a shell happens to
 *   contain remote credentials
 */
function resolveUrl() {
  if (process.env.NODE_ENV === "production") {
    const remoteUrl = process.env.DATABASE_URL?.trim();
    const remoteToken = process.env.DATABASE_AUTH_TOKEN?.trim();
    if (!remoteUrl || !remoteToken) {
      throw new Error(
        "Production database is not configured. Set DATABASE_URL and DATABASE_AUTH_TOKEN.",
      );
    }
    if (!remoteUrl.startsWith("libsql://") && !remoteUrl.startsWith("https://")) {
      throw new Error("Production DATABASE_URL must point to Turso/libSQL.");
    }
    return remoteUrl;
  }

  const p = process.env.DATABASE_PATH ?? "./data/bizflow.db";
  return `file:${p.replace(/\\/g, "/")}`;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS businesses (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  logo_text TEXT NOT NULL,
  industry TEXT NOT NULL,
  address TEXT,
  contact_number TEXT,
  latitude REAL,
  longitude REAL
);
CREATE TABLE IF NOT EXISTS campaigns (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id),
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  offer_message TEXT NOT NULL,
  hero_image TEXT NOT NULL,
  mode TEXT NOT NULL,
  location TEXT,
  status TEXT NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  base_attempts INTEGER NOT NULL,
  referral_daily_limit INTEGER NOT NULL,
  candidate_timeout_minutes INTEGER NOT NULL,
  terms TEXT NOT NULL,
  shop_url TEXT,
  allow_reschedule INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS slots (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id),
  date TEXT NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  timezone TEXT NOT NULL,
  branch_id TEXT,
  total_capacity INTEGER NOT NULL,
  remaining_capacity INTEGER NOT NULL,
  status TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_slots_campaign ON slots (campaign_id);
CREATE TABLE IF NOT EXISTS pools (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id),
  benefit_type TEXT NOT NULL,
  benefit_value TEXT NOT NULL,
  display_label TEXT NOT NULL,
  total_quantity INTEGER NOT NULL,
  remaining_quantity INTEGER NOT NULL,
  rarity TEXT NOT NULL,
  probability_weight INTEGER NOT NULL,
  minimum_spend INTEGER,
  status TEXT NOT NULL,
  restriction TEXT
);
CREATE INDEX IF NOT EXISTS idx_pools_campaign ON pools (campaign_id);
-- Which date/time slots offer each benefit tier. Rarer tiers map to fewer slots.
CREATE TABLE IF NOT EXISTS pool_slots (
  pool_id TEXT NOT NULL REFERENCES pools(id),
  slot_id TEXT NOT NULL REFERENCES slots(id),
  PRIMARY KEY (pool_id, slot_id)
);
CREATE INDEX IF NOT EXISTS idx_pool_slots_slot ON pool_slots (slot_id);
CREATE TABLE IF NOT EXISTS change_requests (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id),
  business_id TEXT NOT NULL REFERENCES businesses(id),
  requested_by TEXT NOT NULL,
  request_type TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'Pending',
  reviewed_by TEXT,
  review_note TEXT,
  created_at TEXT NOT NULL,
  reviewed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_change_requests_status ON change_requests (status, created_at);
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- Console logins: the people who sign in to /dashboard. Deliberately not in
-- DATA_TABLES — these are real credentials, and a schema-version bump wipes
-- every table listed there. Note the name: the users table below is customers.
CREATE TABLE IF NOT EXISTS admin_users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  -- Comma-separated business ids, or '*' for every business. Staff always carry
  -- exactly one id: verifyAdminSession rejects an unscoped staff session.
  business_ids TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  last_login_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_admin_users_email ON admin_users (email);
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id),
  name TEXT,
  phone TEXT NOT NULL,
  email TEXT,
  session_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (campaign_id, phone)
);
-- The customer list groups by phone across campaigns. UNIQUE (campaign_id, phone)
-- leads with campaign_id, so it cannot serve that grouping.
CREATE INDEX IF NOT EXISTS idx_users_phone ON users (phone);
CREATE TABLE IF NOT EXISTS attempts (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL,
  slot_id TEXT,
  user_id TEXT NOT NULL REFERENCES users(id),
  attempt_number INTEGER NOT NULL,
  source_type TEXT NOT NULL,
  benefit_type TEXT NOT NULL,
  benefit_value TEXT NOT NULL,
  display_label TEXT NOT NULL,
  rarity TEXT NOT NULL,
  pool_id TEXT NOT NULL,
  status TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
-- The dashboard aggregates attempts per campaign, and per slot within it, on
-- every campaign-scoped page load. Without this the metrics query scans the
-- whole table, which is the largest table in an active campaign.
CREATE INDEX IF NOT EXISTS idx_attempts_campaign ON attempts (campaign_id, slot_id);
-- The same page also rolls attempts up per benefit label, and the index above
-- cannot serve that: slot_id leads, so the planner narrows to the campaign and
-- then builds a temp B-tree for the GROUP BY. Measured at 180k attempts that
-- rollup took 500ms while the equivalent voucher rollup — which does have a
-- covering index — took 10ms, on the same page load.
CREATE INDEX IF NOT EXISTS idx_attempts_campaign_label ON attempts (campaign_id, display_label);
CREATE TABLE IF NOT EXISTS vouchers (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL,
  slot_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  selected_attempt_id TEXT NOT NULL,
  voucher_code TEXT NOT NULL UNIQUE,
  qr_token TEXT NOT NULL UNIQUE,
  benefit_type TEXT NOT NULL,
  benefit_value TEXT NOT NULL,
  display_label TEXT NOT NULL,
  rarity TEXT NOT NULL,
  status TEXT NOT NULL,
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  redeemed_at TEXT,
  UNIQUE (campaign_id, user_id)
);
-- The UNIQUE (campaign_id, user_id) index cannot serve the dashboard's
-- per-slot/per-status rollups, which never constrain user_id.
CREATE INDEX IF NOT EXISTS idx_vouchers_campaign ON vouchers (campaign_id, slot_id, status);
-- Nor can it serve a lookup by user alone: campaign_id is its leading column, so
-- the customer list's join from users to vouchers had no index at all.
CREATE INDEX IF NOT EXISTS idx_vouchers_user ON vouchers (user_id);
CREATE TABLE IF NOT EXISTS reservations (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL,
  slot_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  voucher_id TEXT NOT NULL,
  guest_count INTEGER,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reservations_campaign ON reservations (campaign_id, status);
CREATE TABLE IF NOT EXISTS sms_logs (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  voucher_id TEXT NOT NULL,
  to_number TEXT NOT NULL,
  body TEXT NOT NULL,
  provider TEXT NOT NULL,
  status TEXT NOT NULL,
  provider_message_id TEXT,
  created_at TEXT NOT NULL,
  failure_reason TEXT,
  delivery_status TEXT,
  delivery_error TEXT,
  delivery_receipt TEXT,
  delivered_at TEXT
);
CREATE TABLE IF NOT EXISTS redemption_logs (
  id TEXT PRIMARY KEY,
  voucher_id TEXT NOT NULL,
  staff_name TEXT NOT NULL,
  purchase_amount INTEGER,
  note TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS analytics_events (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL,
  event_name TEXT NOT NULL,
  user_id TEXT,
  slot_id TEXT,
  metadata TEXT,
  created_at TEXT NOT NULL
);
-- This table grows fastest of all and the dashboard only ever counts it by
-- (campaign, event_name). The index turns those counts into range scans.
CREATE INDEX IF NOT EXISTS idx_analytics_campaign_event ON analytics_events (campaign_id, event_name);
CREATE TABLE IF NOT EXISTS referral_rewards (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL,
  referrer_user_id TEXT NOT NULL REFERENCES users(id),
  visitor_session_id TEXT NOT NULL,
  status TEXT NOT NULL,
  reason TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (campaign_id, referrer_user_id, visitor_session_id)
);
CREATE TABLE IF NOT EXISTS otp_challenges (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL,
  phone TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  verified INTEGER NOT NULL DEFAULT 0,
  consumed_at TEXT,
  -- Wrong guesses against this challenge. A six-digit code is only 20 bits, so
  -- the code's secrecy rests entirely on this counter burning the challenge
  -- before an attacker can walk the space. See verifySignInOtp.
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_otp_campaign_phone ON otp_challenges (campaign_id, phone);
CREATE TABLE IF NOT EXISTS customer_sessions (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL,
  phone TEXT NOT NULL,
  session_token TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_customer_sessions_phone ON customer_sessions (campaign_id, phone, expires_at);
CREATE TABLE IF NOT EXISTS customer_tokens (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  phone TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_customer_tokens_phone ON customer_tokens (phone, expires_at);
CREATE TABLE IF NOT EXISTS push_devices (
  id TEXT PRIMARY KEY,
  phone TEXT NOT NULL,
  expo_push_token TEXT NOT NULL UNIQUE,
  platform TEXT NOT NULL,
  -- Per-category opt-out. Transactional categories stay on by default; the
  -- customer can silence any of them from the app's More screen.
  daily_enabled INTEGER NOT NULL DEFAULT 1,
  reservation_enabled INTEGER NOT NULL DEFAULT 1,
  rewards_enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_push_devices_phone ON push_devices (phone);
CREATE TABLE IF NOT EXISTS push_logs (
  id TEXT PRIMARY KEY,
  phone TEXT NOT NULL,
  expo_push_token TEXT NOT NULL,
  category TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  data TEXT,
  status TEXT NOT NULL,
  ticket_id TEXT,
  failure_reason TEXT,
  -- Idempotency key: one row per (category, subject, day) so a retried or
  -- double-invoked scheduler cannot notify the same customer twice.
  dedupe_key TEXT,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_push_logs_dedupe ON push_logs (dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE TABLE IF NOT EXISTS rate_events (
  id TEXT PRIMARY KEY,
  bucket_key TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rate_bucket ON rate_events (bucket_key, created_at);
CREATE TABLE IF NOT EXISTS reward_wallets (
  id TEXT PRIMARY KEY,
  phone TEXT NOT NULL UNIQUE,
  name TEXT,
  email TEXT,
  wallet_token TEXT NOT NULL UNIQUE,
  wallet_secret TEXT NOT NULL UNIQUE,
  balance_centavos INTEGER NOT NULL DEFAULT 0 CHECK (balance_centavos >= 0),
  lifetime_earned_centavos INTEGER NOT NULL DEFAULT 0 CHECK (lifetime_earned_centavos >= 0),
  lifetime_converted_centavos INTEGER NOT NULL DEFAULT 0 CHECK (lifetime_converted_centavos >= 0),
  status TEXT NOT NULL DEFAULT 'Active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- Loyalty Points earned at one partner, held against that partner rather than
-- the wallet's global balance. reward_wallets.balance_centavos remains the
-- global pot: it is what referrals and daily rewards credit, and the only
-- balance convertible to a spend-anywhere voucher. Points land here first and
-- reach the global pot only by transfer, which charges a fee.
CREATE TABLE IF NOT EXISTS reward_business_balances (
  id TEXT PRIMARY KEY,
  wallet_id TEXT NOT NULL REFERENCES reward_wallets(id),
  business_id TEXT NOT NULL REFERENCES businesses(id),
  balance_centavos INTEGER NOT NULL DEFAULT 0 CHECK (balance_centavos >= 0),
  lifetime_earned_centavos INTEGER NOT NULL DEFAULT 0 CHECK (lifetime_earned_centavos >= 0),
  lifetime_transferred_centavos INTEGER NOT NULL DEFAULT 0 CHECK (lifetime_transferred_centavos >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (wallet_id, business_id)
);
CREATE INDEX IF NOT EXISTS idx_reward_business_balances_wallet ON reward_business_balances (wallet_id);
CREATE TABLE IF NOT EXISTS reward_purchases (
  id TEXT PRIMARY KEY,
  wallet_id TEXT NOT NULL REFERENCES reward_wallets(id),
  business_id TEXT NOT NULL REFERENCES businesses(id),
  purchase_amount_centavos INTEGER NOT NULL CHECK (purchase_amount_centavos > 0),
  reward_amount_centavos INTEGER NOT NULL CHECK (reward_amount_centavos > 0),
  staff_name TEXT NOT NULL,
  idempotency_key TEXT,
  status TEXT NOT NULL,
  fraud_flag TEXT,
  reviewed_by TEXT,
  reviewed_at TEXT,
  review_note TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reward_purchases_wallet ON reward_purchases (wallet_id, created_at);
CREATE INDEX IF NOT EXISTS idx_reward_purchases_business ON reward_purchases (business_id, created_at);
CREATE TABLE IF NOT EXISTS reward_ledger_entries (
  id TEXT PRIMARY KEY,
  wallet_id TEXT NOT NULL REFERENCES reward_wallets(id),
  type TEXT NOT NULL,
  delta_centavos INTEGER NOT NULL,
  balance_after_centavos INTEGER NOT NULL CHECK (balance_after_centavos >= 0),
  source_type TEXT NOT NULL,
  source_id TEXT,
  business_id TEXT,
  staff_name TEXT,
  metadata TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reward_ledger_wallet ON reward_ledger_entries (wallet_id, created_at);
CREATE TABLE IF NOT EXISTS loyalty_daily_rewards (
  id TEXT PRIMARY KEY,
  wallet_id TEXT NOT NULL REFERENCES reward_wallets(id),
  reward_type TEXT NOT NULL,
  reward_date TEXT NOT NULL,
  points_centavos INTEGER NOT NULL CHECK (points_centavos > 0),
  source_id TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (wallet_id, reward_type, reward_date)
);
CREATE INDEX IF NOT EXISTS idx_loyalty_daily_wallet ON loyalty_daily_rewards (wallet_id, reward_date);
CREATE TABLE IF NOT EXISTS reward_vouchers (
  id TEXT PRIMARY KEY,
  wallet_id TEXT NOT NULL REFERENCES reward_wallets(id),
  voucher_code TEXT NOT NULL UNIQUE,
  qr_token TEXT NOT NULL UNIQUE,
  amount_centavos INTEGER NOT NULL CHECK (amount_centavos > 0),
  remaining_centavos INTEGER NOT NULL CHECK (remaining_centavos >= 0),
  status TEXT NOT NULL,
  issued_at TEXT NOT NULL,
  expires_at TEXT,
  redeemed_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reward_vouchers_wallet ON reward_vouchers (wallet_id, created_at);
CREATE TABLE IF NOT EXISTS reward_voucher_redemptions (
  id TEXT PRIMARY KEY,
  voucher_id TEXT NOT NULL REFERENCES reward_vouchers(id),
  wallet_id TEXT NOT NULL REFERENCES reward_wallets(id),
  business_id TEXT NOT NULL REFERENCES businesses(id),
  amount_centavos INTEGER NOT NULL CHECK (amount_centavos > 0),
  service_fee_centavos INTEGER NOT NULL DEFAULT 0 CHECK (service_fee_centavos >= 0),
  settlement_amount_centavos INTEGER NOT NULL CHECK (settlement_amount_centavos >= 0),
  staff_name TEXT NOT NULL,
  settlement_status TEXT NOT NULL,
  settlement_id TEXT,
  settlement_verified_by TEXT,
  settlement_verified_at TEXT,
  adjustment_note TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reward_redemptions_business ON reward_voucher_redemptions (business_id, created_at);
CREATE TABLE IF NOT EXISTS reward_settlements (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id),
  period TEXT NOT NULL,
  gross_amount_centavos INTEGER NOT NULL DEFAULT 0 CHECK (gross_amount_centavos >= 0),
  service_fee_centavos INTEGER NOT NULL DEFAULT 0 CHECK (service_fee_centavos >= 0),
  total_amount_centavos INTEGER NOT NULL CHECK (total_amount_centavos >= 0),
  status TEXT NOT NULL,
  gcash_reference TEXT,
  created_at TEXT NOT NULL,
  processed_at TEXT,
  UNIQUE (business_id, period)
);
-- Every partner posts a deposit before joining the network. LP issued at their
-- checkout is money they owe us, so the deposit is what that exposure is drawn
-- against when a month closes in our favour.
CREATE TABLE IF NOT EXISTS business_deposit_entries (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id),
  -- TopUp | StatementDeduction | Adjustment | Refund
  type TEXT NOT NULL,
  -- Signed: positive adds to the deposit, negative draws it down.
  amount_centavos INTEGER NOT NULL,
  balance_after_centavos INTEGER NOT NULL,
  reference TEXT,
  note TEXT,
  recorded_by TEXT NOT NULL,
  statement_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_business_deposits ON business_deposit_entries (business_id, created_at);
-- Items a customer buys with LP instead of pesos. Priced in LP hundredths, the
-- same unit as every other reward amount.
CREATE TABLE IF NOT EXISTS reward_products (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id),
  name TEXT NOT NULL,
  description TEXT,
  image_url TEXT,
  price_centavos INTEGER NOT NULL CHECK (price_centavos > 0),
  status TEXT NOT NULL DEFAULT 'Active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reward_products_business ON reward_products (business_id, status);
CREATE TABLE IF NOT EXISTS reward_audit_logs (
  id TEXT PRIMARY KEY,
  actor_type TEXT NOT NULL,
  actor_id TEXT,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  metadata TEXT,
  previous_hash TEXT,
  event_hash TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reward_audit_entity ON reward_audit_logs (entity_type, entity_id, created_at);
`;

let client: Client | null = null;
let readyPromise: Promise<void> | null = null;

function rawClient(): Client {
  if (!client) {
    const url = resolveUrl();
    client = createClient({
      url,
      authToken:
        process.env.NODE_ENV === "production"
          ? process.env.DATABASE_AUTH_TOKEN
          : undefined,
      intMode: "number",
    });
  }
  return client;
}

/** Creates the schema (and seeds a fresh/partial database) exactly once per process. */
function ensureReady(): Promise<void> {
  if (!readyPromise) {
    // Do not cache a rejected init: a transient failure would otherwise poison
    // every later request in this serverless instance until it cold-starts again.
    readyPromise = init().catch((error) => {
      readyPromise = null;
      throw error;
    });
  }
  return readyPromise;
}

// Every data table, ordered so deletes respect (soft) references. Used by the
// migration reset and by resetDb.
const DATA_TABLES = [
  "reward_audit_logs",
  // Draws down businesses(id) and references settlements, so it goes first.
  "business_deposit_entries",
  "reward_settlements",
  "reward_voucher_redemptions",
  "reward_vouchers",
  "reward_products",
  "loyalty_daily_rewards",
  "reward_ledger_entries",
  "reward_purchases",
  // References both reward_wallets(id) and businesses(id), so it clears first.
  "reward_business_balances",
  "reward_wallets",
  "rate_events",
  "push_logs",
  "push_devices",
  "customer_tokens",
  "customer_sessions",
  "otp_challenges",
  "analytics_events",
  "referral_rewards",
  "redemption_logs",
  "sms_logs",
  // References campaigns(id) and businesses(id), so it must be wiped before them.
  "change_requests",
  "reservations",
  "vouchers",
  "attempts",
  "users",
  "pool_slots",
  "pools",
  "slots",
  "campaigns",
  "businesses"
];

// Bump when the seed or table shapes change so deployed databases refresh.
// v2 = campaign-level pools + pool_slots tier→slot mapping. v3 = campaign titles.
// v4 = Loyalty Points wallet/settlement tables.
// v5 = slot-bound voucher expiry.
// v6 = per-tier rarity as a stored, required column on pools/attempts/vouchers.
// v7 = dropped the retired expiry_type/expiry_value columns.
//
// Bumping this wipes every table in DATA_TABLES and reseeds — not only the
// voucher tables, but Loyalty Points wallets, partner deposit ledgers and
// settlements with them. That is the deliberate choice here (approved while the
// app is pre-launch), which is why `rarity` can be NOT NULL with no backfill.
const SCHEMA_VERSION = "7";

async function init() {
  const c = rawClient();
  await c.execute("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  const versionRow = (await c.execute("SELECT value FROM meta WHERE key = 'schema_version'")).rows[0] as Row | undefined;
  const migrating = (versionRow?.value as string | undefined) !== SCHEMA_VERSION;
  const suppressed = await seedSuppressed(c);

  if (migrating) {
    // The pools/attempts model changed fundamentally; drop the affected tables
    // (demo data is disposable) so executeMultiple(SCHEMA) recreates them fresh.
    await c.batch(
      [
        "DROP TABLE IF EXISTS pool_slots",
        "DROP TABLE IF EXISTS pools",
        "DROP TABLE IF EXISTS attempts",
        "DROP TABLE IF EXISTS vouchers",
        "DROP TABLE IF EXISTS reservations"
      ],
      "write"
    );
  }

  await c.executeMultiple(SCHEMA);
  await dropStaffPinColumn(c);
  await ensureRewardsSchema(c);
  await ensureSmsSchema(c);
  await ensureAuthSchema(c);

  if (migrating) {
    // Full reset so seed changes (e.g. campaign titles) reach already-seeded
    // databases; INSERT OR IGNORE alone would keep stale rows.
    await c.batch(DATA_TABLES.map((table) => `DELETE FROM ${table}`), "write");
    if (!suppressed) {
      await seed(c);
      await ensureDemoCampaignAvailability(c);
    }
    await c.execute({ sql: "INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)", args: [SCHEMA_VERSION] });
    return;
  }

  // An operator emptied the database on purpose — leave it empty.
  if (suppressed) return;

  // Deliberately after the migrating branch: a version bump wipes and reseeds,
  // which leaves no pre-split wallet to rebuild buckets for.
  await runPartnerBucketBackfill(c);

  // Same version: self-heal an empty or partially-seeded database.
  if (!(await hasCompleteSeed(c))) await seed(c);
  await ensureSeededRewardProductImages(c);
  await ensureDemoCustomer(c);
  await ensureDemoCampaignAvailability(c);
}

/**
 * Adds the demo customer to a database that was seeded before the fixture
 * existed. INSERT OR IGNORE keyed by id, so it never overwrites a real customer
 * and never double-credits the seeded wallet.
 */
async function ensureDemoCustomer(c: Client) {
  await c.batch(demoCustomerStatements(), "write");
}

/**
 * Drops the retired per-venue staff PIN.
 *
 * The column was written on every business create but never read: no code ever
 * verified a PIN against it. Staff reach the console through `admin_users`
 * accounts instead. `CREATE TABLE IF NOT EXISTS` cannot remove it from an
 * already-created table, and leaving a NOT NULL column with no default would
 * fail every later insert, so it has to go explicitly.
 */
async function dropStaffPinColumn(c: Client) {
  if (await hasColumn(c, "businesses", "staff_pin")) {
    await c.execute("ALTER TABLE businesses DROP COLUMN staff_pin");
  }
}

async function hasColumn(c: Client, table: string, column: string) {
  const result = await c.execute(`PRAGMA table_info(${table})`);
  return result.rows.some((row) => String((row as Row).name) === column);
}

async function ensureRewardsSchema(c: Client) {
  const walletSecretExists = await hasColumn(c, "reward_wallets", "wallet_secret");
  if (!walletSecretExists) {
    await c.execute("ALTER TABLE reward_wallets ADD COLUMN wallet_secret TEXT");
  }

  const rewardColumnAdds: Array<[string, string, string]> = [
    ["reward_purchases", "idempotency_key", "TEXT"],
    ["reward_purchases", "reviewed_by", "TEXT"],
    ["reward_purchases", "reviewed_at", "TEXT"],
    ["reward_purchases", "review_note", "TEXT"],
    ["reward_voucher_redemptions", "settlement_verified_by", "TEXT"],
    ["reward_voucher_redemptions", "settlement_verified_at", "TEXT"],
    ["reward_voucher_redemptions", "adjustment_note", "TEXT"],
    ["reward_voucher_redemptions", "service_fee_centavos", "INTEGER"],
    ["reward_voucher_redemptions", "settlement_amount_centavos", "INTEGER"],
    ["reward_settlements", "gross_amount_centavos", "INTEGER"],
    ["reward_settlements", "service_fee_centavos", "INTEGER"],
    // A settlement is now a two-sided monthly statement: LP the partner issued
    // (owed to us) against LP their customers spent (owed to them).
    ["reward_settlements", "lp_issued_centavos", "INTEGER"],
    ["reward_settlements", "lp_redeemed_centavos", "INTEGER"],
    ["reward_settlements", "net_centavos", "INTEGER"],
    ["reward_settlements", "direction", "TEXT"],
    ["reward_settlements", "deposit_deduction_centavos", "INTEGER"],
    ["reward_settlements", "paid_at", "TEXT"],
    ["reward_settlements", "payment_reference", "TEXT"],
    ["reward_settlements", "payment_recorded_by", "TEXT"],
    ["businesses", "deposit_balance_centavos", "INTEGER NOT NULL DEFAULT 0"],
    // An LP voucher bought from the storefront is spendable only at the partner
    // that sells the item, unlike a plain LP conversion.
    ["reward_vouchers", "business_id", "TEXT"],
    ["reward_vouchers", "product_id", "TEXT"],
    ["reward_audit_logs", "previous_hash", "TEXT"],
    ["reward_audit_logs", "event_hash", "TEXT"],
    // A fixed-denomination voucher converted from global LP only applies to a
    // bill of at least this much, so a ₱100 voucher cannot clear a ₱100 tab.
    // Null on the open-amount vouchers minted before this existed, which stay
    // spendable without a floor.
    ["reward_vouchers", "minimum_spend_centavos", "INTEGER"],
  ];

  for (const [table, column, definition] of rewardColumnAdds) {
    if (!(await hasColumn(c, table, column))) {
      await c.execute(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }

  // The deposit ledger is the source of truth; the column on `businesses` is a
  // cached running total. They can drift — adding the column to an existing
  // database defaults every partner to zero while their seeded opening entry
  // says otherwise — so reconcile the cache to the movements on boot.
  await c.execute(
    `UPDATE businesses
     SET deposit_balance_centavos = (
       SELECT COALESCE(SUM(amount_centavos), 0) FROM business_deposit_entries
       WHERE business_id = businesses.id
     )
     WHERE EXISTS (SELECT 1 FROM business_deposit_entries WHERE business_id = businesses.id)
       AND deposit_balance_centavos <> (
         SELECT COALESCE(SUM(amount_centavos), 0) FROM business_deposit_entries
         WHERE business_id = businesses.id
       )`,
  );

  await c.execute(
    `UPDATE reward_wallets
     SET wallet_secret = 'rwsecret_' || lower(hex(randomblob(18)))
     WHERE wallet_secret IS NULL OR wallet_secret = ''`
  );
  await c.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_reward_wallets_secret ON reward_wallets (wallet_secret)");
  await c.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_reward_purchases_idempotency ON reward_purchases (business_id, idempotency_key) WHERE idempotency_key IS NOT NULL");
  await c.execute(
    `CREATE TABLE IF NOT EXISTS loyalty_daily_rewards (
      id TEXT PRIMARY KEY,
      wallet_id TEXT NOT NULL REFERENCES reward_wallets(id),
      reward_type TEXT NOT NULL,
      reward_date TEXT NOT NULL,
      points_centavos INTEGER NOT NULL CHECK (points_centavos > 0),
      source_id TEXT,
      created_at TEXT NOT NULL,
      UNIQUE (wallet_id, reward_type, reward_date)
    )`,
  );
  await c.execute("CREATE INDEX IF NOT EXISTS idx_loyalty_daily_wallet ON loyalty_daily_rewards (wallet_id, reward_date)");
  // Historical redemptions predate the service-fee rule. Preserve their full
  // partner payout instead of retroactively charging a fee.
  await c.execute(
    `UPDATE reward_voucher_redemptions
     SET service_fee_centavos = COALESCE(service_fee_centavos, 0),
         settlement_amount_centavos = COALESCE(settlement_amount_centavos, amount_centavos)`,
  );
  await c.execute(
    `UPDATE reward_settlements
     SET gross_amount_centavos = COALESCE(gross_amount_centavos, total_amount_centavos),
         service_fee_centavos = COALESCE(service_fee_centavos, 0)`,
  );
}

// ---- Partner bucket backfill ----------------------------------------------
// Runs once per database and is then skipped by this flag, so a cold start does
// not re-scan the ledger. Cleared by resetDb(), which starts a new world. An
// operator restoring a pre-split backup over a flagged database can delete the
// meta row to let it run again — the work is idempotent either way.
const LP_BUCKET_BACKFILL_KEY = "lp_bucket_backfill";

/**
 * Wallets still holding partner earnings in the global pot.
 *
 * A bucket is owed the wallet's `credit_earned` at that partner less what the
 * bucket has already been credited. Post-split credits are counted in both and
 * cancel out, leaving only the pre-split ones — which is what makes the whole
 * backfill safe to run a second time.
 */
const LP_BACKFILL_CANDIDATES_SQL = `
  SELECT e.wallet_id AS wallet_id
  FROM (
    SELECT wallet_id, business_id, SUM(delta_centavos) AS earned_centavos
    FROM reward_ledger_entries
    WHERE type = 'credit_earned' AND business_id IS NOT NULL
    GROUP BY wallet_id, business_id
  ) e
  LEFT JOIN reward_business_balances b
    ON b.wallet_id = e.wallet_id AND b.business_id = e.business_id
  WHERE e.earned_centavos > COALESCE(b.lifetime_earned_centavos, 0)
  GROUP BY e.wallet_id
`;

// The same arithmetic for one wallet, biggest debt first so the rounding
// remainder below lands where there is room for it.
const LP_BACKFILL_WALLET_BUCKETS_SQL = `
  SELECT
    e.business_id AS business_id,
    e.earned_centavos - COALESCE(b.lifetime_earned_centavos, 0) AS pending_centavos,
    COALESCE(b.balance_centavos, 0) AS bucket_centavos
  FROM (
    SELECT business_id, SUM(delta_centavos) AS earned_centavos
    FROM reward_ledger_entries
    WHERE wallet_id = ? AND type = 'credit_earned' AND business_id IS NOT NULL
    GROUP BY business_id
  ) e
  LEFT JOIN reward_business_balances b
    ON b.wallet_id = ? AND b.business_id = e.business_id
  WHERE e.earned_centavos - COALESCE(b.lifetime_earned_centavos, 0) > 0
  ORDER BY pending_centavos DESC, business_id
`;

/**
 * What the wallet holds globally, and how much of that was never earned at a
 * partner. Daily rewards, referrals, dev grants and the credited half of a
 * transfer are all identified the same way — a positive ledger delta with no
 * `business_id` — because that is precisely the convention the ledger uses for
 * the global pot.
 */
const LP_BACKFILL_WALLET_GLOBAL_SQL = `
  SELECT
    w.balance_centavos AS global_centavos,
    (SELECT COALESCE(SUM(delta_centavos), 0)
       FROM reward_ledger_entries
      WHERE wallet_id = w.id AND delta_centavos > 0 AND business_id IS NULL
    ) AS global_only_centavos
  FROM reward_wallets w
  WHERE w.id = ?
`;

/**
 * Moves partner-earned Loyalty Points out of the global pot and into the
 * per-partner buckets that now hold them.
 *
 * Earning used to credit `reward_wallets.balance_centavos` directly. It credits
 * `reward_business_balances` instead now, which left every wallet that existed
 * before the split holding its partner earnings in the spend-anywhere pot —
 * exactly the claim the split exists to give the partner who funded them. Every
 * historical credit carries its `business_id`, so the buckets can be rebuilt
 * from the ledger.
 *
 * Three rules decide how much moves:
 *
 * - Only what the buckets are still owed, per the candidate query above.
 * - Points that were never earned at a partner stay global. Withholding them is
 *   the conservative reading for the holder: it never takes away spend-anywhere
 *   points they already had, and daily rewards were never a partner's liability
 *   to begin with.
 * - Nothing may exceed the balance actually left, since spending has drawn the
 *   pot down since. Where that cap bites the buckets fill pro rata — a
 *   commingled pot keeps no record of whose points were spent, so preferring
 *   one partner over another would be inventing one.
 *
 * The movement is written to the ledger on both sides rather than applied
 * silently, so a holder whose global balance drops can see where it went. There
 * is no audit-log row: the hash chain in rewards-network covers actions taken
 * against a wallet, and this is a schema migration, like the deposit
 * reconciliation above.
 */
async function runPartnerBucketBackfill(c: Client, force = false) {
  if (!force) {
    const done = await one(c, "SELECT value FROM meta WHERE key = ?", [
      LP_BUCKET_BACKFILL_KEY,
    ]);
    if (String(done?.value ?? "") === "1") {
      return { wallets: 0, movedCentavos: 0 };
    }
  }

  const candidates = await all(c, LP_BACKFILL_CANDIDATES_SQL);
  let wallets = 0;
  let movedCentavos = 0;
  for (const candidate of candidates) {
    const moved = await backfillOneWallet(c, String(candidate.wallet_id));
    if (moved > 0) {
      wallets += 1;
      movedCentavos += moved;
    }
  }

  await c.execute({
    sql: "INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)",
    args: [LP_BUCKET_BACKFILL_KEY, "1"],
  });
  return { wallets, movedCentavos };
}

/**
 * One wallet, in its own write transaction.
 *
 * The figures are read again inside the transaction rather than carried in from
 * the candidate scan: two serverless instances can cold-start onto the same
 * database at once, and libSQL serializes write transactions, so whichever
 * commits second recomputes a debt of zero instead of paying it twice.
 */
async function backfillOneWallet(c: Client, walletId: string) {
  const tx = await c.transaction("write");
  try {
    const buckets = await all(tx, LP_BACKFILL_WALLET_BUCKETS_SQL, [
      walletId,
      walletId,
    ]);
    const wallet = await one(tx, LP_BACKFILL_WALLET_GLOBAL_SQL, [walletId]);
    if (!wallet || buckets.length === 0) {
      await tx.rollback();
      return 0;
    }

    const pending = buckets.map((row) => Number(row.pending_centavos));
    const totalPending = pending.reduce((sum, value) => sum + value, 0);
    const spendAnywhere = Number(wallet.global_only_centavos);
    const movable = Math.max(
      0,
      Math.min(Number(wallet.global_centavos) - spendAnywhere, totalPending),
    );
    if (movable === 0) {
      await tx.rollback();
      return 0;
    }

    const shares = pending.map((value) =>
      Math.floor((value * movable) / totalPending),
    );
    // Flooring loses up to a centavo per bucket. Hand each one back to the
    // biggest bucket that still has room, so the parts add up to exactly what
    // left the global pot and no bucket is credited more than it is owed.
    let remainder = movable - shares.reduce((sum, share) => sum + share, 0);
    for (let index = 0; remainder > 0 && index < shares.length; index += 1) {
      const room = pending[index] - shares[index];
      const give = Math.min(room, remainder);
      shares[index] += give;
      remainder -= give;
    }

    const now = new Date().toISOString();
    let globalAfter = Number(wallet.global_centavos);
    for (const [index, row] of buckets.entries()) {
      const share = shares[index];
      if (share <= 0) continue;
      const businessId = String(row.business_id);
      globalAfter -= share;
      const bucketAfter = Number(row.bucket_centavos) + share;
      const metadata = JSON.stringify({
        businessId,
        movedCentavos: share,
        owedCentavos: pending[index],
        reason: "partner_bucket_backfill",
      });

      await run(
        tx,
        `INSERT OR IGNORE INTO reward_business_balances
         (id, wallet_id, business_id, balance_centavos, lifetime_earned_centavos, lifetime_transferred_centavos, created_at, updated_at)
         VALUES ('rbb_' || lower(hex(randomblob(8))), ?, ?, 0, 0, 0, ?, ?)`,
        [walletId, businessId, now, now],
      );
      // lifetime_earned_centavos is what the next run measures the remaining
      // debt against, so it has to move by exactly the same amount.
      await run(
        tx,
        `UPDATE reward_business_balances
         SET balance_centavos = balance_centavos + ?,
             lifetime_earned_centavos = lifetime_earned_centavos + ?,
             updated_at = ?
         WHERE wallet_id = ? AND business_id = ?`,
        [share, share, now, walletId, businessId],
      );
      // Two rows for one movement, the same shape a transfer writes: business_id
      // marks the entry that refers to a bucket and is null for the global pot.
      await run(
        tx,
        `INSERT INTO reward_ledger_entries
         (id, wallet_id, type, delta_centavos, balance_after_centavos, source_type, source_id, metadata, created_at)
         VALUES ('rled_' || lower(hex(randomblob(8))), ?, 'backfill_out', ?, ?, 'partner_bucket_backfill', ?, ?, ?)`,
        [walletId, -share, globalAfter, walletId, metadata, now],
      );
      await run(
        tx,
        `INSERT INTO reward_ledger_entries
         (id, wallet_id, type, delta_centavos, balance_after_centavos, source_type, source_id, business_id, metadata, created_at)
         VALUES ('rled_' || lower(hex(randomblob(8))), ?, 'backfill_in', ?, ?, 'partner_bucket_backfill', ?, ?, ?, ?)`,
        [walletId, share, bucketAfter, walletId, businessId, metadata, now],
      );
    }

    // Guarded, so a balance that moved under us leaves the wallet untouched and
    // the transaction rolls back rather than overdrawing it.
    const debited = await run(
      tx,
      `UPDATE reward_wallets
       SET balance_centavos = balance_centavos - ?, updated_at = ?
       WHERE id = ? AND balance_centavos >= ?`,
      [movable, now, walletId, movable],
    );
    if (debited !== 1) {
      await tx.rollback();
      return 0;
    }

    await tx.commit();
    return movable;
  } catch (error) {
    try {
      await tx.rollback();
    } catch {
      // Ignore rollback failure; the original error is the useful one.
    }
    throw error;
  }
}

/**
 * Runs the partner bucket backfill on demand.
 *
 * `force` ignores the completion flag, which is what a manual re-run after a
 * restore needs. It is safe on a database that has already been migrated: the
 * debt each bucket is owed is recomputed from the ledger, and there is none
 * left to pay.
 */
export async function backfillPartnerLoyaltyBuckets({ force = false } = {}) {
  await ensureReady();
  return runPartnerBucketBackfill(rawClient(), force);
}

/**
 * Brings already-deployed databases up to the current sign-in schema without a
 * destructive version bump.
 *
 * `attempts` is what makes a six-digit OTP safe: without it a challenge stays
 * guessable for its full five-minute life, and 10^6 is not a large number when
 * the only other brake is a per-address limiter.
 */
async function ensureAuthSchema(c: Client) {
  const authColumnAdds: Array<[string, string, string]> = [
    ["otp_challenges", "attempts", "INTEGER NOT NULL DEFAULT 0"],
    ["customer_tokens", "last_used_at", "TEXT"],
  ];
  for (const [table, column, definition] of authColumnAdds) {
    if (!(await hasColumn(c, table, column))) {
      await c.execute(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }
}

// Adds the SMPP delivery-receipt columns to already-deployed databases without a
// destructive schema-version bump. Also indexes provider_message_id, which DLR
// handling looks up on every inbound deliver_sm.
async function ensureSmsSchema(c: Client) {
  const smsColumnAdds: Array<[string, string, string]> = [
    ["sms_logs", "delivery_status", "TEXT"],
    ["sms_logs", "delivery_error", "TEXT"],
    ["sms_logs", "delivery_receipt", "TEXT"],
    ["sms_logs", "delivered_at", "TEXT"],
    // Campaign directory location (added without a destructive schema-version bump).
    ["campaigns", "location", "TEXT"],
    // Venue details shown on the campaign page. They belong to the business, not
    // the campaign: one venue runs many campaigns, and copying the address onto
    // each one guarantees they drift apart.
    ["businesses", "address", "TEXT"],
    ["businesses", "contact_number", "TEXT"],
    // Pin dropped on the map in the dashboard. Kept alongside the written
    // address rather than replacing it: the address is what a customer reads,
    // the coordinates are what a map link should actually open.
    ["businesses", "latitude", "REAL"],
    ["businesses", "longitude", "REAL"]
  ];
  for (const [table, column, definition] of smsColumnAdds) {
    if (!(await hasColumn(c, table, column))) {
      await c.execute(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }
  await c.execute("CREATE INDEX IF NOT EXISTS idx_sms_logs_provider_message_id ON sms_logs (provider_message_id)");

  // Backfill locations for seed campaigns that predate the location column.
  // Idempotent (only fills NULLs) and scoped to seed ids, so admin-created
  // campaigns are untouched.
  for (const campaign of seedData.campaigns) {
    if (campaign.location) {
      await c.execute({
        sql: "UPDATE campaigns SET location = ? WHERE id = ? AND location IS NULL",
        args: [campaign.location, campaign.id]
      });
    }
  }

  // Migrate only the original demo copy from the retired date-first journey.
  // The exact-message guard preserves any copy an admin has customized.
  const demoOfferCopyUpdates = [
    {
      id: "camp_july_dinner",
      previous: "Pick your visit window first, then hunt for one final dining voucher.",
      next: "Hunt for your dining voucher first, then choose your visit date and time.",
    },
    {
      id: "camp_8pm_drop",
      previous: "Choose the drop window, reveal candidates, and keep one checkout code.",
      next: "Hunt for your checkout reward first, then choose an available drop window.",
    },
    {
      id: "camp_glow_facial",
      previous: "Book your facial appointment first, then hunt for one skincare voucher.",
      next: "Hunt for your skincare voucher first, then choose your appointment date and time.",
    },
  ];
  for (const copy of demoOfferCopyUpdates) {
    await c.execute({
      sql: "UPDATE campaigns SET offer_message = ? WHERE id = ? AND offer_message = ?",
      args: [copy.next, copy.id, copy.previous],
    });
  }
}

/** Returns the ready libSQL client (schema created + seeded on first use). */
export async function getDb(): Promise<Client> {
  await ensureReady();
  return rawClient();
}

/** Runs a callback inside a write transaction, committing on success and rolling back on error. */
export async function withTx<T>(fn: (tx: Transaction) => Promise<T>): Promise<T> {
  await ensureReady();
  const tx = await rawClient().transaction("write");
  try {
    const result = await fn(tx);
    await tx.commit();
    return result;
  } catch (error) {
    try {
      await tx.rollback();
    } catch {
      // Ignore rollback failure; the original error is the useful one.
    }
    throw error;
  }
}

/** Query helpers usable with either the pooled client or an open transaction. */
export async function all(db: Exec, sql: string, args?: InArgs): Promise<Row[]> {
  const rs = await db.execute(args === undefined ? sql : { sql, args });
  return rs.rows as Row[];
}

export async function one(db: Exec, sql: string, args?: InArgs): Promise<Row | undefined> {
  const rs = await db.execute(args === undefined ? sql : { sql, args });
  return rs.rows[0];
}

/** Runs a write statement and returns the number of affected rows. */
export async function run(db: Exec, sql: string, args?: InArgs): Promise<number> {
  const rs = await db.execute(args === undefined ? sql : { sql, args });
  return rs.rowsAffected;
}

/**
 * Reads several independent result sets in a single round trip.
 *
 * Against remote libSQL every `execute` is a network round trip, so a page that
 * needs five unrelated rollups pays five latencies before it can render. `batch`
 * pays one. Read-only: use `withTx` when statements have to see each other.
 */
export async function batchAll(
  client: Client,
  statements: { sql: string; args?: InArgs }[],
): Promise<Row[][]> {
  const results = await client.batch(
    statements.map((statement) =>
      statement.args === undefined
        ? statement.sql
        : { sql: statement.sql, args: statement.args },
    ) as InStatement[],
    "read",
  );
  return results.map((result) => result.rows as Row[]);
}


/** Seed data. Also used to (re)populate the database for local dev and tests. */
export const seedData: {
  businesses: Array<Business & { depositCentavos: number }>;
  campaigns: Campaign[];
  slots: CampaignSlot[];
  pools: VoucherPool[];
  poolSlots: Array<{ poolId: string; slotId: string }>;
  rewardProducts: Array<{
    id: string;
    businessId: string;
    name: string;
    description: string;
    imageUrl: string;
    priceCentavos: number;
  }>;
  users: Array<{
    id: string;
    campaignId: string;
    name: string;
    phone: string;
    email: string;
    sessionId: string;
  }>;
  rewardWallets: Array<{
    id: string;
    phone: string;
    name: string;
    email: string;
    walletToken: string;
    walletSecret: string;
    balanceCentavos: number;
  }>;
} = {
  // Venue details are seeded, not left blank: they are what the campaign page
  // shows a customer, so a fresh reset that omits them makes the venue section
  // look broken rather than empty.
  //
  // The pin matters as well as the address — `mapsLink` prefers coordinates, and
  // without them a reset left every demo venue on "No pin set". The restaurant
  // and shop pins are what Google's geocoder returns for their addresses; the
  // clinic's is the Zuellig Building itself.
  businesses: [
    {
      id: "biz_demo_restaurant",
      name: "Mesa Manila Test Kitchen",
      logoText: "MM",
      industry: "restaurant",
      // The PHP 5,000 network minimum, so a fresh demo starts fundable.
      depositCentavos: 5_000_00,
      address: "229 Nicanor Garcia St, Makati City, 1209 Metro Manila, Philippines",
      contactNumber: "09161234567",
      latitude: 14.563857,
      longitude: 121.022589
    },
    {
      id: "biz_demo_shop",
      name: "SariSari Studio",
      logoText: "SS",
      industry: "online_shop",
      depositCentavos: 8_000_00,
      address: "1631 31st Street, Makati City, Metro Manila, Philippines",
      contactNumber: "09789632563",
      // BGC, not the short 31st Street near Pitogo that the Makati-suffixed
      // address suggests. This is where Google's geocoder actually resolves it.
      latitude: 14.552533,
      longitude: 121.050599
    },
    {
      id: "biz_demo_clinic",
      name: "Glow Lab Skin Clinic",
      logoText: "GL",
      industry: "beauty",
      depositCentavos: 5_000_00,
      address: "1 Zuellig Loop, Makati City, Metro Manila, Philippines",
      contactNumber: "09471234567",
      latitude: 14.557839,
      longitude: 121.0266
    }
  ],
  campaigns: [
    {
      id: "camp_july_dinner",
      businessId: "biz_demo_restaurant",
      slug: "july-dinner",
      title: "July Dinner",
      location: "Makati City",
      offerMessage: "Hunt for your dining voucher first, then choose your visit date and time.",
      heroImage:
        "linear-gradient(135deg, rgba(21,72,87,.9), rgba(229,90,54,.76)), url('https://images.unsplash.com/photo-1559339352-11d035aa65de?auto=format&fit=crop&w=1600&q=80')",
      mode: "restaurant",
      status: "active",
      startDate: "2026-07-01",
      endDate: "2026-07-31",
      baseAttempts: 3,
      referralDailyLimit: 5,
      candidateTimeoutMinutes: 10,
      terms: "Valid for selected slot only. Minimum spend applies. One final voucher per phone number.",
      allowReschedule: true
    },
    {
      id: "camp_8pm_drop",
      businessId: "biz_demo_shop",
      slug: "8pm-drop",
      title: "8PM Shopping",
      location: "Online · Nationwide",
      offerMessage: "Hunt for your checkout reward first, then choose an available drop window.",
      heroImage:
        "linear-gradient(135deg, rgba(29,44,74,.9), rgba(38,142,125,.72)), url('https://images.unsplash.com/photo-1607082350899-7e105aa886ae?auto=format&fit=crop&w=1600&q=80')",
      mode: "online_shop",
      status: "active",
      startDate: "2026-07-01",
      endDate: "2026-07-31",
      baseAttempts: 3,
      referralDailyLimit: 5,
      candidateTimeoutMinutes: 10,
      terms: "Valid within the selected drop window or stated expiry. One code per phone number.",
      shopUrl: "https://example.com/shop",
      allowReschedule: false
    },
    {
      id: "camp_glow_facial",
      businessId: "biz_demo_clinic",
      slug: "glow-facial",
      title: "Glow Facial Week",
      location: "BGC, Taguig",
      offerMessage: "Hunt for your skincare voucher first, then choose your appointment date and time.",
      heroImage:
        "linear-gradient(135deg, rgba(120,52,110,.9), rgba(233,120,150,.72)), url('https://images.unsplash.com/photo-1570172619644-dfd03ed5d881?auto=format&fit=crop&w=1600&q=80')",
      // Appointment-based flow: same reservation mechanics as a restaurant slot.
      mode: "restaurant",
      status: "active",
      startDate: "2026-07-01",
      endDate: "2026-07-31",
      baseAttempts: 3,
      referralDailyLimit: 5,
      candidateTimeoutMinutes: 10,
      terms: "Valid for the selected appointment only. Non-transferable. One voucher per phone number.",
      allowReschedule: true
    }
  ],
  slots: [
    // Restaurant: a 2pm off-peak lunch window plus busier dinner windows.
    { id: "slot_dinner_0705_1400", campaignId: "camp_july_dinner", date: "2026-07-05", startTime: "14:00", endTime: "16:00", timezone: "Asia/Manila", totalCapacity: 6, remainingCapacity: 6, status: "active" },
    { id: "slot_dinner_0705_1900", campaignId: "camp_july_dinner", date: "2026-07-05", startTime: "19:00", endTime: "21:00", timezone: "Asia/Manila", totalCapacity: 20, remainingCapacity: 20, status: "active" },
    { id: "slot_dinner_0705_2000", campaignId: "camp_july_dinner", date: "2026-07-05", startTime: "20:00", endTime: "22:00", timezone: "Asia/Manila", totalCapacity: 2, remainingCapacity: 2, status: "active" },
    { id: "slot_dinner_0706_1400", campaignId: "camp_july_dinner", date: "2026-07-06", startTime: "14:00", endTime: "16:00", timezone: "Asia/Manila", totalCapacity: 6, remainingCapacity: 6, status: "active" },
    { id: "slot_dinner_0706_1900", campaignId: "camp_july_dinner", date: "2026-07-06", startTime: "19:00", endTime: "21:00", timezone: "Asia/Manila", totalCapacity: 12, remainingCapacity: 0, status: "sold_out" },
    { id: "slot_dinner_0707_1900", campaignId: "camp_july_dinner", date: "2026-07-07", startTime: "19:00", endTime: "21:00", timezone: "Asia/Manila", totalCapacity: 18, remainingCapacity: 18, status: "active" },
    // Online shop: two evening drops plus a 10am off-peak morning drop.
    { id: "slot_shop_0705_2000", campaignId: "camp_8pm_drop", date: "2026-07-05", startTime: "20:00", endTime: "22:00", timezone: "Asia/Manila", totalCapacity: 100, remainingCapacity: 100, status: "active" },
    { id: "slot_shop_0706_2200", campaignId: "camp_8pm_drop", date: "2026-07-06", startTime: "22:00", endTime: "23:59", timezone: "Asia/Manila", totalCapacity: 75, remainingCapacity: 75, status: "active" },
    { id: "slot_shop_0707_1000", campaignId: "camp_8pm_drop", date: "2026-07-07", startTime: "10:00", endTime: "12:00", timezone: "Asia/Manila", totalCapacity: 50, remainingCapacity: 50, status: "active" },
    // Beauty clinic: hourly appointment windows across three days.
    { id: "slot_glow_0708_1000", campaignId: "camp_glow_facial", date: "2026-07-08", startTime: "10:00", endTime: "11:00", timezone: "Asia/Manila", totalCapacity: 4, remainingCapacity: 4, status: "active" },
    { id: "slot_glow_0708_1400", campaignId: "camp_glow_facial", date: "2026-07-08", startTime: "14:00", endTime: "15:00", timezone: "Asia/Manila", totalCapacity: 4, remainingCapacity: 4, status: "active" },
    { id: "slot_glow_0709_1000", campaignId: "camp_glow_facial", date: "2026-07-09", startTime: "10:00", endTime: "11:00", timezone: "Asia/Manila", totalCapacity: 5, remainingCapacity: 5, status: "active" },
    { id: "slot_glow_0709_1600", campaignId: "camp_glow_facial", date: "2026-07-09", startTime: "16:00", endTime: "17:00", timezone: "Asia/Manila", totalCapacity: 3, remainingCapacity: 3, status: "active" },
    { id: "slot_glow_0710_1100", campaignId: "camp_glow_facial", date: "2026-07-10", startTime: "11:00", endTime: "12:00", timezone: "Asia/Manila", totalCapacity: 6, remainingCapacity: 6, status: "active" }
  ],
  pools: [
    // Restaurant: campaign-wide benefit tiers. Rarer tiers have less stock.
    { id: "pool_dinner_90", campaignId: "camp_july_dinner", benefitType: "discount_percent", benefitValue: "90", displayLabel: "90% OFF", totalQuantity: 2, remainingQuantity: 2, probabilityWeight: 1, rarity: "legendary", minimumSpend: 1500, status: "active" },
    { id: "pool_dinner_50", campaignId: "camp_july_dinner", benefitType: "discount_percent", benefitValue: "50", displayLabel: "50% OFF", totalQuantity: 6, remainingQuantity: 6, probabilityWeight: 5, rarity: "epic", minimumSpend: 1200, status: "active" },
    { id: "pool_dinner_30", campaignId: "camp_july_dinner", benefitType: "discount_percent", benefitValue: "30", displayLabel: "30% OFF", totalQuantity: 15, remainingQuantity: 15, probabilityWeight: 15, rarity: "rare", minimumSpend: 900, status: "active" },
    { id: "pool_dinner_20", campaignId: "camp_july_dinner", benefitType: "discount_percent", benefitValue: "20", displayLabel: "20% OFF", totalQuantity: 60, remainingQuantity: 60, probabilityWeight: 50, rarity: "standard", minimumSpend: 800, status: "active" },
    { id: "pool_dinner_dessert", campaignId: "camp_july_dinner", benefitType: "free_item", benefitValue: "dessert", displayLabel: "Free Dessert", totalQuantity: 40, remainingQuantity: 40, probabilityWeight: 15, rarity: "rare", minimumSpend: 500, status: "active" },

    // Online shop: campaign-wide benefit tiers.
    { id: "pool_shop_90", campaignId: "camp_8pm_drop", benefitType: "discount_percent", benefitValue: "90", displayLabel: "90% OFF", totalQuantity: 2, remainingQuantity: 2, probabilityWeight: 1, rarity: "legendary", minimumSpend: 2000, status: "active" },
    { id: "pool_shop_50", campaignId: "camp_8pm_drop", benefitType: "discount_percent", benefitValue: "50", displayLabel: "50% OFF", totalQuantity: 9, remainingQuantity: 9, probabilityWeight: 5, rarity: "epic", minimumSpend: 1500, status: "active" },
    { id: "pool_shop_20", campaignId: "camp_8pm_drop", benefitType: "discount_percent", benefitValue: "20", displayLabel: "20% OFF", totalQuantity: 85, remainingQuantity: 85, probabilityWeight: 50, rarity: "standard", minimumSpend: 1000, status: "active" },
    { id: "pool_shop_10", campaignId: "camp_8pm_drop", benefitType: "discount_percent", benefitValue: "10", displayLabel: "10% OFF", totalQuantity: 24, remainingQuantity: 24, probabilityWeight: 50, rarity: "standard", minimumSpend: 500, status: "active" },
    { id: "pool_shop_ship", campaignId: "camp_8pm_drop", benefitType: "free_shipping", benefitValue: "free_shipping", displayLabel: "Free Shipping", totalQuantity: 55, remainingQuantity: 55, probabilityWeight: 50, rarity: "standard", status: "active" },

    // Beauty clinic: campaign-wide skincare benefit tiers.
    { id: "pool_glow_70", campaignId: "camp_glow_facial", benefitType: "discount_percent", benefitValue: "70", displayLabel: "70% OFF Facial", totalQuantity: 2, remainingQuantity: 2, probabilityWeight: 1, rarity: "legendary", minimumSpend: 1500, status: "active" },
    { id: "pool_glow_50", campaignId: "camp_glow_facial", benefitType: "discount_percent", benefitValue: "50", displayLabel: "50% OFF", totalQuantity: 6, remainingQuantity: 6, probabilityWeight: 5, rarity: "epic", minimumSpend: 1200, status: "active" },
    { id: "pool_glow_30", campaignId: "camp_glow_facial", benefitType: "discount_percent", benefitValue: "30", displayLabel: "30% OFF", totalQuantity: 15, remainingQuantity: 15, probabilityWeight: 15, rarity: "rare", minimumSpend: 800, status: "active" },
    { id: "pool_glow_20", campaignId: "camp_glow_facial", benefitType: "discount_percent", benefitValue: "20", displayLabel: "20% OFF", totalQuantity: 40, remainingQuantity: 40, probabilityWeight: 50, rarity: "standard", minimumSpend: 600, status: "active" },
    { id: "pool_glow_addon", campaignId: "camp_glow_facial", benefitType: "free_item", benefitValue: "add_on", displayLabel: "Free Add-on Treatment", totalQuantity: 25, remainingQuantity: 25, probabilityWeight: 15, rarity: "rare", minimumSpend: 500, status: "active" }
  ],
  // Which slots each benefit tier is offered at. Rarer/higher tiers map to
  // fewer (off-peak) slots; common tiers are available everywhere.
  poolSlots: [
    // 90% OFF: 2pm off-peak only
    { poolId: "pool_dinner_90", slotId: "slot_dinner_0705_1400" },
    // 50% OFF: off-peak lunch windows
    { poolId: "pool_dinner_50", slotId: "slot_dinner_0705_1400" },
    { poolId: "pool_dinner_50", slotId: "slot_dinner_0706_1400" },
    // 30% OFF: lunch + a couple of dinner windows
    { poolId: "pool_dinner_30", slotId: "slot_dinner_0705_1400" },
    { poolId: "pool_dinner_30", slotId: "slot_dinner_0706_1400" },
    { poolId: "pool_dinner_30", slotId: "slot_dinner_0705_1900" },
    { poolId: "pool_dinner_30", slotId: "slot_dinner_0707_1900" },
    // 20% OFF: every slot
    { poolId: "pool_dinner_20", slotId: "slot_dinner_0705_1400" },
    { poolId: "pool_dinner_20", slotId: "slot_dinner_0705_1900" },
    { poolId: "pool_dinner_20", slotId: "slot_dinner_0705_2000" },
    { poolId: "pool_dinner_20", slotId: "slot_dinner_0706_1400" },
    { poolId: "pool_dinner_20", slotId: "slot_dinner_0706_1900" },
    { poolId: "pool_dinner_20", slotId: "slot_dinner_0707_1900" },
    // Free Dessert: dinner windows
    { poolId: "pool_dinner_dessert", slotId: "slot_dinner_0705_1900" },
    { poolId: "pool_dinner_dessert", slotId: "slot_dinner_0705_2000" },
    { poolId: "pool_dinner_dessert", slotId: "slot_dinner_0706_1900" },
    { poolId: "pool_dinner_dessert", slotId: "slot_dinner_0707_1900" },

    // Shop: 90% at the 10am off-peak drop only
    { poolId: "pool_shop_90", slotId: "slot_shop_0707_1000" },
    { poolId: "pool_shop_50", slotId: "slot_shop_0707_1000" },
    { poolId: "pool_shop_50", slotId: "slot_shop_0706_2200" },
    { poolId: "pool_shop_20", slotId: "slot_shop_0705_2000" },
    { poolId: "pool_shop_20", slotId: "slot_shop_0706_2200" },
    { poolId: "pool_shop_20", slotId: "slot_shop_0707_1000" },
    { poolId: "pool_shop_10", slotId: "slot_shop_0705_2000" },
    { poolId: "pool_shop_10", slotId: "slot_shop_0706_2200" },
    { poolId: "pool_shop_10", slotId: "slot_shop_0707_1000" },
    { poolId: "pool_shop_ship", slotId: "slot_shop_0705_2000" },
    { poolId: "pool_shop_ship", slotId: "slot_shop_0706_2200" },
    { poolId: "pool_shop_ship", slotId: "slot_shop_0707_1000" },

    // Clinic: 70% at a single off-peak morning slot; commoner tiers spread wider.
    { poolId: "pool_glow_70", slotId: "slot_glow_0708_1000" },
    { poolId: "pool_glow_50", slotId: "slot_glow_0708_1000" },
    { poolId: "pool_glow_50", slotId: "slot_glow_0709_1000" },
    { poolId: "pool_glow_30", slotId: "slot_glow_0708_1000" },
    { poolId: "pool_glow_30", slotId: "slot_glow_0708_1400" },
    { poolId: "pool_glow_30", slotId: "slot_glow_0709_1000" },
    { poolId: "pool_glow_30", slotId: "slot_glow_0710_1100" },
    // 20% OFF: every appointment slot
    { poolId: "pool_glow_20", slotId: "slot_glow_0708_1000" },
    { poolId: "pool_glow_20", slotId: "slot_glow_0708_1400" },
    { poolId: "pool_glow_20", slotId: "slot_glow_0709_1000" },
    { poolId: "pool_glow_20", slotId: "slot_glow_0709_1600" },
    { poolId: "pool_glow_20", slotId: "slot_glow_0710_1100" },
    // Free Add-on: afternoon windows
    { poolId: "pool_glow_addon", slotId: "slot_glow_0708_1400" },
    { poolId: "pool_glow_addon", slotId: "slot_glow_0709_1600" },
    { poolId: "pool_glow_addon", slotId: "slot_glow_0710_1100" }
  ],

  // Priced in LP hundredths, matching every other reward amount: 500_00 is
  // 500 LP, which settles as PHP 500 owed to the partner. Deliberately spread
  // around the 50 LP conversion floor so a tester can exercise an affordable
  // item and an out-of-reach one without editing data.
  rewardProducts: [
    {
      id: "rprod_demo_dessert",
      businessId: "biz_demo_restaurant",
      name: "Signature Leche Flan",
      description: "House dessert, redeemable at the counter with your LP voucher.",
      imageUrl: "/images/rewards/signature-leche-flan.png",
      priceCentavos: 150_00
    },
    {
      id: "rprod_demo_rice_bowl",
      businessId: "biz_demo_restaurant",
      name: "Adobo Rice Bowl",
      description: "Full lunch portion with egg and atchara.",
      imageUrl: "/images/rewards/adobo-rice-bowl.png",
      priceCentavos: 500_00
    },
    {
      id: "rprod_demo_tote",
      businessId: "biz_demo_shop",
      name: "SariSari Canvas Tote",
      description: "Screen-printed tote, collected in store or shipped free.",
      imageUrl: "/images/rewards/sarisari-canvas-tote.png",
      priceCentavos: 750_00
    },
    {
      id: "rprod_demo_facial",
      businessId: "biz_demo_clinic",
      name: "Express Glow Facial",
      description: "30-minute express facial with a licensed aesthetician.",
      imageUrl: "/images/rewards/express-glow-facial.png",
      priceCentavos: 1_200_00
    }
  ],
  // One demo customer, so Users, the customer detail page, and the Loyalty
  // Points screens render something on a fresh install instead of reading as
  // broken. Attached to the restaurant campaign because that is the business a
  // seeded staff login is scoped to, which keeps the row visible to both roles.
  users: [
    {
      id: "user_demo_customer",
      campaignId: "camp_july_dinner",
      name: "Ana Dela Cruz",
      // Stored normalized (+63...), the same shape normalizePhone produces; the
      // dashboard renders it back as 09... for display.
      phone: "+639171234500",
      email: "ana.delacruz@example.com",
      sessionId: "sess_demo_customer"
    }
  ],
  rewardWallets: [
    {
      id: "rwal_demo_customer",
      phone: "+639171234500",
      name: "Ana Dela Cruz",
      email: "ana.delacruz@example.com",
      walletToken: "rwallet_demo_customer",
      walletSecret: "rwsecret_demo_customer",
      balanceCentavos: 250_00
    }
  ]
};

async function hasCompleteSeed(c: Client) {
  const groups: Array<[string, Array<{ id: string }>]> = [
    ["businesses", seedData.businesses],
    ["campaigns", seedData.campaigns],
    ["slots", seedData.slots],
    ["pools", seedData.pools],
    ["reward_products", seedData.rewardProducts],
  ];

  for (const [table, rows] of groups) {
    if (rows.length === 0) continue;
    const result = await c.execute({
      sql: `SELECT COUNT(*) AS count FROM ${table} WHERE id IN (${rows.map(() => "?").join(",")})`,
      args: rows.map((row) => row.id),
    });
    if (Number((result.rows[0] as Row).count) !== rows.length) return false;
  }

  // pool_slots has a composite key (no id), so verify each seed pair explicitly.
  // Without this, a DB that has the pools/slots but is missing their tier→slot
  // mappings looks "complete" and never gets re-seeded, leaving campaigns with
  // no selectable time slots.
  if (seedData.poolSlots.length > 0) {
    const where = seedData.poolSlots.map(() => "(pool_id = ? AND slot_id = ?)").join(" OR ");
    const result = await c.execute({
      sql: `SELECT COUNT(*) AS count FROM pool_slots WHERE ${where}`,
      args: seedData.poolSlots.flatMap((p) => [p.poolId, p.slotId]),
    });
    if (Number((result.rows[0] as Row).count) !== seedData.poolSlots.length) return false;
  }

  return true;
}

/**
 * Adds bundled artwork to demo products created before product photography was
 * introduced. A partner-provided image always wins: only blank URLs are filled.
 */
async function ensureSeededRewardProductImages(c: Client) {
  const now = new Date().toISOString();
  await c.batch(
    seedData.rewardProducts.map((product) => ({
      sql: `UPDATE reward_products
            SET image_url = ?, updated_at = ?
            WHERE id = ? AND (image_url IS NULL OR trim(image_url) = '')`,
      args: [product.imageUrl, now, product.id],
    })),
    "write",
  );
}

const INSERT_BUSINESS =
  `INSERT OR IGNORE INTO businesses (id, name, logo_text, industry, address, contact_number, latitude, longitude, deposit_balance_centavos)
     VALUES (@id, @name, @logoText, @industry, @address, @contactNumber, @latitude, @longitude, @depositCentavos)`;
const INSERT_DEPOSIT_ENTRY = `INSERT OR IGNORE INTO business_deposit_entries (id, business_id, type, amount_centavos, balance_after_centavos, reference, note, recorded_by, statement_id, created_at)
     VALUES (@id, @businessId, 'TopUp', @amountCentavos, @amountCentavos, @reference, @note, 'Seed', NULL, @createdAt)`;
const INSERT_REWARD_PRODUCT = `INSERT OR IGNORE INTO reward_products (id, business_id, name, description, image_url, price_centavos, status, created_at, updated_at)
     VALUES (@id, @businessId, @name, @description, @imageUrl, @priceCentavos, 'Active', @createdAt, @createdAt)`;
const INSERT_CAMPAIGN = `INSERT OR IGNORE INTO campaigns (id, business_id, slug, title, offer_message, hero_image, mode, location, status, start_date, end_date, base_attempts, referral_daily_limit, candidate_timeout_minutes, terms, shop_url, allow_reschedule)
     VALUES (@id, @businessId, @slug, @title, @offerMessage, @heroImage, @mode, @location, @status, @startDate, @endDate, @baseAttempts, @referralDailyLimit, @candidateTimeoutMinutes, @terms, @shopUrl, @allowReschedule)`;
const INSERT_SLOT = `INSERT OR IGNORE INTO slots (id, campaign_id, date, start_time, end_time, timezone, branch_id, total_capacity, remaining_capacity, status)
     VALUES (@id, @campaignId, @date, @startTime, @endTime, @timezone, @branchId, @totalCapacity, @remainingCapacity, @status)`;
const INSERT_POOL = `INSERT OR IGNORE INTO pools (id, campaign_id, benefit_type, benefit_value, display_label, total_quantity, remaining_quantity, rarity, probability_weight, minimum_spend, status, restriction)
     VALUES (@id, @campaignId, @benefitType, @benefitValue, @displayLabel, @totalQuantity, @remainingQuantity, @rarity, @probabilityWeight, @minimumSpend, @status, @restriction)`;
const INSERT_POOL_SLOT = "INSERT OR IGNORE INTO pool_slots (pool_id, slot_id) VALUES (@poolId, @slotId)";
const INSERT_USER = `INSERT OR IGNORE INTO users (id, campaign_id, name, phone, email, session_id, created_at)
     VALUES (@id, @campaignId, @name, @phone, @email, @sessionId, @createdAt)`;
const INSERT_REWARD_WALLET = `INSERT OR IGNORE INTO reward_wallets (id, phone, name, email, wallet_token, wallet_secret, balance_centavos, lifetime_earned_centavos, lifetime_converted_centavos, status, created_at, updated_at)
     VALUES (@id, @phone, @name, @email, @walletToken, @walletSecret, @balanceCentavos, @balanceCentavos, 0, 'Active', @createdAt, @createdAt)`;
// The opening balance is also a ledger row, so the wallet reconciles against a
// movement rather than appearing from nowhere — same reasoning as the business
// opening deposit. `dev_grant` is deliberate: the balance was not earned at a
// business, so it must not surface as LP the network owes anyone.
const INSERT_REWARD_LEDGER_ENTRY = `INSERT OR IGNORE INTO reward_ledger_entries (id, wallet_id, type, delta_centavos, balance_after_centavos, source_type, source_id, metadata, created_at)
     VALUES (@id, @walletId, 'dev_grant', @amountCentavos, @amountCentavos, 'dev_tool', NULL, @metadata, @createdAt)`;

/**
 * The demo customer's rows, shared by the initial seed and the self-heal on
 * boot. Kept separate from `seed()` so a database that was seeded before this
 * fixture existed still picks the customer up without a destructive reset.
 */
function demoCustomerStatements(): InStatement[] {
  // Tests reset to a genuinely empty database and assert on it — "lists nobody
  // before anyone hunts" is a real guarantee, not a fixture artifact. Seeding a
  // customer there would force those assertions to expect a ghost.
  if (process.env.NODE_ENV === "test") return [];

  const now = new Date().toISOString();
  return [
    ...seedData.users.map((r) => ({
      sql: INSERT_USER,
      args: {
        id: r.id,
        campaignId: r.campaignId,
        name: r.name,
        phone: r.phone,
        email: r.email,
        sessionId: r.sessionId,
        createdAt: now
      }
    })),
    ...seedData.rewardWallets.map((r) => ({
      sql: INSERT_REWARD_WALLET,
      args: {
        id: r.id,
        phone: r.phone,
        name: r.name,
        email: r.email,
        walletToken: r.walletToken,
        walletSecret: r.walletSecret,
        balanceCentavos: r.balanceCentavos,
        createdAt: now
      }
    })),
    ...seedData.rewardWallets.map((r) => ({
      sql: INSERT_REWARD_LEDGER_ENTRY,
      args: {
        id: `rled_seed_${r.id}`,
        walletId: r.id,
        amountCentavos: r.balanceCentavos,
        metadata: JSON.stringify({ note: "Seed opening balance" }),
        createdAt: now
      }
    }))
  ];
}

/**
 * Seeds demo data as a single atomic batch. `client.batch(..., "write")` runs
 * every statement in one implicit transaction over a single network round-trip,
 * which is far more reliable on Turso/Hrana in serverless than an interactive
 * transaction (whose stream can drop between round-trips, leaving a partial
 * seed). Idempotent via INSERT OR IGNORE, so concurrent cold starts are safe.
 */
async function seed(c: Client) {
  const statements: InStatement[] = [
    ...seedData.businesses.map((r) => ({
      sql: INSERT_BUSINESS,
      args: {
        id: r.id,
        name: r.name,
        logoText: r.logoText,
        industry: r.industry,
        // The columns are nullable, but the driver rejects `undefined`.
        address: r.address ?? null,
        contactNumber: r.contactNumber ?? null,
        latitude: r.latitude ?? null,
        longitude: r.longitude ?? null,
        depositCentavos: r.depositCentavos
      }
    })),
    // The opening deposit is also a ledger row, so the balance shown on the
    // dashboard always reconciles against a movement rather than appearing
    // from nowhere.
    ...seedData.businesses.map((r) => ({
      sql: INSERT_DEPOSIT_ENTRY,
      args: {
        id: `bdep_seed_${r.id}`,
        businessId: r.id,
        amountCentavos: r.depositCentavos,
        reference: "SEED-OPENING",
        note: "Opening network deposit",
        createdAt: new Date().toISOString()
      }
    })),
    ...seedData.rewardProducts.map((r) => ({
      sql: INSERT_REWARD_PRODUCT,
      args: {
        id: r.id,
        businessId: r.businessId,
        name: r.name,
        description: r.description,
        imageUrl: r.imageUrl,
        priceCentavos: r.priceCentavos,
        createdAt: new Date().toISOString()
      }
    })),
    ...seedData.campaigns.map((r) => ({
      sql: INSERT_CAMPAIGN,
      args: {
        id: r.id,
        businessId: r.businessId,
        slug: r.slug,
        title: r.title,
        offerMessage: r.offerMessage,
        heroImage: r.heroImage,
        mode: r.mode,
        location: r.location ?? null,
        status: r.status,
        startDate: r.startDate,
        endDate: r.endDate,
        baseAttempts: r.baseAttempts,
        referralDailyLimit: r.referralDailyLimit,
        candidateTimeoutMinutes: r.candidateTimeoutMinutes,
        terms: r.terms,
        shopUrl: r.shopUrl ?? null,
        allowReschedule: r.allowReschedule ? 1 : 0
      }
    })),
    ...seedData.slots.map((r) => ({
      sql: INSERT_SLOT,
      args: {
        id: r.id,
        campaignId: r.campaignId,
        date: r.date,
        startTime: r.startTime,
        endTime: r.endTime,
        timezone: r.timezone,
        branchId: r.branchId ?? null,
        totalCapacity: r.totalCapacity,
        remainingCapacity: r.remainingCapacity,
        status: r.status
      }
    })),
    ...seedData.pools.map((r) => ({
      sql: INSERT_POOL,
      args: {
        id: r.id,
        campaignId: r.campaignId,
        benefitType: r.benefitType,
        benefitValue: r.benefitValue,
        displayLabel: r.displayLabel,
        totalQuantity: r.totalQuantity,
        remainingQuantity: r.remainingQuantity,
        rarity: r.rarity,
        probabilityWeight: r.probabilityWeight,
        minimumSpend: r.minimumSpend ?? null,
        status: r.status,
        restriction: r.restriction ?? null
      }
    })),
    ...seedData.poolSlots.map((r) => ({ sql: INSERT_POOL_SLOT, args: { poolId: r.poolId, slotId: r.slotId } })),
    ...demoCustomerStatements()
  ];
  await c.batch(statements, "write");
}

/**
 * Today as YYYY-MM-DD in campaign time. Slot dates are stored as plain dates in
 * Asia/Manila, so comparing them against a UTC date rolls the cutoff over eight
 * hours early and hides the current day's slots.
 */
export function manilaDateString(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function addCalendarDays(date: string, days: number) {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

/**
 * Keeps the bundled demo campaigns useful after their original fixture dates
 * pass without rewriting or deleting historical slots. Once a demo campaign
 * has no upcoming inventory, a fresh dated copy of its fixture schedule is
 * appended and the campaign window is extended. IDs include the rollover date,
 * making concurrent serverless cold starts safely idempotent.
 */
async function ensureDemoCampaignAvailability(c: Client) {
  const today = manilaDateString();

  for (const campaign of seedData.campaigns) {
    const upcoming = await c.execute({
      sql: "SELECT COUNT(*) AS count FROM slots WHERE campaign_id = ? AND date >= ?",
      args: [campaign.id, today],
    });
    if (Number((upcoming.rows[0] as Row).count) > 0) continue;

    const fixtures = seedData.slots.filter(
      (slot) => slot.campaignId === campaign.id,
    );
    if (fixtures.length === 0) continue;

    const firstFixtureDate = fixtures
      .map((slot) => slot.date)
      .sort()[0];
    const firstFixtureTime = new Date(`${firstFixtureDate}T00:00:00.000Z`).getTime();
    const rolloverKey = today.replace(/-/g, "");
    const rolledSlotIds = new Map<string, string>();
    const statements: InStatement[] = [];

    for (const fixture of fixtures) {
      const fixtureTime = new Date(`${fixture.date}T00:00:00.000Z`).getTime();
      const fixtureOffset = Math.round(
        (fixtureTime - firstFixtureTime) / 86_400_000,
      );
      const rolledId = `${fixture.id}_roll_${rolloverKey}`;
      rolledSlotIds.set(fixture.id, rolledId);
      statements.push({
        sql: INSERT_SLOT,
        args: {
          id: rolledId,
          campaignId: fixture.campaignId,
          date: addCalendarDays(today, fixtureOffset + 1),
          startTime: fixture.startTime,
          endTime: fixture.endTime,
          timezone: fixture.timezone,
          branchId: fixture.branchId ?? null,
          totalCapacity: fixture.totalCapacity,
          remainingCapacity: fixture.totalCapacity,
          status: "active",
        },
      });
    }

    for (const mapping of seedData.poolSlots) {
      const rolledSlotId = rolledSlotIds.get(mapping.slotId);
      if (!rolledSlotId) continue;
      statements.push({
        sql: INSERT_POOL_SLOT,
        args: { poolId: mapping.poolId, slotId: rolledSlotId },
      });
    }

    statements.push({
      sql: `UPDATE campaigns
            SET start_date = ?, end_date = ?
            WHERE id = ?`,
      args: [today, addCalendarDays(today, 30), campaign.id],
    });
    await c.batch(statements, "write");
  }
}

// ---- Demo seed suppression ------------------------------------------------
// `wipeDb()` empties the database and deliberately does not reseed. Nothing else
// knows that: the cold-start self-heal in `init()` treats a missing seed as
// damage and puts the fixtures straight back, and a SCHEMA_VERSION bump reseeds
// unconditionally. This flag in `meta` records "empty on purpose"; `resetDb()`
// clears it again, so the two reset actions can be run in any order.
const SEED_SUPPRESSED_KEY = "seed_suppressed";

async function seedSuppressed(c: Client) {
  const row = await one(c, "SELECT value FROM meta WHERE key = ?", [
    SEED_SUPPRESSED_KEY
  ]);
  return String(row?.value ?? "") === "1";
}

/** Wipe every table and re-seed. Used by tests and the admin reset action. */
export async function resetDb() {
  await ensureReady();
  const c = rawClient();
  await c.batch(
    DATA_TABLES.map((table) => `DELETE FROM ${table}`),
    "write"
  );
  await seed(c);
  await ensureDemoCampaignAvailability(c);
  await c.batch(
    // The reset is a new world: the one-shot bucket backfill has nothing left to
    // migrate, and its flag must not outlive the data it was set for.
    [SEED_SUPPRESSED_KEY, LP_BUCKET_BACKFILL_KEY].map((key) => ({
      sql: "DELETE FROM meta WHERE key = ?",
      args: [key]
    })),
    "write"
  );
  // Invalidate every customer sign-in: the reseed wipes the users their cookies
  // point at, so bump the epoch to force a fresh sign-in on any device.
  await bumpCustomerAuthEpoch(c);
}

/**
 * Wipe every table and leave the database empty — no demo seed.
 *
 * The counterpart to `resetDb()` for handing over a clean install: same
 * destruction, none of the fixtures. Console logins are the one exception.
 * Staff and admin accounts are scoped to businesses that no longer exist, so
 * they go with the data, but super admins are kept — they are the only accounts
 * that can create the rest, and dropping them would lock everyone out of the
 * dashboard with nothing left to sign in against.
 */
export async function wipeDb() {
  await ensureReady();
  const c = rawClient();
  await c.batch(
    [
      ...DATA_TABLES.map((table) => `DELETE FROM ${table}`),
      "DELETE FROM admin_users WHERE role <> 'super_admin'"
    ],
    "write"
  );
  // Survives restarts, so init() does not helpfully reseed what was just wiped.
  await c.execute({
    sql: "INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)",
    args: [SEED_SUPPRESSED_KEY, "1"]
  });
  // Every customer row is gone, so every customer cookie has to stop working.
  await bumpCustomerAuthEpoch(c);
}

// ---- Customer auth epoch --------------------------------------------------
// Customer "sign-in" is a phone stamped into a client cookie. There is no
// per-user server session to revoke, so revocation is done globally: the server
// holds a monotonically increasing epoch in `meta`, sign-in stamps the current
// epoch into the cookie, and the page gates reject a cookie whose epoch is stale.
// Bumping the epoch (on reset) therefore signs everyone out, everywhere.

const CUSTOMER_AUTH_EPOCH_KEY = "customer_auth_epoch";

export async function getCustomerAuthEpoch(): Promise<string> {
  const db = await getDb();
  const row = await one(db, "SELECT value FROM meta WHERE key = ?", [
    CUSTOMER_AUTH_EPOCH_KEY
  ]);
  return row ? String(row.value) : "1";
}

async function bumpCustomerAuthEpoch(c: Client) {
  const row = await one(c, "SELECT value FROM meta WHERE key = ?", [
    CUSTOMER_AUTH_EPOCH_KEY
  ]);
  const next = String(Number(row?.value ?? "1") + 1);
  await c.execute({
    sql: "INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)",
    args: [CUSTOMER_AUTH_EPOCH_KEY, next]
  });
}

// ---- Row mappers: SQLite snake_case rows -> typed camelCase domain objects ----

export const mapBusiness = (r: Row): Business => ({
  id: r.id,
  name: r.name,
  logoText: r.logo_text,
  industry: r.industry,
  address: r.address ?? undefined,
  contactNumber: r.contact_number ?? undefined,
  latitude: r.latitude ?? undefined,
  longitude: r.longitude ?? undefined
});

export const mapCampaign = (r: Row): Campaign => ({
  id: r.id,
  businessId: r.business_id,
  slug: r.slug,
  title: r.title,
  offerMessage: r.offer_message,
  heroImage: r.hero_image,
  mode: r.mode,
  location: r.location ?? undefined,
  status: r.status,
  startDate: r.start_date,
  endDate: r.end_date,
  baseAttempts: r.base_attempts,
  referralDailyLimit: r.referral_daily_limit,
  candidateTimeoutMinutes: r.candidate_timeout_minutes,
  terms: r.terms,
  shopUrl: r.shop_url ?? undefined,
  allowReschedule: Boolean(r.allow_reschedule)
});

export const mapSlot = (r: Row): CampaignSlot => ({
  id: r.id,
  campaignId: r.campaign_id,
  date: r.date,
  startTime: r.start_time,
  endTime: r.end_time,
  timezone: r.timezone,
  branchId: r.branch_id ?? undefined,
  totalCapacity: r.total_capacity,
  remainingCapacity: r.remaining_capacity,
  status: r.status
});

export const mapPool = (r: Row): VoucherPool => ({
  id: r.id,
  campaignId: r.campaign_id,
  benefitType: r.benefit_type,
  benefitValue: r.benefit_value,
  displayLabel: r.display_label,
  totalQuantity: r.total_quantity,
  remainingQuantity: r.remaining_quantity,
  rarity: r.rarity,
  probabilityWeight: r.probability_weight,
  minimumSpend: r.minimum_spend ?? undefined,
  status: r.status,
  restriction: r.restriction ?? undefined
});

export const mapUser = (r: Row): EndUser => ({
  id: r.id,
  campaignId: r.campaign_id,
  name: r.name ?? undefined,
  phone: r.phone,
  email: r.email ?? undefined,
  sessionId: r.session_id,
  createdAt: r.created_at
});

export const mapAttempt = (r: Row): VoucherAttempt => ({
  id: r.id,
  campaignId: r.campaign_id,
  slotId: r.slot_id ?? undefined,
  userId: r.user_id,
  attemptNumber: r.attempt_number,
  sourceType: r.source_type,
  benefitType: r.benefit_type,
  benefitValue: r.benefit_value,
  displayLabel: r.display_label,
  rarity: r.rarity,
  poolId: r.pool_id,
  status: r.status,
  expiresAt: r.expires_at,
  createdAt: r.created_at
});

export const mapVoucher = (r: Row): Voucher => ({
  id: r.id,
  campaignId: r.campaign_id,
  slotId: r.slot_id,
  userId: r.user_id,
  selectedAttemptId: r.selected_attempt_id,
  voucherCode: r.voucher_code,
  qrToken: r.qr_token,
  benefitType: r.benefit_type,
  benefitValue: r.benefit_value,
  displayLabel: r.display_label,
  rarity: r.rarity,
  status: r.status,
  issuedAt: r.issued_at,
  expiresAt: r.expires_at,
  redeemedAt: r.redeemed_at ?? undefined
});

export const mapReservation = (r: Row): Reservation => ({
  id: r.id,
  campaignId: r.campaign_id,
  slotId: r.slot_id,
  userId: r.user_id,
  voucherId: r.voucher_id,
  guestCount: r.guest_count ?? undefined,
  status: r.status,
  createdAt: r.created_at
});

export const mapSmsLog = (r: Row): SmsLog => ({
  id: r.id,
  campaignId: r.campaign_id,
  userId: r.user_id,
  voucherId: r.voucher_id,
  to: r.to_number,
  body: r.body,
  provider: r.provider,
  status: r.status,
  providerMessageId: r.provider_message_id ?? undefined,
  createdAt: r.created_at,
  failureReason: r.failure_reason ?? undefined,
  deliveryStatus: r.delivery_status ?? undefined,
  deliveryError: r.delivery_error ?? undefined,
  deliveryReceipt: r.delivery_receipt ?? undefined,
  deliveredAt: r.delivered_at ?? undefined
});

export const mapRedemptionLog = (r: Row): RedemptionLog => ({
  id: r.id,
  voucherId: r.voucher_id,
  staffName: r.staff_name,
  purchaseAmount: r.purchase_amount ?? undefined,
  note: r.note ?? undefined,
  createdAt: r.created_at
});

export const mapAnalyticsEvent = (r: Row): AnalyticsEvent => ({
  id: r.id,
  campaignId: r.campaign_id,
  eventName: r.event_name,
  userId: r.user_id ?? undefined,
  slotId: r.slot_id ?? undefined,
  metadata: r.metadata ? (JSON.parse(r.metadata) as Record<string, unknown>) : undefined,
  createdAt: r.created_at
});

export const mapReferralReward = (r: Row): ReferralReward => ({
  id: r.id,
  campaignId: r.campaign_id,
  referrerUserId: r.referrer_user_id,
  visitorSessionId: r.visitor_session_id,
  status: r.status,
  reason: r.reason ?? undefined,
  createdAt: r.created_at
});
