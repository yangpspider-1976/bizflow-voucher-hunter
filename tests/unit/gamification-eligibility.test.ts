import { describe, expect, it } from "vitest";
import { metresBetween } from "@bizflow/shared";
import {
  evaluateEligibility,
  matchesSegment,
  parseAudience,
  quotaRemaining,
  type MissionDefinition,
  type PlayerFacts,
} from "@/server/gamification/missions";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-08-27T04:00:00.000Z"); // noon in Manila

function daysAgo(days: number) {
  return new Date(NOW.getTime() - days * DAY_MS).toISOString();
}

function facts(overrides: Partial<PlayerFacts> = {}): PlayerFacts {
  return {
    walletCreatedAt: daysAgo(200),
    lastEventAt: daysAgo(1),
    priorEventAt: daysAgo(10),
    visitedPartnerIds: new Set<string>(),
    ...overrides,
  };
}

function definition(overrides: Partial<MissionDefinition> = {}): MissionDefinition {
  return {
    missionKey: "offpeak_lunch",
    definitionVersion: 1,
    type: "URGENT",
    title: "Off-peak lunch",
    description: "",
    triggerEvent: "qr_redeem",
    targetCount: 1,
    window: null,
    minLevel: 1,
    partnerId: "biz_1",
    reward: [{ type: "XP", amount: 50 }],
    condition: {},
    audience: { segment: "all" },
    autoClaim: true,
    requiresProof: false,
    quotaMode: "ON_COMPLETION",
    userQuota: 1,
    globalQuota: null,
    joinedCount: 0,
    completedCount: 0,
    rewardBudgetCentavos: null,
    spentBudgetCentavos: 0,
    startsAt: null,
    endsAt: null,
    exposureChannel: "app",
    termsUrl: null,
    sortOrder: 100,
    status: "Active",
    ...overrides,
  };
}

describe("audience parsing", () => {
  it("defaults a row written before the column existed", () => {
    expect(parseAudience(null)).toEqual({ segment: "all" });
    expect(parseAudience("not json")).toEqual({ segment: "all" });
  });

  it("refuses an unknown segment rather than passing it through", () => {
    expect(parseAudience(JSON.stringify({ segment: "vip" })).segment).toBe("all");
  });

  it("drops an area with no usable radius", () => {
    const audience = parseAudience(
      JSON.stringify({ segment: "all", area: { latitude: 14.5, longitude: 121, radiusMeters: 0 } }),
    );
    expect(audience.area).toBeUndefined();
  });
});

describe("segments", () => {
  it("counts a player as new by how long ago the wallet was created", () => {
    const audience = { segment: "new" as const };
    expect(matchesSegment(audience, facts({ walletCreatedAt: daysAgo(3) }), NOW)).toBe(true);
    expect(matchesSegment(audience, facts({ walletCreatedAt: daysAgo(30) }), NOW)).toBe(false);
  });

  it("does not call somebody who has never done anything dormant", () => {
    // They are new, not lapsed, and a win-back campaign aimed at them is aimed
    // at the wrong person.
    const audience = { segment: "dormant" as const };
    expect(matchesSegment(audience, facts({ lastEventAt: null }), NOW)).toBe(false);
    expect(matchesSegment(audience, facts({ lastEventAt: daysAgo(60) }), NOW)).toBe(true);
    expect(matchesSegment(audience, facts({ lastEventAt: daysAgo(2) }), NOW)).toBe(false);
  });

  it("wants both halves of a return before calling somebody returning", () => {
    const audience = { segment: "returning" as const };
    // Active now, and silent for the whole dormancy window before it.
    expect(
      matchesSegment(audience, facts({ lastEventAt: daysAgo(1), priorEventAt: daysAgo(90) }), NOW),
    ).toBe(true);
    // Active now, but never went away.
    expect(
      matchesSegment(audience, facts({ lastEventAt: daysAgo(1), priorEventAt: daysAgo(5) }), NOW),
    ).toBe(false);
    // Went away and has not come back.
    expect(
      matchesSegment(audience, facts({ lastEventAt: daysAgo(40), priorEventAt: daysAgo(90) }), NOW),
    ).toBe(false);
  });

  it("honours a segment window an operator overrode", () => {
    expect(
      matchesSegment(
        { segment: "new", segmentDays: 90 },
        facts({ walletCreatedAt: daysAgo(60) }),
        NOW,
      ),
    ).toBe(true);
  });
});

