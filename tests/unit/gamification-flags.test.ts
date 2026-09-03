import { describe, expect, it } from "vitest";
import { DEFAULT_ECONOMY, type EconomyConfig, type GamificationFeature } from "@/server/gamification/config";
import { featureEnabledFor, rolloutBucket } from "@/server/gamification/flags";

/**
 * Feature flags and the gradual rollout (§17's last question).
 *
 * The property that matters most is the last one: raising a percentage must
 * only ever add players. A cohort that reshuffles would take the feature away
 * from somebody who had it, which is worse than never having rolled out.
 */

function economy(
  feature: GamificationFeature,
  flag: { enabled: boolean; rolloutPercent: number },
): EconomyConfig {
  return {
    ...DEFAULT_ECONOMY,
    features: { ...DEFAULT_ECONOMY.features, [feature]: flag },
  };
}

const WALLETS = Array.from({ length: 500 }, (_, i) => `rwal_${i.toString(16).padStart(8, "0")}`);

describe("feature flags", () => {
  it("is on by default, for everybody", () => {
    for (const wallet of WALLETS.slice(0, 20)) {
      expect(featureEnabledFor(DEFAULT_ECONOMY, "missions", wallet)).toBe(true);
    }
  });

  it("switches off immediately whatever the percentage says", () => {
    const config = economy("missions", { enabled: false, rolloutPercent: 100 });
    expect(featureEnabledFor(config, "missions", WALLETS[0]!)).toBe(false);
  });

  it("switches off for everybody at zero percent", () => {
    const config = economy("missions", { enabled: true, rolloutPercent: 0 });
    expect(WALLETS.some((wallet) => featureEnabledFor(config, "missions", wallet))).toBe(false);
  });

  it("leaves other features alone", () => {
    const config = economy("missions", { enabled: false, rolloutPercent: 0 });
    expect(featureEnabledFor(config, "achievements", WALLETS[0]!)).toBe(true);
  });

  it("reads a missing flag as on, so an old config version is not an outage", () => {
    const config = { ...DEFAULT_ECONOMY, features: {} } as unknown as EconomyConfig;
    expect(featureEnabledFor(config, "levels", WALLETS[0]!)).toBe(true);
  });

  it("waits for 100% when there is no player to place in a cohort", () => {
    // A cron sweep is not a member of a rollout. Half-rolled-out means "not yet"
    // for anything that is not a person.
    expect(featureEnabledFor(economy("missions", { enabled: true, rolloutPercent: 50 }), "missions", null)).toBe(false);
    expect(featureEnabledFor(economy("missions", { enabled: true, rolloutPercent: 100 }), "missions", null)).toBe(true);
  });

  it("gives the same answer every time for the same player", () => {
    const config = economy("missions", { enabled: true, rolloutPercent: 30 });
    for (const wallet of WALLETS.slice(0, 50)) {
      const first = featureEnabledFor(config, "missions", wallet);
      for (let i = 0; i < 5; i += 1) {
        expect(featureEnabledFor(config, "missions", wallet)).toBe(first);
      }
    }
  });

  it("only ever adds players as the percentage rises", () => {
    let previous: string[] = [];
    for (const percent of [0, 5, 10, 25, 50, 75, 100]) {
      const config = economy("missions", { enabled: true, rolloutPercent: percent });
      const inside = WALLETS.filter((wallet) => featureEnabledFor(config, "missions", wallet));
      for (const wallet of previous) {
        expect(inside).toContain(wallet);
      }
      previous = inside;
    }
    expect(previous).toHaveLength(WALLETS.length);
  });

  it("lands roughly the share it was asked for", () => {
    const config = economy("missions", { enabled: true, rolloutPercent: 25 });
    const inside = WALLETS.filter((wallet) => featureEnabledFor(config, "missions", wallet)).length;
    // Loose bounds: this asserts the hash is not degenerate, not that it is a
    // perfect uniform over 500 samples.
    expect(inside).toBeGreaterThan(WALLETS.length * 0.15);
    expect(inside).toBeLessThan(WALLETS.length * 0.35);
  });

  it("picks a different tenth for each feature", () => {
    // Otherwise the same unlucky players are the guinea pigs for everything and
    // one bad cohort looks like a bad build.
    const missions = WALLETS.filter((wallet) => rolloutBucket("missions", wallet) < 10);
    const achievements = WALLETS.filter((wallet) => rolloutBucket("achievements", wallet) < 10);
    expect(missions).not.toEqual(achievements);
  });

  it("keeps every bucket inside 0-99", () => {
    for (const wallet of WALLETS) {
      const bucket = rolloutBucket("levels", wallet);
      expect(bucket).toBeGreaterThanOrEqual(0);
      expect(bucket).toBeLessThan(100);
    }
  });
});
