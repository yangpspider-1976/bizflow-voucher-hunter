/**
 * Achievements: cumulative counters, tiered badges, and the backfill that gives
 * existing players credit for everything they did before this shipped.
 *
 * Counters are stored, not recounted. A profile request that re-aggregated
 * every historical event would get slower for exactly the players who have used
 * the app most, so `user_achievement_progress` holds the running total and the
 * source events stay in `gamification_events` for when a total has to be
 * rebuilt. Distinct-thing counters ("partners visited") are backed by
 * membership rows instead, because a total cannot deduplicate on its own.
 *
 * Rewards granted here never feed back into a counter: progress moves only when
 * an event handler explicitly calls one of the bump functions below, and a
 * reward grant calls none of them. That is the recursion guard the requirements
 * ask for, enforced by structure rather than by a flag someone has to remember
 * to set.
 */
import type { AchievementTier, AchievementUnlockNotice, RewardLine } from "@bizflow/shared";
import { ACHIEVEMENT_TIERS } from "@bizflow/shared";
import crypto from "node:crypto";
import { all, one, run, type Exec } from "@/server/db";
import { parseRewardLines } from "./config";
import { grantReward, summarise } from "./rewards";
import { manilaDate, manilaDaysBetween } from "./time";

const isoNow = () => new Date().toISOString();
const id = (prefix: string) => `${prefix}_${crypto.randomBytes(8).toString("hex")}`;

export type CounterBump = {
  walletId: string;
  counterKey: string;
  delta: number;
  sourceId: string;
  /** Set for a backfill so the unlocks it creates can be identified later. */
  backfillJobId?: string;
};

/** Adds to a cumulative counter and unlocks whatever tiers that crosses. */
export async function bumpCounter(
  tx: Exec,
  input: CounterBump,
): Promise<AchievementUnlockNotice[]> {
  if (input.delta <= 0) return [];
  const now = isoNow();
  await run(
    tx,
    `INSERT INTO user_achievement_progress (wallet_id, counter_key, counter_value, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (wallet_id, counter_key)
     DO UPDATE SET counter_value = user_achievement_progress.counter_value + EXCLUDED.counter_value,
                   updated_at = EXCLUDED.updated_at`,
    [input.walletId, input.counterKey, Math.floor(input.delta), now],
  );
  return evaluate(tx, input.walletId, input.counterKey, input.backfillJobId);
}

/**
 * Records that a player has now touched one distinct thing, and counts it only
 * the first time. The membership row is the deduplication: a second visit to
 * the same partner inserts nothing and moves no counter.
 */
export async function bumpDistinctCounter(
  tx: Exec,
  input: CounterBump & { memberKey: string },
): Promise<AchievementUnlockNotice[]> {
  const inserted = await run(
    tx,
    `INSERT OR IGNORE INTO user_counter_members (wallet_id, counter_key, member_key, created_at)
     VALUES (?, ?, ?, ?)`,
    [input.walletId, input.counterKey, input.memberKey, isoNow()],
  );
  if (inserted !== 1) return [];
  return bumpCounter(tx, { ...input, delta: 1 });
}

/**
 * Advances a consecutive-day streak.
 *
 * The rule is deliberately about calendar days in Manila, not about elapsed
 * hours: a player who acts at 23:50 and again at 00:10 has acted on two days
 * and their streak should say so. Same day is a no-op, the next day extends,
 * and any larger gap starts again at one.
 */
export async function advanceStreak(
  tx: Exec,
  input: {
    walletId: string;
    counterKey: string;
    date?: string;
    sourceId: string;
    backfillJobId?: string;
  },
): Promise<AchievementUnlockNotice[]> {
  const today = input.date ?? manilaDate();
  const now = isoNow();
  const existing = await one(
    tx,
    "SELECT counter_value, last_date FROM user_achievement_progress WHERE wallet_id = ? AND counter_key = ?",
    [input.walletId, input.counterKey],
  );

  const lastDate = existing?.last_date ? String(existing.last_date) : null;
  if (lastDate === today) return [];

  const gap = lastDate ? manilaDaysBetween(lastDate, today) : null;
  const next = gap === 1 ? Number(existing?.counter_value ?? 0) + 1 : 1;

  await run(
    tx,
    `INSERT INTO user_achievement_progress (wallet_id, counter_key, counter_value, last_date, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (wallet_id, counter_key)
     DO UPDATE SET counter_value = EXCLUDED.counter_value,
                   last_date = EXCLUDED.last_date,
                   updated_at = EXCLUDED.updated_at`,
    [input.walletId, input.counterKey, next, today, now],
  );
  return evaluate(tx, input.walletId, input.counterKey, input.backfillJobId);
}

export async function counterValue(tx: Exec, walletId: string, counterKey: string) {
  const row = await one(
    tx,
    "SELECT counter_value FROM user_achievement_progress WHERE wallet_id = ? AND counter_key = ?",
    [walletId, counterKey],
  );
  return Number(row?.counter_value ?? 0);
}

