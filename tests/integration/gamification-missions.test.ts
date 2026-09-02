import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDb, one, resetDb } from "@/server/db";
import { ingestEvent } from "@/server/gamification/events";
import { claimMission, expireMissions } from "@/server/gamification/missions";
import { gamificationProfile } from "@/server/gamification/profile";
import { ensureRewardWallet } from "@/server/rewards-network";

const phone = "+639171110002";

/** The Manila clock the suite's frozen time already sits at, for reference. */
const MORNING_UTC = "2026-07-03T02:00:00.000Z"; // 10:00 Manila
const AFTERNOON_UTC = "2026-07-03T07:00:00.000Z"; // 15:00 Manila

async function walletId() {
  return (await ensureRewardWallet(await getDb(), { phone })).id;
}

describe("daily missions", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("assigns today's set the first time a player looks", async () => {
    const profile = await gamificationProfile({ phone });
    const keys = profile.missions.map((mission) => mission.missionKey);

    expect(keys).toContain("daily_ad_morning");
    expect(keys).toContain("daily_hunt");
    expect(keys).toContain("daily_qr_redeem");
    expect(profile.missions.every((mission) => mission.state === "AVAILABLE")).toBe(true);
    expect(profile.missionDate).toBe("2026-07-03");
    // The reset is the next Manila midnight, expressed in UTC.
    expect(profile.missionsResetAt).toBe("2026-07-03T16:00:00.000Z");
  });

  it("completes and auto-pays a mission when its event arrives", async () => {
    const result = await ingestEvent({
      eventName: "hunt_complete",
      phone,
      source: "test",
      objectType: "attempt",
      objectId: "att_1",
      idempotencyKey: "hunt_complete:att_1",
    });

    expect(result.accepted).toBe(true);
    const hunt = result.missions.find((mission) => mission.missionKey === "daily_hunt");
    expect(hunt?.claimed).toBe(true);
    expect(hunt?.reward.xp).toBe(10);

    const profile = await gamificationProfile({ phone });
    // 10 for the mission and 25 for Hunt Master Bronze, which one hunt unlocks.
    // A badge pays XP too, so a mission reward is never the whole of what one
    // event moves.
    expect(profile.level.lifetimeXp).toBe(35);
    expect(
      profile.missions.find((mission) => mission.missionKey === "daily_hunt")?.state,
    ).toBe("CLAIMED");
  });

  it("pays once when the same event is delivered twice", async () => {
    const first = await ingestEvent({
      eventName: "hunt_complete",
      phone,
      source: "test",
      objectId: "att_dup",
      idempotencyKey: "hunt_complete:att_dup",
    });
    const second = await ingestEvent({
      eventName: "hunt_complete",
      phone,
      source: "test",
      objectId: "att_dup",
      idempotencyKey: "hunt_complete:att_dup",
    });

    expect(first.accepted).toBe(true);
    expect(second.accepted).toBe(false);
    // The mission and the badge it unlocked, counted once between them.
    expect((await gamificationProfile({ phone })).level.lifetimeXp).toBe(35);
  });

  it("credits an ad only to the window it was watched in", async () => {
    const morning = await ingestEvent({
      eventName: "ad_reward_verified",
      phone,
      source: "test",
      occurredAt: MORNING_UTC,
      objectId: "ad_morning",
      idempotencyKey: "ad:morning",
    });
    expect(morning.missions.map((mission) => mission.missionKey)).toEqual([
      "daily_ad_morning",
    ]);

    const afternoon = await ingestEvent({
      eventName: "ad_reward_verified",
      phone,
      source: "test",
      occurredAt: AFTERNOON_UTC,
      objectId: "ad_afternoon",
      idempotencyKey: "ad:afternoon",
    });
    expect(afternoon.missions.map((mission) => mission.missionKey)).toEqual([
      "daily_ad_lunch",
    ]);

    const profile = await gamificationProfile({ phone });
    // Two ads, two windows: 10 XP each, and 5 LP each into the global pot.
    expect(profile.level.lifetimeXp).toBe(20);
    const global = profile.convertibleLp.find((entry) => entry.businessId === null);
    expect(global?.balanceCentavos).toBe(10_00);
  });

  it("pays a window mission for an event that arrives slightly late", async () => {
    // 11:05 Manila, five minutes after the morning window closed.
    const late = await ingestEvent({
      eventName: "ad_reward_verified",
      phone,
      source: "test",
      occurredAt: "2026-07-03T03:05:00.000Z",
      objectId: "ad_late",
      idempotencyKey: "ad:late",
    });
    expect(late.missions.map((mission) => mission.missionKey)).toContain(
      "daily_ad_morning",
    );
  });

  it("finishes the capstone once four other missions are done, and only once", async () => {
    const events: Array<[string, string]> = [
      ["hunt_complete", "cap_hunt"],
      ["voucher_select", "cap_voucher"],
      ["qr_redeem", "cap_qr"],
    ];
    for (const [eventName, objectId] of events) {
      await ingestEvent({
        eventName: eventName as "hunt_complete",
        phone,
        source: "test",
        partnerId: eventName === "qr_redeem" ? "biz_demo_restaurant" : null,
        objectId,
        idempotencyKey: `${eventName}:${objectId}`,
      });
    }

    let profile = await gamificationProfile({ phone });
    expect(
      profile.missions.find((mission) => mission.missionKey === "daily_four_missions")
        ?.state,
    ).not.toBe("CLAIMED");

    // The fourth.
    await ingestEvent({
      eventName: "ad_reward_verified",
      phone,
      source: "test",
      occurredAt: MORNING_UTC,
      objectId: "cap_ad",
      idempotencyKey: "ad:cap",
    });

    profile = await gamificationProfile({ phone });
    const capstone = profile.missions.find(
      (mission) => mission.missionKey === "daily_four_missions",
    );
    expect(capstone?.state).toBe("CLAIMED");
    expect(capstone?.progress).toBe(4);

    const db = await getDb();
    const payouts = await one(
      db,
      `SELECT COUNT(*) AS total FROM reward_transactions
       WHERE wallet_id = ? AND source_id LIKE 'daily_four_missions%'`,
      [await walletId()],
    );
    expect(Number(payouts?.total)).toBe(1);
  });

  it("refuses to claim a mission that has already paid", async () => {
    await ingestEvent({
      eventName: "hunt_complete",
      phone,
      source: "test",
      objectId: "att_claimed",
      idempotencyKey: "hunt_complete:att_claimed",
    });

    await expect(claimMission({ phone, missionKey: "daily_hunt" })).rejects.toMatchObject({
      code: "E-REWARD-ALREADY-GRANTED",
    });
  });

  it("refuses to claim a mission that is not finished", async () => {
    await gamificationProfile({ phone });
    await expect(claimMission({ phone, missionKey: "daily_hunt" })).rejects.toMatchObject({
      code: "E-MISSION-NOT-ACTIVE",
    });
  });

  it("starts a fresh set after the Manila day rolls over", async () => {
    await ingestEvent({
      eventName: "hunt_complete",
      phone,
      source: "test",
      objectId: "att_day1",
      idempotencyKey: "hunt_complete:att_day1",
    });
    expect((await gamificationProfile({ phone })).level.lifetimeXp).toBe(35);

    // One second past 00:00 Manila the next day.
    vi.setSystemTime(new Date("2026-07-03T16:00:01.000Z"));

    const tomorrow = await gamificationProfile({ phone });
    expect(tomorrow.missionDate).toBe("2026-07-04");
    expect(
      tomorrow.missions.find((mission) => mission.missionKey === "daily_hunt")?.state,
    ).toBe("AVAILABLE");
    // XP is cumulative and survives the reset; the mission instance does not.
    expect(tomorrow.level.lifetimeXp).toBe(35);

    await ingestEvent({
      eventName: "hunt_complete",
      phone,
      source: "test",
      objectId: "att_day2",
      idempotencyKey: "hunt_complete:att_day2",
    });
    // A second hunt pays the new day mission; Hunt Master Silver is ten hunts
    // away, so no badge lands with it.
    expect((await gamificationProfile({ phone })).level.lifetimeXp).toBe(45);
  });

  it("expires yesterday's unfinished missions but keeps a finished one claimable", async () => {
    await gamificationProfile({ phone });
    vi.setSystemTime(new Date("2026-07-04T16:00:01.000Z"));

    await expireMissions();

    const db = await getDb();
    const expired = await one(
      db,
      `SELECT COUNT(*) AS total FROM user_missions
       WHERE wallet_id = ? AND mission_date = '2026-07-03' AND state = 'EXPIRED'`,
      [await walletId()],
    );
    expect(Number(expired?.total)).toBeGreaterThan(0);
  });
});
