/**
 * The central reward service.
 *
 * Levels, missions and achievements never touch a balance themselves — they ask
 * for a reward package and this decides what actually happens to it. That is
 * what makes three things true at once: every grant is idempotent (one unique
 * key per source, so a retried event, a double tap and a replayed ad callback
 * pay out once), every grant is atomic with the state change that earned it
 * (the caller passes its own open transaction), and every grant is explainable
 * (one `reward_transactions` row, plus a ledger entry on whichever balance
 * moved, plus the config version it ran under).
 *
 * Budget rules live here too: past the daily LP cap a payout is converted to XP
 * rather than refused, and a single grant above the review threshold is written
 * as REVIEW_REQUIRED and waits for an administrator instead of paying itself.
 */
import crypto from "node:crypto";
import type { FundingSource, RewardLine, RewardSummary } from "@bizflow/shared";
import { levelForXp } from "@bizflow/shared";
import { all, one, run, type Exec } from "@/server/db";
import { AppError } from "@/server/errors";
import { centavosToLoyaltyPoints, recordRewardAudit } from "@/server/rewards-network";
import { loadEconomy, loadLevels, parseRewardLines, type EconomyConfig } from "./config";
import { manilaDate, manilaMidnightUtc } from "./time";

const isoNow = () => new Date().toISOString();
const id = (prefix: string) => `${prefix}_${crypto.randomBytes(8).toString("hex")}`;

export type RewardSourceType = "mission" | "achievement" | "conversion" | "admin";

export type GrantInput = {
  walletId: string;
  sourceType: RewardSourceType;
  sourceId: string;
  reward: RewardLine[];
  /**
   * The one thing that makes this call safe to repeat. Derived from the source,
   * never random: `mission:<key>:<date>:<walletId>` and the like, so two paths
   * racing to reward the same fact collide on the unique index instead of both
   * paying.
   */
  idempotencyKey: string;
  partnerId?: string | null;
  /** Campaign budget to draw a PARTNER-funded reward against. */
  missionKey?: string;
  metadata?: Record<string, unknown>;
};

export type GrantResult = {
  rewardTxId: string;
  /** False when a prior call with this key already paid; nothing moved. */
  applied: boolean;
  /** True when the grant is parked awaiting administrator approval. */
  held: boolean;
  summary: RewardSummary;
  /** Set when the payout included XP. */
  lifetimeXp: number;
  level: number;
  previousLevel: number;
  leveledUp: boolean;
};

export const EMPTY_REWARD: RewardSummary = {
  xp: 0,
  lpCentavos: 0,
  lp: "",
  huntTickets: 0,
};

/** Collapses reward lines into the shape the app renders. */
export function summarise(lines: RewardLine[]): RewardSummary {
  const xp = sum(lines, "XP");
  const lpCentavos = sum(lines, "LP");
  const huntTickets = sum(lines, "HUNT_TICKET");
  const badge = lines.find((line) => line.type === "BADGE")?.badge;
  return {
    xp,
    lpCentavos,
    lp: lpCentavos > 0 ? centavosToLoyaltyPoints(lpCentavos) : "",
    huntTickets,
    badge,
  };
}

export function addSummaries(a: RewardSummary, b: RewardSummary): RewardSummary {
  const lpCentavos = a.lpCentavos + b.lpCentavos;
  return {
    xp: a.xp + b.xp,
    lpCentavos,
    lp: lpCentavos > 0 ? centavosToLoyaltyPoints(lpCentavos) : "",
    huntTickets: a.huntTickets + b.huntTickets,
    badge: a.badge ?? b.badge,
  };
}

function sum(lines: RewardLine[], type: RewardLine["type"]) {
  return lines
    .filter((line) => line.type === type)
    .reduce((total, line) => total + Math.max(0, Math.floor(line.amount ?? 0)), 0);
}

