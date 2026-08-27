import { beforeEach, describe, expect, it } from "vitest";
import { getDb, one, resetDb, run } from "@/server/db";
import { AppError } from "@/server/errors";
import { convertPointsToXp, levelStateFor } from "@/server/gamification/levels";
import { gamificationProfile } from "@/server/gamification/profile";
import { ensureRewardWallet } from "@/server/rewards-network";

const phone = "+639171110001";
const businessId = "biz_demo_restaurant";

/** Puts LP in a pot directly; the earning paths have their own tests. */
async function seedLp(pot: "global" | "partner", centavos: number) {
  const db = await getDb();
  const wallet = await ensureRewardWallet(db, { phone });
  if (pot === "global") {
    await run(db, "UPDATE reward_wallets SET balance_centavos = ? WHERE id = ?", [
      centavos,
      wallet.id,
    ]);
  } else {
    await run(
      db,
      `INSERT INTO reward_business_balances
       (id, wallet_id, business_id, balance_centavos, lifetime_earned_centavos, lifetime_transferred_centavos, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?)
       ON CONFLICT (wallet_id, business_id)
       DO UPDATE SET balance_centavos = EXCLUDED.balance_centavos`,
      [
        `rbb_test_${wallet.id}`,
        wallet.id,
        businessId,
        centavos,
        centavos,
        new Date().toISOString(),
        new Date().toISOString(),
      ],
    );
  }
  return wallet;
}

