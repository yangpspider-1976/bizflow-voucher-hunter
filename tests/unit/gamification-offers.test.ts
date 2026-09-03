import { describe, expect, it } from "vitest";
import {
  ANONYMOUS_VIEWER,
  evaluateOfferGate,
  OPEN_OFFER_RULES,
  type LevelDefinition,
  type OfferLevelRules,
  type OfferViewer,
} from "@bizflow/shared";

/**
 * The level gate on a campaign (§3.4), which is the decision both the card and
 * the server's refusal are made from. Pure, so all of it runs here rather than
 * waiting for a database.
 */

const LADDER: LevelDefinition[] = [
  { level: 1, minXp: 0, name: "Explorer", benefits: [], bonusHunts: 0, earlyAccessMinutes: 0 },
  { level: 2, minXp: 500, name: "Hunter", benefits: [], bonusHunts: 0, earlyAccessMinutes: 10 },
  { level: 3, minXp: 1500, name: "Pro Hunter", benefits: [], bonusHunts: 1, earlyAccessMinutes: 10 },
  { level: 4, minXp: 3500, name: "Elite Hunter", benefits: [], bonusHunts: 1, earlyAccessMinutes: 30 },
  { level: 5, minXp: 7000, name: "Royal Hunter", benefits: [], bonusHunts: 2, earlyAccessMinutes: 30 },
];

const NOW = "2026-09-03T04:00:00.000Z"; // noon in Manila

function rules(overrides: Partial<OfferLevelRules> = {}): OfferLevelRules {
  return { ...OPEN_OFFER_RULES, ...overrides };
}

function viewer(overrides: Partial<OfferViewer> = {}): OfferViewer {
  return { level: 1, lifetimeXp: 0, earlyAccessMinutes: 0, ...overrides };
}

const gate = (
  offer: Partial<OfferLevelRules>,
  who: Partial<OfferViewer> = {},
  now = NOW,
) => evaluateOfferGate(rules(offer), viewer(who), LADDER, now);

describe("offer level gate", () => {
  it("leaves an unconfigured campaign open to everybody", () => {
    const result = gate({}, {});
    expect(result.locked).toBe(false);
    expect(result.hidden).toBe(false);
    expect(result.reason).toBeNull();
  });

  it("locks a campaign the viewer's level does not reach", () => {
    const result = gate({ minUserLevel: 3 }, { level: 2, lifetimeXp: 900 });
    expect(result.locked).toBe(true);
    expect(result.reason).toBe("LEVEL_REQUIRED");
    expect(result.requiredLevel).toBe(3);
  });

  it("says how much XP is still missing, so the lock reads as a goal", () => {
    // Level 3 starts at 1,500 and the player is on 900.
    expect(gate({ minUserLevel: 3 }, { level: 2, lifetimeXp: 900 }).missingXp).toBe(600);
  });

  it("admits somebody exactly on the threshold", () => {
    const result = gate({ minUserLevel: 3 }, { level: 3, lifetimeXp: 1500 });
    expect(result.locked).toBe(false);
    expect(result.missingXp).toBeNull();
  });

  it("treats a signed-out visitor as the floor of the ladder, not as unknown", () => {
    const result = evaluateOfferGate(
      rules({ minUserLevel: 2 }),
      ANONYMOUS_VIEWER,
      LADDER,
      NOW,
    );
    expect(result.locked).toBe(true);
    expect(result.missingXp).toBe(500);
  });

  it("hides an exclusive campaign from somebody below the level", () => {
    expect(gate({ minUserLevel: 5, levelExclusive: true }, { level: 2 }).hidden).toBe(true);
  });

  it("shows a locked campaign that is not exclusive", () => {
    const result = gate({ minUserLevel: 5 }, { level: 2 });
    expect(result.locked).toBe(true);
    expect(result.hidden).toBe(false);
  });

  it("does not hide an exclusive campaign from somebody who qualifies", () => {
    const result = gate({ minUserLevel: 3, levelExclusive: true }, { level: 4, lifetimeXp: 3500 });
    expect(result.locked).toBe(false);
    expect(result.hidden).toBe(false);
  });

  describe("early access", () => {
    const opensAt = "2026-09-03T06:00:00.000Z"; // 14:00 Manila

    it("refuses a campaign that has not opened", () => {
      const result = gate({ earlyAccessAt: opensAt }, {}, "2026-09-03T05:00:00.000Z");
      expect(result.locked).toBe(true);
      expect(result.reason).toBe("NOT_OPEN");
    });

    it("lets a level with a head start in early", () => {
      // 30 minutes before, for a level that carries 30 minutes.
      const result = gate(
        { earlyAccessAt: opensAt },
        { level: 4, lifetimeXp: 3500, earlyAccessMinutes: 30 },
        "2026-09-03T05:40:00.000Z",
      );
      expect(result.locked).toBe(false);
      expect(result.earlyAccessActive).toBe(true);
    });

    it("still refuses somebody whose head start has not started either", () => {
      const result = gate(
        { earlyAccessAt: opensAt },
        { level: 4, lifetimeXp: 3500, earlyAccessMinutes: 30 },
        "2026-09-03T05:20:00.000Z",
      );
      expect(result.locked).toBe(true);
      expect(result.reason).toBe("NOT_OPEN");
      expect(result.opensForViewerAt).toBe("2026-09-03T05:30:00.000Z");
    });

    it("stops calling it early access once the offer is open to everybody", () => {
      const result = gate(
        { earlyAccessAt: opensAt },
        { level: 4, lifetimeXp: 3500, earlyAccessMinutes: 30 },
        "2026-09-03T07:00:00.000Z",
      );
      expect(result.locked).toBe(false);
      expect(result.earlyAccessActive).toBe(false);
    });

    it("gives no head start to somebody the level gate refuses", () => {
      // A head start into an offer you cannot hunt is not a benefit, and the
      // level answer is the one worth showing.
      const result = gate(
        { earlyAccessAt: opensAt, minUserLevel: 5 },
        { level: 4, lifetimeXp: 3500, earlyAccessMinutes: 30 },
        "2026-09-03T05:40:00.000Z",
      );
      expect(result.reason).toBe("LEVEL_REQUIRED");
      expect(result.opensForViewerAt).toBe(opensAt);
    });

    it("is open when no opening time is set", () => {
      const result = gate({ minUserLevel: 2 }, { level: 2, lifetimeXp: 500 });
      expect(result.locked).toBe(false);
      expect(result.opensAt).toBeNull();
    });
  });

  describe("level quota", () => {
    it("carries the campaign's extra hunts for a qualifying player", () => {
      expect(gate({ minUserLevel: 3, levelQuota: 2 }, { level: 3, lifetimeXp: 1500 }).levelQuota).toBe(2);
    });

    it("reports the quota on a locked campaign too, but the caller must not spend it", () => {
      // `campaignLevelQuota` zeroes it when the gate is locked; the gate itself
      // stays a description of the campaign rather than of the entitlement.
      const result = gate({ minUserLevel: 3, levelQuota: 2 }, { level: 1 });
      expect(result.locked).toBe(true);
      expect(result.levelQuota).toBe(2);
    });
  });

  it("carries the partner's label through", () => {
    expect(gate({ levelOfferLabel: "Pro Hunter menu" }, {}).label).toBe("Pro Hunter menu");
  });
});
