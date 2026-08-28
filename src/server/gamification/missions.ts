/**
 * The mission engine: assignment, progress, completion and payout.
 *
 * Missions are event-driven and progress is separated from reward, which is
 * what makes the two halves independently correct. An event moves a mission's
 * progress; reaching the target moves its state; only a claim (automatic or
 * tapped) pays. Each of those is idempotent on its own, so a duplicated event
 * cannot double-progress and a retried claim cannot double-pay.
 *
 * A daily mission is one row per player per Manila date. That is what makes the
 * reset a fact about data rather than a job that has to run at midnight: no
 * cron creates tomorrow's missions, tomorrow's date simply has no row yet and
 * gets one the first time anybody looks or acts.
 *
 * An urgent mission is the other shape. It is a campaign somebody runs, with a
 * start, an end, a budget and a number of places, and a player is not in it
 * until they join. So its card exists before any row does — assembled from the
 * definition and the player's eligibility rather than from an instance — and
 * `joinMission` is what turns a card into a row.
 */
import crypto from "node:crypto";
import type {
  MissionAudience,
  MissionCard,
  MissionClaimResult,
  MissionProofState,
  MissionProofStatus,
  MissionQuotaMode,
  MissionSegment,
  MissionState,
  MissionTriggerEvent,
  MissionType,
  RewardLine,
} from "@bizflow/shared";
import { levelForXp, metresBetween } from "@bizflow/shared";
import { all, one, run, withTx, type Exec } from "@/server/db";
import { AppError } from "@/server/errors";
import { ensureRewardWallet } from "@/server/rewards-network";
import { bumpCounter, advanceStreak } from "./achievements";
import { loadLevels, parseRewardLines } from "./config";
import { publishEvent } from "./events";
import { addSummaries, EMPTY_REWARD, grantReward, summarise } from "./rewards";
import {
  eventWithinWindow,
  manilaClock,
  manilaDate,
  manilaDayEndUtc,
  withinWindow,
} from "./time";

const isoNow = () => new Date().toISOString();
const id = (prefix: string) => `${prefix}_${crypto.randomBytes(8).toString("hex")}`;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How late an event may arrive and still count against the window it happened
 * in. Processing lag is ours, not the player's: an ad watched at 10:58 that is
 * verified at 11:02 still finished the morning mission.
 */
const WINDOW_GRACE_MINUTES = 15;

/** Default days that make a player "new", "dormant" or freshly "returning". */
const SEGMENT_DAYS: Record<MissionSegment, number> = {
  all: 0,
  new: 7,
  dormant: 30,
  returning: 30,
};

/** How recently a returning player must have acted for the label to still fit. */
const RETURN_WINDOW_DAYS = 3;

/**
 * The worst location accuracy a flash mission accepts, in metres.
 *
 * A phone reporting a five-kilometre error radius is not telling us where it
 * is, and a radius check against that is theatre. Refusing is the honest
 * answer; the app asks the player to try again outdoors.
 */
const MAX_LOCATION_ACCURACY_M = 200;

/** Non-terminal states — a mission still capable of moving. */
const OPEN_STATES = ["LOCKED", "AVAILABLE", "IN_PROGRESS", "VERIFYING", "CLAIMABLE"];

/**
 * A position the app reported, with everything needed to distrust it.
 *
 * The coordinates are the client's, unavoidably — a phone is the only thing
 * that knows where it is. What the server does with them is not: the radius
 * test, the accuracy floor and the mock-signal refusal all happen here, and a
 * location is never the thing that decides a reward on its own. It gates
 * joining; the reward still needs the partner's own QR scan.
 */
export type ReportedLocation = {
  latitude: number;
  longitude: number;
  accuracyMeters?: number;
  /** Android and iOS both flag a simulated fix; the spec asks that we look. */
  mocked?: boolean;
};

export type MissionDefinition = {
  missionKey: string;
  definitionVersion: number;
  type: MissionType;
  title: string;
  description: string;
  triggerEvent: MissionTriggerEvent;
  targetCount: number;
  window: { startTime: string; endTime: string } | null;
  minLevel: number;
  partnerId: string | null;
  reward: RewardLine[];
  condition: Record<string, unknown>;
  audience: MissionAudience;
  autoClaim: boolean;
  requiresProof: boolean;
  quotaMode: MissionQuotaMode;
  userQuota: number;
  globalQuota: number | null;
  joinedCount: number;
  completedCount: number;
  rewardBudgetCentavos: number | null;
  spentBudgetCentavos: number;
  startsAt: string | null;
  endsAt: string | null;
  exposureChannel: string;
  termsUrl: string | null;
  sortOrder: number;
  status: string;
};

/** Parses `audience_json`, defaulting a row written before the column existed. */
export function parseAudience(json: string | null | undefined): MissionAudience {
  if (!json) return { segment: "all" };
  try {
    const parsed = JSON.parse(json) as Partial<MissionAudience>;
    const segment: MissionSegment =
      parsed.segment === "new" || parsed.segment === "dormant" || parsed.segment === "returning"
        ? parsed.segment
        : "all";
    const area =
      parsed.area &&
      Number.isFinite(Number(parsed.area.latitude)) &&
      Number.isFinite(Number(parsed.area.longitude)) &&
      Number(parsed.area.radiusMeters) > 0
        ? {
            latitude: Number(parsed.area.latitude),
            longitude: Number(parsed.area.longitude),
            radiusMeters: Number(parsed.area.radiusMeters),
          }
        : undefined;
    return {
      segment,
      ...(parsed.segmentDays ? { segmentDays: Number(parsed.segmentDays) } : {}),
      ...(area ? { area } : {}),
      ...(parsed.firstVisitOnly ? { firstVisitOnly: true } : {}),
    };
  } catch {
    return { segment: "all" };
  }
}