describe("quota", () => {
  it("counts joins when a campaign reserves on join, finishes when it does not", () => {
    expect(
      quotaRemaining(
        definition({ globalQuota: 100, quotaMode: "RESERVE_ON_JOIN", joinedCount: 40, completedCount: 5 }),
      ),
    ).toBe(60);
    expect(
      quotaRemaining(
        definition({ globalQuota: 100, quotaMode: "ON_COMPLETION", joinedCount: 40, completedCount: 5 }),
      ),
    ).toBe(95);
  });

  it("reports null for an unlimited campaign and never a negative number", () => {
    expect(quotaRemaining(definition())).toBeNull();
    expect(
      quotaRemaining(definition({ globalQuota: 10, quotaMode: "ON_COMPLETION", completedCount: 12 })),
    ).toBe(0);
  });
});

describe("eligibility", () => {
  it("lets an ordinary player into an ordinary campaign", () => {
    const result = evaluateEligibility({ definition: definition(), level: 1, facts: facts(), at: NOW });
    expect(result).toEqual({ eligible: true, reason: null, distanceMeters: null });
  });

  it("reports the level gate before anything else", () => {
    // Both apply; the level is the one that reads as a goal, so it wins.
    const result = evaluateEligibility({
      definition: definition({ minLevel: 3, globalQuota: 1, completedCount: 1 }),
      level: 1,
      facts: facts(),
      at: NOW,
    });
    expect(result.reason).toBe("LEVEL_REQUIRED");
  });

  it("reports a campaign that has not opened yet rather than hiding it", () => {
    const result = evaluateEligibility({
      definition: definition({ startsAt: new Date(NOW.getTime() + DAY_MS).toISOString() }),
      level: 5,
      facts: facts(),
      at: NOW,
    });
    expect(result.reason).toBe("NOT_STARTED");
  });

  it("refuses a partner the player has already visited when first visits only", () => {
    const result = evaluateEligibility({
      definition: definition({ audience: { segment: "all", firstVisitOnly: true } }),
      level: 1,
      facts: facts({ visitedPartnerIds: new Set(["biz_1"]) }),
      at: NOW,
    });
    expect(result.reason).toBe("NOT_ELIGIBLE");
  });

  describe("a mission with a radius", () => {
    const area = { latitude: 14.5547, longitude: 121.0244, radiusMeters: 300 };
    const withArea = definition({ audience: { segment: "all", area } });

    it("refuses a player who shared no location", () => {
      const result = evaluateEligibility({ definition: withArea, level: 1, facts: facts(), at: NOW });
      expect(result.reason).toBe("OUT_OF_AREA");
      expect(result.distanceMeters).toBeNull();
    });

    it("admits a player inside the circle and reports the distance", () => {
      const result = evaluateEligibility({
        definition: withArea,
        level: 1,
        facts: facts(),
        location: { latitude: 14.5555, longitude: 121.0244, accuracyMeters: 20 },
        at: NOW,
      });
      expect(result.eligible).toBe(true);
      expect(result.distanceMeters).toBeLessThan(300);
    });

    it("lets a poor fix count in the player's favour at the boundary", () => {
      // ~330m out with a 60m error radius: they may well be inside, and
      // refusing somebody standing in the shop is the worse mistake.
      const result = evaluateEligibility({
        definition: withArea,
        level: 1,
        facts: facts(),
        location: { latitude: 14.5577, longitude: 121.0244, accuracyMeters: 60 },
        at: NOW,
      });
      expect(result.distanceMeters).toBeGreaterThan(300);
      expect(result.eligible).toBe(true);
    });

    it("refuses a fix too vague to test against", () => {
      const result = evaluateEligibility({
        definition: withArea,
        level: 1,
        facts: facts(),
        location: { latitude: 14.5547, longitude: 121.0244, accuracyMeters: 5_000 },
        at: NOW,
      });
      expect(result.eligible).toBe(false);
    });

    it("refuses a location the device itself says is simulated", () => {
      const result = evaluateEligibility({
        definition: withArea,
        level: 1,
        facts: facts(),
        location: { latitude: 14.5547, longitude: 121.0244, accuracyMeters: 5, mocked: true },
        at: NOW,
      });
      expect(result.eligible).toBe(false);
      expect(result.reason).toBe("OUT_OF_AREA");
    });
  });
});

describe("distance", () => {
  it("measures a short hop in metres", () => {
    // One ten-thousandth of a degree of latitude is about 11 metres.
    expect(
      metresBetween({ latitude: 14.5547, longitude: 121.0244 }, { latitude: 14.5548, longitude: 121.0244 }),
    ).toBe(11);
  });

  it("is zero for the same point and symmetric between two", () => {
    const a = { latitude: 14.5547, longitude: 121.0244 };
    const b = { latitude: 14.6091, longitude: 121.0223 };
    expect(metresBetween(a, a)).toBe(0);
    expect(metresBetween(a, b)).toBe(metresBetween(b, a));
    // Makati to Quezon City is roughly six kilometres.
    expect(metresBetween(a, b)).toBeGreaterThan(5_000);
    expect(metresBetween(a, b)).toBeLessThan(7_000);
  });
});
