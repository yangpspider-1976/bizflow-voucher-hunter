/**
 * Stage 1 of the manual gamification plan, automated: the player loop.
 *
 * The existing gamification suites test the rules engine by handing it events
 * directly. Nothing tested the half in front of it — whether the product's own
 * entry points actually raise those events. That is the half that broke: the
 * mission builder offered a `purchase_verified` trigger for a fortnight while
 * `onPurchaseVerified` had no call site at all, and every engine test passed
 * throughout, because the engine was never the thing that was wrong.
 *
 * So these drive the real routes and the real engine functions — sign in, draw,
 * book, redeem — and assert the missions a player would see move. A hook
 * deleted from a route fails a test here and nowhere else.
 *
 * Case numbers refer to the manual plan; T5 (conversion rules) is already
 * covered in depth by gamification-levels.test.ts and is not repeated, and T6
 * is a mobile navigation-lifecycle fix with no server surface to assert on.
 */
import type { AchievementCard } from "@bizflow/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

const cookieValues = vi.hoisted(() => new Map<string, string>());

// verify-otp sets the customer session cookies through next/headers, which has
// no request context outside a server component.
vi.mock("next/headers", () => ({
  cookies: () => ({
    get: (name: string) => {
      const value = cookieValues.get(name);
      return value === undefined ? undefined : { name, value };
    },
    set: (name: string, value: string) => {
      if (value) cookieValues.set(name, value);
      else cookieValues.delete(name);
    },
  }),
}));

import { GET as readAchievements } from "@/app/api/public/gamification/achievements/route";
import { POST as acknowledgeSeen } from "@/app/api/public/gamification/achievements/seen/route";
import { GET as readProfile } from "@/app/api/public/gamification/profile/route";
import { POST as drawVoucher } from "@/app/api/public/hunt/attempt/route";
import { POST as selectVoucher } from "@/app/api/public/hunt/select/route";
import { GET as listAttemptSlots } from "@/app/api/public/hunt/slots/route";
import { POST as startHuntRoute } from "@/app/api/public/hunt/start/route";
import { POST as verifyOtpRoute } from "@/app/api/public/signin/verify-otp/route";
import { all, getDb, resetDb, run } from "@/server/db";
import { ingestEvent } from "@/server/gamification/events";
import { convertPointsToXp } from "@/server/gamification/levels";
import { gamificationProfile } from "@/server/gamification/profile";
import { requestSignInOtp } from "@/server/otp";
import { ensureRewardWallet } from "@/server/rewards-network";
import { redeemVoucher } from "@/server/voucher-engine";

const phone = "+639171110003";
const campaignSlug = "july-dinner";

/**
 * The bill presented at the till, comfortably above every seeded tier's minimum
 * spend. The reel draws at random, so a figure that clears only some of the
 * tiers makes the whole file fail a few runs in ten on whichever voucher came
 * up — which reads as a gamification bug and is not one.
 */
const TILL_SPEND = 5000;

type ApiResponse<T> =
  | { success: true; data: T }
  | { success: false; error: { code: string; message: string } };

async function unwrap<T>(response: Response): Promise<T> {
  const body = (await response.json()) as ApiResponse<T>;
  if (!body.success) {
    throw new Error(`${response.status} ${body.error.code}: ${body.error.message}`);
  }
  return body.data;
}

async function issueMobileToken() {
  const challenge = await requestSignInOtp({ phone });
  const response = await verifyOtpRoute(
    new Request("http://localhost/api/public/signin/verify-otp", {
      method: "POST",
      headers: { "content-type": "application/json", "x-client": "mobile" },
      body: JSON.stringify({ phone, code: challenge.devCode }),
    }),
  );
  return (await unwrap<{ token: string }>(response)).token;
}

function bearer(url: string, token: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  if (init.body) headers.set("content-type", "application/json");
  return new Request(url, { ...init, headers });
}

