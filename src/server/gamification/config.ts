/**
 * Versioned economy configuration.
 *
 * Nothing in the gamification system reads a hard-coded number. Levels,
 * conversion terms, mission payouts and achievement thresholds all come from
 * rows, every row carries a version, and every transaction records the version
 * it ran under — so a month can be reconciled after operations have changed the
 * numbers, and an in-flight mission cannot have its rules moved under it.
 *
 * The values seeded here are the recommended MVP defaults from the requirements
 * document, not decisions: an administrator publishes a new version to change
 * any of them, and no deployment is involved.
 */
import crypto from "node:crypto";
import type { LevelDefinition, RewardLine } from "@bizflow/shared";
import { all, one, run, type Exec } from "@/server/db";
import { AppError } from "@/server/errors";

const isoNow = () => new Date().toISOString();
const id = (prefix: string) => `${prefix}_${crypto.randomBytes(8).toString("hex")}`;

/** LP amounts are centavos everywhere in this codebase; XP is a whole number. */
export type EconomyConfig = {
  /** XP granted per whole LP converted. */
  xpPerLp: number;
  /** Smallest conversion the server will accept. */
  minConversionCentavos: number;
  /** Quick-pick amounts on the Level Up screen. */
  conversionPresetsCentavos: number[];
  /**
   * The most LP one player can be granted by missions and achievements in a
   * Manila day. Past it the reward engine substitutes XP rather than refusing,
   * so a capped player still progresses.
   */
  dailyLpGrantCapCentavos: number;
  /**
   * A single grant above this is written as REVIEW_REQUIRED instead of paid,
   * and waits for an administrator.
   */
  reviewThresholdCentavos: number;
  /** Push blackout, Manila wall clock. Users may override in the app. */
  quietHours: { start: string; end: string };
  /**
   * What the anomaly detectors treat as too much in one Manila day.
   *
   * Risk policy rather than economy, but it belongs to the same versioned
   * settings for the same reason: raising a threshold because a real campaign
   * tripped it should be an operator changing a number, not a deploy.
   */
  risk: RiskThresholds;
  /**
   * Per-feature kill switches and rollout percentages.
   *
   * §17 asks that every feature can be stopped immediately and rolled out
   * gradually. This is where that lives, rather than in an environment
   * variable, for the same reason every other number does: operations turning
   * something off at nine on a Friday must not need a deployment, and the
   * version history is the record of who turned what off and when.
   */
  features: Record<GamificationFeature, FeatureFlag>;
};

/**
 * The five things that can be switched off independently.
 *
 * `levels` covers the ladder, its benefits and the offer gates; `conversion` is
 * LP → XP on its own, because that is the one that moves a partner's liability
 * and is the most likely to need stopping while everything else keeps running.
 */
export type GamificationFeature =
  | "levels"
  | "conversion"
  | "missions"
  | "achievements"
  | "notifications";

export type FeatureFlag = {
  enabled: boolean;
  /**
   * 0-100. The share of players the feature is live for, chosen by a stable
   * hash of the wallet id, so raising the number only ever adds people and a
   * player never falls out of a cohort they were in yesterday.
   *
   * `notifications` is the exception and must be 0 or 100: a push fan-out
   * decides its audience by query rather than one player at a time, and a
   * half-rolled-out announcement would be a silent, unexplainable gap in who
   * heard about a campaign. It is a switch, and publishing anything else for it
   * is refused.
   */
  rolloutPercent: number;
};

export const FEATURE_KEYS: GamificationFeature[] = [
  "levels",
  "conversion",
  "missions",
  "achievements",
  "notifications",
];

const FULLY_ON: FeatureFlag = { enabled: true, rolloutPercent: 100 };

export const DEFAULT_FEATURES: Record<GamificationFeature, FeatureFlag> = {
  levels: FULLY_ON,
  conversion: FULLY_ON,
  missions: FULLY_ON,
  achievements: FULLY_ON,
  notifications: FULLY_ON,
};

