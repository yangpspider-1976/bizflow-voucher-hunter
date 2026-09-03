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

/**
 * Who an urgent mission is offered to.
 *
 * Evaluated on the server against the player's own history — never sent to the
 * client to decide — but carried in the card so a locked mission can explain
 * itself rather than simply not appearing.
 */
export type MissionSegment = "all" | "new" | "returning" | "dormant";

/** A circle on the map an urgent mission is confined to. */
export type MissionArea = {
  latitude: number;
  longitude: number;
  radiusMeters: number;
};

export type MissionAudience = {
  segment: MissionSegment;
  /**
   * Days of silence that make a player "dormant", or days since sign-up that
   * make them "new". Ignored by the `all` segment.
   */
  segmentDays?: number;
  area?: MissionArea;
  /** True when only a partner the player has never visited counts. */
  firstVisitOnly?: boolean;
};

/** Whether a limited campaign takes a place when a player joins, or when they finish. */
export type MissionQuotaMode = "RESERVE_ON_JOIN" | "ON_COMPLETION";

export type MissionProofKind = "photo" | "receipt" | "text";

export type MissionProofStatus = "Pending" | "Approved" | "Rejected" | "Superseded";

/** What the app needs to render the evidence half of a mission. */
export type MissionProofState = {
  proofId: string;
  kind: MissionProofKind;
  status: MissionProofStatus;
  submittedAt: string;
  reviewedAt?: string;
  /** Why an operator turned it down, shown verbatim so the player can fix it. */
  rejectReason?: string;
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

  /* Urgent missions ---------------------------------------------------------
   *
   * A daily mission is always the player's own row; an urgent one is a campaign
   * they may not have joined yet, so its card also has to describe the campaign
   * itself — how long it runs, how many places are left, and why they cannot
   * join if they cannot.
   */

  /** True when the player has no instance yet and tapping Join would create one. */
  joinable: boolean;
  /** Places left in a limited campaign, or null when it is unlimited. */
  quotaRemaining: number | null;
  /** ISO. When the campaign itself opens, or null if it already has. */
  startsAt: string | null;
  /** ISO. When the campaign closes, or null when it runs until stopped. */
  endsAt: string | null;
  /** True when finishing needs a photo, receipt or note an operator approves. */
  requiresProof: boolean;
  /** The evidence already submitted for this instance, newest first. */
  proof: MissionProofState | null;
  /** Set when the mission is confined to an area, so the app can show a map. */
  area: MissionArea | null;
  /** Metres from the player to `area`, when they shared a location. */
  distanceMeters: number | null;
  /**
   * Why this mission cannot be joined right now, or null when it can be.
   * A named reason rather than a hidden card: the requirements are explicit
   * that a restriction should read as a goal.
   */
  ineligibleReason:
    | "LEVEL_REQUIRED"
    | "QUOTA_EXHAUSTED"
    | "NOT_ELIGIBLE"
    | "OUT_OF_AREA"
    | "NOT_STARTED"
    | null;
  /** Optional link to the campaign's own terms. */
  termsUrl: string | null;
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
  /**
   * Which parts of the system are running for this player right now.
   *
   * The server has already applied these — a switched-off feature comes back
   * empty rather than populated-but-forbidden — so the app uses them to decide
   * what to draw, never what to allow. A tab for a feature that is off is worse
   * than no tab: it is a dead end with no explanation.
   */
  features: GamificationFeatures;
};

export type GamificationFeatures = {
  levels: boolean;
  conversion: boolean;
  missions: boolean;
  achievements: boolean;
};

