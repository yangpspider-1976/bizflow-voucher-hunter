import type { VoucherAttempt } from "@bizflow/shared";
import { describe, expect, it } from "vitest";

import {
  attemptToReveal,
  isHuntStepPath,
  parseProgressMap,
  pruneProgress,
  resumeStep,
  stepFromPathname,
} from "../../apps/mobile/src/hunt/progress";

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

const live = [attempt("att_1")];

describe("hunt step from a pathname", () => {
  it("names each hunt screen of the campaign it belongs to", () => {
    expect(stepFromPathname("/campaign/july-dinner/roulette", "july-dinner")).toBe(
      "roulette",
    );
    expect(stepFromPathname("/campaign/july-dinner/confirm", "july-dinner")).toBe(
      "confirm",
    );
    expect(
      stepFromPathname("/campaign/july%2Ddinner/datetime", "july-dinner"),
    ).toBe("datetime");
  });

  it("does not record the landing screen", () => {
    // The landing is where a resume is offered. Recording it would overwrite
    // the progress the customer went there to continue.
    expect(stepFromPathname("/campaign/july-dinner", "july-dinner")).toBeNull();
  });

  it("ignores paths belonging to anywhere else", () => {
    // A campaign stack stays mounted behind another tab; it must not rewrite
    // its own progress from wherever the customer has gone since.
    expect(stepFromPathname("/campaign/glow-facial/results", "july-dinner")).toBeNull();
    expect(stepFromPathname("/vouchers", "july-dinner")).toBeNull();
    expect(stepFromPathname("/campaign/july-dinner/venue", "july-dinner")).toBeNull();
  });
});

describe("stored progress", () => {
  it("reads nothing out of a blob it cannot trust", () => {
    expect(parseProgressMap(null)).toEqual({});
    expect(parseProgressMap("{ not json")).toEqual({});
    expect(parseProgressMap("[]")).toEqual({});
    // An entry with no recognisable step cannot resume anything.
    expect(parseProgressMap('{"a":{"step":"venue"}}')).toEqual({});
    expect(parseProgressMap('{"a":{"attemptId":"att_1"}}')).toEqual({});
  });

  it("keeps the fields it recognises and drops the rest", () => {
    expect(
      parseProgressMap(
        '{"july-dinner":{"step":"confirm","attemptId":"att_1","slotId":"slot_1","date":"2026-07-05","guestCount":"4","updatedAt":7,"extra":true}}',
      ),
    ).toEqual({
      "july-dinner": {
        step: "confirm",
        attemptId: "att_1",
        slotId: "slot_1",
        date: "2026-07-05",
        guestCount: "4",
        updatedAt: 7,
      },
    });
  });

  it("keeps the most recent campaigns when trimming", () => {
    // The map is one SecureStore value, and an oversized write fails outright —
    // so the campaign being hunted now is the last thing that may be dropped.
    const entries = {
      old: { step: "results" as const, updatedAt: 1 },
      newer: { step: "results" as const, updatedAt: 2 },
      newest: { step: "results" as const, updatedAt: 3 },
    };
    expect(Object.keys(pruneProgress(entries, 2))).toEqual(["newest", "newer"]);
  });
});