function mapDefinition(row: Record<string, unknown>): MissionDefinition {
  return {
    missionKey: String(row.mission_key),
    definitionVersion: Number(row.definition_version),
    type: String(row.type) as MissionType,
    title: String(row.title),
    description: String(row.description ?? ""),
    triggerEvent: String(row.trigger_event) as MissionTriggerEvent,
    targetCount: Number(row.target_count),
    window: row.window_start
      ? { startTime: String(row.window_start), endTime: String(row.window_end) }
      : null,
    minLevel: Number(row.min_level ?? 1),
    partnerId: row.partner_id ? String(row.partner_id) : null,
    reward: parseRewardLines(row.reward_json ? String(row.reward_json) : null),
    condition: JSON.parse(String(row.condition_json ?? "{}")),
    audience: parseAudience(row.audience_json ? String(row.audience_json) : null),
    autoClaim: Number(row.auto_claim ?? 1) === 1,
    requiresProof: Number(row.requires_proof ?? 0) === 1,
    quotaMode:
      String(row.quota_mode ?? "ON_COMPLETION") === "RESERVE_ON_JOIN"
        ? "RESERVE_ON_JOIN"
        : "ON_COMPLETION",
    userQuota: Number(row.user_quota ?? 1),
    globalQuota:
      row.global_quota === null || row.global_quota === undefined
        ? null
        : Number(row.global_quota),
    joinedCount: Number(row.joined_count ?? 0),
    completedCount: Number(row.completed_count ?? 0),
    rewardBudgetCentavos:
      row.reward_budget_centavos === null || row.reward_budget_centavos === undefined
        ? null
        : Number(row.reward_budget_centavos),
    spentBudgetCentavos: Number(row.spent_budget_centavos ?? 0),
    startsAt: row.starts_at ? String(row.starts_at) : null,
    endsAt: row.ends_at ? String(row.ends_at) : null,
    exposureChannel: String(row.exposure_channel ?? "app"),
    termsUrl: row.terms_url ? String(row.terms_url) : null,
    sortOrder: Number(row.sort_order ?? 0),
    status: String(row.status),
  };
}

/**
 * The definitions currently in force: the highest published version of each
 * mission key, and only the ones live right now.
 *
 * A definition is never edited once live — publishing a change writes a new
 * version — so "the live set" is a max-version join rather than a status flag
 * somebody has to remember to flip on the old row.
 */
export async function liveMissionDefinitions(
  db: Exec,
  options: { type?: MissionType; at?: string } = {},
): Promise<MissionDefinition[]> {
  const at = options.at ?? isoNow();
  const typeFilter = options.type ? "AND d.type = ?" : "";
  const rows = await all(
    db,
    `SELECT d.* FROM mission_definitions d
     JOIN (
       SELECT mission_key, MAX(definition_version) AS definition_version
       FROM mission_definitions
       WHERE status IN ('Active', 'Scheduled')
       GROUP BY mission_key
     ) live
       ON live.mission_key = d.mission_key
      AND live.definition_version = d.definition_version
     WHERE d.status = 'Active'
       AND (d.starts_at IS NULL OR d.starts_at <= ?)
       AND (d.ends_at IS NULL OR d.ends_at >= ?)
       ${typeFilter}
     ORDER BY d.sort_order ASC, d.mission_key ASC`,
    options.type ? [at, at, options.type] : [at, at],
  );
  return rows.map(mapDefinition);
}

/**
 * Campaigns a player could join, including ones that have not opened yet.
 *
 * Deliberately wider than `liveMissionDefinitions`: a mission whose `starts_at`
 * is still ahead is worth showing, because "opens at 2 PM" is information. It
 * comes back marked NOT_STARTED rather than hidden.
 */
export async function joinableMissionDefinitions(db: Exec): Promise<MissionDefinition[]> {
  const rows = await all(
    db,
    `SELECT d.* FROM mission_definitions d
     JOIN (
       SELECT mission_key, MAX(definition_version) AS definition_version
       FROM mission_definitions
       WHERE status IN ('Active', 'Scheduled')
       GROUP BY mission_key
     ) live
       ON live.mission_key = d.mission_key
      AND live.definition_version = d.definition_version
     WHERE d.status = 'Active'
       AND d.type IN ('URGENT', 'PARTNER', 'ONBOARDING')
       AND (d.ends_at IS NULL OR d.ends_at >= ?)
     ORDER BY d.sort_order ASC, d.mission_key ASC`,
    [isoNow()],
  );
  return rows.map(mapDefinition);
}

/** Places left in a limited campaign, or null when it is unlimited. */
export function quotaRemaining(definition: MissionDefinition): number | null {
  if (definition.globalQuota === null) return null;
  const taken =
    definition.quotaMode === "RESERVE_ON_JOIN"
      ? definition.joinedCount
      : definition.completedCount;
  return Math.max(0, definition.globalQuota - taken);
}

/* Eligibility --------------------------------------------------------------- */

/**
 * The handful of facts every audience rule is decided against, read once.
 *
 * Gathered per player rather than per mission: the alternative is three small
 * queries multiplied by however many campaigns are running, on the app's
 * most-called endpoint.
 */
export type PlayerFacts = {
  walletCreatedAt: string;
  lastEventAt: string | null;
  /** The most recent event older than the "just came back" window. */
  priorEventAt: string | null;
  /** Partners this player has already used a voucher at. */
  visitedPartnerIds: Set<string>;
};

export async function loadPlayerFacts(db: Exec, walletId: string): Promise<PlayerFacts> {
  const returnCutoff = new Date(Date.now() - RETURN_WINDOW_DAYS * DAY_MS).toISOString();
  const [wallet, activity, visits] = await Promise.all([
    one(db, "SELECT created_at FROM reward_wallets WHERE id = ?", [walletId]),
    one(
      db,
      `SELECT MAX(occurred_at_utc) AS last_at,
              MAX(CASE WHEN occurred_at_utc < ? THEN occurred_at_utc END) AS prior_at
       FROM gamification_events WHERE wallet_id = ?`,
      [returnCutoff, walletId],
    ),
    all(
      db,
      `SELECT member_key FROM user_counter_members
       WHERE wallet_id = ? AND counter_key = 'distinct_partners'`,
      [walletId],
    ),
  ]);
  return {
    walletCreatedAt: String(wallet?.created_at ?? isoNow()),
    lastEventAt: activity?.last_at ? String(activity.last_at) : null,
    priorEventAt: activity?.prior_at ? String(activity.prior_at) : null,
    visitedPartnerIds: new Set(visits.map((row) => String(row.member_key))),
  };
}

/** Whether a player belongs to the segment a campaign is aimed at. */
export function matchesSegment(
  audience: MissionAudience,
  facts: PlayerFacts,
  at: Date = new Date(),
): boolean {
  if (audience.segment === "all") return true;
  const days = audience.segmentDays ?? SEGMENT_DAYS[audience.segment];
  const cutoff = at.getTime() - days * DAY_MS;

  if (audience.segment === "new") {
    return Date.parse(facts.walletCreatedAt) >= cutoff;
  }
  if (audience.segment === "dormant") {
    // Nobody who has never done anything is "dormant" in the sense that
    // matters here — they are new, and a win-back campaign aimed at them is
    // aimed at the wrong person.
    if (!facts.lastEventAt) return false;
    return Date.parse(facts.lastEventAt) < cutoff;
  }
  // Returning: active inside the return window, and silent for the whole
  // dormancy period before it. Two conditions rather than one, because "came
  // back" is a shape over time and not a single timestamp.
  const returnCutoff = at.getTime() - RETURN_WINDOW_DAYS * DAY_MS;
  if (!facts.lastEventAt || Date.parse(facts.lastEventAt) < returnCutoff) return false;
  return !facts.priorEventAt || Date.parse(facts.priorEventAt) < cutoff;
}

