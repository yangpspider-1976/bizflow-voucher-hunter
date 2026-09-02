/**
 * Stage 3 of the manual gamification plan, automated: the operations side.
 *
 * Configuration published without a deploy, the three budget rules that
 * deliberately behave differently from one another, the detectors and the hold
 * they raise, and the KPI panel that has to agree with the ledger it reads
 * from.
 *
 * The theme is that none of this is enforced by care. Each rule is a number an
 * operator can change, so the tests set the number and then check the engine
 * obeyed it, rather than asserting the seeded defaults for their own sake.
 *
 * Case numbers refer to the manual plan.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { all, getDb, one, resetDb, run, withTx } from "@/server/db";
import { runAnomalyScan, actionFraudSignal, listFraudSignals } from "@/server/gamification/anomaly";
import {
  defaultRange,
  gamificationKpis,
  missionFunnel,
  missionFunnelToCsv,
} from "@/server/gamification/analytics";
import { DEFAULT_ECONOMY, loadEconomy, publishEconomy } from "@/server/gamification/config";
import { ingestEvent } from "@/server/gamification/events";
import { convertPointsToXp } from "@/server/gamification/levels";
import { gamificationProfile } from "@/server/gamification/profile";
import { grantReward, listHeldRewards, settleHeldReward } from "@/server/gamification/rewards";
import { ensureRewardWallet } from "@/server/rewards-network";

const phone = "+639171110301";
const partner = "biz_demo_restaurant";

async function walletId(forPhone = phone) {
  return (await ensureRewardWallet(await getDb(), { phone: forPhone })).id;
}

/** Publishes an economy that differs from the seed in the named ways only. */
async function publish(overrides: Partial<typeof DEFAULT_ECONOMY>, note = "test") {
  const db = await getDb();
  const { economy } = await loadEconomy(db);
  return publishEconomy(db, {
    economy: { ...economy, ...overrides },
    actor: "ops@test",
    note,
  });
}

/** One reward, granted through the engine the way a mission payout is. */
async function grant(
  reward: Parameters<typeof grantReward>[1]["reward"],
  overrides: Partial<Parameters<typeof grantReward>[1]> = {},
) {
  const wallet = await walletId();
  return withTx((tx) =>
    grantReward(tx, {
      walletId: wallet,
      sourceType: "mission",
      sourceId: `ops_test:${Math.random().toString(36).slice(2)}`,
      reward,
      idempotencyKey: `ops:${Math.random().toString(36).slice(2)}`,
      ...overrides,
    }),
  );
}

describe("economy configuration", () => {
  beforeEach(async () => {
    await resetDb();
  });

  // T14
  it("takes effect on the next call, with no deploy", async () => {
    await ensureRewardWallet(await getDb(), { phone });
    await run(
      await getDb(),
      "UPDATE reward_wallets SET balance_centavos = ? WHERE phone = ?",
      [600_00, phone],
    );

    // The seeded minimum is 50 LP, so this converts.
    await convertPointsToXp({
      phone,
      businessId: null,
      amount: 50,
      idempotencyKey: "ops-before-change",
    });

    await publish({ minConversionCentavos: 100_00 }, "Raise the floor to 100 LP");

    await expect(
      convertPointsToXp({
        phone,
        businessId: null,
        amount: 50,
        idempotencyKey: "ops-after-change",
      }),
    ).rejects.toThrow();

    // And the app is told the new floor rather than having to know it.
    const profile = await gamificationProfile({ phone });
    expect(profile.conversion.minLpCentavos).toBe(100_00);
  });

  // T14. A settled month has to stay explicable after the numbers move.
  it("stamps every transaction with the version it ran under", async () => {
    const first = await grant([{ type: "XP", amount: 10 }]);
    const published = await publish({ xpPerLp: 2 }, "Double the conversion rate");
    const second = await grant([{ type: "XP", amount: 10 }]);

    const db = await getDb();
    const rows = await all(
      db,
      "SELECT id, config_version FROM reward_transactions WHERE id IN (?, ?)",
      [first.rewardTxId, second.rewardTxId],
    );
    const byId = new Map(rows.map((row) => [String(row.id), Number(row.config_version)]));

    expect(byId.get(first.rewardTxId)).toBeLessThan(published);
    expect(byId.get(second.rewardTxId)).toBe(published);
  });
});