export type RiskThresholds = {
  /** Verified rewarded ads in a day beyond which a wallet is worth a look. */
  adsPerDay: number;
  /** Distinct wallets sharing one device fingerprint. */
  walletsPerDevice: number;
  /** QR redemptions by one player in a day. */
  qrPerDay: number;
  /** Referrals verified for one player in a day. */
  referralsPerDay: number;
  /** Reviews verified for one player in a day. */
  reviewsPerDay: number;
  /** Rejected evidence submissions before a player is worth reviewing. */
  rejectedProofs: number;
  /**
   * Open-signal score at which new rewards are held for approval rather than
   * paid. Below it a flagged player keeps earning and is only watched.
   */
  holdScore: number;
};

export const DEFAULT_RISK: RiskThresholds = {
  adsPerDay: 6,
  walletsPerDevice: 4,
  qrPerDay: 12,
  referralsPerDay: 8,
  reviewsPerDay: 6,
  rejectedProofs: 3,
  holdScore: 6,
};

export const DEFAULT_ECONOMY: EconomyConfig = {
  xpPerLp: 1,
  minConversionCentavos: 50_00,
  conversionPresetsCentavos: [50_00, 100_00, 500_00],
  dailyLpGrantCapCentavos: 200_00,
  reviewThresholdCentavos: 500_00,
  quietHours: { start: "22:00", end: "08:00" },
  risk: DEFAULT_RISK,
  features: DEFAULT_FEATURES,
};

export const DEFAULT_LEVELS: LevelDefinition[] = [
  {
    level: 1,
    minXp: 0,
    name: "Explorer",
    benefits: ["public_offers", "daily_missions"],
    bonusHunts: 0,
    earlyAccessMinutes: 0,
  },
  {
    level: 2,
    minXp: 500,
    name: "Hunter",
    benefits: ["public_offers", "daily_missions", "level_missions", "early_access"],
    bonusHunts: 0,
    earlyAccessMinutes: 10,
  },
  {
    level: 3,
    minXp: 1_500,
    name: "Pro Hunter",
    benefits: [
      "public_offers",
      "daily_missions",
      "level_missions",
      "early_access",
      "exclusive_partners",
    ],
    bonusHunts: 1,
    earlyAccessMinutes: 10,
  },
  {
    level: 4,
    minXp: 3_500,
    name: "Elite Hunter",
    benefits: [
      "public_offers",
      "daily_missions",
      "level_missions",
      "early_access",
      "exclusive_partners",
      "premium_offers",
      "level_quota",
    ],
    bonusHunts: 1,
    earlyAccessMinutes: 30,
  },
  {
    level: 5,
    minXp: 7_000,
    name: "Royal Hunter",
    benefits: [
      "public_offers",
      "daily_missions",
      "level_missions",
      "early_access",
      "exclusive_partners",
      "premium_offers",
      "level_quota",
      "invite_only",
      "vip_missions",
    ],
    bonusHunts: 2,
    earlyAccessMinutes: 30,
  },
];

/* Config loading ------------------------------------------------------------ */

type ConfigKey = "economy";

/**
 * Reads the highest-versioned Active row whose `effective_at` has passed.
 *
 * A row scheduled for the future is deliberately invisible until then, which is
 * how an administrator stages a change: publish it dated, and it takes over on
 * its own without anyone deploying at midnight.
 */
async function activeConfigRow(db: Exec, key: ConfigKey) {
  return one(
    db,
    `SELECT * FROM gamification_configs
     WHERE config_key = ? AND status = 'Active' AND effective_at <= ?
     ORDER BY effective_at DESC, version DESC
     LIMIT 1`,
    [key, isoNow()],
  );
}

function mergeFeatures(
  parsed: Partial<Record<GamificationFeature, Partial<FeatureFlag>>> | undefined,
): Record<GamificationFeature, FeatureFlag> {
  const merged = {} as Record<GamificationFeature, FeatureFlag>;
  for (const key of FEATURE_KEYS) {
    const stored = parsed?.[key];
    merged[key] = {
      enabled: stored?.enabled ?? true,
      rolloutPercent: clampPercent(stored?.rolloutPercent ?? 100),
    };
  }
  return merged;
}

