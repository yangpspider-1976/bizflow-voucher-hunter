// Gamification domain: levels, missions, achievements.
//
// Isomorphic, like the rest of @bizflow/shared: the web app, the API and the
// React Native app all read these shapes. Nothing here decides anything on a
// user's behalf — the server is the authority on XP, level, progress and
// reward. The one calculation that lives here, `levelForXp`, is exported so the
// server has a single tested implementation and so admin previews can render a
// threshold table without a round trip; the app shows the level the server sent
// it, never one it worked out itself.

/* Levels -------------------------------------------------------------------- */

export type LevelBenefitKey =
  | "public_offers"
  | "daily_missions"
  | "level_missions"
  | "early_access"
  | "exclusive_partners"
  | "premium_offers"
  | "level_quota"
  | "invite_only"
  | "vip_missions";

export type LevelDefinition = {
  level: number;
  /** Cumulative lifetime XP at which this level starts. Level 1 is always 0. */
  minXp: number;
  /** Display name, e.g. "Explorer". */
  name: string;
  benefits: LevelBenefitKey[];
  /** Extra voucher-hunt attempts per day this level grants. */
  bonusHunts: number;
  /** Minutes of head start on offers flagged for early access. 0 means none. */
  earlyAccessMinutes: number;
};

/** A user's level standing, exactly as the server computed it. */
export type LevelState = {
  level: number;
  name: string;
  lifetimeXp: number;
  /** XP at which the current level started. */
  levelFloorXp: number;
  /** XP at which the next level starts, or null at the top level. */
  nextLevelXp: number | null;
  /** XP still to earn to be promoted, or null at the top level. */
  xpToNextLevel: number | null;
  /** 0-1, how far through the current band. 1 at the top level. */
  progress: number;
  benefits: LevelBenefitKey[];
  bonusHunts: number;
  earlyAccessMinutes: number;
};

/**
 * The level a lifetime XP total earns.
 *
 * Definitions need not arrive sorted and need not start at zero: the lowest
 * defined level is the floor, so a total below every threshold still lands on a
 * real level rather than on `undefined`. XP does not decrease through normal
 * activity, so this only ever moves a user up — a demotion requires a reversing
 * ledger entry, which lowers `lifetimeXp` first.
 */
export function levelForXp(
  definitions: readonly LevelDefinition[],
  lifetimeXp: number,
): LevelState {
  const ladder = [...definitions].sort((a, b) => a.minXp - b.minXp);
  if (ladder.length === 0) {
    throw new Error("Level configuration has no levels");
  }
  const xp = Math.max(0, Math.floor(lifetimeXp));
  let index = 0;
  for (let i = 0; i < ladder.length; i += 1) {
    if (xp >= ladder[i]!.minXp) index = i;
  }
  const current = ladder[index]!;
  const next = ladder[index + 1];
  const span = next ? next.minXp - current.minXp : 0;
  return {
    level: current.level,
    name: current.name,
    lifetimeXp: xp,
    levelFloorXp: current.minXp,
    nextLevelXp: next ? next.minXp : null,
    xpToNextLevel: next ? Math.max(0, next.minXp - xp) : null,
    // A zero-width band would divide by zero; treat it as complete, which is
    // also what the top level reports.
    progress: next && span > 0 ? Math.min(1, (xp - current.minXp) / span) : 1,
    benefits: current.benefits,
    bonusHunts: current.bonusHunts,
    earlyAccessMinutes: current.earlyAccessMinutes,
  };
}

/* Rewards ------------------------------------------------------------------- */

export type GamificationRewardType = "XP" | "LP" | "HUNT_TICKET" | "BADGE";
export type FundingSource = "PLATFORM" | "PARTNER";
export type RewardTransactionState =
  | "GRANTED"
  | "REVIEW_REQUIRED"
  | "REVERSED"
  | "REJECTED";

/**
 * One line of a reward package. `amount` is XP points, LP centavos or a ticket
 * count depending on `type` — the unit follows the type, as it does in the
 * loyalty ledger, so nothing has to carry a currency alongside it.
 */
export type RewardLine = {
  type: GamificationRewardType;
  amount: number;
  fundingSource?: FundingSource;
  /** Badge rewards only: the achievement group the badge belongs to. */
  badge?: string;
};

/** What a mission or achievement pays out, as the app should render it. */
export type RewardSummary = {
  xp: number;
  /** LP centavos, matching every other LP amount in the API. */
  lpCentavos: number;
  /** Preformatted, e.g. "5 LP". Empty when the reward pays no LP. */
  lp: string;
  huntTickets: number;
  badge?: string;
};

/* Missions ------------------------------------------------------------------ */

export type MissionType = "DAILY" | "URGENT" | "ONBOARDING" | "PARTNER";

/**
 * The lifecycle from the spec. Auto-reward missions move straight from
 * IN_PROGRESS to CLAIMED, but the CLAIMABLE transition is still written to the
 * mission's history so the path is auditable either way.
 */
export type MissionState =
  | "LOCKED"
  | "AVAILABLE"
  | "IN_PROGRESS"
  | "VERIFYING"
  | "CLAIMABLE"
  | "CLAIMED"
  | "EXPIRED"
  | "REJECTED"
  | "CANCELLED";

