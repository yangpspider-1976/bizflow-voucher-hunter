/**
 * Mission, level and achievement notifications.
 *
 * Copy and audience for the gamification half of the notification system, kept
 * beside the engine that raises them rather than in `notifications.ts` — the
 * queries here all read mission and level tables, and the policy they enforce
 * (quiet hours, marketing consent, a daily ceiling) is economy configuration
 * rather than transport.
 *
 * Every function is fire-and-forget and must be called **after** the
 * originating transaction commits. `sendPush` performs a network call, and
 * holding a write transaction open across one is how a throughput problem
 * becomes a correctness problem.
 *
 * Three rules from §11, applied here rather than at each call site:
 *
 *  - **Quiet hours.** 22:00–08:00 Manila by default, published as economy
 *    configuration, overridable per device by the player.
 *  - **Marketing consent.** An urgent-mission announcement is marketing and
 *    needs it. "Your evidence was approved" is transactional and does not.
 *  - **A frequency cap.** Nobody gets more than a few mission pushes a day,
 *    however many campaigns happen to launch.
 */
import type { AchievementUnlockNotice } from "@bizflow/shared";
import { all, getDb, one, run } from "@/server/db";
import { centavosToLoyaltyPoints } from "@/server/rewards-network";
import { sendPush, type PushResult } from "@/server/push";
import { loadEconomy, loadLevels } from "./config";
import { evaluateEligibility, joinableMissionDefinitions, loadPlayerFacts } from "./missions";
import { summarise } from "./rewards";
import { manilaDate } from "./time";

/** The most mission pushes one player receives in a Manila day. */
const MISSION_PUSH_DAILY_CAP = 3;

/**
 * The most players one announcement will consider in a single call.
 *
 * The fan-out re-checks eligibility per player, which is a couple of small
 * queries each, and it runs inside the request that published the campaign. A
 * ceiling keeps that request bounded; past it the campaign is still live and
 * still visible in the app, which is the part that matters.
 */
const ANNOUNCE_BATCH = 1_000;

/** The blackout window and cap every mission push is sent under. */
async function pushPolicy() {
  const db = await getDb();
  const { economy } = await loadEconomy(db);
  return {
    quietHours: economy.quietHours,
    dailyCap: MISSION_PUSH_DAILY_CAP,
  };
}

/**
 * Announces a newly published urgent mission to the players who qualify.
 *
 * Eligibility is re-checked per player rather than trusted from the campaign's
 * audience settings, because "who matches this segment" is a fact that moves —
 * and a push telling somebody about a mission they cannot join is worse than
 * no push at all.
 *
 * The area is deliberately not filtered on. We do not know where our players
 * are between sessions, and a location-gated campaign is announced to everyone
 * else it fits; the card itself says "you need to be near the partner", and
 * joining still checks.
 */