const clampPercent = (value: number) =>
  !Number.isFinite(value) ? 100 : Math.min(100, Math.max(0, Math.round(value)));

export type LoadedEconomy = { version: number; economy: EconomyConfig };

/**
 * The economy in force right now.
 *
 * Falls back to the built-in defaults at version 0 when nothing is published —
 * a database that has not been seeded yet still behaves, rather than failing
 * every mission claim with a configuration error.
 */
export async function loadEconomy(db: Exec): Promise<LoadedEconomy> {
  const row = await activeConfigRow(db, "economy");
  if (!row) return { version: 0, economy: DEFAULT_ECONOMY };
  const parsed = JSON.parse(String(row.payload)) as Partial<EconomyConfig>;
  return {
    version: Number(row.version),
    // Merged rather than replaced, so a payload written before a field existed
    // does not read back as undefined and multiply an amount by NaN.
    economy: {
      ...DEFAULT_ECONOMY,
      ...parsed,
      quietHours: { ...DEFAULT_ECONOMY.quietHours, ...(parsed.quietHours ?? {}) },
      risk: { ...DEFAULT_RISK, ...(parsed.risk ?? {}) },
      // A payload written before flags existed reads back as fully on, which is
      // the behaviour it had. A missing flag must never read as "off": that
      // would turn an old config version into an outage.
      features: mergeFeatures(parsed.features),
    },
  };
}

export type LoadedLevels = { version: number; levels: LevelDefinition[] };

/** The published level ladder, newest version wins. */
export async function loadLevels(db: Exec): Promise<LoadedLevels> {
  const versionRow = await one(
    db,
    `SELECT MAX(version) AS version FROM level_definitions WHERE effective_at <= ?`,
    [isoNow()],
  );
  const version = Number(versionRow?.version ?? 0);
  if (!version) return { version: 0, levels: DEFAULT_LEVELS };
  const rows = await all(
    db,
    "SELECT * FROM level_definitions WHERE version = ? ORDER BY min_xp ASC",
    [version],
  );
  return {
    version,
    levels: rows.map((row) => ({
      level: Number(row.level),
      minXp: Number(row.min_xp),
      name: String(row.name),
      benefits: JSON.parse(String(row.benefits_json ?? "[]")),
      bonusHunts: Number(row.bonus_hunts ?? 0),
      earlyAccessMinutes: Number(row.early_access_minutes ?? 0),
    })),
  };
}

/* Publishing ---------------------------------------------------------------- */

/**
 * Publishes a new economy version.
 *
 * Never an update: the previous row is retired, not overwritten, so a
 * conversion that recorded version 3 can still be explained after version 4 is
 * live. `effectiveAt` in the future stages the change instead of applying it.
 */
export async function publishEconomy(
  db: Exec,
  input: {
    economy: EconomyConfig;
    actor: string;
    note?: string;
    effectiveAt?: string;
  },
) {
  assertEconomyIsSane(input.economy);
  const nextVersion = Number(
    (
      await one(
        db,
        "SELECT COALESCE(MAX(version), 0) + 1 AS next FROM gamification_configs WHERE config_key = 'economy'",
      )
    )?.next ?? 1,
  );
  const effectiveAt = input.effectiveAt ?? isoNow();
  await run(
    db,
    `INSERT INTO gamification_configs
     (id, config_key, version, payload, status, effective_at, created_by, note, created_at)
     VALUES (?, 'economy', ?, ?, 'Active', ?, ?, ?, ?)`,
    [
      id("gcfg"),
      nextVersion,
      JSON.stringify(input.economy),
      effectiveAt,
      input.actor,
      input.note ?? null,
      isoNow(),
    ],
  );
  // Only rows already in force are retired. A version staged for next week is
  // still Active-and-pending and must survive this publish.
  await run(
    db,
    `UPDATE gamification_configs SET status = 'Retired'
     WHERE config_key = 'economy' AND version < ? AND status = 'Active'`,
    [nextVersion],
  );
  return nextVersion;
}