export type MissionEligibility = {
  eligible: boolean;
  reason: MissionCard["ineligibleReason"];
  distanceMeters: number | null;
};

/**
 * Whether one player may join one campaign, and why not when they may not.
 *
 * Order matters here and is the order the app should read them in: a level gate
 * is a goal, a sold-out campaign is bad luck, and being outside the area is
 * something the player can walk out of. Reporting the first that applies keeps
 * the card's message stable rather than flipping between two true reasons.
 */
export function evaluateEligibility(input: {
  definition: MissionDefinition;
  level: number;
  facts: PlayerFacts;
  location?: ReportedLocation | null;
  at?: Date;
}): MissionEligibility {
  const { definition, facts } = input;
  const at = input.at ?? new Date();
  const distance = distanceToArea(definition.audience, input.location);

  if (definition.startsAt && Date.parse(definition.startsAt) > at.getTime()) {
    return { eligible: false, reason: "NOT_STARTED", distanceMeters: distance };
  }
  if (input.level < definition.minLevel) {
    return { eligible: false, reason: "LEVEL_REQUIRED", distanceMeters: distance };
  }
  const left = quotaRemaining(definition);
  if (left !== null && left <= 0) {
    return { eligible: false, reason: "QUOTA_EXHAUSTED", distanceMeters: distance };
  }
  if (!matchesSegment(definition.audience, facts, at)) {
    return { eligible: false, reason: "NOT_ELIGIBLE", distanceMeters: distance };
  }
  if (
    definition.audience.firstVisitOnly &&
    definition.partnerId &&
    facts.visitedPartnerIds.has(definition.partnerId)
  ) {
    return { eligible: false, reason: "NOT_ELIGIBLE", distanceMeters: distance };
  }
  if (definition.audience.area) {
    if (!input.location || distance === null) {
      return { eligible: false, reason: "OUT_OF_AREA", distanceMeters: null };
    }
    if (input.location.mocked) {
      return { eligible: false, reason: "OUT_OF_AREA", distanceMeters: distance };
    }
    const accuracy = input.location.accuracyMeters ?? 0;
    if (accuracy > MAX_LOCATION_ACCURACY_M) {
      return { eligible: false, reason: "OUT_OF_AREA", distanceMeters: distance };
    }
    // The reported accuracy widens the circle rather than narrowing it: a fix
    // that is 40m uncertain at 30m outside the boundary may well be inside it,
    // and refusing a player standing in the shop is the worse mistake.
    if (distance > definition.audience.area.radiusMeters + accuracy) {
      return { eligible: false, reason: "OUT_OF_AREA", distanceMeters: distance };
    }
  }
  return { eligible: true, reason: null, distanceMeters: distance };
}

function distanceToArea(
  audience: MissionAudience,
  location: ReportedLocation | null | undefined,
): number | null {
  if (!audience.area || !location) return null;
  return metresBetween(location, audience.area);
}

/* Assignment ---------------------------------------------------------------- */

/**
 * Creates today's missing daily instances for one player.
 *
 * `INSERT OR IGNORE` on (wallet, mission, date) makes this safe to call from
 * anywhere and as often as anything likes — the profile screen, an inbound
 * event, a push job — without any of them coordinating.
 */