/** Everything on, which is what a client that cannot see the field assumes. */
export const ALL_FEATURES_ON: GamificationFeatures = {
  levels: true,
  conversion: true,
  missions: true,
  achievements: true,
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

/** What the server says after a player submits evidence for a mission. */
export type MissionProofResult = {
  missionKey: string;
  /**
   * VERIFYING while an operator has yet to decide. Auto-approved evidence
   * (none is, today) would come back CLAIMABLE or CLAIMED instead.
   */
  state: MissionState;
  proof: MissionProofState;
};

/* Level-gated offers -------------------------------------------------------- */

/**
 * The level restrictions a partner may put on one campaign.
 *
 * All four are opt-in and their defaults are exactly the behaviour that existed
 * before levels: level 1, not exclusive, no head start, no extra hunts. A
 * campaign nobody has configured is open to everybody, as it always was.
 */
export type OfferLevelRules = {
  /** Nobody below this level may hunt the campaign. 1 means no restriction. */
  minUserLevel: number;
  /**
   * Hide the campaign from players below `minUserLevel` instead of showing it
   * locked. §3.2 says a restriction should read as a goal, so this is off by
   * default and is meant for the invitation-only offers at the top of the
   * ladder — the ones whose existence is itself the privilege.
   */
  levelExclusive: boolean;
  /**
   * Extra hunts per day this campaign grants a qualifying player, on top of the
   * allowance their level already carries. 0 means none.
   */
  levelQuota: number;
  /** The partner's own name for the level offer, shown on the card. */
  levelOfferLabel: string | null;
  /**
   * When the campaign opens to everybody, as an ISO instant. Null means it is
   * open now, which is what every campaign written before this field did.
   * A level's `earlyAccessMinutes` is subtracted from this and from nothing
   * else — a head start needs a start to be ahead of.
   */
  earlyAccessAt: string | null;
};

export const OPEN_OFFER_RULES: OfferLevelRules = {
  minUserLevel: 1,
  levelExclusive: false,
  levelQuota: 0,
  levelOfferLabel: null,
  earlyAccessAt: null,
};

/** What the viewer's own standing contributes to the decision. */
export type OfferViewer = {
  level: number;
  lifetimeXp: number;
  /** From the viewer's level definition. 0 for a signed-out visitor. */
  earlyAccessMinutes: number;
};

/** A signed-out visitor is judged as the floor of the ladder, never as unknown. */
export const ANONYMOUS_VIEWER: OfferViewer = {
  level: 1,
  lifetimeXp: 0,
  earlyAccessMinutes: 0,
};

export type OfferGate = {
  /** True when the server would refuse a hunt on this campaign right now. */
  locked: boolean;
  reason: "LEVEL_REQUIRED" | "NOT_OPEN" | null;
  /** Always present, so the card can say what the offer is for. */
  requiredLevel: number;
  /** XP still to earn to reach `requiredLevel`; null when already there. */
  missingXp: number | null;
  /** When it opens to everybody. Null when it is always open. */
  opensAt: string | null;
  /** When it opens for this viewer — earlier than `opensAt` with a head start. */
  opensForViewerAt: string | null;
  /** True while the viewer is inside their head start and others are not. */
  earlyAccessActive: boolean;
  /** Extra hunts this campaign grants the viewer, once they qualify. */
  levelQuota: number;
  label: string | null;
  /** Keep the campaign out of the viewer's list entirely. */
  hidden: boolean;
};

const minXpForLevel = (ladder: readonly LevelDefinition[], level: number) => {
  const match = [...ladder].sort((a, b) => a.minXp - b.minXp).find((d) => d.level >= level);
  return match ? match.minXp : null;
};

/**
 * Whether one viewer may hunt one campaign, and what to tell them if not.
 *
 * Pure, and shared, so the card the app renders and the refusal the server
 * issues are the same decision rather than two that agree by inspection.
 *
 * The order matters: the level gate is answered before the clock. A player
 * three levels short does not need to know the offer opens at six — the level
 * is the thing they can do something about, and §4's rule that the first true
 * reason wins applies here for the same reason it applies to missions.
 */
export function evaluateOfferGate(
  rules: OfferLevelRules,
  viewer: OfferViewer,
  ladder: readonly LevelDefinition[],
  nowIso: string,
): OfferGate {
  const requiredLevel = Math.max(1, Math.floor(rules.minUserLevel));
  const belowLevel = viewer.level < requiredLevel;
  const threshold = minXpForLevel(ladder, requiredLevel);
  const missingXp =
    belowLevel && threshold !== null ? Math.max(0, threshold - viewer.lifetimeXp) : null;

  // A head start is only ever granted to somebody the level gate already
  // admits: early access to an offer you cannot hunt is not a benefit.
  const headStartMinutes = belowLevel ? 0 : Math.max(0, viewer.earlyAccessMinutes);
  const opensAt = rules.earlyAccessAt;
  const opensForViewerAt =
    opensAt === null
      ? null
      : new Date(new Date(opensAt).getTime() - headStartMinutes * 60_000).toISOString();

  const now = new Date(nowIso).getTime();
  const beforeViewerOpening = opensForViewerAt !== null && now < new Date(opensForViewerAt).getTime();
  const earlyAccessActive =
    opensAt !== null && headStartMinutes > 0 && !beforeViewerOpening && now < new Date(opensAt).getTime();

  const locked = belowLevel || beforeViewerOpening;
  return {
    locked,
    reason: belowLevel ? "LEVEL_REQUIRED" : beforeViewerOpening ? "NOT_OPEN" : null,
    requiredLevel,
    missingXp,
    opensAt,
    opensForViewerAt,
    earlyAccessActive,
    levelQuota: Math.max(0, Math.floor(rules.levelQuota)),
    label: rules.levelOfferLabel,
    // Only the level gate hides a campaign. One that is merely not open yet is
    // shown with its opening time — that is a countdown, not a restriction.
    hidden: belowLevel && rules.levelExclusive,
  };
}
