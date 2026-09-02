import { beforeEach, describe, expect, it } from "vitest";
import { all, getDb, one, resetDb, run, withTx } from "@/server/db";
import { ingestEvent } from "@/server/gamification/events";
import {
  expireMissions,
  joinMission,
  listMissionCards,
  releaseReservedQuota,
} from "@/server/gamification/missions";
import { publishMissionDefinition, simulateMission } from "@/server/gamification/mission-admin";
import { gamificationProfile, resolveWallet } from "@/server/gamification/profile";
import { reviewMissionProof, submitMissionProof } from "@/server/gamification/proofs";
import { listHeldRewards, settleHeldReward } from "@/server/gamification/rewards";
import { partnerGamificationStatement } from "@/server/gamification/settlement";
import { ensureRewardWallet } from "@/server/rewards-network";

const phone = "+639171110101";
const other = "+639171110102";
const partner = "biz_demo_restaurant";

const scope = { actor: "ops@test", partnerIds: null, canApprove: true } as const;

/** A one-by-one PNG, small enough to be an obviously valid attachment. */
const PIXEL_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function draft(overrides: Record<string, unknown> = {}) {
  return {
    missionKey: "urgent_offpeak",
    type: "URGENT" as const,
    title: "Off-peak lunch",
    description: "Visit on a weekday afternoon.",
    triggerEvent: "qr_redeem",
    targetCount: 1,
    window: null,
    minLevel: 1,
    partnerId: partner,
    reward: [{ type: "XP" as const, amount: 50 }],
    condition: {},
    audience: { segment: "all" as const },
    autoClaim: true,
    requiresProof: false,
    quotaMode: "ON_COMPLETION" as const,
    userQuota: 1,
    globalQuota: null,
    rewardBudgetCentavos: null,
    status: "Active" as const,
    startsAt: null,
    endsAt: null,
    exposureChannel: "app" as const,
    termsUrl: null,
    localizationKey: null,
    sortOrder: 100,
    ...overrides,
  };
}

async function walletId(forPhone = phone) {
  return (await ensureRewardWallet(await getDb(), { phone: forPhone })).id;
}

/**
 * XP actually paid out for one mission, rather than the player's total.
 *
 * The event that finishes an urgent campaign generally finishes a daily mission
 * and unlocks a badge tier as well, so lifetime XP moves whether or not the
 * campaign itself paid anything. Only the mission's own reward transaction
 * answers the question the evidence tests are asking, which is whether a
 * mission waiting on a human has paid before one looked.
 */
async function missionXpPaid(missionKey: string) {
  const rows = await all(
    await getDb(),
    `SELECT xp_amount FROM reward_transactions
     WHERE source_type = 'mission' AND source_id LIKE ? AND status = 'GRANTED'`,
    [`${missionKey}:%`],
  );
  return rows.reduce((total, row) => total + Number(row.xp_amount), 0);
}

async function board(forPhone = phone) {
  const wallet = await resolveWallet(forPhone);
  const db = await getDb();
  return listMissionCards(db, { walletId: wallet, level: 5, lifetimeXp: 10_000 });
}