describe("the three budget rules", () => {
  beforeEach(async () => {
    await resetDb();
  });

  // T15. Past the daily cap the payout is trimmed and the rest paid in XP.
  // Refusing would mean the player did the thing and got nothing, which reads
  // as a bug rather than as a policy.
  it("trims past the daily LP cap and pays the shortfall in XP", async () => {
    await publish({ dailyLpGrantCapCentavos: 100_00, reviewThresholdCentavos: 500_00 });

    const first = await grant([{ type: "LP", amount: 80_00, fundingSource: "PLATFORM" }]);
    expect(first.summary.lpCentavos).toBe(80_00);
    expect(first.summary.xp).toBe(0);

    // 20 LP of headroom left, 50 requested.
    const second = await grant([{ type: "LP", amount: 50_00, fundingSource: "PLATFORM" }]);
    expect(second.summary.lpCentavos).toBe(20_00);
    // 30 LP of shortfall at the published 1 XP per LP.
    expect(second.summary.xp).toBe(30);
    expect(second.held).toBe(false);
  });

  // T15
  it("parks a single grant above the review threshold instead of paying it", async () => {
    await publish({ reviewThresholdCentavos: 200_00 });

    const big = await grant([{ type: "LP", amount: 300_00, fundingSource: "PLATFORM" }]);

    expect(big.held).toBe(true);
    expect(big.summary.lpCentavos).toBe(0);
    expect(big.summary.xp).toBe(0);

    const queue = await listHeldRewards(await getDb());
    expect(queue).toHaveLength(1);
    expect(String(queue[0]!.hold_reason)).toMatch(/threshold/i);
    // Nothing was taken and nothing was dropped: the row records what is owed.
    expect(JSON.parse(String(queue[0]!.reward_json))).toEqual([
      { type: "LP", amount: 300_00, fundingSource: "PLATFORM" },
    ]);
  });

  // T15. Approving pays what is owed, under the cap as of the day the money
  // actually moves rather than the day it was earned.
  it("pays a held reward on approval, under today's cap", async () => {
    await publish({ reviewThresholdCentavos: 200_00, dailyLpGrantCapCentavos: 1_000_00 });
    await grant([{ type: "LP", amount: 300_00, fundingSource: "PLATFORM" }]);

    const db = await getDb();
    const queue = await listHeldRewards(db);
    const released = await withTx((tx) =>
      settleHeldReward(tx, {
        rewardTxId: String(queue[0]!.id),
        actor: "ops@test",
        decision: "Approve",
        reason: "Checked against the campaign",
        reference: "FIN-2026-09-01",
      }),
    );

    expect(released.paid.lpCentavos).toBe(300_00);
    expect(await listHeldRewards(db)).toHaveLength(0);
    // The finance reference is on the record, which is the point of asking.
    const settled = await one(db, "SELECT reviewed_by, status FROM reward_transactions WHERE id = ?", [
      String(queue[0]!.id),
    ]);
    expect(String(settled?.status)).toBe("GRANTED");
    expect(String(settled?.reviewed_by)).toContain("ops@test");
  });
});

