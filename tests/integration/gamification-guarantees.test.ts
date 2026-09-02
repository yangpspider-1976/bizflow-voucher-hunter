/**
 * Stage 4 of the manual gamification plan, automated: the four properties the
 * whole reward engine rests on, and the Manila day it reckons them in.
 *
 * These are the claims that are cheap to assert and expensive to be wrong
 * about. Every one of them is meant to be enforced by a database constraint
 * rather than by care — a unique key, a conditional update, a mirrored row — so
 * each test tries the thing the constraint is supposed to make impossible.
 *
 * Case numbers refer to the manual plan. The Manila reset and the window grace
 * period are covered in gamification-missions.test.ts and are not repeated;
 * what is here is the part that outlives a single day's missions.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { all, getDb, one, resetDb, run, withTx } from "@/server/db";
import { reverseCounter, revokeBadge } from "@/server/gamification/achievements";
import { ingestEvent } from "@/server/gamification/events";
import { convertPointsToXp } from "@/server/gamification/levels";
import { gamificationProfile } from "@/server/gamification/profile";
import { grantReward, reverseReward } from "@/server/gamification/rewards";
import { ensureRewardWallet } from "@/server/rewards-network";

const phone = "+639171110401";

async function walletId() {
  return (await ensureRewardWallet(await getDb(), { phone })).id;
}

async function grant(idempotencyKey: string, xp = 40) {
  const wallet = await walletId();
  return withTx((tx) =>
    grantReward(tx, {
      walletId: wallet,
      sourceType: "mission",
      sourceId: `guarantee:${idempotencyKey}`,
      reward: [{ type: "XP", amount: xp }],
      idempotencyKey,
    }),
  );
}

describe("idempotency", () => {
  beforeEach(async () => {
    await resetDb();
  });

  // T21. The key names the fact, not the moment, so a retry describes the same
  // event rather than a new one.
  it("grants nothing the second time the same event arrives", async () => {
    const first = await ingestEvent({
      eventName: "hunt_complete",
      phone,
      source: "test",
      objectId: "att_replay",
      idempotencyKey: "hunt_complete:att_replay",
    });
    const second = await ingestEvent({
      eventName: "hunt_complete",
      phone,
      source: "test",
      objectId: "att_replay",
      idempotencyKey: "hunt_complete:att_replay",
    });

    expect(first.accepted).toBe(true);
    expect(second.accepted).toBe(false);

    const events = await all(
      await getDb(),
      "SELECT event_id FROM gamification_events WHERE idempotency_key = ?",
      ["hunt_complete:att_replay"],
    );
    expect(events).toHaveLength(1);
  });

  // T21. A duplicate must not even consume budget headroom, so the reward
  // engine checks the key before it reads anything else.
  it("returns the original transaction for a repeated reward key", async () => {
    const first = await grant("guarantee:once");
    const second = await grant("guarantee:once");

    expect(second.rewardTxId).toBe(first.rewardTxId);
    expect(second.applied).toBe(false);
    expect((await gamificationProfile({ phone })).level.lifetimeXp).toBe(40);
  });

  /**
   * T21. Two workers reaching the same insert is the case the unique index is
   * there to settle, and for a while it did not: the recovery ran in a catch
   * block, which works on SQLite but not on PostgreSQL, where any error aborts
   * the transaction and every statement after it — including the read that
   * built the reply — fails with "current transaction is aborted". The loser
   * threw instead of returning. `grantReward` now inserts with a conflict
   * clause, so the transaction is never poisoned.
   */
  it("survives the same grant arriving twice at once", async () => {
    const results = await Promise.allSettled([
      grant("guarantee:race"),
      grant("guarantee:race"),
    ]);

    const rejected = results
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => String(result.reason?.message ?? result.reason));
    expect(rejected).toEqual([]);
    const rows = await all(
      await getDb(),
      "SELECT id FROM reward_transactions WHERE idempotency_key = ?",
      ["guarantee:race"],
    );
    expect(rows).toHaveLength(1);
    expect((await gamificationProfile({ phone })).level.lifetimeXp).toBe(40);
  });

  // T21. Conversion carries the client's own key, which is what makes a flaky
  // network safe rather than expensive.
  it("converts once for a repeated conversion key", async () => {
    const db = await getDb();
    const wallet = await ensureRewardWallet(db, { phone });
    await run(db, "UPDATE reward_wallets SET balance_centavos = ? WHERE id = ?", [
      500_00,
      wallet.id,
    ]);

    const first = await convertPointsToXp({
      phone,
      businessId: null,
      amount: 100,
      idempotencyKey: "guarantee:convert",
    });
    const second = await convertPointsToXp({
      phone,
      businessId: null,
      amount: 100,
      idempotencyKey: "guarantee:convert",
    });

    expect(second.xpGranted).toBe(first.xpGranted);
    const balance = await one(db, "SELECT balance_centavos FROM reward_wallets WHERE id = ?", [
      wallet.id,
    ]);
    // One debit, not two.
    expect(Number(balance?.balance_centavos)).toBe(400_00);
  });
});