describe("urgent missions", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("shows a live campaign as joinable before any row exists for it", async () => {
    await publishMissionDefinition(scope, draft());

    const cards = await board();
    const card = cards.find((entry) => entry.missionKey === "urgent_offpeak");
    expect(card?.joinable).toBe(true);
    expect(card?.state).toBe("AVAILABLE");
    expect(card?.partnerName).toBeTruthy();
    // The profile is the app's one call, so the campaign has to reach it too.
    const profile = await gamificationProfile({ phone });
    expect(profile.missions.some((entry) => entry.missionKey === "urgent_offpeak")).toBe(true);
  });

  it("shows a level-gated campaign with the XP still to go rather than hiding it", async () => {
    await publishMissionDefinition(scope, draft({ minLevel: 3 }));
    const wallet = await resolveWallet(phone);
    const db = await getDb();
    const cards = await listMissionCards(db, { walletId: wallet, level: 1, lifetimeXp: 0 });
    const card = cards.find((entry) => entry.missionKey === "urgent_offpeak");

    expect(card?.joinable).toBe(false);
    expect(card?.ineligibleReason).toBe("LEVEL_REQUIRED");
    // 1,500 XP is level 3 in the seeded ladder.
    expect(card?.xpToUnlock).toBe(1_500);
  });

  it("moves a campaign out of the joinable list once it is joined", async () => {
    await publishMissionDefinition(scope, draft());
    await joinMission({ phone, missionKey: "urgent_offpeak" });

    const cards = await board();
    const matching = cards.filter((entry) => entry.missionKey === "urgent_offpeak");
    expect(matching).toHaveLength(1);
    expect(matching[0]!.state).toBe("IN_PROGRESS");
    expect(matching[0]!.joinable).toBe(false);
  });

  it("refuses a second join and does not eat a second place", async () => {
    await publishMissionDefinition(
      scope,
      draft({ globalQuota: 5, quotaMode: "RESERVE_ON_JOIN" }),
    );
    await joinMission({ phone, missionKey: "urgent_offpeak" });
    await expect(joinMission({ phone, missionKey: "urgent_offpeak" })).rejects.toThrow();

    const db = await getDb();
    const definition = await one(
      db,
      "SELECT joined_count FROM mission_definitions WHERE mission_key = 'urgent_offpeak'",
    );
    expect(Number(definition?.joined_count)).toBe(1);
  });

  it("stops joins once a reserve-on-join campaign is full", async () => {
    await publishMissionDefinition(
      scope,
      draft({ globalQuota: 1, quotaMode: "RESERVE_ON_JOIN" }),
    );
    await joinMission({ phone, missionKey: "urgent_offpeak" });
    await expect(joinMission({ phone: other, missionKey: "urgent_offpeak" })).rejects.toThrow(
      /fully booked/i,
    );
  });

  it("gives a reserved place back when the instance expires, exactly once", async () => {
    await publishMissionDefinition(
      scope,
      draft({
        globalQuota: 1,
        quotaMode: "RESERVE_ON_JOIN",
        endsAt: "2026-07-03T05:00:00.000Z",
      }),
    );
    await joinMission({ phone, missionKey: "urgent_offpeak" });

    const db = await getDb();
    // Push the instance past its deadline and sweep.
    await run(db, "UPDATE user_missions SET expires_at = '2026-07-01T00:00:00.000Z'");
    const first = await expireMissions();
    expect(first.released).toBe(1);

    const afterOne = await one(
      db,
      "SELECT joined_count FROM mission_definitions WHERE mission_key = 'urgent_offpeak'",
    );
    expect(Number(afterOne?.joined_count)).toBe(0);

    // A second sweep must not give the same seat back twice.
    await run(db, "UPDATE mission_definitions SET joined_count = 1 WHERE mission_key = 'urgent_offpeak'");
    const releasedAgain = await releaseReservedQuota(db);
    expect(releasedAgain).toBe(0);
  });

  it("refuses the last completion of a quota counted at the finish line", async () => {
    await publishMissionDefinition(
      scope,
      draft({ globalQuota: 1, quotaMode: "ON_COMPLETION" }),
    );
    await joinMission({ phone, missionKey: "urgent_offpeak" });
    await joinMission({ phone: other, missionKey: "urgent_offpeak" });

    await ingestEvent({
      eventName: "qr_redeem",
      phone,
      source: "test",
      partnerId: partner,
      objectId: "v_first",
      idempotencyKey: "qr:first",
    });
    await ingestEvent({
      eventName: "qr_redeem",
      phone: other,
      source: "test",
      partnerId: partner,
      objectId: "v_second",
      idempotencyKey: "qr:second",
    });

    const db = await getDb();
    const states = await all(
      db,
      "SELECT state, reject_reason FROM user_missions WHERE mission_key = 'urgent_offpeak' ORDER BY assigned_at ASC",
    );
    expect(states.map((row) => String(row.state))).toEqual(["CLAIMED", "REJECTED"]);
    expect(String(states[1]!.reject_reason)).toBe("QUOTA_EXHAUSTED");
  });

  it("counts a partner's event only for that partner", async () => {
    await publishMissionDefinition(scope, draft());
    await joinMission({ phone, missionKey: "urgent_offpeak" });

    await ingestEvent({
      eventName: "qr_redeem",
      phone,
      source: "test",
      partnerId: "biz_demo_cafe",
      objectId: "v_elsewhere",
      idempotencyKey: "qr:elsewhere",
    });

    const cards = await board();
    expect(cards.find((entry) => entry.missionKey === "urgent_offpeak")?.state).toBe(
      "IN_PROGRESS",
    );
  });
});