export async function announceUrgentMission(input: {
  missionKey: string;
  definitionVersion: number;
  /** Stops the same campaign being announced twice if a publish is retried. */
  force?: boolean;
}) {
  const db = await getDb();
  const definition = (await joinableMissionDefinitions(db)).find(
    (candidate) =>
      candidate.missionKey === input.missionKey &&
      candidate.definitionVersion === input.definitionVersion,
  );
  if (!definition) return { notified: 0, considered: 0 };
  if (definition.exposureChannel === "app") return { notified: 0, considered: 0 };

  const already = await one(
    db,
    "SELECT push_sent_at FROM mission_definitions WHERE mission_key = ? AND definition_version = ?",
    [input.missionKey, input.definitionVersion],
  );
  if (already?.push_sent_at && !input.force) return { notified: 0, considered: 0 };

  // Marking first. A fan-out that crashes halfway is a partial send; a fan-out
  // that runs twice is everybody hearing about the same campaign twice, and the
  // second is the one players notice.
  await run(
    db,
    "UPDATE mission_definitions SET push_sent_at = ?, updated_at = ? WHERE mission_key = ? AND definition_version = ?",
    [new Date().toISOString(), new Date().toISOString(), input.missionKey, input.definitionVersion],
  );

  const policy = await pushPolicy();
  const reward = summarise(definition.reward);
  const rewardText = [
    reward.xp > 0 ? `${reward.xp} XP` : null,
    reward.lpCentavos > 0 ? centavosToLoyaltyPoints(reward.lpCentavos) : null,
  ]
    .filter(Boolean)
    .join(" + ");

  const candidates = await all(
    db,
    // `created_at` is selected because it is ordered on: PostgreSQL requires
    // every ORDER BY expression to appear in the select list of a SELECT
    // DISTINCT, since otherwise the rows being ordered are not the rows being
    // returned. SQLite allowed it, so this threw on every announcement — the
    // campaign published and the fan-out that was meant to follow it errored
    // instead. Selecting it changes nothing about which wallets come back: it
    // is functionally dependent on `w.id`, which is already there.
    `SELECT DISTINCT w.id AS wallet_id, w.phone AS phone, w.created_at AS created_at
     FROM push_devices d
     JOIN reward_wallets w ON w.phone = d.phone
     WHERE d.missions_enabled = 1 AND d.marketing_enabled = 1
       AND w.status = 'Active'
     ORDER BY w.created_at DESC
     LIMIT ?`,
    [ANNOUNCE_BATCH],
  );

  let notified = 0;
  for (const row of candidates) {
    const walletId = String(row.wallet_id);
    const facts = await loadPlayerFacts(db, walletId);
    const standing = await one(
      db,
      "SELECT current_level FROM user_levels WHERE wallet_id = ?",
      [walletId],
    );
    const eligibility = evaluateEligibility({
      definition,
      level: Number(standing?.current_level ?? 1),
      facts,
      // Nobody is holding their phone at the moment a fan-out runs, so a radius
      // cannot be tested here. An area campaign comes back OUT_OF_AREA, which
      // is allowed through below and gated properly at join.
      location: null,
    });
    if (!eligibility.eligible && eligibility.reason !== "OUT_OF_AREA") continue;

    const result = await sendPush({
      phone: String(row.phone),
      category: "missions",
      marketing: true,
      quietHours: policy.quietHours,
      dailyCap: policy.dailyCap,
      title: definition.title,
      body: rewardText
        ? `${definition.description || "A new mission is live."} Earn ${rewardText}.`
        : definition.description || "A new mission is live.",
      data: { type: "urgent_mission", missionKey: definition.missionKey },
      dedupeKey: `mission:${definition.missionKey}:${definition.definitionVersion}:${row.phone}`,
    });
    notified += result.sent;
  }

  return { notified, considered: candidates.length };
}

/**
 * The "your window is open" nudge for a time-boxed daily mission.
 *
 * Sent to players who have a device, have not finished today's instance, and
 * are inside the window right now. Deduped on the mission and the Manila date,
 * so an hourly scheduler cannot say it twice.
 */
export async function announceDailyWindow(input: { missionKey: string }): Promise<{
  notified: number;
}> {
  const db = await getDb();
  const date = manilaDate();
  const policy = await pushPolicy();

  const rows = await all(
    db,
    `SELECT DISTINCT w.phone AS phone, d.title AS title, d.description AS description
     FROM user_missions um
     JOIN mission_definitions d
       ON d.mission_key = um.mission_key AND d.definition_version = um.definition_version
     JOIN reward_wallets w ON w.id = um.wallet_id
     JOIN push_devices pd ON pd.phone = w.phone
     WHERE um.mission_key = ?
       AND um.mission_date = ?
       AND um.state IN ('AVAILABLE', 'IN_PROGRESS')
       AND pd.missions_enabled = 1`,
    [input.missionKey, date],
  );

  let notified = 0;
  for (const row of rows) {
    const result = await sendPush({
      phone: String(row.phone),
      category: "missions",
      quietHours: policy.quietHours,
      dailyCap: policy.dailyCap,
      title: String(row.title),
      body: String(row.description ?? "This mission is open now."),
      data: { type: "daily_mission", missionKey: input.missionKey },
      dedupeKey: `mission-window:${input.missionKey}:${date}:${row.phone}`,
    });
    notified += result.sent;
  }
  return { notified };
}

/**
 * "One action left" and "closing soon", the two nudges §11 allows.
 *
 * Deliberately not framed as pressure. The requirements are explicit that a
 * near-completion message must not push, so it says what is left and nothing
 * about what will be lost.
 */