/**
 * The reply for a grant this key has already made, read off the existing row.
 *
 * Reached from two directions — the check before any work is done, and the race
 * lost at the insert — and both owe the caller the same answer: what was paid,
 * by which transaction, and that this call moved nothing.
 */
async function alreadyGranted(
  tx: Exec,
  walletId: string,
  row: Record<string, unknown>,
): Promise<GrantResult> {
  const standing = await levelSnapshot(tx, walletId);
  return {
    rewardTxId: String(row.id),
    applied: false,
    held: String(row.status) === "REVIEW_REQUIRED",
    summary: summarise([
      { type: "XP", amount: Number(row.xp_amount ?? 0) },
      { type: "LP", amount: Number(row.lp_centavos ?? 0) },
      { type: "HUNT_TICKET", amount: Number(row.hunt_tickets ?? 0) },
      ...(row.badge ? [{ type: "BADGE" as const, amount: 1, badge: String(row.badge) }] : []),
    ]),
    lifetimeXp: standing.lifetimeXp,
    level: standing.level,
    previousLevel: standing.level,
    leveledUp: false,
  };
}

/**
 * Grants a reward package inside the caller's transaction.
 *
 * The caller owns the transaction on purpose. A mission moving to CLAIMED and
 * the reward it pays are one fact, and the requirements are explicit that they
 * commit or fail together; handing this its own connection would let a crash
 * land a claimed mission that paid nothing.
 */