describe("LP to XP conversion", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("debits the pot, credits XP and recalculates the level in one go", async () => {
    const wallet = await seedLp("global", 600_00);

    const result = await convertPointsToXp({
      phone,
      businessId: null,
      amount: 500,
      idempotencyKey: "test-convert-1",
    });

    expect(result.xpGranted).toBe(500);
    expect(result.lpDebitedCentavos).toBe(500_00);
    expect(result.leveledUp).toBe(true);
    expect(result.previousLevel).toBe(1);
    expect(result.level.level).toBe(2);
    expect(result.level.name).toBe("Hunter");

    const db = await getDb();
    const balance = await one(db, "SELECT balance_centavos FROM reward_wallets WHERE id = ?", [
      wallet.id,
    ]);
    expect(Number(balance?.balance_centavos)).toBe(100_00);

    const ledger = await one(
      db,
      "SELECT * FROM reward_ledger_entries WHERE wallet_id = ? AND type = 'level_conversion'",
      [wallet.id],
    );
    expect(Number(ledger?.delta_centavos)).toBe(-500_00);

    const xp = await one(db, "SELECT * FROM user_xp_ledger WHERE wallet_id = ?", [wallet.id]);
    expect(Number(xp?.delta)).toBe(500);
    expect(Number(xp?.balance_after)).toBe(500);
  });

  it("refuses to convert more than the pot holds and leaves it untouched", async () => {
    const wallet = await seedLp("global", 100_00);

    await expect(
      convertPointsToXp({
        phone,
        businessId: null,
        amount: 500,
        idempotencyKey: "test-convert-short",
      }),
    ).rejects.toMatchObject({ code: "E-INSUFFICIENT-POINTS" });

    const db = await getDb();
    const balance = await one(db, "SELECT balance_centavos FROM reward_wallets WHERE id = ?", [
      wallet.id,
    ]);
    expect(Number(balance?.balance_centavos)).toBe(100_00);
    expect((await levelStateFor(db, wallet.id)).lifetimeXp).toBe(0);
  });

  it("refuses an amount below the published minimum", async () => {
    await seedLp("global", 100_00);
    await expect(
      convertPointsToXp({
        phone,
        businessId: null,
        amount: 10,
        idempotencyKey: "test-convert-tiny",
      }),
    ).rejects.toBeInstanceOf(AppError);
  });

  it("returns the original result for a repeated idempotency key", async () => {
    const wallet = await seedLp("global", 1_000_00);

    const first = await convertPointsToXp({
      phone,
      businessId: null,
      amount: 500,
      idempotencyKey: "test-convert-repeat",
    });
    const second = await convertPointsToXp({
      phone,
      businessId: null,
      amount: 500,
      idempotencyKey: "test-convert-repeat",
    });

    expect(second.conversionId).toBe(first.conversionId);
    expect(second.xpGranted).toBe(first.xpGranted);

    const db = await getDb();
    const balance = await one(db, "SELECT balance_centavos FROM reward_wallets WHERE id = ?", [
      wallet.id,
    ]);
    // Debited once, not twice.
    expect(Number(balance?.balance_centavos)).toBe(500_00);
    expect((await levelStateFor(db, wallet.id)).lifetimeXp).toBe(500);
  });

  it("does not double-debit when the same tap arrives twice at once", async () => {
    const wallet = await seedLp("global", 1_000_00);

    const results = await Promise.allSettled([
      convertPointsToXp({
        phone,
        businessId: null,
        amount: 500,
        idempotencyKey: "test-convert-race-a",
      }),
      convertPointsToXp({
        phone,
        businessId: null,
        amount: 500,
        idempotencyKey: "test-convert-race-b",
      }),
    ]);

    const db = await getDb();
    const balance = Number(
      (await one(db, "SELECT balance_centavos FROM reward_wallets WHERE id = ?", [wallet.id]))
        ?.balance_centavos,
    );
    const succeeded = results.filter((result) => result.status === "fulfilled").length;
    // Whatever the interleaving, LP out and XP in have to agree.
    expect(balance).toBe(1_000_00 - succeeded * 500_00);
    expect((await levelStateFor(db, wallet.id)).lifetimeXp).toBe(succeeded * 500);
  });

  it("records the partner a conversion drew from, for the settlement line", async () => {
    const wallet = await seedLp("partner", 800_00);

    await convertPointsToXp({
      phone,
      businessId,
      amount: 500,
      idempotencyKey: "test-convert-partner",
    });

    const db = await getDb();
    const conversion = await one(
      db,
      "SELECT * FROM point_xp_conversions WHERE wallet_id = ?",
      [wallet.id],
    );
    expect(String(conversion?.business_id)).toBe(businessId);

    const bucket = await one(
      db,
      "SELECT balance_centavos FROM reward_business_balances WHERE wallet_id = ? AND business_id = ?",
      [wallet.id, businessId],
    );
    expect(Number(bucket?.balance_centavos)).toBe(300_00);

    const ledger = await one(
      db,
      `SELECT * FROM reward_ledger_entries
       WHERE wallet_id = ? AND type = 'level_conversion' AND business_id = ?`,
      [wallet.id, businessId],
    );
    expect(JSON.parse(String(ledger?.metadata)).settlementLine).toBe("Level Conversion");
  });

  it("stores the economy version the conversion ran under", async () => {
    await seedLp("global", 600_00);
    await convertPointsToXp({
      phone,
      businessId: null,
      amount: 500,
      idempotencyKey: "test-convert-version",
    });

    const db = await getDb();
    const conversion = await one(db, "SELECT config_version FROM point_xp_conversions LIMIT 1");
    expect(Number(conversion?.config_version)).toBeGreaterThan(0);
  });

  it("unlocks the Level Investor achievement the conversion earns", async () => {
    await seedLp("global", 200_00);
    await convertPointsToXp({
      phone,
      businessId: null,
      amount: 100,
      idempotencyKey: "test-convert-investor",
    });

    const profile = await gamificationProfile({ phone });
    const investor = profile.achievements.find((card) => card.groupKey === "level_investor");
    expect(investor?.progress).toBe(100);
    expect(investor?.tiers.find((tier) => tier.tier === "Bronze")?.unlocked).toBe(true);
    expect(investor?.tiers.find((tier) => tier.tier === "Silver")?.unlocked).toBe(false);
  });
});