/**
 * Unlocks every tier the counter now clears, in order.
 *
 * Crossing several thresholds at once — which a backfill does routinely —
 * unlocks each of them and pays each of their rewards, exactly once. The unique
 * key on `user_achievements` is what enforces "once per tier"; the insert
 * result, not a prior read, is what decides whether the reward is paid.
 */
async function evaluate(
  tx: Exec,
  walletId: string,
  counterKey: string,
  backfillJobId?: string,
): Promise<AchievementUnlockNotice[]> {
  const value = await counterValue(tx, walletId, counterKey);
  if (value <= 0) return [];

  const definitions = await all(
    tx,
    `SELECT d.* FROM achievement_definitions d
     JOIN (
       SELECT group_key, MAX(version) AS version FROM achievement_definitions GROUP BY group_key
     ) live ON live.group_key = d.group_key AND live.version = d.version
     WHERE d.counter_key = ? AND d.status = 'Active' AND d.threshold <= ?
     ORDER BY d.threshold ASC`,
    [counterKey, value],
  );

  const notices: AchievementUnlockNotice[] = [];
  for (const definition of definitions) {
    const groupKey = String(definition.group_key);
    const tier = String(definition.tier) as AchievementTier;
    const unlockId = id("uach");
    const inserted = await run(
      tx,
      `INSERT OR IGNORE INTO user_achievements
       (id, wallet_id, group_key, tier, progress_at_unlock, unlocked_at, backfill_job_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [unlockId, walletId, groupKey, tier, value, isoNow(), backfillJobId ?? null],
    );
    if (inserted !== 1) continue;

    const reward = parseRewardLines(String(definition.reward_json)) as RewardLine[];
    const granted = await grantReward(tx, {
      walletId,
      sourceType: "achievement",
      sourceId: `${groupKey}:${tier}`,
      reward,
      idempotencyKey: `achievement:${walletId}:${groupKey}:${tier}`,
      metadata: { counterKey, value, backfillJobId: backfillJobId ?? null },
    });
    await run(tx, "UPDATE user_achievements SET reward_tx_id = ? WHERE id = ?", [
      granted.rewardTxId,
      unlockId,
    ]);

    notices.push({
      groupKey,
      title: String(definition.title),
      tier,
      reward: summarise(reward),
      unlockedAt: isoNow(),
    });
  }
  return notices;
}

/**
 * Reverses an achievement counter after a cancelled payment, a fraudulent
 * review or an abusive referral.
 *
 * The counter is corrected; the badge is not automatically taken back. Revoking
 * a badge is a policy decision with a person behind it, so it needs an explicit
 * `revokeBadge` call carrying an administrator's reason — a counter drifting
 * below a threshold is not, on its own, evidence of anything.
 */
export async function reverseCounter(
  tx: Exec,
  input: { walletId: string; counterKey: string; delta: number; memberKey?: string },
) {
  if (input.memberKey) {
    await run(
      tx,
      "DELETE FROM user_counter_members WHERE wallet_id = ? AND counter_key = ? AND member_key = ?",
      [input.walletId, input.counterKey, input.memberKey],
    );
  }
  await run(
    tx,
    `UPDATE user_achievement_progress
     SET counter_value = GREATEST(0, counter_value - ?), updated_at = ?
     WHERE wallet_id = ? AND counter_key = ?`,
    [Math.max(0, Math.floor(input.delta)), isoNow(), input.walletId, input.counterKey],
  );
}

export async function revokeBadge(
  tx: Exec,
  input: { walletId: string; groupKey: string; tier: AchievementTier; reason: string },
) {
  await run(
    tx,
    `UPDATE user_achievements SET revoked_at = ?, revoked_reason = ?
     WHERE wallet_id = ? AND group_key = ? AND tier = ?`,
    [isoNow(), input.reason, input.walletId, input.groupKey, input.tier],
  );
}

/** Tier unlocks the app has not yet shown a celebration for. */
export async function unseenUnlocks(
  db: Exec,
  walletId: string,
): Promise<AchievementUnlockNotice[]> {
  const rows = await all(
    db,
    `SELECT u.group_key, u.tier, u.unlocked_at, d.title, d.reward_json
     FROM user_achievements u
     LEFT JOIN achievement_definitions d
       ON d.group_key = u.group_key AND d.tier = u.tier
      AND d.version = (SELECT MAX(version) FROM achievement_definitions WHERE group_key = u.group_key)
     WHERE u.wallet_id = ? AND u.seen_at IS NULL AND u.revoked_at IS NULL
     ORDER BY u.unlocked_at ASC`,
    [walletId],
  );
  return rows.map((row) => ({
    groupKey: String(row.group_key),
    title: String(row.title ?? row.group_key),
    tier: String(row.tier) as AchievementTier,
    reward: summarise(parseRewardLines(row.reward_json ? String(row.reward_json) : null)),
    unlockedAt: String(row.unlocked_at),
  }));
}

/** Called once the app has shown the celebration screen. */
export async function markUnlocksSeen(db: Exec, walletId: string, groupKeys?: string[]) {
  if (groupKeys && groupKeys.length === 0) return 0;
  if (groupKeys) {
    // Passed as one delimited string rather than as an array parameter: the
    // driver binds scalars, and splitting server-side keeps this a single
    // placeholder however many keys the app acknowledges at once.
    return run(
      db,
      `UPDATE user_achievements SET seen_at = ?
       WHERE wallet_id = ? AND seen_at IS NULL
         AND group_key = ANY (string_to_array(?, ','))`,
      [isoNow(), walletId, groupKeys.join(",")],
    );
  }
  return run(
    db,
    "UPDATE user_achievements SET seen_at = ? WHERE wallet_id = ? AND seen_at IS NULL",
    [isoNow(), walletId],
  );
}

/* Backfill ------------------------------------------------------------------ */

/**
 * Rebuilds one player's counters from the history they already have.
 *
 * Reads the existing tables rather than a replayed event stream, because the
 * events these achievements describe predate the event log: hunts, vouchers,
 * QR redemptions and referrals are all recorded in their own tables and are the
 * authoritative record of what happened. Idempotent — counters are set to the
 * historical total, not added to it — so a job that dies halfway can simply be
 * run again.
 */
export async function backfillWallet(
  tx: Exec,
  input: { walletId: string; phone: string; backfillJobId: string },
): Promise<AchievementUnlockNotice[]> {
  const totals = await historicalTotals(tx, input.phone, input.walletId);
  const notices: AchievementUnlockNotice[] = [];
  const now = isoNow();

  for (const [counterKey, value] of Object.entries(totals.counters)) {
    if (value <= 0) continue;
    await run(
      tx,
      `INSERT INTO user_achievement_progress (wallet_id, counter_key, counter_value, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (wallet_id, counter_key)
       DO UPDATE SET counter_value = GREATEST(user_achievement_progress.counter_value, EXCLUDED.counter_value),
                     updated_at = EXCLUDED.updated_at`,
      [input.walletId, counterKey, value, now],
    );
  }

  for (const businessId of totals.distinctPartners) {
    await run(
      tx,
      `INSERT OR IGNORE INTO user_counter_members (wallet_id, counter_key, member_key, created_at)
       VALUES (?, 'distinct_partners', ?, ?)`,
      [input.walletId, businessId, now],
    );
  }

  for (const counterKey of [...Object.keys(totals.counters), "distinct_partners"]) {
    notices.push(...(await evaluate(tx, input.walletId, counterKey, input.backfillJobId)));
  }
  return notices;
}

/**
 * The historical figures every seeded achievement counts, read from the tables
 * that already hold them.
 */
async function historicalTotals(tx: Exec, phone: string, walletId: string) {
  const hunts = await one(
    tx,
    `SELECT COUNT(*) AS total FROM attempts a
     JOIN users u ON u.id = a.user_id
     WHERE u.phone = ? AND a.status IN ('Selected', 'Released', 'Expired', 'Held')`,
    [phone],
  );
  const vouchers = await one(
    tx,
    `SELECT COUNT(*) AS total FROM vouchers v
     JOIN users u ON u.id = v.user_id
     WHERE u.phone = ? AND v.status = 'Redeemed'`,
    [phone],
  );
  const rewardRedemptions = await one(
    tx,
    "SELECT COUNT(*) AS total FROM reward_voucher_redemptions WHERE wallet_id = ?",
    [walletId],
  );
  const referrals = await one(
    tx,
    `SELECT COUNT(*) AS total FROM referral_rewards r
     JOIN users u ON u.id = r.referrer_user_id
     WHERE u.phone = ? AND r.status = 'granted'`,
    [phone],
  );
  const converted = await one(
    tx,
    "SELECT COALESCE(SUM(lp_centavos), 0) AS total FROM point_xp_conversions WHERE wallet_id = ?",
    [walletId],
  );
  const partners = await all(
    tx,
    `SELECT DISTINCT c.business_id AS business_id FROM vouchers v
     JOIN users u ON u.id = v.user_id
     JOIN campaigns c ON c.id = v.campaign_id
     WHERE u.phone = ? AND v.status = 'Redeemed'
     UNION
     SELECT DISTINCT business_id FROM reward_voucher_redemptions WHERE wallet_id = ?`,
    [phone, walletId],
  );

  const qrRedeems =
    Number(vouchers?.total ?? 0) + Number(rewardRedemptions?.total ?? 0);

  return {
    counters: {
      hunt_complete: Number(hunts?.total ?? 0),
      qr_redeem: qrRedeems,
      referral_verified: Number(referrals?.total ?? 0),
      lp_converted: Math.floor(Number(converted?.total ?? 0) / 100),
    } as Record<string, number>,
    distinctPartners: partners
      .map((row) => String(row.business_id))
      .filter((value) => value && value !== "null"),
  };
}