export async function grantReward(tx: Exec, input: GrantInput): Promise<GrantResult> {
  const { economy, version: configVersion } = await loadEconomy(tx);
  const requested = summarise(input.reward);

  // Idempotency first, before anything is read for a decision: a duplicate must
  // not even consume budget headroom.
  const existing = await one(
    tx,
    "SELECT * FROM reward_transactions WHERE idempotency_key = ?",
    [input.idempotencyKey],
  );
  if (existing) return alreadyGranted(tx, input.walletId, existing);

  const funding: FundingSource =
    input.reward.find((line) => line.fundingSource)?.fundingSource ?? "PLATFORM";

  // A payout too large to pay on its own authority is recorded and parked. It
  // is not silently dropped: an administrator sees the row and approves or
  // rejects it, which is also what the audit trail needs.
  //
  // A flagged wallet is parked the same way, and that is deliberate. The
  // alternative — dropping the reward — would mean a legitimate player caught
  // by a detector does the thing, sees nothing happen, and has no way to ask
  // about it. Held means the reward exists, is visible to an operator, and is
  // released or reversed by a person. Read inline rather than through
  // `anomaly.ts` to keep the reward engine free of a dependency on the
  // detectors that feed it.
  const wallet = await one(tx, "SELECT risk_state FROM reward_wallets WHERE id = ?", [
    input.walletId,
  ]);
  const riskState = String(wallet?.risk_state ?? "Clear");
  const heldForRisk = riskState === "Held" || riskState === "Suspended";
  const held = heldForRisk || requested.lpCentavos > economy.reviewThresholdCentavos;

  const capped = held
    ? { lpCentavos: 0, substitutedXp: 0 }
    : await applyDailyLpCap(tx, input.walletId, requested.lpCentavos, economy);

  const payable: RewardSummary = held
    ? EMPTY_REWARD
    : {
        xp: requested.xp + capped.substitutedXp,
        lpCentavos: capped.lpCentavos,
        lp: capped.lpCentavos > 0 ? centavosToLoyaltyPoints(capped.lpCentavos) : "",
        huntTickets: requested.huntTickets,
        badge: requested.badge,
      };

  const rewardTxId = id("rtx");
  // `INSERT OR IGNORE` rather than catching the unique violation afterwards.
  //
  // Letting the insert throw and recovering in a catch block worked on SQLite,
  // where a failed statement leaves the transaction usable. PostgreSQL aborts
  // the whole transaction on any error, so every statement after it — including
  // the read that built the "already granted" reply — fails with "current
  // transaction is aborted", and the loser of the race threw instead of
  // returning. The conflict clause keeps the transaction clean, and a zero row
  // count says the same thing the exception did.
  const inserted = await run(
    tx,
      `INSERT OR IGNORE INTO reward_transactions
       (id, wallet_id, source_type, source_id, reward_json, xp_amount, lp_centavos,
        hunt_tickets, badge, funding_source, partner_id, status, hold_reason,
        idempotency_key, config_version, metadata, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        rewardTxId,
        input.walletId,
        input.sourceType,
        input.sourceId,
        JSON.stringify(input.reward),
        payable.xp,
        payable.lpCentavos,
        payable.huntTickets,
        payable.badge ?? null,
        funding,
        input.partnerId ?? null,
        held ? "REVIEW_REQUIRED" : "GRANTED",
        held
          ? heldForRisk
            ? `Wallet is ${riskState.toLowerCase()} pending review`
            : "Above the single-grant review threshold"
          : null,
        input.idempotencyKey,
        configVersion,
        JSON.stringify({
          ...(input.metadata ?? {}),
          requestedLpCentavos: requested.lpCentavos,
          ...(capped.substitutedXp > 0
            ? { lpCapReachedSubstitutedXp: capped.substitutedXp }
            : {}),
        }),
        isoNow(),
      ],
  );

  // The unique index is the authority under concurrency: two workers handling
  // the same event both reach the insert, and exactly one wins. The loser reads
  // back what the winner wrote and reports that, rather than an empty result —
  // the reward exists, and its caller is entitled to know what it was.
  if (inserted === 0) {
    const winner = await one(
      tx,
      "SELECT * FROM reward_transactions WHERE idempotency_key = ?",
      [input.idempotencyKey],
    );
    if (winner) return alreadyGranted(tx, input.walletId, winner);
    // No row and no insert means the conflict was on something other than the
    // idempotency key, which is a bug rather than a race.
    throw new AppError(
      "E-REWARD-CONFLICT",
      "The reward could not be recorded",
      500,
    );
  }

  if (held) {
    await recordRewardAudit(tx, {
      actorType: "system",
      action: "gamification_reward_held",
      entityType: "reward_transaction",
      entityId: rewardTxId,
      metadata: {
        walletId: input.walletId,
        requested: requested.lpCentavos,
        reason: heldForRisk ? "risk" : "threshold",
      },
    });
    const standing = await levelSnapshot(tx, input.walletId);
    return {
      rewardTxId,
      applied: true,
      held: true,
      summary: EMPTY_REWARD,
      lifetimeXp: standing.lifetimeXp,
      level: standing.level,
      previousLevel: standing.level,
      leveledUp: false,
    };
  }

  if (payable.lpCentavos > 0) {
    await creditLoyaltyPoints(tx, {
      walletId: input.walletId,
      amountCentavos: payable.lpCentavos,
      funding,
      partnerId: input.partnerId ?? null,
      ledgerType: input.sourceType === "achievement" ? "achievement_reward" : "mission_reward",
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      rewardTxId,
    });
  }

  if (payable.huntTickets > 0) {
    await run(
      tx,
      `INSERT OR IGNORE INTO hunt_ticket_ledger
       (id, wallet_id, source_type, source_id, delta, ticket_date, idempotency_key, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id("htk"),
        input.walletId,
        input.sourceType,
        input.sourceId,
        payable.huntTickets,
        // Earned tickets are not tied to a day; only the level allowance is.
        "",
        `${input.idempotencyKey}:ticket`,
        isoNow(),
      ],
    );
  }

  const xpResult =
    payable.xp > 0
      ? await creditXp(tx, {
          walletId: input.walletId,
          delta: payable.xp,
          sourceType: input.sourceType,
          sourceId: input.sourceId,
          rewardTxId,
          idempotencyKey: `${input.idempotencyKey}:xp`,
          configVersion,
        })
      : await (async () => {
          const standing = await levelSnapshot(tx, input.walletId);
          return { ...standing, previousLevel: standing.level, leveledUp: false };
        })();

  return {
    rewardTxId,
    applied: true,
    held: false,
    summary: payable,
    lifetimeXp: xpResult.lifetimeXp,
    level: xpResult.level,
    previousLevel: xpResult.previousLevel,
    leveledUp: xpResult.leveledUp,
  };
}

