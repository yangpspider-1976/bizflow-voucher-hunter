import crypto from "node:crypto";
import { all, getDb } from "@/server/db";
import { reportAlert } from "@/server/monitoring";

/**
 * Nightly proof that the Loyalty Points system still adds up.
 *
 * Every guard in `rewards-network.ts` answers "may this request proceed?".
 * Nothing answered "is what we hold still consistent with what we recorded?" —
 * and that is the question that catches the failures worth catching: a balance
 * edited directly against the database, a settlement that quietly stopped
 * matching the redemptions behind it, an audit chain someone rewrote. None of
 * those throw. The system keeps serving requests, correctly, on wrong numbers.
 *
 * Each check below is an equality that must hold by construction. A failure is
 * therefore never "unusual activity" to be judged — it is a bug, a manual edit,
 * or tampering, and it is worth waking someone for.
 */

// ---------------------------------------------------------------------------
// The ledger
// ---------------------------------------------------------------------------

/**
 * `reward_ledger_entries.balance_after_centavos` means two different things,
 * and `business_id` is what says which.
 *
 * Points live in two places: the global pot on `reward_wallets`, and a
 * per-partner bucket on `reward_business_balances`. An entry that moves the
 * bucket records the *bucket's* balance afterwards (`credit_earned`,
 * `transfer_out`, `product_purchased`, and a partner-scoped `dev_grant`); an
 * entry that moves the global pot records the *wallet's* (`daily_app_use`,
 * `referral_bonus`, `transfer_in`, `voucher_converted`, a global `dev_grant`).
 *
 * The two sets are not separable by `type` — `dev_grant` appears in both — but
 * they are separable by `business_id`, which is set on exactly the bucket
 * entries. Reconciling against the wrong balance would alarm every night, so
 * this distinction is the load-bearing part of the two queries below.
 */
const LEDGER_TAIL_SQL = {
  /** Last global-pot entry per wallet vs the wallet's balance. */
  global: `
    SELECT w.id AS subject, w.balance_centavos AS holds, tail.balance_after_centavos AS recorded
    FROM reward_wallets w
    JOIN LATERAL (
      SELECT e.balance_after_centavos
      FROM reward_ledger_entries e
      WHERE e.wallet_id = w.id AND e.business_id IS NULL
      ORDER BY e.created_at DESC, e.id DESC
      LIMIT 1
    ) tail ON TRUE
    WHERE w.status = 'Active'
      AND tail.balance_after_centavos <> w.balance_centavos`,

  /** Last partner-bucket entry per (wallet, partner) vs that bucket's balance. */
  bucket: `
    SELECT b.wallet_id || ':' || b.business_id AS subject,
           b.balance_centavos AS holds,
           tail.balance_after_centavos AS recorded
    FROM reward_business_balances b
    JOIN reward_wallets w ON w.id = b.wallet_id
    JOIN LATERAL (
      SELECT e.balance_after_centavos
      FROM reward_ledger_entries e
      WHERE e.wallet_id = b.wallet_id AND e.business_id = b.business_id
      ORDER BY e.created_at DESC, e.id DESC
      LIMIT 1
    ) tail ON TRUE
    WHERE w.status = 'Active'
      AND tail.balance_after_centavos <> b.balance_centavos`,

  /** Last deposit movement per partner vs the deposit balance on the business. */
  deposit: `
    SELECT b.id AS subject, b.deposit_balance_centavos AS holds, tail.balance_after_centavos AS recorded
    FROM businesses b
    JOIN LATERAL (
      SELECT e.balance_after_centavos
      FROM business_deposit_entries e
      WHERE e.business_id = b.id
      ORDER BY e.seq DESC
      LIMIT 1
    ) tail ON TRUE
    WHERE tail.balance_after_centavos <> b.deposit_balance_centavos`,
} as const;

/**
 * Wallets closed by account deletion are skipped (`status = 'Active'` above).
 *
 * Deletion zeroes a balance without writing a movement, on purpose — the points
 * are forfeited, not spent, and there is no counterparty to record. Every
 * mutation path requires an Active wallet, so a deleted one is frozen and has
 * nothing left to reconcile.
 */
export type BalanceDrift = {
  check: "wallet" | "partner_bucket" | "partner_deposit";
  subject: string;
  /** What the balance column says. */
  holdsCentavos: number;
  /** What the last movement said it should be. */
  recordedCentavos: number;
  driftCentavos: number;
};