/** One drawn candidate, through the route the app actually calls. */
async function drawOne(token: string, sessionId: string) {
  await startHuntRoute(
    bearer("http://localhost/api/public/hunt/start", token, {
      method: "POST",
      body: JSON.stringify({ campaignSlug, sessionId, name: "Loop Tester" }),
    }),
  );
  const attempt = await unwrap<{ id: string }>(
    await drawVoucher(
      bearer("http://localhost/api/public/hunt/attempt", token, {
        method: "POST",
        body: JSON.stringify({ campaignSlug, sessionId }),
      }),
    ),
  );
  return attempt.id;
}

/** A drawn candidate booked into the first slot its tier is offered at. */
async function bookOne(token: string, sessionId: string, attemptId: string) {
  const { slots } = await unwrap<{ slots: Array<{ id: string }> }>(
    await listAttemptSlots(
      bearer(
        `http://localhost/api/public/hunt/slots?campaignSlug=${campaignSlug}&attemptId=${attemptId}`,
        token,
      ),
    ),
  );
  return unwrap<{ voucher: { voucherCode: string } }>(
    await selectVoucher(
      bearer("http://localhost/api/public/hunt/select", token, {
        method: "POST",
        body: JSON.stringify({
          campaignSlug,
          attemptId,
          slotId: slots[0].id,
          sessionId,
          name: "Loop Tester",
        }),
      }),
    ),
  );
}

function missionState(
  profile: Awaited<ReturnType<typeof gamificationProfile>>,
  key: string,
) {
  return profile.missions.find((mission) => mission.missionKey === key)?.state;
}

/** The spend-anywhere pot, which is where a PLATFORM-funded reward lands. */
function globalLp(profile: Awaited<ReturnType<typeof gamificationProfile>>) {
  return (
    profile.convertibleLp.find((entry) => entry.businessId === null)
      ?.balanceCentavos ?? 0
  );
}

/**
 * The events the product itself raised, in order.
 *
 * The engine writes its own derived events into the same table — mission
 * progress, payouts, unlocks — all stamped `rules-engine`. Those are its audit
 * trail rather than facts about what the player did, so they are not what this
 * file is asserting on.
 */
async function productEventNames() {
  const rows = await all(
    await getDb(),
    `SELECT event_name FROM gamification_events
     WHERE source <> 'rules-engine'
     ORDER BY created_at ASC`,
  );
  return rows.map((row) => String(row.event_name));
}

