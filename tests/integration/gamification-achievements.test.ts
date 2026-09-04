import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDb, one, resetDb, run } from "@/server/db";
import {
  featuredBadges,
  markUnlocksSeen,
  setBadgeFeatured,
} from "@/server/gamification/achievements";
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

/**
 * §5.3's "select 1-3 featured badges".
 *
 * The cap and the eligibility rule live on the server because the app is not
 * the authority on either, so these are the tests that matter: a fourth badge
 * refused, a locked badge refused, a revoked badge falling off the profile on
 * its own, and a double tap not reordering the row.
 */
describe("featured badges", () => {
  beforeEach(async () => {
    await resetDb();
  });

  /** Unlocks Bronze on four different groups, so there are four to choose from. */
  async function unlockFour() {
    await qrRedeem("f1", restaurant); // voucher_user Bronze
    await ingestEvent({
      eventName: "hunt_complete",
      phone,
      source: "test",
      objectId: "att_f1",
      idempotencyKey: "hunt_complete:att_f1",
    });
    await ingestEvent({
      eventName: "review_verified",
      phone,
      source: "test",
      objectId: "rev_f1",
      idempotencyKey: "review_verified:rev_f1",
    });
    await ingestEvent({
      eventName: "referral_verified",
      phone,
      source: "test",
      objectId: "ref_f1",
      idempotencyKey: "referral_verified:ref_f1",
    });
    return (await ensureRewardWallet(await getDb(), { phone })).id;
  }

  it("features a badge and reports it back on the card", async () => {
    const walletId = await unlockFour();

    const result = await setBadgeFeatured({
      walletId,
      groupKey: "voucher_user",
      tier: "Bronze",
      featured: true,
    });
    expect(result.featured).toHaveLength(1);

    const shown = await card("voucher_user");
    expect(shown?.tiers.find((tier) => tier.tier === "Bronze")?.featured).toBe(true);
    // The others are untouched rather than defaulted to featured.
    const other = await card("hunt_master");
    expect(other?.tiers.find((tier) => tier.tier === "Bronze")?.featured).toBeFalsy();
  });

  it("refuses a fourth badge and keeps the three already chosen", async () => {
    const walletId = await unlockFour();
    for (const groupKey of ["voucher_user", "hunt_master", "reviewer"]) {
      await setBadgeFeatured({ walletId, groupKey, tier: "Bronze", featured: true });
    }

    await expect(
      setBadgeFeatured({ walletId, groupKey: "connector", tier: "Bronze", featured: true }),
    ).rejects.toMatchObject({ code: "E-ALREADY-COMPLETED" });

    expect(await featuredBadges(await getDb(), walletId)).toHaveLength(3);
  });

  it("refuses a badge the player has not unlocked", async () => {
    const walletId = await unlockFour();
    await expect(
      setBadgeFeatured({ walletId, groupKey: "voucher_user", tier: "Royal", featured: true }),
    ).rejects.toMatchObject({ code: "E-NOT-ELIGIBLE" });
  });

  it("keeps its place when the same badge is tapped twice", async () => {
    const walletId = await unlockFour();
    const first = await setBadgeFeatured({
      walletId,
      groupKey: "voucher_user",
      tier: "Bronze",
      featured: true,
    });
    await setBadgeFeatured({ walletId, groupKey: "hunt_master", tier: "Bronze", featured: true });
    // A second tap on the first badge must not move it to the end of the row.
    await setBadgeFeatured({ walletId, groupKey: "voucher_user", tier: "Bronze", featured: true });

    const row = await featuredBadges(await getDb(), walletId);
    expect(row.map((entry) => entry.groupKey)).toEqual(["voucher_user", "hunt_master"]);
    expect(row[0]?.featuredAt).toBe(first.featured[0]?.featuredAt);
  });

  it("un-features on the second call, and says so", async () => {
    const walletId = await unlockFour();
    await setBadgeFeatured({ walletId, groupKey: "voucher_user", tier: "Bronze", featured: true });
    const cleared = await setBadgeFeatured({
      walletId,
      groupKey: "voucher_user",
      tier: "Bronze",
      featured: false,
    });

    expect(cleared.featured).toHaveLength(0);
    // Clearing what is not featured is a no-op rather than an error: the same
    // tap arriving twice must not turn into a failure the player can see.
    await expect(
      setBadgeFeatured({ walletId, groupKey: "voucher_user", tier: "Bronze", featured: false }),
    ).resolves.toMatchObject({ featured: [] });
  });

  it("drops a revoked badge off the profile without being asked", async () => {
    const walletId = await unlockFour();
    await setBadgeFeatured({ walletId, groupKey: "voucher_user", tier: "Bronze", featured: true });

    await run(
      await getDb(),
      `UPDATE user_achievements SET revoked_at = ?, revoked_reason = ?
       WHERE wallet_id = ? AND group_key = ? AND tier = ?`,
      [new Date().toISOString(), "abuse", walletId, "voucher_user", "Bronze"],
    );

    // The revocation is the only write; nothing had to remember to tidy the
    // profile, because the read only ever counted unrevoked rows.
    expect(await featuredBadges(await getDb(), walletId)).toHaveLength(0);
  });
});