export async function reconcileBalances(): Promise<BalanceDrift[]> {
  const db = await getDb();
  const checks: Array<[BalanceDrift["check"], string]> = [
    ["wallet", LEDGER_TAIL_SQL.global],
    ["partner_bucket", LEDGER_TAIL_SQL.bucket],
    ["partner_deposit", LEDGER_TAIL_SQL.deposit],
  ];

  const drift: BalanceDrift[] = [];
  for (const [check, sql] of checks) {
    for (const row of await all(db, sql)) {
      const holdsCentavos = Number(row.holds ?? 0);
      const recordedCentavos = Number(row.recorded ?? 0);
      drift.push({
        check,
        subject: String(row.subject),
        holdsCentavos,
        recordedCentavos,
        driftCentavos: holdsCentavos - recordedCentavos,
      });
    }
  }
  return drift;
}

// ---------------------------------------------------------------------------
// Settlements
// ---------------------------------------------------------------------------

/**
 * A closed statement froze two totals: what the partner issued in LP that month
 * and what was redeemed against them. Recomputing both from the underlying rows
 * has to give the same answer forever — a month that has been closed cannot
 * legitimately gain a redemption.
 *
 * When it does not, real money is wrong: `total_amount_centavos` is what the
 * partner is paid or charged.
 */
const SETTLEMENT_SQL = `
  SELECT s.id,
         s.business_id,
         s.period,
         s.gross_amount_centavos AS recorded_redeemed,
         s.lp_issued_centavos AS recorded_issued,
         (SELECT COALESCE(SUM(r.amount_centavos), 0)
            FROM reward_voucher_redemptions r
           WHERE r.business_id = s.business_id
             AND substr(r.created_at, 1, 7) = s.period) AS actual_redeemed,
         (SELECT COALESCE(SUM(p.reward_amount_centavos), 0)
            FROM reward_purchases p
           WHERE p.business_id = s.business_id
             AND p.status = 'Accepted'
             AND substr(p.created_at, 1, 7) = s.period) AS actual_issued
    FROM reward_settlements s`;

export type SettlementDrift = {
  settlementId: string;
  businessId: string;
  period: string;
  redeemedDriftCentavos: number;
  issuedDriftCentavos: number;
};

export async function reconcileSettlements(): Promise<SettlementDrift[]> {
  const db = await getDb();
  return (await all(db, SETTLEMENT_SQL))
    .map((row) => ({
      settlementId: String(row.id),
      businessId: String(row.business_id),
      period: String(row.period),
      redeemedDriftCentavos: Number(row.actual_redeemed ?? 0) - Number(row.recorded_redeemed ?? 0),
      issuedDriftCentavos: Number(row.actual_issued ?? 0) - Number(row.recorded_issued ?? 0),
    }))
    .filter((row) => row.redeemedDriftCentavos !== 0 || row.issuedDriftCentavos !== 0);
}

// ---------------------------------------------------------------------------
// The audit chain
// ---------------------------------------------------------------------------

/**
 * `reward_audit_logs` hashes each entry's contents together with the previous
 * entry's hash. The property that buys — you cannot alter one entry without
 * every later entry disagreeing — is worth exactly nothing until something
 * checks it. Nothing did.
 *
 * Two independent failures are looked for:
 *
 *   **Content.** Recompute the entry's own hash from its stored fields and its
 *   stored `previous_hash`. A mismatch means the row was edited after it was
 *   written. This needs no ordering assumption, so it holds even where two
 *   entries share a timestamp.
 *
 *   **Linkage.** Every `previous_hash` must name an entry that exists, and no
 *   two entries may claim the same predecessor. A missing predecessor is a
 *   deleted entry; a shared one is a fork, which is what a concurrent writer or
 *   a re-inserted history looks like.
 */
const CHAIN_PAGE = 5_000;

export type ChainReport = {
  entries: number;
  /** Rows written before hashing existed. Not a failure, but not verifiable. */
  unhashed: number;
  tampered: string[];
  missingPredecessor: string[];
  forked: string[];
  /** True when the chain was longer than `maxRows` and only the tail was read. */
  truncated: boolean;
};

/** Byte-for-byte the payload `recordRewardAudit` hashes. Any drift here is a false alarm. */
function expectedHash(row: Record<string, unknown>) {
  return crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        previousHash: row.previous_hash ?? null,
        actorType: row.actor_type,
        actorId: row.actor_id ?? null,
        action: row.action,
        entityType: row.entity_type,
        entityId: row.entity_id,
        metadata: row.metadata ?? null,
        createdAt: row.created_at,
      }),
    )
    .digest("hex");
}