export async function ensureDailyMissions(
  tx: Exec,
  input: { walletId: string; level: number; date?: string },
) {
  const date = input.date ?? manilaDate();
  const expiresAt = manilaDayEndUtc(
    // Expiry is the end of the mission's own Manila day, not of the day the
    // call happens to be made on: a backfilled instance for yesterday must
    // still expire yesterday.
    new Date(`${date}T12:00:00.000Z`),
  );
  const now = isoNow();
  const definitions = await liveMissionDefinitions(tx, { type: "DAILY" });

  for (const definition of definitions) {
    await run(
      tx,
      `INSERT OR IGNORE INTO user_missions
       (id, wallet_id, mission_key, definition_version, mission_date, state, progress,
        target, assigned_at, expires_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
      [
        id("umis"),
        input.walletId,
        definition.missionKey,
        definition.definitionVersion,
        date,
        input.level >= definition.minLevel ? "AVAILABLE" : "LOCKED",
        definition.targetCount,
        now,
        expiresAt,
        now,
      ],
    );
  }
  // A player promoted mid-day should not have to wait for tomorrow to see what
  // their new level opened up.
  await run(
    tx,
    `UPDATE user_missions um SET state = 'AVAILABLE', updated_at = ?
     FROM mission_definitions d
     WHERE d.mission_key = um.mission_key
       AND d.definition_version = um.definition_version
       AND um.wallet_id = ? AND um.mission_date = ?
       AND um.state = 'LOCKED' AND d.min_level <= ?`,
    [now, input.walletId, date, input.level],
  );
  return date;
}

/**
 * The instance an event should move, or nothing.
 *
 * A daily mission has exactly one row for the date. An urgent one can have
 * several over its run when `user_quota` allows repeats, so the open one is
 * found by state rather than by a key that can be computed. Locked here because
 * the caller is about to advance it.
 */
async function openInstanceFor(
  tx: Exec,
  input: { walletId: string; definition: MissionDefinition; date: string },
) {
  if (input.definition.type === "DAILY") {
    return one(
      tx,
      `SELECT * FROM user_missions
       WHERE wallet_id = ? AND mission_key = ? AND mission_date = ?
       FOR UPDATE`,
      [input.walletId, input.definition.missionKey, input.date],
    );
  }
  return one(
    tx,
    `SELECT * FROM user_missions
     WHERE wallet_id = ? AND mission_key = ?
       AND state IN ('LOCKED', 'AVAILABLE', 'IN_PROGRESS', 'VERIFYING')
     ORDER BY assigned_at DESC
     LIMIT 1
     FOR UPDATE`,
    [input.walletId, input.definition.missionKey],
  );
}

export type MissionEvent = {
  walletId: string;
  phone: string;
  eventName: MissionTriggerEvent;
  occurredAt: string;
  partnerId?: string | null;
  objectId?: string | null;
  /** The mission that produced this event, when it is a `mission_completed`. */
  originMissionKey?: string | null;
  metadata?: Record<string, unknown>;
};

export type MissionProgressOutcome = {
  missionKey: string;
  state: MissionState;
  progress: number;
  target: number;
  completed: boolean;
  claimed: boolean;
  reward: ReturnType<typeof summarise>;
};

/**
 * Applies one verified event to every mission it could advance.
 *
 * The event has already been deduplicated by the event layer, so this is free
 * to count it: reaching here twice for the same fact is the one thing the
 * design does not have to defend against, and the `reward_transactions` unique
 * key catches it anyway if the assumption ever breaks.
 */
export async function applyEventToMissions(
  tx: Exec,
  event: MissionEvent,
): Promise<MissionProgressOutcome[]> {
  const date = manilaDate(new Date(event.occurredAt));
  const { levels } = await loadLevels(tx);
  const xpRow = await one(tx, "SELECT lifetime_xp FROM user_levels WHERE wallet_id = ?", [
    event.walletId,
  ]);
  const level = levelForXp(levels, Number(xpRow?.lifetime_xp ?? 0)).level;
  await ensureDailyMissions(tx, { walletId: event.walletId, level, date });

  const definitions = (await liveMissionDefinitions(tx)).filter(
    (definition) => definition.triggerEvent === event.eventName,
  );
  const outcomes: MissionProgressOutcome[] = [];

  for (const definition of definitions) {
    // A mission that names a partner only counts that partner's events.
    if (definition.partnerId && definition.partnerId !== event.partnerId) continue;
    if (level < definition.minLevel) continue;
    if (!eventWithinWindow(event.occurredAt, definition.window, WINDOW_GRACE_MINUTES)) {
      continue;
    }
    // The capstone counts other missions, so its own completion event must not
    // feed it. Without this the mission completes itself the moment it pays.
    if (
      definition.condition.excludeSelf === true &&
      event.originMissionKey === definition.missionKey
    ) {
      continue;
    }

    const instance = await openInstanceFor(tx, {
      walletId: event.walletId,
      definition,
      date,
    });
    if (!instance) continue;

    const state = String(instance.state) as MissionState;
    if (state === "CLAIMED" || state === "EXPIRED" || state === "CANCELLED" || state === "REJECTED") {
      continue;
    }

    const missionDate = String(instance.mission_date ?? "");
    const progress =
      definition.condition.uniqueRule === "distinct_mission_key"
        ? await distinctCompletedToday(tx, event.walletId, date, definition.missionKey)
        : Math.min(definition.targetCount, Number(instance.progress) + 1);

    const complete = progress >= definition.targetCount;
    // Evidence turns "finished" into "finished, pending review". The state is
    // VERIFYING rather than CLAIMABLE precisely so nothing downstream pays it:
    // the requirements separate completion from issuance, and a mission whose
    // proof an operator later rejects must never have paid first.
    const awaitingProof =
      complete && definition.requiresProof && !(await hasApprovedProof(tx, String(instance.id)));
    const nextState: MissionState = awaitingProof
      ? "VERIFYING"
      : complete
        ? "CLAIMABLE"
        : "IN_PROGRESS";

    await run(
      tx,
      `UPDATE user_missions
       SET progress = ?, state = ?, completed_at = COALESCE(completed_at, ?), updated_at = ?
       WHERE id = ?`,
      [progress, nextState, complete ? isoNow() : null, isoNow(), String(instance.id)],
    );

    let reward = EMPTY_REWARD;
    let claimed = false;
    if (complete) {
      await publishEvent(tx, {
        eventName: "mission_progressed",
        walletId: event.walletId,
        phone: event.phone,
        source: "rules-engine",
        objectType: "user_mission",
        objectId: String(instance.id),
        idempotencyKey: `mission_progressed:${instance.id}:${progress}`,
        metadata: { missionKey: definition.missionKey, progress },
        status: "Processed",
      });
      if (definition.autoClaim && !awaitingProof) {
        const payout = await payMission(tx, {
          walletId: event.walletId,
          phone: event.phone,
          instanceId: String(instance.id),
          definition,
          missionDate,
        });
        reward = payout.reward;
        claimed = !payout.rejected;
      }
    }

    outcomes.push({
      missionKey: definition.missionKey,
      state: claimed ? "CLAIMED" : nextState,
      progress,
      target: definition.targetCount,
      completed: complete,
      claimed,
      reward,
    });
  }

  return outcomes;
}

/** How many distinct daily missions this player has finished today. */
async function distinctCompletedToday(
  tx: Exec,
  walletId: string,
  date: string,
  excludeMissionKey: string,
) {
  const row = await one(
    tx,
    `SELECT COUNT(DISTINCT mission_key) AS total FROM user_missions
     WHERE wallet_id = ? AND mission_date = ?
       AND mission_key <> ?
       AND state IN ('CLAIMABLE', 'CLAIMED')`,
    [walletId, date, excludeMissionKey],
  );
  return Number(row?.total ?? 0);
}

/** Whether an operator has already approved evidence for this instance. */
async function hasApprovedProof(tx: Exec, instanceId: string) {
  const row = await one(
    tx,
    "SELECT 1 AS present FROM mission_proofs WHERE user_mission_id = ? AND review_status = 'Approved' LIMIT 1",
    [instanceId],
  );
  return Boolean(row);
}

/**
 * Pays a completed mission and moves it to CLAIMED.
 *
 * Everything here is one transaction with the state change, which is the point:
 * the requirements are explicit that reward issuance and state change commit
 * together. The reward key is derived from the instance, so a claim retried
 * after a timeout finds the transaction already written and pays nothing more.
 */
export async function payMission(
  tx: Exec,
  input: {
    walletId: string;
    phone: string;
    instanceId: string;
    definition: MissionDefinition;
    missionDate: string;
  },
) {
  const { definition } = input;

  // A campaign whose places are counted at the finish line takes one here, and
  // the conditional UPDATE is the count: it either fits under the quota or it
  // does not, with no read-then-write in between for two finishers to race in.
  if (definition.globalQuota !== null && definition.quotaMode === "ON_COMPLETION") {
    const took = await run(
      tx,
      `UPDATE mission_definitions
       SET completed_count = completed_count + 1, updated_at = ?
       WHERE mission_key = ? AND definition_version = ?
         AND completed_count < global_quota`,
      [isoNow(), definition.missionKey, definition.definitionVersion],
    );
    if (took !== 1) {
      await run(
        tx,
        "UPDATE user_missions SET state = 'REJECTED', reject_reason = ?, updated_at = ? WHERE id = ?",
        ["QUOTA_EXHAUSTED", isoNow(), input.instanceId],
      );
      return { rejected: true as const, reason: "QUOTA_EXHAUSTED", reward: EMPTY_REWARD, unlocked: [], granted: null };
    }
  }

  // A partner-funded mission stops paying when its campaign budget is gone.
  // The reward engine would hold or substitute XP instead, but a partner's
  // money is not ours to substitute with, so the refusal belongs here.
  //
  // Recorded rather than thrown: this runs inside an event's transaction, and
  // aborting it would roll back a QR redemption over a budget shortfall. The
  // instance is marked REJECTED with its reason and the caller decides whether
  // that is an error to surface — `claimMission` does, the event path does not.
  const lpAsked = summarise(definition.reward).lpCentavos;
  if (
    definition.rewardBudgetCentavos !== null &&
    lpAsked > 0 &&
    definition.spentBudgetCentavos + lpAsked > definition.rewardBudgetCentavos
  ) {
    await run(
      tx,
      "UPDATE user_missions SET state = 'REJECTED', reject_reason = ?, updated_at = ? WHERE id = ?",
      ["BUDGET_EXHAUSTED", isoNow(), input.instanceId],
    );
    return { rejected: true as const, reason: "BUDGET_EXHAUSTED", reward: EMPTY_REWARD, unlocked: [], granted: null };
  }

  const granted = await grantReward(tx, {
    walletId: input.walletId,
    sourceType: "mission",
    sourceId: `${definition.missionKey}:${input.missionDate}`,
    reward: definition.reward,
    idempotencyKey: `mission:${input.instanceId}`,
    partnerId: definition.partnerId,
    missionKey: definition.missionKey,
    metadata: { definitionVersion: definition.definitionVersion },
  });

  await run(
    tx,
    `UPDATE user_missions
     SET state = 'CLAIMED', claimed_at = ?, reward_tx_id = ?, updated_at = ?
     WHERE id = ?`,
    [isoNow(), granted.rewardTxId, isoNow(), input.instanceId],
  );

  // A reserve-on-join campaign still counts its finishers, so the completion
  // rate an operator reads is a real number rather than a division by joins.
  if (definition.quotaMode === "RESERVE_ON_JOIN") {
    await run(
      tx,
      `UPDATE mission_definitions SET completed_count = completed_count + 1, updated_at = ?
       WHERE mission_key = ? AND definition_version = ?`,
      [isoNow(), definition.missionKey, definition.definitionVersion],
    );
  }

  if (lpAsked > 0 && definition.rewardBudgetCentavos !== null) {
    await run(
      tx,
      `UPDATE mission_definitions
       SET spent_budget_centavos = spent_budget_centavos + ?, updated_at = ?
       WHERE mission_key = ? AND definition_version = ?`,
      [granted.summary.lpCentavos, isoNow(), definition.missionKey, definition.definitionVersion],
    );
  }

  // Only now is the mission finished, so only now does anything else get to
  // hear about it — including the capstone mission and the achievement counter.
  const unlocked = await bumpCounter(tx, {
    walletId: input.walletId,
    counterKey: "mission_completed",
    delta: 1,
    sourceId: input.instanceId,
  });
  const streakUnlocks =
    definition.type === "DAILY"
      ? await advanceStreak(tx, {
          walletId: input.walletId,
          counterKey: "daily_streak",
          date: input.missionDate || manilaDate(),
          sourceId: input.instanceId,
        })
      : [];

  await publishEvent(tx, {
    eventName: "mission_completed",
    walletId: input.walletId,
    phone: input.phone,
    source: "rules-engine",
    partnerId: definition.partnerId,
    objectType: "user_mission",
    objectId: input.instanceId,
    idempotencyKey: `mission_completed:${input.instanceId}`,
    metadata: { missionKey: definition.missionKey, rewardTxId: granted.rewardTxId },
    status: "Processed",
  });
  await publishEvent(tx, {
    eventName: "mission_reward_granted",
    walletId: input.walletId,
    phone: input.phone,
    source: "rules-engine",
    objectType: "reward_transaction",
    objectId: granted.rewardTxId,
    idempotencyKey: `mission_reward_granted:${input.instanceId}`,
    metadata: { missionKey: definition.missionKey },
    status: "Processed",
  });

  // The capstone reacts to this completion in the same transaction, so a player
  // who finishes their fourth mission sees both payouts at once.
  const cascade = await applyEventToMissions(tx, {
    walletId: input.walletId,
    phone: input.phone,
    eventName: "mission_completed",
    occurredAt: isoNow(),
    originMissionKey: definition.missionKey,
    objectId: input.instanceId,
  });

  return {
    rejected: false as const,
    reason: null,
    reward: cascade.reduce((total, outcome) => addSummaries(total, outcome.reward), granted.summary),
    unlocked: [...unlocked, ...streakUnlocks],
    granted,
  };
}

/**
 * Claims a mission the player has to tap for.
 *
 * Auto-claim missions never reach here; this is the manual path, and it is
 * strict about state precisely because it is the one a client can call
 * directly: only CLAIMABLE pays, everything else is an error with a name the
 * app can map to a message.
 */
export async function claimMission(input: {
  phone: string;
  missionKey: string;
  missionDate?: string;
}): Promise<MissionClaimResult> {
  return withTx(async (tx) => {
    const wallet = await ensureRewardWallet(tx, { phone: input.phone });
    const missionDate = input.missionDate ?? manilaDate();

    const instance = await one(
      tx,
      `SELECT * FROM user_missions
       WHERE wallet_id = ? AND mission_key = ?
         AND (mission_date = ? OR mission_date NOT LIKE '____-__-__')
       ORDER BY
         CASE WHEN state = 'CLAIMABLE' THEN 0 ELSE 1 END,
         assigned_at DESC
       LIMIT 1
       FOR UPDATE`,
      [wallet.id, input.missionKey, missionDate],
    );
    if (!instance) {
      throw new AppError("E-MISSION-NOT-ACTIVE", "That mission is not active for you", 404);
    }
    const state = String(instance.state) as MissionState;
    if (state === "CLAIMED") {
      throw new AppError("E-REWARD-ALREADY-GRANTED", "This reward is already claimed", 409);
    }
    if (state === "EXPIRED") {
      throw new AppError("E-MISSION-NOT-ACTIVE", "That mission has expired", 409);
    }
    if (state === "VERIFYING") {
      throw new AppError("E-REVIEW-PENDING", "Your evidence is still being reviewed", 409);
    }
    if (state !== "CLAIMABLE") {
      throw new AppError("E-MISSION-NOT-ACTIVE", "That mission is not finished yet", 409);
    }

    const definition = await definitionFor(
      tx,
      input.missionKey,
      Number(instance.definition_version),
    );
    const payout = await payMission(tx, {
      walletId: wallet.id,
      phone: wallet.phone,
      instanceId: String(instance.id),
      definition,
      missionDate: String(instance.mission_date),
    });
    if (payout.rejected) {
      throw payout.reason === "QUOTA_EXHAUSTED"
        ? new AppError("E-QUOTA-EXHAUSTED", "This mission is fully claimed", 409)
        : new AppError("E-BUDGET-EXHAUSTED", "This mission's reward budget is used up", 409);
    }

    const { levels } = await loadLevels(tx);
    const xpRow = await one(tx, "SELECT lifetime_xp FROM user_levels WHERE wallet_id = ?", [
      wallet.id,
    ]);
    return {
      missionKey: input.missionKey,
      state: "CLAIMED" as MissionState,
      reward: payout.reward,
      level: levelForXp(levels, Number(xpRow?.lifetime_xp ?? 0)),
      leveledUp: payout.granted.leveledUp,
      unlocked: payout.unlocked,
    };
  });
}

/** The exact version an instance was assigned under, never a newer one. */
export async function definitionFor(tx: Exec, missionKey: string, definitionVersion: number) {
  const row = await one(
    tx,
    "SELECT * FROM mission_definitions WHERE mission_key = ? AND definition_version = ?",
    [missionKey, definitionVersion],
  );
  if (!row) {
    throw new AppError("E-MISSION-NOT-ACTIVE", "That mission no longer exists", 404);
  }
  return mapDefinition(row);
}

/**
 * Joins an urgent mission, reserving quota if the campaign reserves on join.
 *
 * The conditional UPDATE on `joined_count` is the reservation: it either takes
 * a place or it does not, which is the only way a limited campaign survives
 * everybody tapping at once when the push lands.
 */
export async function joinMission(input: {
  phone: string;
  missionKey: string;
  location?: ReportedLocation | null;
}) {
  return withTx(async (tx) => {
    const wallet = await ensureRewardWallet(tx, { phone: input.phone });
    const live = (await joinableMissionDefinitions(tx)).find(
      (definition) => definition.missionKey === input.missionKey,
    );
    if (!live) {
      throw new AppError("E-MISSION-NOT-ACTIVE", "That mission is not running", 404);
    }

    const { levels } = await loadLevels(tx);
    const xpRow = await one(tx, "SELECT lifetime_xp FROM user_levels WHERE wallet_id = ?", [
      wallet.id,
    ]);
    const standing = levelForXp(levels, Number(xpRow?.lifetime_xp ?? 0));
    const facts = await loadPlayerFacts(tx, wallet.id);
    const eligibility = evaluateEligibility({
      definition: live,
      level: standing.level,
      facts,
      location: input.location,
    });
    if (!eligibility.eligible) throw eligibilityError(eligibility.reason, live);

    // How many times this player has already been in this campaign. The unique
    // key is (wallet, mission, mission_date), so repeats live in numbered
    // occurrence slots rather than in extra rows the key would reject.
    const held = await all(
      tx,
      "SELECT state, mission_date FROM user_missions WHERE wallet_id = ? AND mission_key = ?",
      [wallet.id, live.missionKey],
    );
    if (held.some((row) => OPEN_STATES.includes(String(row.state)))) {
      throw new AppError("E-ALREADY-COMPLETED", "You have already joined this mission", 409);
    }
    if (held.length >= live.userQuota) {
      throw new AppError(
        "E-ALREADY-COMPLETED",
        live.userQuota === 1
          ? "You have already done this mission"
          : `This mission can be done ${live.userQuota} times, and you have used them all`,
        409,
      );
    }
    const occurrence = held.length === 0 ? "" : `#${held.length + 1}`;

    if (live.globalQuota !== null && live.quotaMode === "RESERVE_ON_JOIN") {
      const taken = await run(
        tx,
        `UPDATE mission_definitions
         SET joined_count = joined_count + 1, updated_at = ?
         WHERE mission_key = ? AND definition_version = ?
           AND joined_count < global_quota`,
        [isoNow(), live.missionKey, live.definitionVersion],
      );
      if (taken !== 1) {
        throw new AppError("E-QUOTA-EXHAUSTED", "This mission is fully booked", 409);
      }
    } else {
      // Not a reservation, just the participation count an operator reads.
      await run(
        tx,
        `UPDATE mission_definitions SET joined_count = joined_count + 1, updated_at = ?
         WHERE mission_key = ? AND definition_version = ?`,
        [isoNow(), live.missionKey, live.definitionVersion],
      );
    }

    const inserted = await run(
      tx,
      `INSERT OR IGNORE INTO user_missions
       (id, wallet_id, mission_key, definition_version, mission_date, state, progress,
        target, assigned_at, expires_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'IN_PROGRESS', 0, ?, ?, ?, ?)`,
      [
        id("umis"),
        wallet.id,
        live.missionKey,
        live.definitionVersion,
        occurrence,
        live.targetCount,
        isoNow(),
        live.endsAt ?? manilaDayEndUtc(),
        isoNow(),
      ],
    );
    if (inserted !== 1) {
      // Two taps arriving together: one made the row, the other must not keep
      // the seat it reserved on the way past.
      if (live.globalQuota !== null && live.quotaMode === "RESERVE_ON_JOIN") {
        await run(
          tx,
          `UPDATE mission_definitions SET joined_count = GREATEST(0, joined_count - 1)
           WHERE mission_key = ? AND definition_version = ?`,
          [live.missionKey, live.definitionVersion],
        );
      }
      throw new AppError("E-ALREADY-COMPLETED", "You have already joined this mission", 409);
    }

    await publishEvent(tx, {
      eventName: "mission_assigned",
      walletId: wallet.id,
      phone: wallet.phone,
      source: "api",
      partnerId: live.partnerId,
      objectType: "mission",
      objectId: live.missionKey,
      idempotencyKey: `mission_assigned:${wallet.id}:${live.missionKey}:${live.definitionVersion}:${occurrence}`,
      metadata: { definitionVersion: live.definitionVersion, quotaMode: live.quotaMode },
      status: "Processed",
    });

    return {
      missionKey: live.missionKey,
      state: "IN_PROGRESS" as MissionState,
      requiresProof: live.requiresProof,
    };
  });
}

