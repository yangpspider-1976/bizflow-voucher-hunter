/**
 * The seeded mission and achievement catalogue.
 *
 * These are the requirements document's recommended starting values, written
 * once into `mission_definitions` and `achievement_definitions` so an
 * administrator can change any of them immediately without a deployment. The
 * seed only ever inserts what is missing, so re-running it never overwrites an
 * operator's edits — a definition is changed by publishing a new version, not
 * by editing the row.
 */
import crypto from "node:crypto";
import type {
  AchievementCategory,
  AchievementTier,
  MissionTriggerEvent,
  MissionType,
  RewardLine,
} from "@bizflow/shared";
import { ACHIEVEMENT_TIERS } from "@bizflow/shared";
import type { Client } from "@/server/pg-driver";
import { all, one, run, type Exec } from "@/server/db";
import { DEFAULT_ECONOMY, DEFAULT_LEVELS, publishEconomy, publishLevels } from "./config";

const isoNow = () => new Date().toISOString();
const id = (prefix: string) => `${prefix}_${crypto.randomBytes(8).toString("hex")}`;

export type MissionSeed = {
  missionKey: string;
  type: MissionType;
  title: string;
  description: string;
  triggerEvent: MissionTriggerEvent;
  targetCount: number;
  /** Manila wall clock, inclusive both ends. Null means all day. */
  window: { startTime: string; endTime: string } | null;
  reward: RewardLine[];
  minLevel: number;
  autoClaim: boolean;
  sortOrder: number;
  /** JSON condition rules: uniqueness, amount floors, evidence. */
  condition?: Record<string, unknown>;
};

/**
 * The three ad windows exist to spread engagement across the day rather than to
 * ask for three views in a row: each is its own mission with its own once-a-day
 * limit, so a player who opens the app only at lunch earns exactly one of them.
 */
export const DEFAULT_MISSIONS: MissionSeed[] = [
  {
    missionKey: "daily_ad_morning",
    type: "DAILY",
    title: "Watch a morning ad",
    description: "Watch one rewarded ad between 6:00 AM and 11:00 AM.",
    triggerEvent: "ad_reward_verified",
    targetCount: 1,
    window: { startTime: "06:00", endTime: "10:59" },
    reward: [
      { type: "LP", amount: 5_00, fundingSource: "PLATFORM" },
      { type: "XP", amount: 10 },
    ],
    minLevel: 1,
    autoClaim: true,
    sortOrder: 10,
  },
  {
    missionKey: "daily_ad_lunch",
    type: "DAILY",
    title: "Watch a lunchtime ad",
    description: "Watch one rewarded ad between 11:00 AM and 3:00 PM.",
    triggerEvent: "ad_reward_verified",
    targetCount: 1,
    window: { startTime: "11:00", endTime: "14:59" },
    reward: [
      { type: "LP", amount: 5_00, fundingSource: "PLATFORM" },
      { type: "XP", amount: 10 },
    ],
    minLevel: 1,
    autoClaim: true,
    sortOrder: 20,
  },
  {
    missionKey: "daily_ad_evening",
    type: "DAILY",
    title: "Watch an evening ad",
    description: "Watch one rewarded ad between 5:00 PM and 10:00 PM.",
    triggerEvent: "ad_reward_verified",
    targetCount: 1,
    window: { startTime: "17:00", endTime: "21:59" },
    reward: [
      { type: "LP", amount: 5_00, fundingSource: "PLATFORM" },
      { type: "XP", amount: 10 },
    ],
    minLevel: 1,
    autoClaim: true,
    sortOrder: 30,
  },
  {
    missionKey: "daily_hunt",
    type: "DAILY",
    title: "Complete a voucher hunt",
    description: "Finish a hunt and see what you won.",
    triggerEvent: "hunt_complete",
    targetCount: 1,
    window: null,
    reward: [{ type: "XP", amount: 10 }],
    minLevel: 1,
    autoClaim: true,
    sortOrder: 40,
  },
  {
    missionKey: "daily_voucher_select",
    type: "DAILY",
    title: "Claim a voucher",
    description: "Pick one of your hunt results and book it.",
    triggerEvent: "voucher_select",
    targetCount: 1,
    window: null,
    reward: [{ type: "XP", amount: 10 }],
    minLevel: 1,
    autoClaim: true,
    sortOrder: 50,
  },
  {
    missionKey: "daily_qr_redeem",
    type: "DAILY",
    title: "Visit a partner and scan",
    description: "Use a booking or voucher QR code at a partner store.",
    triggerEvent: "qr_redeem",
    targetCount: 1,
    window: null,
    reward: [
      { type: "LP", amount: 5_00, fundingSource: "PLATFORM" },
      { type: "XP", amount: 20 },
    ],
    minLevel: 1,
    autoClaim: true,
    sortOrder: 60,
  },
  {
    /**
     * The capstone. It counts other missions completing, which is why the rules
     * engine must not let a mission's own reward event feed back into it — see
     * the recursion guard in `missions.ts`.
     */
    missionKey: "daily_four_missions",
    type: "DAILY",
    title: "Finish four missions today",
    description: "Complete any four of today's daily missions.",
    triggerEvent: "mission_completed",
    targetCount: 4,
    window: null,
    reward: [{ type: "XP", amount: 30 }],
    minLevel: 1,
    autoClaim: true,
    sortOrder: 70,
    condition: { uniqueRule: "distinct_mission_key", excludeSelf: true },
  },
];