/**
 * Trims an LP payout to what is left of the player's daily allowance and pays
 * the shortfall in XP instead.
 *
 * Refusing outright was the alternative and is worse: the player did the thing,
 * the mission has to complete, and a completion that pays nothing reads as a
 * bug. XP costs the business nothing and still advances them, which is exactly
 * what the requirements ask for when a cap is hit.
 */
async function applyDailyLpCap(
  tx: Exec,
  walletId: string,
  requestedCentavos: number,
  economy: EconomyConfig,
) {
  if (requestedCentavos <= 0 || economy.dailyLpGrantCapCentavos <= 0) {
    return { lpCentavos: requestedCentavos, substitutedXp: 0 };
  }
  // The allowance is a Manila day, so the window starts at Manila midnight
  // expressed in UTC rather than at a UTC date boundary eight hours late.
  const today = manilaDate();
  const row = await one(
    tx,
    `SELECT COALESCE(SUM(lp_centavos), 0) AS spent
     FROM reward_transactions
     WHERE wallet_id = ? AND status = 'GRANTED' AND created_at >= ?`,
    [walletId, manilaMidnightUtc(today)],
  );
  const spent = Number(row?.spent ?? 0);
  const headroom = Math.max(0, economy.dailyLpGrantCapCentavos - spent);
  if (headroom >= requestedCentavos) {
    return { lpCentavos: requestedCentavos, substitutedXp: 0 };
  }
  const shortfall = requestedCentavos - headroom;
  return {
    lpCentavos: headroom,
    // One whole LP of shortfall becomes one XP, at the published ratio.
    substitutedXp: Math.floor((shortfall / 100) * economy.xpPerLp),
  };
}

type LoyaltyCreditInput = {
  walletId: string;
  amountCentavos: number;
  funding: FundingSource;
  partnerId: string | null;
  ledgerType: "mission_reward" | "achievement_reward";
  sourceType: string;
  sourceId: string;
  rewardTxId: string;
};

/**
 * Puts LP where its funder says it belongs.
 *
 * PLATFORM money lands in the global pot, alongside referral and daily-use
 * awards — Voucher Hunt owes it, not a partner, and it is spendable anywhere.
 * PARTNER money lands in that partner's bucket, because it is that partner's
 * liability and settles on their statement.
 */
async function creditLoyaltyPoints(tx: Exec, input: LoyaltyCreditInput) {
  const now = isoNow();
  const wallet = await one(tx, "SELECT status FROM reward_wallets WHERE id = ?", [
    input.walletId,
  ]);
  if (!wallet || String(wallet.status) !== "Active") {
    throw new AppError(
      "E-REWARD-WALLET-SUSPENDED",
      "Loyalty Points wallet is suspended",
      409,
    );
  }

  if (input.funding === "PARTNER" && input.partnerId) {
    await run(
      tx,
      `INSERT OR IGNORE INTO reward_business_balances
       (id, wallet_id, business_id, balance_centavos, lifetime_earned_centavos, lifetime_transferred_centavos, created_at, updated_at)
       VALUES (?, ?, ?, 0, 0, 0, ?, ?)`,
      [id("rbb"), input.walletId, input.partnerId, now, now],
    );
    await run(
      tx,
      `UPDATE reward_business_balances
       SET balance_centavos = balance_centavos + ?,
           lifetime_earned_centavos = lifetime_earned_centavos + ?,
           updated_at = ?
       WHERE wallet_id = ? AND business_id = ?`,
      [input.amountCentavos, input.amountCentavos, now, input.walletId, input.partnerId],
    );
    await run(
      tx,
      `UPDATE reward_wallets
       SET lifetime_earned_centavos = lifetime_earned_centavos + ?, updated_at = ?
       WHERE id = ?`,
      [input.amountCentavos, now, input.walletId],
    );
    const bucket = await one(
      tx,
      "SELECT balance_centavos FROM reward_business_balances WHERE wallet_id = ? AND business_id = ?",
      [input.walletId, input.partnerId],
    );
    await writeLedger(tx, input, Number(bucket?.balance_centavos ?? 0), input.partnerId, now);
    return;
  }

  await run(
    tx,
    `UPDATE reward_wallets
     SET balance_centavos = balance_centavos + ?,
         lifetime_earned_centavos = lifetime_earned_centavos + ?,
         updated_at = ?
     WHERE id = ? AND status = 'Active'`,
    [input.amountCentavos, input.amountCentavos, now, input.walletId],
  );
  const updated = await one(tx, "SELECT balance_centavos FROM reward_wallets WHERE id = ?", [
    input.walletId,
  ]);
  await writeLedger(tx, input, Number(updated?.balance_centavos ?? 0), null, now);
}

