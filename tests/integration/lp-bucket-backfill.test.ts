import { beforeEach, describe, expect, it } from "vitest";
import {
  all,
  backfillPartnerLoyaltyBuckets,
  getDb,
  one,
  resetDb,
  run,
} from "@/server/db";
import {
  creditRewardFromPurchase,
  getOrCreateRewardWallet,
} from "@/server/rewards-network";

const phone = "+639171117777";
const restaurant = "biz_demo_restaurant";
const shop = "biz_demo_shop";

/**
 * Wallets that earned before per-partner buckets existed.
 *
 * The credit lands in the global pot and writes the ledger row the old code
 * wrote — carrying its `business_id`, with no bucket row anywhere. That row is
 * the only record of where the points came from, and the whole backfill is
 * built on it.
 */
async function earnedBeforeTheSplit(
  walletId: string,
  businessId: string,
  centavos: number,
) {
  const db = await getDb();
  await run(
    db,
    `UPDATE reward_wallets
     SET balance_centavos = balance_centavos + ?,
         lifetime_earned_centavos = lifetime_earned_centavos + ?
     WHERE id = ?`,
    [centavos, centavos, walletId],
  );
  const balance = Number(
    (await one(db, "SELECT balance_centavos FROM reward_wallets WHERE id = ?", [
      walletId,
    ]))?.balance_centavos,
  );
  await run(
    db,
    `INSERT INTO reward_ledger_entries
     (id, wallet_id, type, delta_centavos, balance_after_centavos, source_type, source_id, business_id, staff_name, metadata, created_at)
     VALUES (?, ?, 'credit_earned', ?, ?, 'staff_scan_purchase', ?, ?, 'legacy staff', NULL, ?)`,
    [
      `rled_legacy_${businessId}_${centavos}`,
      walletId,
      centavos,
      balance,
      `rpur_legacy_${businessId}`,
      businessId,
      new Date().toISOString(),
    ],
  );
}

async function bucketCentavos(walletId: string, businessId: string) {
  const row = await one(
    await getDb(),
    "SELECT balance_centavos FROM reward_business_balances WHERE wallet_id = ? AND business_id = ?",
    [walletId, businessId],
  );
  return Number(row?.balance_centavos ?? 0);
}

async function globalCentavos(walletId: string) {
  const row = await one(
    await getDb(),
    "SELECT balance_centavos FROM reward_wallets WHERE id = ?",
    [walletId],
  );
  return Number(row?.balance_centavos ?? 0);
}