/** Turns an eligibility refusal into the error code the app maps to a message. */
function eligibilityError(
  reason: MissionEligibility["reason"],
  definition: MissionDefinition,
) {
  switch (reason) {
    case "LEVEL_REQUIRED":
      return new AppError(
        "E-LEVEL-REQUIRED",
        `This mission opens at level ${definition.minLevel}`,
        403,
      );
    case "QUOTA_EXHAUSTED":
      return new AppError("E-QUOTA-EXHAUSTED", "This mission is fully booked", 409);
    case "NOT_STARTED":
      return new AppError("E-MISSION-NOT-ACTIVE", "This mission has not started yet", 409);
    case "OUT_OF_AREA":
      return new AppError(
        "E-NOT-ELIGIBLE",
        "This mission is only available near the partner. Turn on location and try again there.",
        403,
      );
    default:
      return new AppError("E-NOT-ELIGIBLE", "This mission is not available to you", 403);
  }
}

/* Reading ------------------------------------------------------------------- */

/** The proof rows an app needs alongside its mission instances. */
async function proofsForInstances(db: Exec, instanceIds: string[]) {
  const found = new Map<string, MissionProofState>();
  if (instanceIds.length === 0) return found;
  const placeholders = instanceIds.map(() => "?").join(", ");
  const rows = await all(
    db,
    `SELECT id, user_mission_id, kind, review_status, submitted_at, reviewed_at, reject_reason
     FROM mission_proofs
     WHERE user_mission_id IN (${placeholders})
     ORDER BY submitted_at ASC`,
    instanceIds,
  );
  // Ascending, so the newest submission for an instance wins the map slot: the
  // one the player is waiting on is the one worth showing.
  for (const row of rows) {
    found.set(String(row.user_mission_id), {
      proofId: String(row.id),
      kind: String(row.kind) as MissionProofState["kind"],
      status: String(row.review_status) as MissionProofStatus,
      submittedAt: String(row.submitted_at),
      ...(row.reviewed_at ? { reviewedAt: String(row.reviewed_at) } : {}),
      ...(row.reject_reason ? { rejectReason: String(row.reject_reason) } : {}),
    });
  }
  return found;
}