export type AchievementSeed = {
  groupKey: string;
  title: string;
  description: string;
  category: AchievementCategory;
  counterKey: string;
  thresholds: Record<AchievementTier, number>;
  sortOrder: number;
};

/**
 * XP paid per tier. Badge plus XP is the default reward everywhere; LP and
 * vouchers are opt-in per tier and require budget approval, so no seeded tier
 * pays LP.
 */
export const DEFAULT_TIER_XP: Record<AchievementTier, number> = {
  Bronze: 25,
  Silver: 75,
  Gold: 200,
  Royal: 500,
};

export const DEFAULT_ACHIEVEMENTS: AchievementSeed[] = [
  {
    groupKey: "hunt_master",
    title: "Hunt Master",
    description: "Complete voucher hunts.",
    category: "hunt",
    counterKey: "hunt_complete",
    thresholds: { Bronze: 1, Silver: 10, Gold: 50, Royal: 200 },
    sortOrder: 10,
  },
  {
    groupKey: "voucher_user",
    title: "Voucher User",
    description: "Use vouchers at partner stores.",
    category: "visit",
    counterKey: "qr_redeem",
    thresholds: { Bronze: 1, Silver: 5, Gold: 20, Royal: 50 },
    sortOrder: 20,
  },
  {
    groupKey: "mission_specialist",
    title: "Mission Specialist",
    description: "Complete missions of any kind.",
    category: "mission",
    counterKey: "mission_completed",
    thresholds: { Bronze: 7, Silver: 30, Gold: 100, Royal: 300 },
    sortOrder: 30,
  },
  {
    groupKey: "daily_streak",
    title: "Daily Streak",
    description: "Complete a daily mission on consecutive days.",
    category: "streak",
    counterKey: "daily_streak",
    thresholds: { Bronze: 3, Silver: 7, Gold: 14, Royal: 30 },
    sortOrder: 40,
  },
  {
    groupKey: "reviewer",
    title: "Reviewer",
    description: "Leave a verified review after a visit.",
    category: "review",
    counterKey: "review_verified",
    thresholds: { Bronze: 1, Silver: 5, Gold: 20, Royal: 50 },
    sortOrder: 50,
  },
  {
    groupKey: "connector",
    title: "Connector",
    description: "Bring friends to Voucher Hunt.",
    category: "referral",
    counterKey: "referral_verified",
    thresholds: { Bronze: 1, Silver: 5, Gold: 20, Royal: 50 },
    sortOrder: 60,
  },
  {
    groupKey: "city_explorer",
    title: "City Explorer",
    description: "Use a voucher at partners you have never visited before.",
    category: "explore",
    // Distinct partners, not visits: backed by `user_counter_members`, so the
    // tenth visit to one cafe does not count as ten partners.
    counterKey: "distinct_partners",
    thresholds: { Bronze: 3, Silver: 10, Gold: 25, Royal: 50 },
    sortOrder: 70,
  },
  {
    groupKey: "level_investor",
    title: "Level Investor",
    description: "Convert Loyalty Points into experience.",
    category: "points",
    // Counted in whole LP, which is how the thresholds are written.
    counterKey: "lp_converted",
    thresholds: { Bronze: 100, Silver: 500, Gold: 2_000, Royal: 5_000 },
    sortOrder: 80,
  },
];

