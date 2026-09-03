/**
 * Event ingestion: the one door into the rules engine.
 *
 * Everything that can move a mission or an achievement arrives here as a
 * verified domain event, is written down before it is acted on, and is
 * deduplicated by `idempotency_key` on the way in. That ordering is the whole
 * point of the table: business data and event publication commit together
 * (the transactional-outbox pattern), so a crash between "the QR was redeemed"
 * and "the mission advanced" leaves a Pending row to finish rather than a fact
 * nobody will ever act on.
 *
 * The client never sends these. They come from server-side verification points:
 * a redeemed QR, an issued voucher, a finished hunt, an AdMob server-side
 * verification callback. A phone with its clock moved forward changes nothing,
 * because `received_at_utc` is ours and the window test uses the server's view
 * of when the action happened.
 */
import crypto from "node:crypto";
import type { AchievementUnlockNotice, MissionTriggerEvent } from "@bizflow/shared";
import { all, getDb, one, run, withTx, type Exec } from "@/server/db";
import { reportError } from "@/server/monitoring";
import { ensureRewardWallet } from "@/server/rewards-network";
import { bumpCounter, bumpDistinctCounter } from "./achievements";
import { loadEconomy } from "./config";
import { featureEnabledFor } from "./flags";
import { applyEventToMissions, type MissionProgressOutcome } from "./missions";

const isoNow = () => new Date().toISOString();
const id = (prefix: string) => `${prefix}_${crypto.randomBytes(12).toString("hex")}`;

/** Everything the engine understands, including what it only records. */
export type GamificationEventName =
  | MissionTriggerEvent
  | "points_converted_to_xp"
  | "xp_granted"
  | "level_up"
  | "level_recalculated"
  | "mission_assigned"
  | "mission_progressed"
  | "mission_reward_granted"
  | "mission_expired"
  | "achievement_progressed"
  | "achievement_unlocked"
  | "achievement_reward_granted"
  | "proof_approved"
  | "proof_rejected"
  | "fraud_flagged"
  | "reward_held"
  | "reward_reversed"
  | "account_suspended"
  | "credit_earned"
  | "credit_redeemed";

export type PublishEventInput = {
  eventName: GamificationEventName;
  walletId?: string | null;
  phone?: string | null;
  /** When the action happened. Defaults to now; never taken from a client. */
  occurredAt?: string;
  source: string;
  partnerId?: string | null;
  objectType?: string | null;
  objectId?: string | null;
  idempotencyKey: string;
  amountCentavos?: number | null;
  deviceIdHash?: string | null;
  metadata?: Record<string, unknown>;
  /**
   * Pending means the rules engine still has work to do on this row. Deferred
   * means a feature flag was off when it arrived: the fact is kept, and
   * `requeueDeferredEvents` puts it back in the queue when the flag returns.
   */
  status?: "Pending" | "Processed" | "Ignored" | "Deferred";
};

/**
 * Writes an event row, once.
 *
 * Returns false when the key has been seen before, which is how every caller
 * gets deduplication for free: the second delivery of an ad callback, the retry
 * of a redemption, the replay of a queue — all of them insert nothing and are
 * told so.
 */