describe("partner bucket backfill", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("moves partner earnings into buckets and leaves the rest global", async () => {
    // The wallet opens with its daily app-use credit — a 1-10 LP draw — which
    // was never earned at a partner. Every figure below is relative to it.
    const created = await getOrCreateRewardWallet({ phone });
    const walletId = created.wallet.id;
    const daily = await globalCentavos(walletId);
    await earnedBeforeTheSplit(walletId, restaurant, 500_00);
    await earnedBeforeTheSplit(walletId, shop, 200_00);
    expect(await globalCentavos(walletId)).toBe(daily + 700_00);

    const result = await backfillPartnerLoyaltyBuckets();
    expect(result).toMatchObject({ wallets: 1, movedCentavos: 700_00 });

    expect(await bucketCentavos(walletId, restaurant)).toBe(500_00);
    expect(await bucketCentavos(walletId, shop)).toBe(200_00);
    // The daily reward stays where the holder can still spend it anywhere.
    expect(await globalCentavos(walletId)).toBe(daily);

    // Both sides of every movement are on the ledger, so a holder watching
    // their global balance fall can see where it went.
    const entries = await all(
      await getDb(),
      `SELECT type, delta_centavos, business_id
       FROM reward_ledger_entries
       WHERE wallet_id = ? AND source_type = 'partner_bucket_backfill'
       ORDER BY type, delta_centavos`,
      [walletId],
    );
    expect(entries).toHaveLength(4);
    expect(
      entries
        .filter((entry) => entry.type === "backfill_in")
        .map((entry) => [entry.business_id, Number(entry.delta_centavos)]),
    ).toEqual([
      [shop, 200_00],
      [restaurant, 500_00],
    ]);
    expect(
      entries
        .filter((entry) => entry.type === "backfill_out")
        .every((entry) => entry.business_id === null),
    ).toBe(true);
  });

  it("caps at what is left after spending and splits it pro rata", async () => {
    const created = await getOrCreateRewardWallet({ phone });
    const walletId = created.wallet.id;
    const daily = await globalCentavos(walletId);
    await earnedBeforeTheSplit(walletId, restaurant, 500_00);
    await earnedBeforeTheSplit(walletId, shop, 200_00);

    // The holder spent the pot down to 290 LP of partner-attributable points
    // plus their own daily credit. Nothing records whose points were spent, so
    // what is left to a partner is divided in the ratio the two are owed.
    await run(
      await getDb(),
      "UPDATE reward_wallets SET balance_centavos = ? WHERE id = ?",
      [daily + 290_00, walletId],
    );

    const result = await backfillPartnerLoyaltyBuckets();
    expect(result).toMatchObject({ wallets: 1, movedCentavos: 290_00 });

    // 5:2, with the rounding centavo going to the larger side so the parts add
    // up to exactly what left the global pot.
    expect(await bucketCentavos(walletId, restaurant)).toBe(207_15);
    expect(await bucketCentavos(walletId, shop)).toBe(82_85);
    expect(await globalCentavos(walletId)).toBe(daily);
  });

  it("never moves the same points twice", async () => {
    const created = await getOrCreateRewardWallet({ phone });
    const walletId = created.wallet.id;
    const daily = await globalCentavos(walletId);
    await earnedBeforeTheSplit(walletId, restaurant, 500_00);
    await backfillPartnerLoyaltyBuckets();

    // Forced past the completion flag: the flag saves a scan, but it is the
    // arithmetic that has to be safe — two instances can cold-start at once,
    // and a restored backup can be migrated again.
    const again = await backfillPartnerLoyaltyBuckets({ force: true });
    expect(again).toMatchObject({ wallets: 0, movedCentavos: 0 });
    expect(await bucketCentavos(walletId, restaurant)).toBe(500_00);
    expect(await globalCentavos(walletId)).toBe(daily);
  });

  it("leaves a wallet that earned after the split alone", async () => {
    const created = await getOrCreateRewardWallet({ phone });
    const walletId = created.wallet.id;
    const daily = await globalCentavos(walletId);
    await creditRewardFromPurchase({
      walletToken: created.wallet.walletToken,
      businessId: restaurant,
      purchaseAmount: "4000",
      staffName: "staff@bizflow.local",
      idempotencyKey: "backfill-post-split-scan",
    });
    expect(await bucketCentavos(walletId, restaurant)).toBe(200_00);

    const result = await backfillPartnerLoyaltyBuckets({ force: true });
    expect(result).toMatchObject({ wallets: 0, movedCentavos: 0 });
    // The credit was already in its bucket, and the daily reward is still the
    // holder's to spend anywhere.
    expect(await bucketCentavos(walletId, restaurant)).toBe(200_00);
    expect(await globalCentavos(walletId)).toBe(daily);
  });

  it("moves nothing when spending already drained the pot", async () => {
    const created = await getOrCreateRewardWallet({ phone });
    const walletId = created.wallet.id;
    const daily = await globalCentavos(walletId);
    await earnedBeforeTheSplit(walletId, restaurant, 500_00);
    // Nothing left beyond the daily reward the holder earned themselves: there
    // is nothing a partner can claim without taking spend-anywhere points off
    // the holder.
    await run(
      await getDb(),
      "UPDATE reward_wallets SET balance_centavos = ? WHERE id = ?",
      [daily, walletId],
    );

    expect(await backfillPartnerLoyaltyBuckets()).toMatchObject({
      wallets: 0,
      movedCentavos: 0,
    });
    expect(await bucketCentavos(walletId, restaurant)).toBe(0);
    expect(await globalCentavos(walletId)).toBe(daily);
  });
});