describe("evidence review", () => {
  beforeEach(async () => {
    await resetDb();
    await publishMissionDefinition(scope, draft({ requiresProof: true }));
    await joinMission({ phone, missionKey: "urgent_offpeak" });
  });

  it("holds a finished mission in VERIFYING instead of paying it", async () => {
    await ingestEvent({
      eventName: "qr_redeem",
      phone,
      source: "test",
      partnerId: partner,
      objectId: "v_proof",
      idempotencyKey: "qr:proof",
    });

    const cards = await board();
    const card = cards.find((entry) => entry.missionKey === "urgent_offpeak");
    expect(card?.state).toBe("VERIFYING");
    // Nothing paid, because nobody has looked yet.
    expect(await missionXpPaid("urgent_offpeak")).toBe(0);
  });

  it("pays on approval and keeps the picture out of the decision row", async () => {
    await ingestEvent({
      eventName: "qr_redeem",
      phone,
      source: "test",
      partnerId: partner,
      objectId: "v_proof",
      idempotencyKey: "qr:proof",
    });
    const submitted = await submitMissionProof({
      phone,
      missionKey: "urgent_offpeak",
      kind: "receipt",
      note: "Table 4, 2:15 PM",
      file: { contentBase64: PIXEL_PNG, contentType: "image/png" },
    });
    expect(submitted.proof.status).toBe("Pending");

    const db = await getDb();
    const row = await one(db, "SELECT file_ref, note FROM mission_proofs WHERE id = ?", [
      submitted.proof.proofId,
    ]);
    expect(row?.file_ref).toBeTruthy();
    const file = await one(db, "SELECT content_type FROM mission_proof_files WHERE file_ref = ?", [
      String(row?.file_ref),
    ]);
    expect(String(file?.content_type)).toBe("image/png");

    const decision = await reviewMissionProof({
      proofId: submitted.proof.proofId,
      decision: "Approved",
      reviewer: "ops@test",
    });
    expect(decision.paid).toBe(true);
    expect(await missionXpPaid("urgent_offpeak")).toBe(50);
  });

  it("leaves a rejected mission open with the reason on it", async () => {
    await ingestEvent({
      eventName: "qr_redeem",
      phone,
      source: "test",
      partnerId: partner,
      objectId: "v_proof",
      idempotencyKey: "qr:proof",
    });
    const submitted = await submitMissionProof({
      phone,
      missionKey: "urgent_offpeak",
      kind: "receipt",
      file: { contentBase64: PIXEL_PNG, contentType: "image/png" },
    });
    await reviewMissionProof({
      proofId: submitted.proof.proofId,
      decision: "Rejected",
      reviewer: "ops@test",
      reason: "The receipt is from a different branch",
    });

    const cards = await board();
    const card = cards.find((entry) => entry.missionKey === "urgent_offpeak");
    expect(card?.state).toBe("VERIFYING");
    expect(card?.proof?.status).toBe("Rejected");
    expect(card?.proof?.rejectReason).toContain("different branch");
    expect(await missionXpPaid("urgent_offpeak")).toBe(0);

    // And a second attempt supersedes the first rather than replacing history.
    const again = await submitMissionProof({
      phone,
      missionKey: "urgent_offpeak",
      kind: "receipt",
      file: { contentBase64: PIXEL_PNG, contentType: "image/png" },
    });
    const db = await getDb();
    const superseded = await one(db, "SELECT review_status FROM mission_proofs WHERE id = ?", [
      submitted.proof.proofId,
    ]);
    expect(String(superseded?.review_status)).toBe("Superseded");
    expect(again.proof.proofId).not.toBe(submitted.proof.proofId);
  });

  it("refuses a decision twice on the same submission", async () => {
    const submitted = await submitMissionProof({
      phone,
      missionKey: "urgent_offpeak",
      kind: "text",
      note: "I ordered the set menu",
    });
    await reviewMissionProof({
      proofId: submitted.proof.proofId,
      decision: "Approved",
      reviewer: "ops@test",
    });
    await expect(
      reviewMissionProof({
        proofId: submitted.proof.proofId,
        decision: "Rejected",
        reviewer: "ops@test",
        reason: "Changed my mind",
      }),
    ).rejects.toThrow(/already/i);
  });

  it("refuses a reviewer acting outside their own partner", async () => {
    const submitted = await submitMissionProof({
      phone,
      missionKey: "urgent_offpeak",
      kind: "text",
      note: "I ordered the set menu",
    });
    await expect(
      reviewMissionProof({
        proofId: submitted.proof.proofId,
        decision: "Approved",
        reviewer: "partner@elsewhere",
        allowedPartnerIds: ["biz_demo_cafe"],
      }),
    ).rejects.toThrow(/your own business/i);
  });
});

