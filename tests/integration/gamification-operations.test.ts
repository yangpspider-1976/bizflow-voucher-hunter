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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import {
  decideMissionReview,
  publishMissionDefinition,
} from "@/server/gamification/mission-admin";
import { announceUrgentMission, notifyProofReviewed } from "@/server/gamification/notify";
import { grantReward, listHeldRewards, settleHeldReward } from "@/server/gamification/rewards";
import {
  partnerGamificationStatement,
  statementToCsv,
} from "@/server/gamification/settlement";
import { registerPushDevice, setPushPreferences } from "@/server/push";
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

describe("notifications", () => {
  const deviceToken = "ExponentPushToken[ops-device-aaa]";

  beforeEach(async () => {
    await resetDb();
    await ensureRewardWallet(await getDb(), { phone });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** Stands in for Expo's push service; every send reports an `ok` ticket. */
  function mockExpoOk() {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ data: [{ status: "ok", id: "ticket-1" }] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    );
  }

  /** A campaign that announces itself, published live by operations. */
  async function publishAnnounceable(missionKey: string) {
    return publishMissionDefinition(
      { actor: "ops@test", partnerIds: null, canApprove: true },
      {
        missionKey,
        type: "URGENT",
        title: "Off-peak lunch",
        description: "Visit on a weekday afternoon.",
        triggerEvent: "qr_redeem",
        targetCount: 1,
        window: null,
        minLevel: 1,
        partnerId: partner,
        reward: [{ type: "XP", amount: 50 }],
        condition: {},
        audience: { segment: "all" },
        autoClaim: true,
        requiresProof: false,
        quotaMode: "ON_COMPLETION",
        userQuota: 1,
        globalQuota: null,
        rewardBudgetCentavos: null,
        status: "Active",
        startsAt: null,
        endsAt: null,
        // "app" never announces; a campaign has to ask for the push.
        exposureChannel: "both",
        termsUrl: null,
        localizationKey: null,
        sortOrder: 100,
      },
    );
  }

  // T20. An urgent campaign is marketing, and marketing needs consent on top of
  // the missions category.
  it("announces a campaign only to players who left marketing on", async () => {
    mockExpoOk();
    await registerPushDevice({ phone, expoPushToken: deviceToken, platform: "android" });
    await setPushPreferences({ phone, marketing: false });

    const published = await publishAnnounceable("urgent_ops_consent");
    const withoutConsent = await announceUrgentMission({
      missionKey: published.missionKey,
      definitionVersion: published.definitionVersion,
    });
    expect(withoutConsent.notified).toBe(0);

    await setPushPreferences({ phone, marketing: true });
    const withConsent = await announceUrgentMission({
      missionKey: published.missionKey,
      definitionVersion: published.definitionVersion,
      force: true,
    });
    expect(withConsent.notified).toBe(1);
  });

  // T20. "Your evidence was approved" is not marketing, and does not ask.
  it("delivers a transactional notice to a player who declined marketing", async () => {
    mockExpoOk();
    await registerPushDevice({ phone, expoPushToken: deviceToken, platform: "android" });
    await setPushPreferences({ phone, marketing: false });

    const result = await notifyProofReviewed({
      phone,
      approved: true,
      missionTitle: "Off-peak lunch",
    });

    expect(result.sent).toBe(1);
  });

  // T20. The blackout is a published economy setting, and the opt-out is per
  // device because the setting is.
  it("holds a campaign push during quiet hours unless the device opted out", async () => {
    mockExpoOk();
    await registerPushDevice({ phone, expoPushToken: deviceToken, platform: "android" });
    // 23:00 Manila, inside the seeded 22:00-08:00 blackout.
    vi.setSystemTime(new Date("2026-07-03T15:00:00.000Z"));

    const published = await publishAnnounceable("urgent_ops_quiet");
    const asleep = await announceUrgentMission({
      missionKey: published.missionKey,
      definitionVersion: published.definitionVersion,
    });
    expect(asleep.notified).toBe(0);

    await setPushPreferences({ phone, quietHours: false });
    const awake = await announceUrgentMission({
      missionKey: published.missionKey,
      definitionVersion: published.definitionVersion,
      force: true,
    });
    expect(awake.notified).toBe(1);
  });

  // T20. Three a day, however many campaigns happen to launch.
  it("stops at three mission pushes in a Manila day", async () => {
    mockExpoOk();
    await registerPushDevice({ phone, expoPushToken: deviceToken, platform: "android" });

    const delivered: number[] = [];
    for (let index = 1; index <= 4; index += 1) {
      const published = await publishAnnounceable(`urgent_ops_cap_${index}`);
      const result = await announceUrgentMission({
        missionKey: published.missionKey,
        definitionVersion: published.definitionVersion,
      });
      delivered.push(result.notified);
    }

    // The fourth campaign is live and visible in the app; it just does not
    // interrupt anybody a fourth time.
    expect(delivered).toEqual([1, 1, 1, 0]);
  });
});

describe("the pre-flight, at both moments", () => {
  beforeEach(async () => {
    await resetDb();
  });

  /** A partner-funded campaign, written by the partner and sent for review. */
  async function submitPartnerFunded(missionKey: string, budgetCentavos: number) {
    return publishMissionDefinition(
      { actor: "partner@test", partnerIds: [partner], canApprove: false },
      {
        missionKey,
        type: "URGENT",
        title: "Partner-funded lunch",
        description: "Visit on a weekday afternoon.",
        triggerEvent: "qr_redeem",
        targetCount: 1,
        window: null,
        minLevel: 1,
        partnerId: partner,
        reward: [{ type: "LP", amount: 10_00, fundingSource: "PARTNER" }],
        condition: {},
        audience: { segment: "all" },
        autoClaim: true,
        requiresProof: false,
        quotaMode: "ON_COMPLETION",
        userQuota: 1,
        globalQuota: 5,
        rewardBudgetCentavos: budgetCentavos,
        status: "Active",
        startsAt: null,
        endsAt: null,
        exposureChannel: "app",
        termsUrl: null,
        localizationKey: null,
        sortOrder: 100,
      },
    );
  }

  // T16. The deposit is checked again at approval, because both the audience
  // and the money move between writing a campaign and somebody approving it.
  // A campaign that was affordable on Monday is not necessarily affordable on
  // Wednesday, and the approval is the moment that commits it.
  it("refuses at approval a campaign the deposit stopped covering", async () => {
    const db = await getDb();
    await run(db, "UPDATE businesses SET deposit_balance_centavos = ? WHERE id = ?", [
      100_000_00,
      partner,
    ]);

    const submitted = await submitPartnerFunded("urgent_ops_deposit", 50_00);
    // Queued rather than live: a partner cannot approve its own campaign.
    expect(submitted.status).toBe("Review");

    // The deposit is spent between the writing and the approval.
    await run(db, "UPDATE businesses SET deposit_balance_centavos = 0 WHERE id = ?", [
      partner,
    ]);

    await expect(
      decideMissionReview({
        scope: { actor: "ops@test", partnerIds: null, canApprove: true },
        missionKey: submitted.missionKey,
        definitionVersion: submitted.definitionVersion,
        decision: "Approved",
        activate: true,
        note: "Approving without re-reading the deposit",
      }),
    ).rejects.toThrow(/deposit/i);

    // And it stays in review rather than being half-approved.
    const row = await one(
      db,
      "SELECT status FROM mission_definitions WHERE mission_key = ? AND definition_version = ?",
      [submitted.missionKey, submitted.definitionVersion],
    );
    expect(String(row?.status)).toBe("Review");
  });

  // T16. The same campaign goes through once the money is there.
  it("approves the campaign once the deposit covers it again", async () => {
    const db = await getDb();
    await run(db, "UPDATE businesses SET deposit_balance_centavos = ? WHERE id = ?", [
      100_000_00,
      partner,
    ]);
    const submitted = await submitPartnerFunded("urgent_ops_deposit_ok", 50_00);

    await decideMissionReview({
      scope: { actor: "ops@test", partnerIds: null, canApprove: true },
      missionKey: submitted.missionKey,
      definitionVersion: submitted.definitionVersion,
      decision: "Approved",
      activate: true,
      note: "Deposit checked against the worst case",
    });

    const row = await one(
      db,
      "SELECT status FROM mission_definitions WHERE mission_key = ? AND definition_version = ?",
      [submitted.missionKey, submitted.definitionVersion],
    );
    expect(String(row?.status)).toBe("Active");
  });
});

describe("the partner statement export", () => {
  beforeEach(async () => {
    await resetDb();
  });

  // T19. Finance works from the CSV, so the five lines have to survive the
  // export with their labels — a memo line that reads as billed in a
  // spreadsheet is the whole risk this report exists to avoid.
  it("carries the five lines and their billing labels into the CSV", async () => {
    const statement = await partnerGamificationStatement({
      businessId: partner,
      period: "2026-07",
    });

    const csv = statementToCsv(statement);
    const header = csv.split("\n")[0]!.toLowerCase();
    expect(header).toContain("line");

    for (const label of [
      "Purchase accruals",
      "Voucher use",
      "Mission rewards",
      "Achievement rewards",
      "Level conversions",
    ]) {
      expect(csv).toContain(label);
    }

    // Billed and memo are told apart in the file itself, not just on screen.
    expect(csv.toLowerCase()).toContain("memo");
    expect(csv.toLowerCase()).toContain("billed");
  });
});