export type MissionTriggerEvent =
  | "ad_reward_verified"
  | "hunt_complete"
  | "voucher_select"
  | "qr_redeem"
  | "booking_complete"
  | "purchase_verified"
  | "review_verified"
  | "referral_verified"
  | "mission_completed";

/** A daily window in Asia/Manila, inclusive of both ends of the minute range. */
export type MissionWindow = {
  /** "06:00" */
  startTime: string;
  /** "10:59" */
  endTime: string;
};

export type MissionCard = {
  missionKey: string;
  definitionVersion: number;
  type: MissionType;
  title: string;
  description: string;
  triggerEvent: MissionTriggerEvent;
  state: MissionState;
  progress: number;
  target: number;
  reward: RewardSummary;
  /** Null on missions with no time-of-day restriction. */
  window: MissionWindow | null;
  /** True while the Manila clock is inside `window` (always true when null). */
  windowOpen: boolean;
  /** Minimum level required to join. */
  minLevel: number;
  /** True when the viewer's level is below `minLevel`. */
  locked: boolean;
  /** XP the viewer still needs to unlock a level-gated mission. */
  xpToUnlock: number;
  /** Set when the mission belongs to one partner. */
  partnerId?: string;
  partnerName?: string;
  /** ISO. When this instance stops counting. */
  expiresAt: string;
  /** True when completing pays out without the user tapping Claim. */
  autoClaim: boolean;
};

/* Achievements -------------------------------------------------------------- */

export type AchievementTier = "Bronze" | "Silver" | "Gold" | "Royal";

export const ACHIEVEMENT_TIERS: readonly AchievementTier[] = [
  "Bronze",
  "Silver",
  "Gold",
  "Royal",
];

export type AchievementCategory =
  | "hunt"
  | "visit"
  | "mission"
  | "streak"
  | "review"
  | "referral"
  | "explore"
  | "points";

export type AchievementTierState = {
  tier: AchievementTier;
  threshold: number;
  reward: RewardSummary;
  unlocked: boolean;
  /** ISO, set only once unlocked. */
  unlockedAt?: string;
};

export type AchievementCard = {
  groupKey: string;
  title: string;
  description: string;
  category: AchievementCategory;
  counterKey: string;
  /** Where the cumulative counter stands right now. */
  progress: number;
  tiers: AchievementTierState[];
  /** The next tier still to unlock, or null once every tier is done. */
  nextTier: AchievementTierState | null;
  unlockedTiers: number;
};

/* Profile ------------------------------------------------------------------- */

/** One screen's worth of state: the spec's "one screen" success criterion. */
export type GamificationProfile = {
  level: LevelState;
  /** All levels, so the app can show the ladder without a second call. */
  levels: LevelDefinition[];
  missions: MissionCard[];
  achievements: AchievementCard[];
  /** Manila date the daily missions belong to, YYYY-MM-DD. */
  missionDate: string;
  /** ISO instant the daily set resets (00:00 Manila tomorrow). */
  missionsResetAt: string;
  /** Reward still sitting in CLAIMABLE across every mission. */
  claimable: RewardSummary;
  /** LP available to convert, by wallet. */
  convertibleLp: ConvertibleWallet[];
  /** Economy settings the LP-to-XP screen needs. */
  conversion: ConversionTerms;
  /** Achievement tiers unlocked but never shown a celebration screen. */
  unseenUnlocks: AchievementUnlockNotice[];
  /**
   * A promotion the player has not been shown yet, or null.
   *
   * Held server-side rather than in device storage because a level can be won
   * while the app is closed - a mission completing on an ad callback, an
   * achievement unlocking on a QR scan - and the celebration should be waiting
   * on whichever device they open next, exactly once.
   */
  levelUpToAnnounce: number | null;
  configVersion: number;
};

export type AchievementUnlockNotice = {
  groupKey: string;
  title: string;
  tier: AchievementTier;
  reward: RewardSummary;
  unlockedAt: string;
};

export type ConvertibleWallet = {
  /** Null for the spend-anywhere global pot. */
  businessId: string | null;
  businessName: string;
  balanceCentavos: number;
  balance: string;
};

export type ConversionTerms = {
  /** XP granted per whole LP. Default 1. */
  xpPerLp: number;
  minLpCentavos: number;
  minLp: string;
  /** Suggested quick-pick amounts, in LP centavos. */
  presetsCentavos: number[];
};

export type PointConversionResult = {
  conversionId: string;
  lpDebitedCentavos: number;
  lpDebited: string;
  xpGranted: number;
  level: LevelState;
  /** True when this conversion crossed at least one threshold. */
  leveledUp: boolean;
  previousLevel: number;
  xpLedgerId: string;
  loyaltyLedgerId: string;
};

/** What a mission claim (or an auto-claim) actually paid out. */
export type MissionClaimResult = {
  missionKey: string;
  state: MissionState;
  reward: RewardSummary;
  level: LevelState;
  leveledUp: boolean;
  /** Achievement tiers this claim happened to unlock, if any. */
  unlocked: AchievementUnlockNotice[];
};