export type MissionBoardInput = {
  walletId: string;
  level: number;
  lifetimeXp: number;
  date?: string;
  location?: ReportedLocation | null;
  /** Pre-read facts, when the caller already had them. */
  facts?: PlayerFacts;
};

/**
 * Today's mission board for one player: their own instances first, then the
 * campaigns they could still join.
 *
 * Instances are read rather than definitions so a mission whose definition was
 * republished mid-day still shows the rules the player is actually being judged
 * against. Joinable campaigns are the opposite by necessity — there is no
 * instance yet — and are built from the live definition and a fresh eligibility
 * check.
 */
export async function listMissionCards(
  db: Exec,
  input: MissionBoardInput,
): Promise<MissionCard[]> {
  const date = input.date ?? manilaDate();
  const clock = manilaClock();
  const rows = await all(
    db,
    `SELECT um.*, d.type, d.title, d.description, d.trigger_event, d.window_start,
            d.window_end, d.min_level, d.partner_id, d.reward_json, d.auto_claim,
            d.requires_proof, d.audience_json, d.global_quota, d.quota_mode,
            d.joined_count, d.completed_count, d.starts_at, d.ends_at, d.terms_url,
            d.sort_order, b.name AS partner_name
     FROM user_missions um
     JOIN mission_definitions d
       ON d.mission_key = um.mission_key AND d.definition_version = um.definition_version
     LEFT JOIN businesses b ON b.id = d.partner_id
     WHERE um.wallet_id = ?
       AND (um.mission_date = ? OR um.mission_date NOT LIKE '____-__-__')
       AND um.state NOT IN ('CANCELLED')
     ORDER BY d.sort_order ASC, um.mission_key ASC`,
    [input.walletId, date],
  );

  const { levels } = await loadLevels(db);
  const ladder = [...levels].sort((a, b) => a.level - b.level);
  const proofs = await proofsForInstances(db, rows.map((row) => String(row.id)));

  const cards = rows.map((row) => {
    const window = row.window_start
      ? { startTime: String(row.window_start), endTime: String(row.window_end) }
      : null;
    const minLevel = Number(row.min_level ?? 1);
    // A locked mission shows the XP still to go, not just a padlock: the
    // requirements are explicit that a restriction should read as a goal.
    const requirement = ladder.find((entry) => entry.level >= minLevel);
    const audience = parseAudience(row.audience_json ? String(row.audience_json) : null);
    const globalQuota =
      row.global_quota === null || row.global_quota === undefined
        ? null
        : Number(row.global_quota);
    const taken =
      String(row.quota_mode ?? "ON_COMPLETION") === "RESERVE_ON_JOIN"
        ? Number(row.joined_count ?? 0)
        : Number(row.completed_count ?? 0);
    return {
      missionKey: String(row.mission_key),
      definitionVersion: Number(row.definition_version),
      type: String(row.type) as MissionType,
      title: String(row.title),
      description: String(row.description ?? ""),
      triggerEvent: String(row.trigger_event) as MissionTriggerEvent,
      state: String(row.state) as MissionState,
      progress: Number(row.progress),
      target: Number(row.target),
      reward: summarise(parseRewardLines(row.reward_json ? String(row.reward_json) : null)),
      window,
      windowOpen: withinWindow(clock, window),
      minLevel,
      locked: input.level < minLevel,
      xpToUnlock:
        input.level < minLevel && requirement
          ? Math.max(0, requirement.minXp - input.lifetimeXp)
          : 0,
      partnerId: row.partner_id ? String(row.partner_id) : undefined,
      partnerName: row.partner_name ? String(row.partner_name) : undefined,
      expiresAt: String(row.expires_at),
      autoClaim: Number(row.auto_claim ?? 1) === 1,
      // Already in it, so none of the joining fields apply.
      joinable: false,
      quotaRemaining: globalQuota === null ? null : Math.max(0, globalQuota - taken),
      startsAt: row.starts_at ? String(row.starts_at) : null,
      endsAt: row.ends_at ? String(row.ends_at) : null,
      requiresProof: Number(row.requires_proof ?? 0) === 1,
      proof: proofs.get(String(row.id)) ?? null,
      area: audience.area ?? null,
      distanceMeters:
        audience.area && input.location ? metresBetween(input.location, audience.area) : null,
      ineligibleReason: null,
      termsUrl: row.terms_url ? String(row.terms_url) : null,
    } satisfies MissionCard;
  });

  const joined = new Set(cards.map((card) => card.missionKey));
  return [
    ...cards,
    ...(await joinableCards(db, { ...input, exclude: joined, ladder })),
  ];
}

