import type { VoucherAttempt } from "@bizflow/shared";
import { describe, expect, it } from "vitest";

import { reelAction } from "../../apps/mobile/src/hunt/reelDecision";

/**
 * The reel is the only screen that can spend a customer's attempt, and the
 * navigator mounts it far more often than a customer asks for a spin. These
 * cases are the guard on that: every "the reel opened but nobody asked" shape
 * that has actually been observed in the app is here, and none of them may
 * come back as a draw.
 */
function attempt(
  id: string,
  status: VoucherAttempt["status"] = "Candidate",
): VoucherAttempt {
  return {
    id,
    campaignId: "campaign-1",
    userId: "user-1",
    attemptNumber: 1,
    sourceType: "base",
    benefitType: "discount_percent",
    benefitValue: "20",
    displayLabel: "20% OFF",
    rarity: "standard",
    poolId: "pool-1",
    status,
    expiresAt: "2099-01-01T00:00:00.000Z",
    createdAt: "2026-08-18T00:00:00.000Z",
  };
}

const none: VoucherAttempt[] = [];

describe("what the reel does when it opens", () => {
  it("draws when the customer asked for a spin and holds nothing", () => {
    expect(
      reelAction({
        attempts: none,
        freshSpin: false,
        hasIntent: true,
        hasVoucher: false,
      }),
    ).toEqual({ type: "draw" });
  });

  it("never draws for a mount nobody asked for", () => {
    // The stale reel left in the campaign stack, remounting as the screens
    // above it unwind. Three of these in a row spent every attempt a campaign
    // allows and handed the customer a results list they never span for.
    expect(
      reelAction({
        attempts: none,
        freshSpin: false,
        hasIntent: false,
        hasVoucher: false,
      }),
    ).toEqual({ type: "leave" });
  });

  it("still refuses to draw for an unasked mount carrying spin=fresh", () => {
    // The parameter rides in the URL, so it survives every remount of that
    // route. Only the intent, which is consumed once, can authorise a draw.
    expect(
      reelAction({
        attempts: none,
        freshSpin: true,
        hasIntent: false,
        hasVoucher: false,
      }),
    ).toEqual({ type: "leave" });
  });

  it("reveals a draw that was never landed instead of buying another", () => {
    const held = attempt("att_live");
    expect(
      reelAction({
        attempts: [held],
        freshSpin: false,
        hasIntent: true,
        hasVoucher: false,
      }),
    ).toEqual({ type: "reveal", attempt: held });
  });

  it("reveals it on a resume, with no intent at all", () => {
    const held = attempt("att_live");
    expect(
      reelAction({
        attempts: [held],
        freshSpin: false,
        hasIntent: false,
        hasVoucher: false,
      }),
    ).toEqual({ type: "reveal", attempt: held });
  });

  it("reveals the newest bookable draw when several are held", () => {
    const attempts = [attempt("att_1"), attempt("att_2")];
    expect(
      reelAction({
        attempts,
        freshSpin: false,
        hasIntent: true,
        hasVoucher: false,
      }),
    ).toEqual({ type: "reveal", attempt: attempts[1] });
  });

  it("ignores attempts that can no longer be booked", () => {
    expect(
      reelAction({
        attempts: [attempt("att_expired", "Expired")],
        freshSpin: false,
        hasIntent: true,
        hasVoucher: false,
      }),
    ).toEqual({ type: "draw" });
  });

  it("draws a genuine Spin again over a held candidate", () => {
    expect(
      reelAction({
        attempts: [attempt("att_live")],
        freshSpin: true,
        hasIntent: true,
        hasVoucher: false,
      }),
    ).toEqual({ type: "draw" });
  });

  it("falls back to revealing when a Spin again loses its intent", () => {
    // A remount of the spin=fresh route: showing the prize it already holds
    // beats abandoning a screen the customer is looking at.
    const held = attempt("att_live");
    expect(
      reelAction({
        attempts: [held],
        freshSpin: true,
        hasIntent: false,
        hasVoucher: false,
      }),
    ).toEqual({ type: "reveal", attempt: held });
  });

  it("sends a finished campaign to its voucher rather than the reel", () => {
    expect(
      reelAction({
        attempts: [attempt("att_live")],
        freshSpin: true,
        hasIntent: true,
        hasVoucher: true,
      }),
    ).toEqual({ type: "voucher" });
  });
});