describe("resuming a campaign", () => {
  const base = {
    attempts: live,
    hasVoucher: false,
    selectedAttemptId: "att_1",
    selectedSlotId: "",
    step: null,
  };

  it("shows an issued voucher whatever the remembered step says", () => {
    expect(
      resumeStep({ ...base, hasVoucher: true, step: "roulette" }),
    ).toBe("confirmation");
  });

  it("returns to the reel when a draw was never revealed", () => {
    // The regression this exists for: an interrupted spin used to resume at the
    // results list, which shows the prize as settled and silently skips the
    // reveal the attempt was spent on.
    expect(resumeStep({ ...base, step: "roulette" })).toBe("roulette");
  });

  it("returns to the booking screens the customer reached", () => {
    expect(
      resumeStep({ ...base, step: "confirm", selectedSlotId: "slot_1" }),
    ).toBe("confirm");
    expect(resumeStep({ ...base, step: "datetime" })).toBe("datetime");
    expect(resumeStep({ ...base, step: "results" })).toBe("results");
  });

  it("falls back a step when the booking is only half made", () => {
    // Remembered as ready to confirm, but with no slot to confirm against.
    expect(resumeStep({ ...base, step: "confirm" })).toBe("datetime");
  });

  it("sends the customer back to the list when their candidate is gone", () => {
    const stale = {
      ...base,
      attempts: [attempt("att_1", "Expired"), attempt("att_2")],
      selectedSlotId: "slot_1",
    };
    expect(resumeStep({ ...stale, step: "confirm" })).toBe("results");
    expect(resumeStep({ ...stale, step: "datetime" })).toBe("results");
  });

  it("starts a new draw when nothing bookable is held", () => {
    expect(
      resumeStep({
        ...base,
        attempts: [attempt("att_1", "Expired")],
        step: "confirm",
      }),
    ).toBe("roulette");
    expect(resumeStep({ ...base, attempts: [], step: "results" })).toBe("roulette");
  });

  it("resumes a hunt it has no record of from the server state alone", () => {
    // A reinstall, or a device whose storage could not be read: the candidates
    // are still the server's, so the list is the honest place to land.
    expect(resumeStep({ ...base, selectedAttemptId: "", step: null })).toBe(
      "results",
    );
  });

  it("leaves a confirmation with no voucher behind for the candidates", () => {
    expect(resumeStep({ ...base, step: "confirmation" })).toBe("results");
  });

  it("keeps a remembered booking when there is no state to contradict it", () => {
    // Offline: the campaign loaded from cache but the snapshot never arrived,
    // so "no voucher" here means "no answer". Someone who has already booked
    // must not be sent to the reel to hunt a campaign they have finished.
    expect(resumeStep({ ...base, attempts: [], step: "confirmation" })).toBe(
      "confirmation",
    );
  });
});

describe("the draw a resumed reel owes", () => {
  it("takes the newest bookable attempt", () => {
    expect(
      attemptToReveal([attempt("att_1"), attempt("att_2")])?.id,
    ).toBe("att_2");
  });

  it("ignores attempts that can no longer be booked", () => {
    expect(
      attemptToReveal([attempt("att_1"), attempt("att_2", "Expired")])?.id,
    ).toBe("att_1");
    expect(attemptToReveal([attempt("att_1", "Released")])).toBeUndefined();
    expect(attemptToReveal([])).toBeUndefined();
  });
});

/**
 * The regression these exist for: the campaign-switch reset asked "is this path
 * a step of *this* campaign", and at the moment it runs the path still names the
 * campaign being left. It answered no exactly when it needed to answer yes, so
 * opening a second campaign kept showing the first one's reel.
 */
describe("recognising a hunt step path", () => {
  it("sees a step whichever campaign the path names", () => {
    expect(isHuntStepPath("/campaign/campaign-one/roulette")).toBe(true);
    expect(isHuntStepPath("/campaign/campaign-two/results")).toBe(true);
    expect(isHuntStepPath("/campaign/july-dinner/confirmation")).toBe(true);
  });

  it("does not treat a campaign landing as a step", () => {
    // The landing is where a campaign is supposed to open. Popping there would
    // be a no-op at best and a loop at worst.
    expect(isHuntStepPath("/campaign/july-dinner")).toBe(false);
  });

  it("ignores everything outside a campaign", () => {
    expect(isHuntStepPath("/")).toBe(false);
    expect(isHuntStepPath("/more")).toBe(false);
    expect(isHuntStepPath("/vouchers")).toBe(false);
    expect(isHuntStepPath("/shop/checkout")).toBe(false);
  });

  it("does not treat an unknown campaign sub-path as a step", () => {
    expect(isHuntStepPath("/campaign/july-dinner/venue")).toBe(false);
  });
});