/**
 * The campaigns a player is not in yet, as cards they can act on.
 *
 * A campaign they are barred from is still returned, carrying the reason. That
 * is the requirements' rule about locked content restated for missions: a
 * padlock with a number beside it is a goal, and a card that silently is not
 * there is nothing at all.
 */
async function joinableCards(
  db: Exec,
  input: MissionBoardInput & {
    exclude: Set<string>;
    ladder: { level: number; minXp: number }[];
  },
): Promise<MissionCard[]> {
  const definitions = (await joinableMissionDefinitions(db)).filter(
    (definition) => !input.exclude.has(definition.missionKey),
  );
  if (definitions.length === 0) return [];

  const facts = input.facts ?? (await loadPlayerFacts(db, input.walletId));
  const partnerNames = await partnerNamesFor(
    db,
    definitions.map((definition) => definition.partnerId).filter((value): value is string => Boolean(value)),
  );
  const clock = manilaClock();

  return definitions.map((definition) => {
    const eligibility = evaluateEligibility({
      definition,
      level: input.level,
      facts,
      location: input.location,
    });
    const requirement = input.ladder.find((entry) => entry.level >= definition.minLevel);
    return {
      missionKey: definition.missionKey,
      definitionVersion: definition.definitionVersion,
      type: definition.type,
      title: definition.title,
      description: definition.description,
      triggerEvent: definition.triggerEvent,
      // Not started is not a state a row can be in, so an unjoined campaign
      // reports the one the app draws: AVAILABLE with a Join button, or LOCKED
      // with the reason beside it.
      state: eligibility.eligible ? "AVAILABLE" : "LOCKED",
      progress: 0,
      target: definition.targetCount,
      reward: summarise(definition.reward),
      window: definition.window,
      windowOpen: withinWindow(clock, definition.window),
      minLevel: definition.minLevel,
      locked: !eligibility.eligible,
      xpToUnlock:
        eligibility.reason === "LEVEL_REQUIRED" && requirement
          ? Math.max(0, requirement.minXp - input.lifetimeXp)
          : 0,
      partnerId: definition.partnerId ?? undefined,
      partnerName: definition.partnerId
        ? partnerNames.get(definition.partnerId) ?? undefined
        : undefined,
      expiresAt: definition.endsAt ?? manilaDayEndUtc(),
      autoClaim: definition.autoClaim,
      joinable: eligibility.eligible,
      quotaRemaining: quotaRemaining(definition),
      startsAt: definition.startsAt,
      endsAt: definition.endsAt,
      requiresProof: definition.requiresProof,
      proof: null,
      area: definition.audience.area ?? null,
      distanceMeters: eligibility.distanceMeters,
      ineligibleReason: eligibility.reason,
      termsUrl: definition.termsUrl,
    } satisfies MissionCard;
  });
}