async function writeLedger(
  tx: Exec,
  input: LoyaltyCreditInput,
  balanceAfter: number,
  businessId: string | null,
  now: string,
) {
  await run(
    tx,
    `INSERT INTO reward_ledger_entries
     (id, wallet_id, type, delta_centavos, balance_after_centavos, source_type, source_id, business_id, metadata, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id("rled"),
      input.walletId,
      input.ledgerType,
      input.amountCentavos,
      balanceAfter,
      input.sourceType,
      input.sourceId,
      businessId,
      JSON.stringify({ rewardTxId: input.rewardTxId, fundingSource: input.funding }),
      now,
    ],
  );
}

export type XpCreditInput = {
  walletId: string;
  /** Signed. Negative is a reversal and is the only way a level can fall. */
  delta: number;
  sourceType: string;
  sourceId?: string | null;
  rewardTxId?: string | null;
  idempotencyKey: string;
  configVersion: number;
  metadata?: Record<string, unknown>;
};

export type XpCreditResult = {
  ledgerId: string;
  lifetimeXp: number;
  level: number;
  previousLevel: number;
  leveledUp: boolean;
  applied: boolean;
};

/**
 * Writes one XP ledger entry and re-derives the level from the new total.
 *
 * The level is never incremented — it is recomputed from `lifetime_xp` against
 * the published ladder every time. That is what makes a ladder change take
 * effect for everyone at once, and what makes a reversal put a player back
 * exactly where the arithmetic says they belong rather than where a counter
 * happened to be left.
 */
export async function creditXp(tx: Exec, input: XpCreditInput): Promise<XpCreditResult> {
  const now = isoNow();
  await run(
    tx,
    `INSERT OR IGNORE INTO user_levels (wallet_id, lifetime_xp, current_level, announced_level, created_at, updated_at)
     VALUES (?, 0, 1, 1, ?, ?)`,
    [input.walletId, now, now],
  );

  // Locked for the duration: two events crediting the same player at once would
  // otherwise both read the old total and write the same balance_after.
  const before = await one(
    tx,
    "SELECT lifetime_xp, current_level FROM user_levels WHERE wallet_id = ? FOR UPDATE",
    [input.walletId],
  );
  const previousXp = Number(before?.lifetime_xp ?? 0);
  const previousLevel = Number(before?.current_level ?? 1);
  const nextXp = Math.max(0, previousXp + Math.trunc(input.delta));

  const ledgerId = id("xpl");
  const inserted = await run(
    tx,
    `INSERT OR IGNORE INTO user_xp_ledger
     (id, wallet_id, delta, balance_after, source_type, source_id, reward_tx_id, idempotency_key, config_version, metadata, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      ledgerId,
      input.walletId,
      Math.trunc(input.delta),
      nextXp,
      input.sourceType,
      input.sourceId ?? null,
      input.rewardTxId ?? null,
      input.idempotencyKey,
      input.configVersion,
      input.metadata ? JSON.stringify(input.metadata) : null,
      now,
    ],
  );
  if (inserted !== 1) {
    // Someone already credited this exact fact. Report where things stand
    // rather than crediting twice.
    const standing = await levelSnapshot(tx, input.walletId);
    return {
      ledgerId: "",
      lifetimeXp: standing.lifetimeXp,
      level: standing.level,
      previousLevel: standing.level,
      leveledUp: false,
      applied: false,
    };
  }

  const { levels } = await loadLevels(tx);
  const level = levelForXp(levels, nextXp).level;
  await run(
    tx,
    "UPDATE user_levels SET lifetime_xp = ?, current_level = ?, updated_at = ? WHERE wallet_id = ?",
    [nextXp, level, now, input.walletId],
  );

  return {
    ledgerId,
    lifetimeXp: nextXp,
    level,
    previousLevel,
    leveledUp: level > previousLevel,
    applied: true,
  };
}