export async function verifyAuditChain({ maxRows = 100_000 } = {}): Promise<ChainReport> {
  const db = await getDb();
  const report: ChainReport = {
    entries: 0,
    unhashed: 0,
    tampered: [],
    missingPredecessor: [],
    forked: [],
    truncated: false,
  };

  const hashes = new Set<string>();
  const predecessors = new Map<string, string>();
  const claimedPredecessors: Array<{ id: string; previous: string }> = [];

  for (let offset = 0; offset < maxRows; offset += CHAIN_PAGE) {
    const rows = await all(
      db,
      `SELECT id, actor_type, actor_id, action, entity_type, entity_id, metadata,
              previous_hash, event_hash, created_at
         FROM reward_audit_logs
        ORDER BY created_at ASC, id ASC
        LIMIT ? OFFSET ?`,
      [CHAIN_PAGE, offset],
    );
    if (rows.length === 0) break;

    for (const row of rows) {
      report.entries += 1;
      const eventHash = row.event_hash ? String(row.event_hash) : null;
      if (!eventHash) {
        report.unhashed += 1;
        continue;
      }
      hashes.add(eventHash);
      if (expectedHash(row) !== eventHash) report.tampered.push(String(row.id));

      const previous = row.previous_hash ? String(row.previous_hash) : null;
      if (previous) {
        claimedPredecessors.push({ id: String(row.id), previous });
        const claimedBy = predecessors.get(previous);
        if (claimedBy) report.forked.push(String(row.id));
        else predecessors.set(previous, String(row.id));
      }
    }

    if (rows.length < CHAIN_PAGE) break;
    if (offset + CHAIN_PAGE >= maxRows) report.truncated = true;
  }

  // Deferred to the end: an entry's predecessor is only known to be missing once
  // every page has been read.
  for (const claim of claimedPredecessors) {
    if (!hashes.has(claim.previous)) report.missingPredecessor.push(claim.id);
  }

  return report;
}

// ---------------------------------------------------------------------------
// The nightly job
// ---------------------------------------------------------------------------

export type ReconciliationResult = {
  balanceDrift: BalanceDrift[];
  settlementDrift: SettlementDrift[];
  chain: ChainReport;
  clean: boolean;
};

/**
 * Runs every check and raises an alert per failing class.
 *
 * Ids rather than amounts in the alert body: the number is meaningless without
 * the row, and the row is one query away. Amounts are kept because "off by 5
 * centavos" and "off by ₱40,000" want different reactions at 3am.
 */
export async function runReconciliation(): Promise<ReconciliationResult> {
  const [balanceDrift, settlementDrift, chain] = await Promise.all([
    reconcileBalances(),
    reconcileSettlements(),
    verifyAuditChain(),
  ]);

  if (balanceDrift.length > 0) {
    const total = balanceDrift.reduce((sum, row) => sum + Math.abs(row.driftCentavos), 0);
    await reportAlert({
      source: "cron/maintenance",
      severity: "error",
      title: `${balanceDrift.length} balance(s) disagree with the ledger`,
      message:
        `Total absolute drift ₱${(total / 100).toFixed(2)}. ` +
        `First: ${balanceDrift
          .slice(0, 5)
          .map((row) => `${row.check} ${row.subject} ${row.driftCentavos > 0 ? "+" : ""}${row.driftCentavos}c`)
          .join(", ")}`,
      detail: { count: balanceDrift.length },
    });
  }

  if (settlementDrift.length > 0) {
    await reportAlert({
      source: "cron/maintenance",
      severity: "error",
      title: `${settlementDrift.length} closed statement(s) no longer match their rows`,
      message: settlementDrift
        .slice(0, 5)
        .map(
          (row) =>
            `${row.businessId} ${row.period}: redeemed ${row.redeemedDriftCentavos}c, issued ${row.issuedDriftCentavos}c`,
        )
        .join("; "),
      detail: { count: settlementDrift.length },
    });
  }

  const chainBroken =
    chain.tampered.length + chain.missingPredecessor.length + chain.forked.length;
  if (chainBroken > 0) {
    await reportAlert({
      source: "cron/maintenance",
      severity: "error",
      title: "Loyalty Points audit chain does not verify",
      message:
        `${chain.tampered.length} altered, ${chain.missingPredecessor.length} with a missing ` +
        `predecessor, ${chain.forked.length} forked, out of ${chain.entries} entries. ` +
        `First: ${[...chain.tampered, ...chain.missingPredecessor, ...chain.forked].slice(0, 5).join(", ")}`,
      detail: { entries: chain.entries, unhashed: chain.unhashed },
    });
  }

  return {
    balanceDrift,
    settlementDrift,
    chain,
    clean: balanceDrift.length === 0 && settlementDrift.length === 0 && chainBroken === 0,
  };
}