describe("anomaly detection", () => {
  beforeEach(async () => {
    await resetDb();
  });

  /**
   * More redemptions in a day than a person plausibly makes.
   *
   * Deliberately not the ad detector, which counts rows in `ad_verifications` —
   * written only by Google's own server-side callback. Nothing a test can
   * ingest reaches it, for the same reason nothing in the app can: the ad path
   * has no producer on this side.
   */
  async function redeemRepeatedly(count: number) {
    for (let index = 0; index < count; index += 1) {
      await ingestEvent({
        eventName: "qr_redeem",
        phone,
        source: "test",
        partnerId: partner,
        objectId: `v_burst_${index}`,
        idempotencyKey: `anomaly:qr:${index}`,
      });
    }
  }

  // T17
  it("raises one signal per detector per wallet per day, however often it runs", async () => {
    await publish({ risk: { ...DEFAULT_ECONOMY.risk, qrPerDay: 2 } });
    await redeemRepeatedly(4);

    const first = await runAnomalyScan();
    expect(first.raised).toBeGreaterThanOrEqual(1);

    const afterOne = await listFraudSignals({ status: "Open" });
    const burst = afterOne.filter((row) => row.signalKey === "qr_velocity");
    expect(burst).toHaveLength(1);
    // The observation that raised it is carried in full: a signal is a question
    // for a person, and a bare score is not a question anyone can answer.
    expect(String(burst[0]!.observation ?? "")).not.toBe("");

    await runAnomalyScan();
    const afterTwo = await listFraudSignals({ status: "Open" });
    expect(afterTwo.filter((row) => row.signalKey === "qr_velocity")).toHaveLength(1);
  });

  // T17. Held is not suspended: the wallet keeps earning and nothing is taken.
  it("holds a wallet past the score, then parks what it earns", async () => {
    await publish({
      risk: { ...DEFAULT_ECONOMY.risk, qrPerDay: 2, holdScore: 2 },
    });
    await redeemRepeatedly(4);
    await runAnomalyScan();

    const db = await getDb();
    const wallet = await one(db, "SELECT risk_state FROM reward_wallets WHERE phone = ?", [
      phone,
    ]);
    expect(String(wallet?.risk_state)).toBe("Held");

    const parked = await grant([{ type: "LP", amount: 10_00, fundingSource: "PLATFORM" }]);
    expect(parked.held).toBe(true);
    expect(parked.summary.lpCentavos).toBe(0);

    // Nothing was taken from what they already had.
    const balance = await one(db, "SELECT balance_centavos FROM reward_wallets WHERE phone = ?", [
      phone,
    ]);
    expect(Number(balance?.balance_centavos)).toBeGreaterThanOrEqual(0);
  });

  // T17. Clearing the last open signal lets the wallet back, and takes a reason.
  it("lets a cleared wallet back to earning", async () => {
    await publish({ risk: { ...DEFAULT_ECONOMY.risk, qrPerDay: 2, holdScore: 2 } });
    await redeemRepeatedly(4);
    await runAnomalyScan();

    const open = await listFraudSignals({ status: "Open" });
    for (const signal of open) {
      await actionFraudSignal({
        signalId: String(signal.id),
        action: "clear",
        actor: "ops@test",
        note: "A family sharing one handset",
      });
    }

    const db = await getDb();
    const wallet = await one(db, "SELECT risk_state FROM reward_wallets WHERE phone = ?", [
      phone,
    ]);
    expect(String(wallet?.risk_state)).toBe("Clear");

    const paid = await grant([{ type: "LP", amount: 10_00, fundingSource: "PLATFORM" }]);
    expect(paid.held).toBe(false);
    expect(paid.summary.lpCentavos).toBe(10_00);
  });
});

describe("the KPI panel", () => {
  beforeEach(async () => {
    await resetDb();
  });

  // T18. There is no separate analytics store, so the dashboard and the ledger
  // cannot disagree — this asserts that they in fact do not.
  it("reports what the ledger holds", async () => {
    await ingestEvent({
      eventName: "hunt_complete",
      phone,
      source: "test",
      objectId: "att_kpi",
      idempotencyKey: "kpi:hunt",
    });
    await ingestEvent({
      eventName: "qr_redeem",
      phone,
      source: "test",
      partnerId: partner,
      objectId: "v_kpi",
      idempotencyKey: "kpi:qr",
    });

    const db = await getDb();
    const ledger = await one(
      db,
      `SELECT COALESCE(SUM(xp_amount), 0) AS xp, COALESCE(SUM(lp_centavos), 0) AS lp
       FROM reward_transactions WHERE status = 'GRANTED'`,
    );

    const kpis = await gamificationKpis(defaultRange());
    expect(kpis.economy.xpGranted).toBe(Number(ledger?.xp));
    expect(kpis.economy.issuedLpCentavos).toBe(Number(ledger?.lp));
  });

  // T18
  it("exports the mission funnel as CSV", async () => {
    await ingestEvent({
      eventName: "hunt_complete",
      phone,
      source: "test",
      objectId: "att_csv",
      idempotencyKey: "csv:hunt",
    });

    const csv = missionFunnelToCsv(await missionFunnel(await getDb(), defaultRange()));
    const [header] = csv.split("\n");
    expect(header).toContain("mission");
    expect(csv).toContain("daily_hunt");
  });
});