/** Where a player stands, without moving anything. */
export async function levelSnapshot(tx: Exec, walletId: string) {
  const row = await one(
    tx,
    "SELECT lifetime_xp, current_level FROM user_levels WHERE wallet_id = ?",
    [walletId],
  );
  return {
    lifetimeXp: Number(row?.lifetime_xp ?? 0),
    level: Number(row?.current_level ?? 1),
  };
}

/**
 * Reverses a granted reward without deleting anything.
 *
 * Two rows come out of this, not zero: the original stays exactly as it was and
 * a mirrored transaction undoes its effects. That is the only shape in which a
 * reversal can be audited, and it is why a badge revocation needs an
 * administrator's reason rather than a delete.
 */
export async function reverseReward(
  tx: Exec,
  input: { rewardTxId: string; actor: string; reason: string },
) {
  const original = await one(tx, "SELECT * FROM reward_transactions WHERE id = ?", [
    input.rewardTxId,
  ]);
  if (!original) {
    throw new AppError("E-REWARD-TX-404", "Reward transaction was not found", 404);
  }
  if (String(original.status) === "REVERSED") {
    throw new AppError("E-REWARD-ALREADY-REVERSED", "This reward is already reversed", 409);
  }

  const walletId = String(original.wallet_id);
  const xp = Number(original.xp_amount ?? 0);
  const lpCentavos = Number(original.lp_centavos ?? 0);
  const { version: configVersion } = await loadEconomy(tx);
  const now = isoNow();
  const reversalId = id("rtx");

  await run(
    tx,
    `INSERT INTO reward_transactions
     (id, wallet_id, source_type, source_id, reward_json, xp_amount, lp_centavos,
      hunt_tickets, funding_source, partner_id, status, reversal_of,
      idempotency_key, config_version, metadata, created_at)
     VALUES (?, ?, 'admin', ?, ?, ?, ?, 0, ?, ?, 'GRANTED', ?, ?, ?, ?, ?)`,
    [
      reversalId,
      walletId,
      String(original.source_id),
      JSON.stringify([{ type: "XP", amount: -xp }]),
      -xp,
      -lpCentavos,
      String(original.funding_source ?? "PLATFORM"),
      original.partner_id ?? null,
      input.rewardTxId,
      `reversal:${input.rewardTxId}`,
      configVersion,
      JSON.stringify({ reason: input.reason, actor: input.actor }),
      now,
    ],
  );
  await run(
    tx,
    "UPDATE reward_transactions SET status = 'REVERSED', reviewed_by = ?, reviewed_at = ? WHERE id = ?",
    [input.actor, now, input.rewardTxId],
  );

  if (xp > 0) {
    await creditXp(tx, {
      walletId,
      delta: -xp,
      sourceType: "reversal",
      sourceId: input.rewardTxId,
      rewardTxId: reversalId,
      idempotencyKey: `reversal:${input.rewardTxId}:xp`,
      configVersion,
      metadata: { reason: input.reason },
    });
  }

  if (lpCentavos > 0) {
    // LP is clamped at zero by a column check, so a wallet already spent down
    // has the reversal recorded and takes back what is there. The transaction
    // row carries the full figure either way, which is what reconciles.
    await run(
      tx,
      `UPDATE reward_wallets
       SET balance_centavos = GREATEST(0, balance_centavos - ?), updated_at = ?
       WHERE id = ?`,
      [lpCentavos, now, walletId],
    );
    const balance = await one(tx, "SELECT balance_centavos FROM reward_wallets WHERE id = ?", [
      walletId,
    ]);
    await run(
      tx,
      `INSERT INTO reward_ledger_entries
       (id, wallet_id, type, delta_centavos, balance_after_centavos, source_type, source_id, metadata, created_at)
       VALUES (?, ?, 'adjustment', ?, ?, 'reward_reversal', ?, ?, ?)`,
      [
        id("rled"),
        walletId,
        -lpCentavos,
        Number(balance?.balance_centavos ?? 0),
        input.rewardTxId,
        JSON.stringify({ reason: input.reason, actor: input.actor }),
        now,
      ],
    );
  }

  await recordRewardAudit(tx, {
    actorType: "admin",
    actorId: input.actor,
    action: "gamification_reward_reversed",
    entityType: "reward_transaction",
    entityId: input.rewardTxId,
    metadata: { reason: input.reason, xp, lpCentavos, reversalId },
  });

  return { reversalId, xp, lpCentavos };
}

