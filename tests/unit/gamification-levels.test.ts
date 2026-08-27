import { describe, expect, it } from "vitest";
import { levelForXp, type LevelDefinition } from "@bizflow/shared";
import { assertLadderIsSane, DEFAULT_LEVELS } from "@/server/gamification/config";

describe("level thresholds", () => {
  it("puts a brand-new player on the bottom level", () => {
    const state = levelForXp(DEFAULT_LEVELS, 0);
    expect(state.level).toBe(1);
    expect(state.name).toBe("Explorer");
    expect(state.nextLevelXp).toBe(500);
    expect(state.xpToNextLevel).toBe(500);
    expect(state.progress).toBe(0);
  });

  it("promotes exactly at the threshold, not one XP early", () => {
    expect(levelForXp(DEFAULT_LEVELS, 499).level).toBe(1);
    expect(levelForXp(DEFAULT_LEVELS, 500).level).toBe(2);
    expect(levelForXp(DEFAULT_LEVELS, 1_499).level).toBe(2);
    expect(levelForXp(DEFAULT_LEVELS, 1_500).level).toBe(3);
    expect(levelForXp(DEFAULT_LEVELS, 3_500).level).toBe(4);
    expect(levelForXp(DEFAULT_LEVELS, 7_000).level).toBe(5);
  });

  it("lands on the right level when a single grant jumps several bands", () => {
    // A backfill can credit thousands of XP at once. The level is derived from
    // the total, so it must land on the top band rather than stepping one up.
    const state = levelForXp(DEFAULT_LEVELS, 50_000);
    expect(state.level).toBe(5);
    expect(state.nextLevelXp).toBeNull();
    expect(state.xpToNextLevel).toBeNull();
    expect(state.progress).toBe(1);
  });

  it("reports progress through the current band, not through the whole ladder", () => {
    // Halfway between 500 and 1,500.
    expect(levelForXp(DEFAULT_LEVELS, 1_000).progress).toBeCloseTo(0.5);
  });

  it("carries the benefits and bonus hunts of the level it lands on", () => {
    expect(levelForXp(DEFAULT_LEVELS, 0).bonusHunts).toBe(0);
    expect(levelForXp(DEFAULT_LEVELS, 1_500).bonusHunts).toBe(1);
    expect(levelForXp(DEFAULT_LEVELS, 7_000).bonusHunts).toBe(2);
    expect(levelForXp(DEFAULT_LEVELS, 7_000).benefits).toContain("invite_only");
  });

  it("does not depend on the definitions arriving sorted", () => {
    const shuffled = [...DEFAULT_LEVELS].reverse();
    expect(levelForXp(shuffled, 3_600).level).toBe(4);
  });

  it("treats a negative total as zero rather than as no level at all", () => {
    expect(levelForXp(DEFAULT_LEVELS, -100).level).toBe(1);
  });
});

describe("ladder validation", () => {
  const ladder = (levels: Partial<LevelDefinition>[]): LevelDefinition[] =>
    levels.map((level, index) => ({
      level: index + 1,
      minXp: 0,
      name: `L${index + 1}`,
      benefits: [],
      bonusHunts: 0,
      earlyAccessMinutes: 0,
      ...level,
    }));

  it("accepts the seeded ladder", () => {
    expect(() => assertLadderIsSane(DEFAULT_LEVELS)).not.toThrow();
  });

  it("refuses a ladder that does not start at zero", () => {
    // Every new player would otherwise belong to no level at all.
    expect(() =>
      assertLadderIsSane(ladder([{ minXp: 100 }, { minXp: 500 }])),
    ).toThrow(/start at 0 XP/);
  });

  it("refuses thresholds that do not increase", () => {
    expect(() =>
      assertLadderIsSane(ladder([{ minXp: 0 }, { minXp: 500 }, { minXp: 500 }])),
    ).toThrow(/must require more XP/);
  });

  it("refuses an empty ladder", () => {
    expect(() => assertLadderIsSane([])).toThrow(/at least one level/);
  });
});