export async function publishEvent(tx: Exec, input: PublishEventInput): Promise<boolean> {
  const now = isoNow();
  const inserted = await run(
    tx,
    `INSERT OR IGNORE INTO gamification_events
     (event_id, event_name, schema_version, wallet_id, phone, occurred_at_utc, received_at_utc,
      source, partner_id, object_type, object_id, idempotency_key, amount_centavos,
      device_id_hash, metadata, status, created_at)
     VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id("evt"),
      input.eventName,
      input.walletId ?? null,
      input.phone ?? null,
      input.occurredAt ?? now,
      now,
      input.source,
      input.partnerId ?? null,
      input.objectType ?? null,
      input.objectId ?? null,
      input.idempotencyKey,
      input.amountCentavos ?? null,
      input.deviceIdHash ?? null,
      // Reference keys only. Raw receipts, precise locations and personal data
      // stay in their own stores and are pointed at from here.
      input.metadata ? JSON.stringify(input.metadata) : null,
      input.status ?? "Pending",
      now,
    ],
  );
  return inserted === 1;
}

export type IngestResult = {
  /** False when this exact event had already been recorded. */
  accepted: boolean;
  missions: MissionProgressOutcome[];
  unlocked: AchievementUnlockNotice[];
};

export const IGNORED_RESULT: IngestResult = {
  accepted: false,
  missions: [],
  unlocked: [],
};

export type IngestInput = Omit<PublishEventInput, "status" | "walletId"> & {
  phone: string;
  eventName: GamificationEventName;
};

/**
 * Records a verified event and applies it, atomically.
 *
 * One transaction covers the event row, the mission progress it causes, the
 * achievement counters it moves and the rewards those pay. Half of that landing
 * is the failure mode the whole design exists to prevent, so none of it is
 * allowed to commit alone.
 */
export async function ingestEvent(input: IngestInput): Promise<IngestResult> {
  return withTx(async (tx) => {
    const wallet = await ensureRewardWallet(tx, { phone: input.phone });
    const fresh = await publishEvent(tx, {
      ...input,
      walletId: wallet.id,
      status: "Pending",
    });
    if (!fresh) return IGNORED_RESULT;

    const result = await applyEvent(tx, {
      walletId: wallet.id,
      phone: wallet.phone,
      eventName: input.eventName,
      occurredAt: input.occurredAt ?? isoNow(),
      partnerId: input.partnerId ?? null,
      objectId: input.objectId ?? null,
      metadata: input.metadata,
    });

    await run(
      tx,
      "UPDATE gamification_events SET status = ?, processed_at = ? WHERE idempotency_key = ?",
      result.deferred
        ? ["Deferred", null, input.idempotencyKey]
        : ["Processed", isoNow(), input.idempotencyKey],
    );
    return { accepted: true, missions: result.missions, unlocked: result.unlocked };
  });
}

/**
 * Ingests an event without ever failing the thing that caused it.
 *
 * A voucher redemption is complete whether or not a mission noticed. Letting a
 * rules-engine fault roll back a redemption would trade a cosmetic problem for
 * a real one, so this swallows the error, reports it, and leaves the event row
 * behind for `processPendingEvents` to retry.
 */
export async function ingestEventQuietly(input: IngestInput): Promise<IngestResult> {
  try {
    return await ingestEvent(input);
  } catch (error) {
    await reportError(error, {
      source: "gamification",
      detail: { eventName: input.eventName, idempotencyKey: input.idempotencyKey },
    });
    return IGNORED_RESULT;
  }
}

type ApplyInput = {
  walletId: string;
  phone: string;
  eventName: GamificationEventName;
  occurredAt: string;
  partnerId: string | null;
  objectId: string | null;
  metadata?: Record<string, unknown>;
};

/**
 * Routes one event to the missions it can advance and the counters it feeds.
 *
 * Missions first, then counters: a mission completing raises the
 * `mission_completed` counter itself, so doing counters first would let the
 * same fact be counted from two directions.
 */
async function applyEvent(tx: Exec, input: ApplyInput) {
  const { economy } = await loadEconomy(tx);
  const missionsOn = featureEnabledFor(economy, "missions", input.walletId);
  const achievementsOn = featureEnabledFor(economy, "achievements", input.walletId);

  // With the whole engine switched off for this player the event is kept and
  // not judged. Nothing is lost: the row waits as Deferred and is requeued when
  // the flags come back, so a stop-the-world switch costs history rather than
  // destroying it.
  //
  // With only one half off, that half is skipped for events that happen while
  // it is off and the row is finished. Retrying the other half later would
  // double-count the half that already ran, and a counter counted twice is a
  // worse outcome than a mission that did not notice a redemption during an
  // outage the operator declared.
  if (!missionsOn && !achievementsOn) {
    return { missions: [] as MissionProgressOutcome[], unlocked: [] as AchievementUnlockNotice[], deferred: true };
  }

  const missions = missionsOn && MISSION_TRIGGERS.has(input.eventName)
    ? await applyEventToMissions(tx, {
        walletId: input.walletId,
        phone: input.phone,
        eventName: input.eventName as MissionTriggerEvent,
        occurredAt: input.occurredAt,
        partnerId: input.partnerId,
        objectId: input.objectId,
      })
    : [];

  const unlocked: AchievementUnlockNotice[] = [];
  const counter = achievementsOn ? COUNTER_FOR_EVENT[input.eventName] : undefined;
  if (counter) {
    unlocked.push(
      ...(await bumpCounter(tx, {
        walletId: input.walletId,
        counterKey: counter,
        delta: 1,
        sourceId: input.objectId ?? input.eventName,
      })),
    );
  }

  // City Explorer counts partners, not visits, so it needs the partner's id and
  // a membership row rather than an increment.
  if (achievementsOn && input.eventName === "qr_redeem" && input.partnerId) {
    unlocked.push(
      ...(await bumpDistinctCounter(tx, {
        walletId: input.walletId,
        counterKey: "distinct_partners",
        memberKey: input.partnerId,
        delta: 1,
        sourceId: input.objectId ?? input.partnerId,
      })),
    );
  }

  return { missions, unlocked, deferred: false };
}

/** Events a mission definition may name as its trigger. */
const MISSION_TRIGGERS = new Set<string>([
  "ad_reward_verified",
  "hunt_complete",
  "voucher_select",
  "qr_redeem",
  "booking_complete",
  "purchase_verified",
  "review_verified",
  "referral_verified",
  "mission_completed",
]);

/**
 * Which achievement counter an event feeds, if any.
 *
 * `mission_completed` is absent on purpose: the mission engine raises that
 * counter itself when it pays, so listing it here would count every completion
 * twice. `daily_streak` is likewise advanced from the payout, where the fact
 * that a *daily* mission finished is known.
 */
const COUNTER_FOR_EVENT: Partial<Record<GamificationEventName, string>> = {
  hunt_complete: "hunt_complete",
  qr_redeem: "qr_redeem",
  review_verified: "review_verified",
  referral_verified: "referral_verified",
};

/**
 * Retries events the rules engine has not finished with.
 *
 * A row that keeps failing stops being retried after `maxRetries` and is left
 * Failed for an operator to look at — this system's dead-letter queue. Silence
 * would be worse than a stuck row: the reward is owed either way, and somebody
 * has to be able to find it.
 */
export async function processPendingEvents(options: { limit?: number; maxRetries?: number } = {}) {
  const limit = options.limit ?? 100;
  const maxRetries = options.maxRetries ?? 5;
  const db = await getDb();
  const pending = await all(
    db,
    `SELECT * FROM gamification_events
     WHERE status = 'Pending' AND retry_count < ?
     ORDER BY created_at ASC
     LIMIT ?`,
    [maxRetries, limit],
  );

  let processed = 0;
  let failed = 0;
  let deferred = 0;
  for (const row of pending) {
    try {
      const outcome = await withTx(async (tx) => {
        const applied = await applyEvent(tx, {
          walletId: String(row.wallet_id),
          phone: String(row.phone ?? ""),
          eventName: String(row.event_name) as GamificationEventName,
          occurredAt: String(row.occurred_at_utc),
          partnerId: row.partner_id ? String(row.partner_id) : null,
          objectId: row.object_id ? String(row.object_id) : null,
        });
        // A row deferred by a flag is not a failure and must not burn a retry:
        // it is waiting for an operator, not for the network.
        await run(
          tx,
          "UPDATE gamification_events SET status = ?, processed_at = ? WHERE event_id = ?",
          applied.deferred
            ? ["Deferred", null, String(row.event_id)]
            : ["Processed", isoNow(), String(row.event_id)],
        );
        return applied;
      });
      if (outcome.deferred) deferred += 1;
      else processed += 1;
    } catch (error) {
      failed += 1;
      await run(
        db,
        `UPDATE gamification_events
         SET retry_count = retry_count + 1,
             last_error = ?,
             status = CASE WHEN retry_count + 1 >= ? THEN 'Failed' ELSE 'Pending' END
         WHERE event_id = ?`,
        [String((error as Error)?.message ?? error).slice(0, 500), maxRetries, String(row.event_id)],
      );
    }
  }
  return { processed, failed, deferred, pending: pending.length };
}

/**
 * Puts flag-deferred events back in the queue.
 *
 * Called when an economy version is published, because that is the only thing
 * that can turn a feature back on. Deferred rows are deliberately not swept up
 * by the ordinary retry pass: while a feature is off they would be re-read on
 * every run, in creation order, and starve the events that can actually be
 * processed. So they wait for the switch that unblocks them.
 */
export async function requeueDeferredEvents(db: Exec) {
  const moved = await run(
    db,
    "UPDATE gamification_events SET status = 'Pending', retry_count = 0 WHERE status = 'Deferred'",
  );
  return { requeued: Number(moved ?? 0) };
}

/** Events an operator needs to look at. Surfaced on the admin dashboard. */
export async function deadLetteredEvents(limit = 50) {
  const db = await getDb();
  return all(
    db,
    `SELECT event_id, event_name, phone, occurred_at_utc, retry_count, last_error
     FROM gamification_events
     WHERE status = 'Failed'
     ORDER BY created_at DESC
     LIMIT ?`,
    [limit],
  );
}

/** Whether a given fact has already been recorded. */
export async function eventExists(db: Exec, idempotencyKey: string) {
  const row = await one(
    db,
    "SELECT 1 AS present FROM gamification_events WHERE idempotency_key = ?",
    [idempotencyKey],
  );
  return Boolean(row);
}