async function partnerNamesFor(db: Exec, partnerIds: string[]) {
  const names = new Map<string, string>();
  const unique = [...new Set(partnerIds)];
  if (unique.length === 0) return names;
  const rows = await all(
    db,
    `SELECT id, name FROM businesses WHERE id IN (${unique.map(() => "?").join(", ")})`,
    unique,
  );
  for (const row of rows) names.set(String(row.id), String(row.name));
  return names;
}

/**
 * Expires instances whose window has closed without them being finished, and
 * gives their reserved quota places back.
 *
 * Run by the maintenance cron. Deliberately does not touch CLAIMABLE rows: a
 * player who finished a mission and had not yet tapped Claim when midnight
 * passed earned that reward, and taking it back at a clock boundary would be
 * the app losing something they did, not them missing a deadline. VERIFYING is
 * left alone for the same reason — the player has done their part and is
 * waiting on us.
 */
export async function expireMissions() {
  return withTx(async (tx) => {
    const expired = await run(
      tx,
      `UPDATE user_missions
       SET state = 'EXPIRED', updated_at = ?
       WHERE expires_at <= ?
         AND state IN ('LOCKED', 'AVAILABLE', 'IN_PROGRESS')`,
      [isoNow(), isoNow()],
    );
    const released = await releaseReservedQuota(tx);
    return { expired, released };
  });
}

/**
 * Hands back the places held by instances that will never be finished.
 *
 * Only ever runs for RESERVE_ON_JOIN campaigns, because only they took a place
 * on the way in. The instance is stamped `quota_released` in the same
 * transaction as the decrement, so however many times the sweep passes over a
 * dead row it gives back exactly one seat.
 */
export async function releaseReservedQuota(tx: Exec, limit = 500) {
  const rows = await all(
    tx,
    `SELECT um.id, um.mission_key, um.definition_version
     FROM user_missions um
     JOIN mission_definitions d
       ON d.mission_key = um.mission_key AND d.definition_version = um.definition_version
     WHERE um.quota_released = 0
       AND um.state IN ('EXPIRED', 'CANCELLED', 'REJECTED')
       AND d.quota_mode = 'RESERVE_ON_JOIN'
       AND d.global_quota IS NOT NULL
     ORDER BY um.updated_at ASC
     LIMIT ?
     FOR UPDATE OF um`,
    [limit],
  );
  if (rows.length === 0) return 0;

  const freed = new Map<string, { missionKey: string; version: number; count: number }>();
  for (const row of rows) {
    const key = `${row.mission_key}:${row.definition_version}`;
    const entry = freed.get(key) ?? {
      missionKey: String(row.mission_key),
      version: Number(row.definition_version),
      count: 0,
    };
    entry.count += 1;
    freed.set(key, entry);
  }

  for (const entry of freed.values()) {
    await run(
      tx,
      `UPDATE mission_definitions
       SET joined_count = GREATEST(0, joined_count - ?), updated_at = ?
       WHERE mission_key = ? AND definition_version = ?`,
      [entry.count, isoNow(), entry.missionKey, entry.version],
    );
  }

  const ids = rows.map((row) => String(row.id));
  await run(
    tx,
    `UPDATE user_missions SET quota_released = 1
     WHERE id IN (${ids.map(() => "?").join(", ")})`,
    ids,
  );
  return ids.length;
}
