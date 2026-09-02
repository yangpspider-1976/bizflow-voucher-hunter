import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDb, one, resetDb } from "@/server/db";
import { markUnlocksSeen } from "@/server/gamification/achievements";
import { runBackfillToCompletion, startBackfill } from "@/server/gamification/backfill";
import { ingestEvent } from "@/server/gamification/events";
import { gamificationProfile } from "@/server/gamification/profile";
import { ensureRewardWallet } from "@/server/rewards-network";
import { huntAndSelect } from "../helpers";

const phone = "+639171110003";
const restaurant = "biz_demo_restaurant";

async function card(groupKey: string) {
  const profile = await gamificationProfile({ phone });
  return profile.achievements.find((entry) => entry.groupKey === groupKey);
}

async function qrRedeem(objectId: string, partnerId: string) {
  return ingestEvent({
    eventName: "qr_redeem",
    phone,
    source: "test",
    partnerId,
    objectType: "voucher",
    objectId,
    idempotencyKey: `qr_redeem:voucher:${objectId}`,
  });
}

describe("achievements", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("unlocks a tier the moment its threshold is crossed, once", async () => {
    const first = await qrRedeem("v1", restaurant);
    expect(first.unlocked.map((notice) => `${notice.groupKey}:${notice.tier}`)).toContain(
      "voucher_user:Bronze",
    );

    const again = await qrRedeem("v2", restaurant);
    expect(
      again.unlocked.some((notice) => notice.groupKey === "voucher_user"),
    ).toBe(false);

    const voucherUser = await card("voucher_user");
    expect(voucherUser?.progress).toBe(2);
    expect(voucherUser?.unlockedTiers).toBe(1);
    expect(voucherUser?.nextTier?.tier).toBe("Silver");
    expect(voucherUser?.nextTier?.threshold).toBe(5);
  });

  it("pays the tier reward exactly once", async () => {
    await qrRedeem("v1", restaurant);
    await qrRedeem("v1", restaurant); // same fact, redelivered

    const db = await getDb();
    const wallet = await ensureRewardWallet(db, { phone });
    const grants = await one(
      db,
      `SELECT COUNT(*) AS total FROM reward_transactions
       WHERE wallet_id = ? AND source_type = 'achievement' AND source_id = 'voucher_user:Bronze'`,
      [wallet.id],
    );
    expect(Number(grants?.total)).toBe(1);
  });

  it("counts distinct partners for City Explorer, not repeat visits", async () => {
    await qrRedeem("v1", restaurant);
    await qrRedeem("v2", restaurant);
    await qrRedeem("v3", restaurant);
    expect((await card("city_explorer"))?.progress).toBe(1);

    const db = await getDb();
    const others = (
      await db.execute({
        sql: "SELECT id FROM businesses WHERE id <> ? ORDER BY id LIMIT 2",
        args: [restaurant],
      })
    ).rows as Array<{ id: string }>;

    for (const [index, business] of others.entries()) {
      await qrRedeem(`vx${index}`, String(business.id));
    }
    expect((await card("city_explorer"))?.progress).toBe(1 + others.length);
  });

  it("advances the daily streak once per Manila day and resets after a gap", async () => {
    await ingestEvent({
      eventName: "hunt_complete",
      phone,
      source: "test",
      objectId: "s1",
      idempotencyKey: "hunt:s1",
    });
    await ingestEvent({
      eventName: "voucher_select",
      phone,
      source: "test",
      objectId: "s2",
      idempotencyKey: "voucher:s2",
    });
    // Two missions, one day: the streak is 1, not 2.
    expect((await card("daily_streak"))?.progress).toBe(1);

    vi.setSystemTime(new Date("2026-07-04T02:00:00.000Z"));
    await ingestEvent({
      eventName: "hunt_complete",
      phone,
      source: "test",
      objectId: "s3",
      idempotencyKey: "hunt:s3",
    });
    expect((await card("daily_streak"))?.progress).toBe(2);

    // Skip the 5th entirely.
    vi.setSystemTime(new Date("2026-07-06T02:00:00.000Z"));
    await ingestEvent({
      eventName: "hunt_complete",
      phone,
      source: "test",
      objectId: "s4",
      idempotencyKey: "hunt:s4",
    });
    expect((await card("daily_streak"))?.progress).toBe(1);
  });

  it("crosses several tiers at once without paying any of them twice", async () => {
    for (let index = 0; index < 5; index += 1) {
      await qrRedeem(`bulk${index}`, restaurant);
    }
    const voucherUser = await card("voucher_user");
    expect(voucherUser?.unlockedTiers).toBe(2);

    const db = await getDb();
    const wallet = await ensureRewardWallet(db, { phone });
    const grants = await one(
      db,
      `SELECT COUNT(*) AS total FROM reward_transactions
       WHERE wallet_id = ? AND source_type = 'achievement'`,
      [wallet.id],
    );
    // Bronze and Silver for Voucher User, Bronze for City Explorer, and the
    // mission-completion tiers the QR mission earned along the way. Whatever
    // the total, each source_id appears once.
    const distinct = await one(
      db,
      `SELECT COUNT(DISTINCT source_id) AS total FROM reward_transactions
       WHERE wallet_id = ? AND source_type = 'achievement'`,
      [wallet.id],
    );
    expect(Number(grants?.total)).toBe(Number(distinct?.total));
  });

  it("shows an unlock as unseen until the app acknowledges it", async () => {
    await qrRedeem("v1", restaurant);
    const before = await gamificationProfile({ phone });
    expect(before.unseenUnlocks.length).toBeGreaterThan(0);

    const db = await getDb();
    const wallet = await ensureRewardWallet(db, { phone });
    await markUnlocksSeen(db, wallet.id);

    expect((await gamificationProfile({ phone })).unseenUnlocks).toHaveLength(0);
  });
});