describe("reversal", () => {
  beforeEach(async () => {
    await resetDb();
  });

  // T21. Nothing is edited and nothing is deleted: a reversal is a new row that
  // mirrors the old one, so the history of a disputed grant survives the
  // decision to undo it.
  it("mirrors a grant rather than editing it", async () => {
    const granted = await grant("guarantee:reversible", 60);
    expect((await gamificationProfile({ phone })).level.lifetimeXp).toBe(60);

    await withTx((tx) =>
      reverseReward(tx, {
        rewardTxId: granted.rewardTxId,
        actor: "super@test",
        reason: "Granted against a campaign that was cancelled",
      }),
    );

    const db = await getDb();
    const original = await one(db, "SELECT status, xp_amount FROM reward_transactions WHERE id = ?", [
      granted.rewardTxId,
    ]);
    // The original keeps its amount; only its status moves.
    expect(Number(original?.xp_amount)).toBe(60);
    expect(String(original?.status)).toBe("REVERSED");

    const mirror = await one(
      db,
      "SELECT xp_amount, status FROM reward_transactions WHERE reversal_of = ?",
      [granted.rewardTxId],
    );
    expect(Number(mirror?.xp_amount)).toBe(-60);

    // And the XP is actually gone from the player's total.
    expect((await gamificationProfile({ phone })).level.lifetimeXp).toBe(0);
  });

  // T21
  it("refuses to reverse the same grant twice", async () => {
    const granted = await grant("guarantee:reverse-once", 25);
    await withTx((tx) =>
      reverseReward(tx, {
        rewardTxId: granted.rewardTxId,
        actor: "super@test",
        reason: "First and only reversal",
      }),
    );

    await expect(
      withTx((tx) =>
        reverseReward(tx, {
          rewardTxId: granted.rewardTxId,
          actor: "super@test",
          reason: "Trying it again",
        }),
      ),
    ).rejects.toThrow(/already reversed/i);
  });
});

describe("counter corrections", () => {
  beforeEach(async () => {
    await resetDb();
  });

  // T21. A badge earned on activity that turned out to be fraudulent comes off
  // only when an administrator says so, and the reason goes on the record.
  it("corrects a counter and revokes a badge only when told to", async () => {
    await ingestEvent({
      eventName: "hunt_complete",
      phone,
      source: "test",
      objectId: "att_counter",
      idempotencyKey: "counter:hunt",
    });

    const db = await getDb();
    const wallet = await walletId();
    const before = await one(
      db,
      "SELECT group_key FROM user_achievements WHERE wallet_id = ? AND group_key = 'hunt_master'",
      [wallet],
    );
    expect(before).toBeTruthy();

    // The counter comes down on its own; the badge is untouched, because a
    // counter falling below a threshold is not by itself evidence of anything.
    await withTx((tx) =>
      reverseCounter(tx, {
        walletId: wallet,
        counterKey: "hunt_complete",
        delta: 1,
      }),
    );
    const afterCounter = await one(
      db,
      "SELECT revoked_at FROM user_achievements WHERE wallet_id = ? AND group_key = 'hunt_master'",
      [wallet],
    );
    expect(afterCounter?.revoked_at).toBeFalsy();

    // Revocation is the separate, explicit decision, and it carries a reason.
    await withTx((tx) =>
      revokeBadge(tx, {
        walletId: wallet,
        groupKey: "hunt_master",
        tier: "Bronze",
        reason: "Hunts came from a scripted client",
      }),
    );
    const revoked = await one(
      db,
      "SELECT revoked_at, revoked_reason FROM user_achievements WHERE wallet_id = ? AND group_key = 'hunt_master'",
      [wallet],
    );
    expect(revoked?.revoked_at).toBeTruthy();
    expect(String(revoked?.revoked_reason)).toContain("scripted client");
  });
});