describe("the player loop, through the product's own entry points", () => {
  beforeEach(async () => {
    cookieValues.clear();
    await resetDb();
  });

  // T1
  it("hands the app today's seven missions on the first look", async () => {
    const token = await issueMobileToken();

    const profile = await unwrap<Awaited<ReturnType<typeof gamificationProfile>>>(
      await readProfile(
        bearer("http://localhost/api/public/gamification/profile", token),
      ),
    );

    expect(profile.missions).toHaveLength(7);
    expect(profile.missions.map((mission) => mission.missionKey)).toEqual(
      expect.arrayContaining([
        "daily_ad_morning",
        "daily_ad_lunch",
        "daily_ad_evening",
        "daily_hunt",
        "daily_voucher_select",
        "daily_qr_redeem",
        "daily_four_missions",
      ]),
    );
    expect(profile.missions.every((mission) => mission.state === "AVAILABLE")).toBe(
      true,
    );
    expect(profile.level.level).toBe(1);
    expect(profile.level.lifetimeXp).toBe(0);
  });

  // T2, the hunt leg. The hook lives in the route rather than in
  // generateCandidate, so only a route-level call proves it fires.
  it("completes the hunt mission when a candidate is drawn", async () => {
    const token = await issueMobileToken();

    await drawOne(token, "loop-hunt");

    const profile = await gamificationProfile({ phone });
    expect(missionState(profile, "daily_hunt")).toBe("CLAIMED");
    // 10 for the mission and 25 for Hunt Master Bronze, which one hunt is
    // enough to unlock. Badges pay XP as well, so a mission's own payout is
    // never the whole of what a single action moves.
    expect(profile.level.lifetimeXp).toBe(35);
  });

  // T2, the booking leg.
  it("completes the claim-a-voucher mission when a slot is booked", async () => {
    const token = await issueMobileToken();
    const attemptId = await drawOne(token, "loop-select");

    await bookOne(token, "loop-select", attemptId);

    const profile = await gamificationProfile({ phone });
    expect(missionState(profile, "daily_voucher_select")).toBe("CLAIMED");
    // 35 from the draw and its badge, then 10 for the booking. Booking has no
    // badge of its own — Mission Specialist Bronze is seven missions away.
    expect(profile.level.lifetimeXp).toBe(45);
  });

  // T2, the till leg.
  it("completes the scan mission and pays its LP when the voucher is redeemed", async () => {
    const token = await issueMobileToken();
    const attemptId = await drawOne(token, "loop-qr");
    const booked = await bookOne(token, "loop-qr", attemptId);

    await redeemVoucher({
      codeOrToken: booked.voucher.voucherCode,
      staffName: "Till Tester",
      purchaseAmount: TILL_SPEND,
    });

    const profile = await gamificationProfile({ phone });
    expect(missionState(profile, "daily_qr_redeem")).toBe("CLAIMED");
    // 45 so far, then 20 for the scan and 25 for Voucher User Bronze. City
    // Explorer needs three distinct partners, so one visit does not touch it.
    expect(profile.level.lifetimeXp).toBe(90);
    // The mission's 5 LP is platform-funded, so it lands in the global pot —
    // not in the partner bucket the 5% purchase accrual credits.
    expect(globalLp(profile)).toBe(5_00);

    // A redemption is a visit, not a checkout scan. The purchase hook belongs
    // to the staff credit route; raising it here as well would let one sale
    // feed two different missions.
    expect(await productEventNames()).not.toContain("purchase_verified");
  });

  // T2 with the optional field left alone, which is how the checkout is used
  // when there is no bill to record — and how a tester scanning from the
  // dashboard reaches it. Every other test in this file passes an amount, which
  // is exactly why the scan mission could go uncredited for a blank one without
  // a single failure: the visit lookup used to sit inside the `purchaseAmount`
  // branch, so no amount meant no `qr_redeem` and no mission, XP or LP.
  it("completes the scan mission when the checkout records no purchase amount", async () => {
    const token = await issueMobileToken();
    const attemptId = await drawOne(token, "loop-qr-blank");
    const booked = await bookOne(token, "loop-qr-blank", attemptId);

    const redeemed = await redeemVoucher({
      codeOrToken: booked.voucher.voucherCode,
      staffName: "Till Tester",
    });

    // No amount, so nothing accrues the 5% — that half stays gated.
    expect(redeemed.loyalty).toBeUndefined();

    const profile = await gamificationProfile({ phone });
    expect(missionState(profile, "daily_qr_redeem")).toBe("CLAIMED");
    // Identical to the paid redemption above: the bill funds loyalty, not the
    // mission, so leaving it blank must not cost the player XP or LP.
    expect(profile.level.lifetimeXp).toBe(90);
    expect(globalLp(profile)).toBe(5_00);
    expect(await productEventNames()).toContain("qr_redeem");
  });

  // T2, the whole leg in one pass: each entry point raises exactly one event,
  // and each event is named after the fact rather than the moment, so a retry
  // of any leg describes the same thing.
  it("raises one event per leg of the loop, and no others", async () => {
    const token = await issueMobileToken();
    const attemptId = await drawOne(token, "loop-events");
    const booked = await bookOne(token, "loop-events", attemptId);
    await redeemVoucher({
      codeOrToken: booked.voucher.voucherCode,
      staffName: "Till Tester",
      purchaseAmount: TILL_SPEND,
    });

    expect(await productEventNames()).toEqual([
      "hunt_complete",
      "voucher_select",
      "qr_redeem",
    ]);
  });

  // T3
  it("finishes the capstone from four real completions", async () => {
    const token = await issueMobileToken();
    const attemptId = await drawOne(token, "loop-capstone");
    const booked = await bookOne(token, "loop-capstone", attemptId);
    await redeemVoucher({
      codeOrToken: booked.voucher.voucherCode,
      staffName: "Till Tester",
      purchaseAmount: TILL_SPEND,
    });

    let profile = await gamificationProfile({ phone });
    expect(missionState(profile, "daily_four_missions")).not.toBe("CLAIMED");

    // The fourth. No ad SDK ships in the app yet, so this is the one leg of the
    // loop with no client producer — the internal intake stands in for it.
    // The suite's clock is 12:00 Manila, inside the lunch window.
    await ingestEvent({
      eventName: "ad_reward_verified",
      phone,
      source: "test",
      objectId: "ad_capstone",
      idempotencyKey: "ad:capstone",
    });

    profile = await gamificationProfile({ phone });
    expect(missionState(profile, "daily_ad_lunch")).toBe("CLAIMED");
    expect(missionState(profile, "daily_four_missions")).toBe("CLAIMED");
    // 90 from the first three legs and their badges, 10 for the ad, then 30
    // for the capstone.
    expect(profile.level.lifetimeXp).toBe(130);
    // The capstone completing must not feed itself a fifth tick.
    expect(
      profile.missions.filter((mission) => mission.state === "CLAIMED"),
    ).toHaveLength(5);
  });

  // T4
  it("offers a level-up to celebrate once and never again", async () => {
    const token = await issueMobileToken();
    const db = await getDb();
    const wallet = await ensureRewardWallet(db, { phone });
    await run(db, "UPDATE reward_wallets SET balance_centavos = ? WHERE id = ?", [
      600_00,
      wallet.id,
    ]);

    await convertPointsToXp({
      phone,
      businessId: null,
      amount: 500,
      idempotencyKey: "loop-levelup-conversion",
    });

    let profile = await gamificationProfile({ phone });
    expect(profile.level.level).toBe(2);
    expect(profile.levelUpToAnnounce).toBe(2);

    await acknowledgeSeen(
      bearer("http://localhost/api/public/gamification/achievements/seen", token, {
        method: "POST",
        body: JSON.stringify({ levelUp: true }),
      }),
    );

    profile = await gamificationProfile({ phone });
    expect(profile.level.level).toBe(2);
    expect(profile.levelUpToAnnounce).toBeNull();
  });

  // T7
  it("unlocks Hunt Master from a real hunt and holds the badge unseen", async () => {
    const token = await issueMobileToken();

    await drawOne(token, "loop-badge");

    const before = await unwrap<{
      achievements: AchievementCard[];
      unseenUnlocks: Array<{ groupKey: string; tier: string }>;
    }>(
      await readAchievements(
        bearer("http://localhost/api/public/gamification/achievements", token),
      ),
    );
    const huntMaster = before.achievements.find(
      (card) => card.groupKey === "hunt_master",
    );
    expect(huntMaster?.progress).toBe(1);
    expect(huntMaster?.unlockedTiers).toBe(1);
    expect(huntMaster?.tiers.find((tier) => tier.tier === "Bronze")?.unlocked).toBe(
      true,
    );
    // Silver is 10 hunts away, so one hunt must not have carried it too.
    expect(huntMaster?.nextTier?.tier).toBe("Silver");
    expect(before.unseenUnlocks.map((unlock) => unlock.groupKey)).toContain(
      "hunt_master",
    );

    await acknowledgeSeen(
      bearer("http://localhost/api/public/gamification/achievements/seen", token, {
        method: "POST",
        body: JSON.stringify({ groupKeys: ["hunt_master"] }),
      }),
    );

    const after = await unwrap<{
      unseenUnlocks: Array<{ groupKey: string }>;
    }>(
      await readAchievements(
        bearer("http://localhost/api/public/gamification/achievements", token),
      ),
    );
    expect(after.unseenUnlocks).toHaveLength(0);
  });
});