describe("pre-flight simulation", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("bounds the cost by the quota rather than by the audience", async () => {
    const db = await getDb();
    await ensureRewardWallet(db, { phone });
    await ensureRewardWallet(db, { phone: other });

    const simulation = await simulateMission(db, {
      audience: { segment: "all" },
      minLevel: 1,
      partnerId: partner,
      reward: [{ type: "LP", amount: 10_00, fundingSource: "PLATFORM" }],
      globalQuota: 1,
      userQuota: 1,
      rewardBudgetCentavos: null,
    });

    expect(simulation.audienceSize).toBeGreaterThanOrEqual(2);
    expect(simulation.maxCompletions).toBe(1);
    expect(simulation.maxLpCostCentavos).toBe(10_00);
  });

  it("warns when the worst case is bigger than the budget", async () => {
    const db = await getDb();
    // Two, because the audience is the other half of the bound: one wallet at
    // 100 LP exactly meets a 100 LP budget, and the warning is for exceeding it.
    await ensureRewardWallet(db, { phone });
    await ensureRewardWallet(db, { phone: other });

    const simulation = await simulateMission(db, {
      audience: { segment: "all" },
      minLevel: 1,
      partnerId: partner,
      reward: [{ type: "LP", amount: 100_00, fundingSource: "PLATFORM" }],
      globalQuota: 50,
      userQuota: 1,
      rewardBudgetCentavos: 100_00,
    });
    expect(simulation.budgetExceeded).toBe(true);
    expect(simulation.warnings.join(" ")).toMatch(/budget/i);
  });

  it("refuses to publish a partner-funded campaign the deposit cannot cover", async () => {
    const db = await getDb();
    await run(db, "UPDATE businesses SET deposit_balance_centavos = 0 WHERE id = ?", [partner]);

    await expect(
      publishMissionDefinition(
        scope,
        draft({
          reward: [{ type: "LP", amount: 50_00, fundingSource: "PARTNER" }],
          rewardBudgetCentavos: 5_000_00,
          status: "Active",
        }),
      ),
    ).rejects.toThrow(/deposit/i);
  });
});