export async function remindMissionsClosingSoon(input: { withinHours?: number } = {}) {
  const db = await getDb();
  const hours = input.withinHours ?? 4;
  const until = new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
  const policy = await pushPolicy();
  const date = manilaDate();

  const rows = await all(
    db,
    `SELECT w.phone AS phone, um.mission_key, um.progress, um.target, um.state,
            d.title AS title
     FROM user_missions um
     JOIN mission_definitions d
       ON d.mission_key = um.mission_key AND d.definition_version = um.definition_version
     JOIN reward_wallets w ON w.id = um.wallet_id
     JOIN push_devices pd ON pd.phone = w.phone
     WHERE um.state IN ('IN_PROGRESS', 'CLAIMABLE')
       AND um.expires_at > ?
       AND um.expires_at <= ?
       AND pd.missions_enabled = 1`,
    [new Date().toISOString(), until],
  );

  let notified = 0;
  for (const row of rows) {
    const claimable = String(row.state) === "CLAIMABLE";
    const left = Math.max(0, Number(row.target) - Number(row.progress));
    const result = await sendPush({
      phone: String(row.phone),
      category: "missions",
      quietHours: policy.quietHours,
      dailyCap: policy.dailyCap,
      title: String(row.title),
      body: claimable
        ? "Your reward is waiting to be claimed."
        : left === 1
          ? "One more step to finish this one."
          : `${left} steps left on this one.`,
      data: { type: "mission_closing", missionKey: String(row.mission_key) },
      dedupeKey: `mission-closing:${row.mission_key}:${date}:${row.phone}`,
    });
    notified += result.sent;
  }
  return { notified };
}

/** An operator decided on a player's evidence. Transactional, not marketing. */
export function notifyProofReviewed(input: {
  phone: string;
  approved: boolean;
  missionTitle: string;
  reason?: string;
}): Promise<PushResult> {
  return sendPush({
    phone: input.phone,
    category: "missions",
    title: input.approved ? "Mission approved" : "Mission evidence declined",
    body: input.approved
      ? `${input.missionTitle}: your reward is on the way.`
      : `${input.missionTitle}: ${input.reason || "please send another photo."}`,
    data: { type: "mission_proof", approved: input.approved },
  });
}

/** A promotion, announced once. The celebration screen still runs in the app. */
export function notifyLevelUp(input: {
  phone: string;
  level: number;
  levelName: string;
}): Promise<PushResult> {
  return sendPush({
    phone: input.phone,
    category: "rewards",
    title: `You reached ${input.levelName}`,
    body: `Level ${input.level} unlocked. Open the app to see what it opens up.`,
    data: { type: "level_up", level: input.level },
    dedupeKey: `level-up:${input.phone}:${input.level}`,
  });
}

/** A badge unlocked. One per tier, ever, which the dedupe key enforces. */
export function notifyAchievementUnlocked(input: {
  phone: string;
  title: string;
  tier: string;
}): Promise<PushResult> {
  return sendPush({
    phone: input.phone,
    category: "rewards",
    title: `${input.tier} badge unlocked`,
    body: `${input.title}. Tap to see your badge.`,
    data: { type: "achievement_unlocked", groupTitle: input.title, tier: input.tier },
    dedupeKey: `achievement:${input.phone}:${input.title}:${input.tier}`,
  });
}

/**
 * Tells a player about anything that landed while they were not looking.
 *
 * Called from the hook layer once the event has been ingested and committed —
 * a rewarded ad verified by Google, a QR scanned at a till — because those are
 * exactly the grants that happen with the app closed. The in-app celebration
 * still runs when they next open it: `announced_level` and `seen_at` are the
 * watermarks for that and neither is touched here, so the push tells them and
 * the app congratulates them, once each.
 */
export async function notifyGamificationOutcome(input: {
  phone: string;
  unlocked: AchievementUnlockNotice[];
}) {
  try {
    for (const unlock of input.unlocked) {
      await notifyAchievementUnlocked({
        phone: input.phone,
        title: unlock.title,
        tier: unlock.tier,
      });
    }

    const db = await getDb();
    const standing = await one(
      db,
      `SELECT ul.current_level, ul.announced_level
       FROM user_levels ul
       JOIN reward_wallets w ON w.id = ul.wallet_id
       WHERE w.phone = ?`,
      [input.phone],
    );
    if (!standing) return;
    const level = Number(standing.current_level ?? 1);
    if (level <= Number(standing.announced_level ?? 1)) return;

    const { levels } = await loadLevels(db);
    const name = levels.find((entry) => entry.level === level)?.name ?? `Level ${level}`;
    await notifyLevelUp({ phone: input.phone, level, levelName: name });
  } catch {
    // A notification must never fail the thing that earned it. The reward is
    // already committed; the worst case here is a quiet promotion.
  }
}