/**
 * Settles a reward that was held for approval.
 *
 * Two things write `REVIEW_REQUIRED`: a single grant above the review threshold,
 * and any grant to a wallet the anomaly detectors have flagged. Both park the
 * reward rather than dropping it, and both need a person to finish the job —
 * which is what this is. Without it a held reward is owed forever and nobody can
 * pay it, which is a worse failure than never having held it.
 *
 * Approving pays what the transaction asked for, not what was recorded on it: a
 * held row carries zeroes in `xp_amount` and `lp_centavos` precisely because
 * nothing was paid, and `reward_json` is the record of what was owed. The daily
 * LP cap is applied at approval rather than at the original grant, because the
 * cap is a fact about the day the money actually moves.
 *
 * `reference` is the finance reference number §6.2 asks to be recorded against
 * an approval.
 */
export async function settleHeldReward(
  tx: Exec,
  input: {
    rewardTxId: string;
    actor: string;
    decision: "Approve" | "Reject";
    reason: string;
    reference?: string;
  },
) {
  const held = await one(
    tx,
    "SELECT * FROM reward_transactions WHERE id = ? FOR UPDATE",
    [input.rewardTxId],
  );
  if (!held) {
    throw new AppError("E-REWARD-TX-404", "Reward transaction was not found", 404);
  }
  if (String(held.status) !== "REVIEW_REQUIRED") {
    throw new AppError(
      "E-REWARD-ALREADY-GRANTED",
      `That reward is ${String(held.status).toLowerCase()}, not waiting for approval`,
      409,
    );
  }

  const walletId = String(held.wallet_id);
  const now = isoNow();

  if (input.decision === "Reject") {
    await run(
      tx,
      `UPDATE reward_transactions
       SET status = 'REJECTED', hold_reason = ?, reviewed_by = ?, reviewed_at = ?
       WHERE id = ?`,
      [input.reason, input.actor, now, input.rewardTxId],
    );
    await recordRewardAudit(tx, {
      actorType: "admin",
      actorId: input.actor,
      action: "gamification_reward_rejected",
      entityType: "reward_transaction",
      entityId: input.rewardTxId,
      metadata: { reason: input.reason, walletId },
    });
    return { rewardTxId: input.rewardTxId, paid: EMPTY_REWARD, decision: input.decision };
  }

  const { economy, version: configVersion } = await loadEconomy(tx);
  const requested = summarise(parseRewardLines(String(held.reward_json ?? "[]")));
  const funding = String(held.funding_source ?? "PLATFORM") as FundingSource;
  const capped = await applyDailyLpCap(tx, walletId, requested.lpCentavos, economy);
  const payable: RewardSummary = {
    xp: requested.xp + capped.substitutedXp,
    lpCentavos: capped.lpCentavos,
    lp: capped.lpCentavos > 0 ? centavosToLoyaltyPoints(capped.lpCentavos) : "",
    huntTickets: requested.huntTickets,
    badge: requested.badge,
  };

  await run(
    tx,
    `UPDATE reward_transactions
     SET status = 'GRANTED', xp_amount = ?, lp_centavos = ?, hunt_tickets = ?,
         hold_reason = NULL, reviewed_by = ?, reviewed_at = ?
     WHERE id = ?`,
    [payable.xp, payable.lpCentavos, payable.huntTickets, input.actor, now, input.rewardTxId],
  );

  if (payable.lpCentavos > 0) {
    await creditLoyaltyPoints(tx, {
      walletId,
      amountCentavos: payable.lpCentavos,
      funding,
      partnerId: held.partner_id ? String(held.partner_id) : null,
      ledgerType:
        String(held.source_type) === "achievement" ? "achievement_reward" : "mission_reward",
      sourceType: String(held.source_type),
      sourceId: String(held.source_id),
      rewardTxId: input.rewardTxId,
    });
  }

  if (payable.huntTickets > 0) {
    await run(
      tx,
      `INSERT OR IGNORE INTO hunt_ticket_ledger
       (id, wallet_id, source_type, source_id, delta, ticket_date, idempotency_key, created_at)
       VALUES (?, ?, ?, ?, ?, '', ?, ?)`,
      [
        id("htk"),
        walletId,
        String(held.source_type),
        String(held.source_id),
        payable.huntTickets,
        `${String(held.idempotency_key)}:ticket`,
        now,
      ],
    );
  }

  if (payable.xp > 0) {
    // Keyed on the release, not on the original grant: the original never
    // credited XP, and reusing its key would be refused by the ledger's unique
    // index the first time a held reward is approved.
    await creditXp(tx, {
      walletId,
      delta: payable.xp,
      sourceType: String(held.source_type),
      sourceId: String(held.source_id),
      rewardTxId: input.rewardTxId,
      idempotencyKey: `release:${input.rewardTxId}:xp`,
      configVersion,
      metadata: { releasedBy: input.actor },
    });
  }

  await recordRewardAudit(tx, {
    actorType: "admin",
    actorId: input.actor,
    action: "gamification_reward_released",
    entityType: "reward_transaction",
    entityId: input.rewardTxId,
    metadata: {
      reason: input.reason,
      reference: input.reference ?? null,
      walletId,
      xp: payable.xp,
      lpCentavos: payable.lpCentavos,
    },
  });

  return { rewardTxId: input.rewardTxId, paid: payable, decision: input.decision };
}

/** Rewards parked for a person to decide on, newest first. */
export async function listHeldRewards(db: Exec, limit = 100) {
  return all(
    db,
    `SELECT rt.id, rt.wallet_id, rt.source_type, rt.source_id, rt.reward_json,
            rt.funding_source, rt.partner_id, rt.hold_reason, rt.created_at,
            w.phone, w.risk_state, b.name AS partner_name
     FROM reward_transactions rt
     JOIN reward_wallets w ON w.id = rt.wallet_id
     LEFT JOIN businesses b ON b.id = rt.partner_id
     WHERE rt.status = 'REVIEW_REQUIRED'
     ORDER BY rt.created_at ASC
     LIMIT ?`,
    [limit],
  );
}

function isUniqueViolation(error: unknown) {
  const code = (error as { code?: string } | null)?.code;
  const message = String((error as Error)?.message ?? "");
  return code === "23505" || /duplicate key value|UNIQUE constraint/i.test(message);
}