describe("partner statement", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("separates mission rewards and level conversions from what is billed", async () => {
    const db = await getDb();
    await run(db, "UPDATE businesses SET deposit_balance_centavos = 1000000 WHERE id = ?", [
      partner,
    ]);
    await publishMissionDefinition(
      scope,
      draft({
        reward: [{ type: "LP", amount: 5_00, fundingSource: "PARTNER" }],
        rewardBudgetCentavos: 500_00,
      }),
    );
    await joinMission({ phone, missionKey: "urgent_offpeak" });
    await ingestEvent({
      eventName: "qr_redeem",
      phone,
      source: "test",
      partnerId: partner,
      objectId: "v_statement",
      idempotencyKey: "qr:statement",
    });

    const statement = await partnerGamificationStatement({
      businessId: partner,
      period: "2026-07",
    });
    const missionLine = statement.lines.find((line) => line.kind === "mission_reward");
    expect(missionLine?.centavos).toBe(5_00);
    expect(missionLine?.billed).toBe(false);
    // The billed total is untouched by the campaign: the settlement policy has
    // not changed, and the report says so rather than quietly re-netting.
    expect(statement.lines.filter((line) => line.billed).map((line) => line.kind)).toEqual([
      "purchase_accrual",
      "voucher_use",
    ]);
    expect(await walletId()).toBeTruthy();
  });
});

describe("held rewards", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("parks a flagged player's reward instead of paying it, then pays it on approval", async () => {
    const db = await getDb();
    const wallet = await walletId();
    await run(
      db,
      "UPDATE reward_wallets SET risk_state = 'Held', risk_reason = 'test' WHERE id = ?",
      [wallet],
    );

    await ingestEvent({
      eventName: "hunt_complete",
      phone,
      source: "test",
      objectId: "att_held",
      idempotencyKey: "hunt_complete:att_held",
    });

    // Nothing paid: the mission is CLAIMED but the XP is still owed.
    expect((await gamificationProfile({ phone })).level.lifetimeXp).toBe(0);

    // Two rows, because one hunt earns two things — the daily mission and Hunt
    // Master Bronze — and a hold parks every reward the wallet earns, not just
    // the one that happened to trip it.
    const queue = await listHeldRewards(db);
    expect(queue).toHaveLength(2);
    expect(queue.map((row) => String(row.source_type)).sort()).toEqual([
      "achievement",
      "mission",
    ]);
    expect(queue.every((row) => String(row.hold_reason).match(/held/i))).toBe(true);

    const missionRow = queue.find((row) => String(row.source_type) === "mission");
    const released = await withTx((tx) =>
      settleHeldReward(tx, {
        rewardTxId: String(missionRow!.id),
        actor: "ops@test",
        decision: "Approve",
        reason: "Family share one phone",
        reference: "REF-001",
      }),
    );
    expect(released.paid.xp).toBe(10);
    expect((await gamificationProfile({ phone })).level.lifetimeXp).toBe(10);
    // Approving one reward releases that reward and no other: the badge is a
    // separate decision and is still waiting for one.
    const remaining = await listHeldRewards(db);
    expect(remaining).toHaveLength(1);
    expect(String(remaining[0]!.source_type)).toBe("achievement");
  });

  it("pays nothing when a held reward is refused, and refuses a second decision", async () => {
    const db = await getDb();
    await run(db, "UPDATE reward_wallets SET risk_state = 'Held' WHERE id = ?", [
      await walletId(),
    ]);
    await ingestEvent({
      eventName: "hunt_complete",
      phone,
      source: "test",
      objectId: "att_refused",
      idempotencyKey: "hunt_complete:att_refused",
    });

    const [heldRow] = await listHeldRewards(db);
    await withTx((tx) =>
      settleHeldReward(tx, {
        rewardTxId: String(heldRow!.id),
        actor: "ops@test",
        decision: "Reject",
        reason: "Confirmed multi-accounting",
      }),
    );
    expect((await gamificationProfile({ phone })).level.lifetimeXp).toBe(0);

    await expect(
      withTx((tx) =>
        settleHeldReward(tx, {
          rewardTxId: String(heldRow!.id),
          actor: "ops@test",
          decision: "Approve",
          reason: "Changed my mind",
        }),
      ),
    ).rejects.toThrow(/not waiting for approval/i);
  });
});