describe("achievement backfill", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("gives an existing player credit for history that predates the feature", async () => {
    // A real hunt, played before any of this existed as far as the counters
    // are concerned: the wallet has no progress rows at all.
    await huntAndSelect({ campaignSlug: "july-dinner", phone });
    const db = await getDb();
    const wallet = await ensureRewardWallet(db, { phone });
    await db.execute({
      sql: "DELETE FROM user_achievement_progress WHERE wallet_id = ?",
      args: [wallet.id],
    });
    await db.execute({
      sql: "DELETE FROM user_achievements WHERE wallet_id = ?",
      args: [wallet.id],
    });

    const job = await startBackfill({ actor: "ops@test", note: "release backfill" });
    const finished = await runBackfillToCompletion({ jobId: job.id, budgetMs: 5_000 });

    expect(finished.done).toBe(true);
    expect(finished.job.status).toBe("Completed");
    expect((await card("hunt_master"))?.progress).toBeGreaterThan(0);
  });

  it("is safe to run twice", async () => {
    await huntAndSelect({ campaignSlug: "july-dinner", phone });
    // The backfill walks reward_wallets, and playing a hunt does not open one.
    // Without this the first pass has nothing to process and reading the card
    // afterwards creates the wallet, so the second pass does the work the first
    // did not — which looks like the run being unrepeatable rather than the
    // wallet arriving late.
    await ensureRewardWallet(await getDb(), { phone });

    const first = await startBackfill({ actor: "ops@test" });
    await runBackfillToCompletion({ jobId: first.id, budgetMs: 5_000 });
    const afterFirst = await card("hunt_master");

    const second = await startBackfill({ actor: "ops@test" });
    await runBackfillToCompletion({ jobId: second.id, budgetMs: 5_000 });
    const afterSecond = await card("hunt_master");

    expect(afterSecond?.progress).toBe(afterFirst?.progress);
    expect(afterSecond?.unlockedTiers).toBe(afterFirst?.unlockedTiers);
  });
});
