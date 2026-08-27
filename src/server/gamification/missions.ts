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
 */
import crypto from "node:crypto";
import type {
  MissionCard,
  MissionClaimResult,
  MissionState,
  MissionTriggerEvent,
  MissionType,
  RewardLine,
} from "@bizflow/shared";
import { levelForXp } from "@bizflow/shared";
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

/**
 * How late an event may arrive and still count against the window it happened
 * in. Processing lag is ours, not the player's: an ad watched at 10:58 that is
 * verified at 11:02 still finished the morning mission.
 */
const WINDOW_GRACE_MINUTES = 15;

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
  autoClaim: boolean;
  userQuota: number;
  globalQuota: number | null;
  joinedCount: number;
  rewardBudgetCentavos: number | null;
  spentBudgetCentavos: number;
  startsAt: string | null;
  endsAt: string | null;
  sortOrder: number;
  status: string;
};

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
    autoClaim: Number(row.auto_claim ?? 1) === 1,
    userQuota: Number(row.user_quota ?? 1),
    globalQuota: row.global_quota === null || row.global_quota === undefined ? null : Number(row.global_quota),
    joinedCount: Number(row.joined_count ?? 0),
    rewardBudgetCentavos:
      row.reward_budget_centavos === null || row.reward_budget_centavos === undefined
        ? null
        : Number(row.reward_budget_centavos),
    spentBudgetCentavos: Number(row.spent_budget_centavos ?? 0),
    startsAt: row.starts_at ? String(row.starts_at) : null,
    endsAt: row.ends_at ? String(row.ends_at) : null,
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
       ${options.type ? "AND d.type = ?" : ""}
     ORDER BY d.sort_order ASC, d.mission_key ASC`,
    options.type ? [at, at, options.type] : [at, at],
  );
  return rows.map(mapDefinition);
}

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

    const missionDate = definition.type === "DAILY" ? date : "";
    const instance = await one(
      tx,
      `SELECT * FROM user_missions
       WHERE wallet_id = ? AND mission_key = ? AND mission_date = ?
       FOR UPDATE`,
      [event.walletId, definition.missionKey, missionDate],
    );
    if (!instance) continue;

    const state = String(instance.state) as MissionState;
    if (state === "CLAIMED" || state === "EXPIRED" || state === "CANCELLED" || state === "REJECTED") {
      continue;
    }

    const progress =
      definition.condition.uniqueRule === "distinct_mission_key"
        ? await distinctCompletedToday(tx, event.walletId, date, definition.missionKey)
        : Math.min(definition.targetCount, Number(instance.progress) + 1);

    const complete = progress >= definition.targetCount;
    // CLAIMABLE either way. An auto-claim mission passes straight through it in
    // the same transaction, but the transition is still written, so the path a
    // reward took is the same shape whether a person tapped or not.
    const nextState: MissionState = complete ? "CLAIMABLE" : "IN_PROGRESS";

    await run(
      tx,
      `UPDATE user_missions
       SET progress = ?, state = ?, completed_at = COALESCE(completed_at, ?), updated_at = ?
       WHERE id = ?`,
      [
        progress,
        nextState,
        complete ? isoNow() : null,
        isoNow(),
        String(instance.id),
      ],
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
      if (definition.autoClaim) {
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

/**
 * Pays a completed mission and moves it to CLAIMED.
 *
 * Everything here is one transaction with the state change, which is the point:
 * the requirements are explicit that reward issuance and state change commit
 * together. The reward key is derived from the instance, so a claim retried
 * after a timeout finds the transaction already written and pays nothing more.
 */
async function payMission(
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
    return { rejected: true as const, reward: EMPTY_REWARD, unlocked: [], granted: null };
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
       WHERE wallet_id = ? AND mission_key = ? AND mission_date IN (?, '')
       ORDER BY mission_date DESC
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
      throw new AppError(
        "E-BUDGET-EXHAUSTED",
        "This mission's reward budget is used up",
        409,
      );
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
async function definitionFor(tx: Exec, missionKey: string, definitionVersion: number) {
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
export async function joinMission(input: { phone: string; missionKey: string }) {
  return withTx(async (tx) => {
    const wallet = await ensureRewardWallet(tx, { phone: input.phone });
    const live = (await liveMissionDefinitions(tx)).find(
      (definition) => definition.missionKey === input.missionKey,
    );
    if (!live) {
      throw new AppError("E-MISSION-NOT-ACTIVE", "That mission is not running", 404);
    }

    const { levels } = await loadLevels(tx);
    const xpRow = await one(tx, "SELECT lifetime_xp FROM user_levels WHERE wallet_id = ?", [
      wallet.id,
    ]);
    const state = levelForXp(levels, Number(xpRow?.lifetime_xp ?? 0));
    if (state.level < live.minLevel) {
      throw new AppError(
        "E-LEVEL-REQUIRED",
        `This mission opens at level ${live.minLevel}`,
        403,
      );
    }

    if (live.globalQuota !== null) {
      const taken = await run(
        tx,
        `UPDATE mission_definitions
         SET joined_count = joined_count + 1, updated_at = ?
         WHERE mission_key = ? AND definition_version = ?
           AND (global_quota IS NULL OR joined_count < global_quota)`,
        [isoNow(), live.missionKey, live.definitionVersion],
      );
      if (taken !== 1) {
        throw new AppError("E-QUOTA-EXHAUSTED", "This mission is fully booked", 409);
      }
    }

    const missionDate = live.type === "DAILY" ? manilaDate() : "";
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
        missionDate,
        live.targetCount,
        isoNow(),
        live.endsAt ?? manilaDayEndUtc(),
        isoNow(),
      ],
    );
    if (inserted !== 1) {
      // Already joined. Give the quota place back rather than letting a double
      // tap eat two of a limited campaign's seats.
      if (live.globalQuota !== null) {
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
      idempotencyKey: `mission_assigned:${wallet.id}:${live.missionKey}:${live.definitionVersion}`,
      metadata: { definitionVersion: live.definitionVersion },
      status: "Processed",
    });

    return { missionKey: live.missionKey, state: "IN_PROGRESS" as MissionState };
  });
}

/**
 * Today's mission board for one player.
 *
 * Reads instances rather than definitions so a mission whose definition was
 * republished mid-day still shows the rules the player is actually being judged
 * against.
 */
export async function listMissionCards(
  db: Exec,
  input: { walletId: string; level: number; lifetimeXp: number; date?: string },
): Promise<MissionCard[]> {
  const date = input.date ?? manilaDate();
  const clock = manilaClock();
  const rows = await all(
    db,
    `SELECT um.*, d.type, d.title, d.description, d.trigger_event, d.window_start,
            d.window_end, d.min_level, d.partner_id, d.reward_json, d.auto_claim,
            d.sort_order, b.name AS partner_name
     FROM user_missions um
     JOIN mission_definitions d
       ON d.mission_key = um.mission_key AND d.definition_version = um.definition_version
     LEFT JOIN businesses b ON b.id = d.partner_id
     WHERE um.wallet_id = ? AND um.mission_date IN (?, '')
       AND um.state NOT IN ('CANCELLED')
     ORDER BY d.sort_order ASC, um.mission_key ASC`,
    [input.walletId, date],
  );

  const { levels } = await loadLevels(db);
  const ladder = [...levels].sort((a, b) => a.level - b.level);

  return rows.map((row) => {
    const window = row.window_start
      ? { startTime: String(row.window_start), endTime: String(row.window_end) }
      : null;
    const minLevel = Number(row.min_level ?? 1);
    // A locked mission shows the XP still to go, not just a padlock: the
    // requirements are explicit that a restriction should read as a goal.
    const requirement = ladder.find((entry) => entry.level >= minLevel);
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
    } satisfies MissionCard;
  });
}

/**
 * Expires instances whose window has closed without them being finished.
 *
 * Run by the maintenance cron. Deliberately does not touch CLAIMABLE rows: a
 * player who finished a mission and had not yet tapped Claim when midnight
 * passed earned that reward, and taking it back at a clock boundary would be
 * the app losing something they did, not them missing a deadline.
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
    return { expired };
  });
}