function assertEconomyIsSane(economy: EconomyConfig) {
  if (!(economy.xpPerLp > 0) || !Number.isFinite(economy.xpPerLp)) {
    throw new AppError("E-CONFIG-INVALID", "XP per LP must be greater than zero", 400);
  }
  if (!Number.isInteger(economy.minConversionCentavos) || economy.minConversionCentavos <= 0) {
    throw new AppError(
      "E-CONFIG-INVALID",
      "The minimum conversion must be a positive LP amount",
      400,
    );
  }
  if (economy.dailyLpGrantCapCentavos < 0 || economy.reviewThresholdCentavos < 0) {
    throw new AppError("E-CONFIG-INVALID", "Budget caps cannot be negative", 400);
  }
  for (const key of FEATURE_KEYS) {
    const flag = economy.features?.[key];
    if (!flag) {
      throw new AppError("E-CONFIG-INVALID", `Feature "${key}" is missing a flag`, 400);
    }
    if (
      !Number.isInteger(flag.rolloutPercent) ||
      flag.rolloutPercent < 0 ||
      flag.rolloutPercent > 100
    ) {
      throw new AppError(
        "E-CONFIG-INVALID",
        `Rollout for "${key}" must be a whole percentage between 0 and 100`,
        400,
      );
    }
    if (key === "notifications" && flag.rolloutPercent !== 0 && flag.rolloutPercent !== 100) {
      throw new AppError(
        "E-CONFIG-INVALID",
        "Notifications are a switch, not a ramp: use 0 or 100",
        400,
      );
    }
  }
}

/**
 * Publishes a level ladder.
 *
 * Validated hard, because a bad ladder is not a cosmetic problem: a duplicated
 * threshold or a missing floor would put players on a level that does not exist
 * and change what they are allowed to buy.
 */
export async function publishLevels(
  db: Exec,
  input: { levels: LevelDefinition[]; effectiveAt?: string },
) {
  assertLadderIsSane(input.levels);
  const nextVersion = Number(
    (await one(db, "SELECT COALESCE(MAX(version), 0) + 1 AS next FROM level_definitions"))
      ?.next ?? 1,
  );
  const effectiveAt = input.effectiveAt ?? isoNow();
  const now = isoNow();
  for (const level of input.levels) {
    await run(
      db,
      `INSERT INTO level_definitions
       (id, version, level, name, min_xp, benefits_json, bonus_hunts, early_access_minutes, effective_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id("lvl"),
        nextVersion,
        level.level,
        level.name,
        level.minXp,
        JSON.stringify(level.benefits ?? []),
        level.bonusHunts ?? 0,
        level.earlyAccessMinutes ?? 0,
        effectiveAt,
        now,
      ],
    );
  }
  return nextVersion;
}

export function assertLadderIsSane(levels: LevelDefinition[]) {
  if (levels.length === 0) {
    throw new AppError("E-CONFIG-INVALID", "A level ladder needs at least one level", 400);
  }
  const sorted = [...levels].sort((a, b) => a.level - b.level);
  if (sorted[0]!.minXp !== 0) {
    throw new AppError(
      "E-CONFIG-INVALID",
      "The lowest level must start at 0 XP, or new players belong to no level",
      400,
    );
  }
  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i]!.level === sorted[i - 1]!.level) {
      throw new AppError("E-CONFIG-INVALID", `Level ${sorted[i]!.level} is defined twice`, 400);
    }
    if (sorted[i]!.minXp <= sorted[i - 1]!.minXp) {
      throw new AppError(
        "E-CONFIG-INVALID",
        `Level ${sorted[i]!.level} must require more XP than level ${sorted[i - 1]!.level}`,
        400,
      );
    }
  }
}

/* Reward shorthand ---------------------------------------------------------- */

/** Parses a stored `reward_json` column, tolerating a row written badly. */
export function parseRewardLines(json: string | null | undefined): RewardLine[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (line): line is RewardLine =>
        line &&
        typeof line.type === "string" &&
        (typeof line.amount === "number" || line.type === "BADGE"),
    );
  } catch {
    return [];
  }
}