/* Seeding ------------------------------------------------------------------- */

/**
 * Puts the default catalogue in place if it is not there already.
 *
 * Runs on every boot and after every reset. Insert-if-absent by key, so an
 * administrator's published version 2 of a mission is never clobbered by the
 * version 1 seed, and a wiped database comes back with a working economy rather
 * than with no missions at all.
 */
export async function ensureGamificationSeed(db: Client) {
  const hasEconomy = await one(
    db,
    "SELECT 1 AS present FROM gamification_configs WHERE config_key = 'economy' LIMIT 1",
  );
  if (!hasEconomy) {
    await publishEconomy(db, {
      economy: DEFAULT_ECONOMY,
      actor: "system",
      note: "Seeded MVP defaults",
    });
  }

  const hasLevels = await one(db, "SELECT 1 AS present FROM level_definitions LIMIT 1");
  if (!hasLevels) await publishLevels(db, { levels: DEFAULT_LEVELS });

  await seedMissions(db);
  await seedAchievements(db);
}

async function seedMissions(db: Exec) {
  const existing = new Set(
    (await all(db, "SELECT DISTINCT mission_key FROM mission_definitions")).map((row) =>
      String(row.mission_key),
    ),
  );
  const now = isoNow();
  for (const mission of DEFAULT_MISSIONS) {
    if (existing.has(mission.missionKey)) continue;
    await run(
      db,
      `INSERT INTO mission_definitions
       (id, mission_key, definition_version, type, title, description, trigger_event,
        target_count, window_start, window_end, min_level, reward_json, condition_json,
        auto_claim, user_quota, status, sort_order, created_by, created_at, updated_at)
       VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'Active', ?, 'system', ?, ?)`,
      [
        id("mdef"),
        mission.missionKey,
        mission.type,
        mission.title,
        mission.description,
        mission.triggerEvent,
        mission.targetCount,
        mission.window?.startTime ?? null,
        mission.window?.endTime ?? null,
        mission.minLevel,
        JSON.stringify(mission.reward),
        JSON.stringify(mission.condition ?? {}),
        mission.autoClaim ? 1 : 0,
        mission.sortOrder,
        now,
        now,
      ],
    );
  }
}

async function seedAchievements(db: Exec) {
  const existing = new Set(
    (await all(db, "SELECT DISTINCT group_key FROM achievement_definitions")).map((row) =>
      String(row.group_key),
    ),
  );
  const now = isoNow();
  for (const achievement of DEFAULT_ACHIEVEMENTS) {
    if (existing.has(achievement.groupKey)) continue;
    for (const tier of ACHIEVEMENT_TIERS) {
      await run(
        db,
        `INSERT INTO achievement_definitions
         (id, group_key, version, tier, title, description, category, counter_key,
          threshold, reward_json, status, sort_order, created_at, updated_at)
         VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, 'Active', ?, ?, ?)`,
        [
          id("adef"),
          achievement.groupKey,
          tier,
          achievement.title,
          achievement.description,
          achievement.category,
          achievement.counterKey,
          achievement.thresholds[tier],
          JSON.stringify([
            { type: "XP", amount: DEFAULT_TIER_XP[tier] },
            { type: "BADGE", amount: 1, badge: `${achievement.groupKey}_${tier.toLowerCase()}` },
          ] satisfies RewardLine[]),
          achievement.sortOrder,
          now,
          now,
        ],
      );
    }
  }
}
