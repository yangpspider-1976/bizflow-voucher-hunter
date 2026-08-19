import crypto from "node:crypto";
import type { Client, Transaction } from "@libsql/client";
import { generateQrToken, generateVoucherCode } from "@/server/codes";
import { assertDevToolsEnabledFor, devToolsEnabledFor } from "@/server/dev-tools";
import { AppError } from "@/server/errors";
import {
  addCalendarDays,
  all,
  batchAll,
  getDb,
  manilaDateString,
  mapAttempt,
  mapBusiness,
  mapCampaign,
  mapPool,
  mapReferralReward,
  mapRedemptionLog,
  mapReservation,
  mapSlot,
  mapUser,
  mapVoucher,
  one,
  run,
  withReadTx,
  withTx
} from "@/server/db";
import { toDisplayPhone } from "@/lib/phone-display";
import { normalizePhone } from "@/server/phone";
import {
  awardLoyaltyPointsForRedemption,
  awardReferralLoyaltyPoints
} from "@/server/rewards-network";
import { sendSms, type SmsResult } from "@/server/sms";
import type {
  Campaign,
  CampaignAvailability,
  CampaignCard,
  CampaignSlot,
  ClaimedVoucher,
  EndUser,
  SourceType,
  Voucher,
  VoucherAttempt,
  VoucherPool,
} from "@/types/voucher";

type Exec = Client | Transaction;

const now = () => new Date();
const isoNow = () => now().toISOString();
const id = (prefix: string) => `${prefix}_${crypto.randomBytes(6).toString("hex")}`;
const startOfTodayIso = () => {
  const d = now();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
};

function isUniqueViolation(error: unknown) {
  if (!(error instanceof Error)) return false;
  const code = "code" in error ? String((error as { code: unknown }).code) : "";
  return code.startsWith("SQLITE_CONSTRAINT") || /UNIQUE constraint failed|SQLITE_CONSTRAINT/i.test(error.message);
}

async function addAnalytics(
  db: Exec,
  campaignId: string,
  eventName: string,
  metadata?: Record<string, unknown>,
  userId?: string,
  slotId?: string
) {
  await run(
    db,
    `INSERT INTO analytics_events (id, campaign_id, event_name, user_id, slot_id, metadata, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id("evt"), campaignId, eventName, userId ?? null, slotId ?? null, metadata ? JSON.stringify(metadata) : null, isoNow()]
  );
}

/**
 * A voucher is redeemable until its booked slot ends — never on a clock that
 * starts at issuance. An issuance-relative window (the retired hours/days/custom
 * types) could elapse before the slot the customer booked ever arrived, handing
 * them a voucher that was dead on arrival at checkout.
 */
function expiryFor(slot: CampaignSlot) {
  return `${slot.date}T${slot.endTime}:00.000+08:00`;
}

// ---- Read helpers ----

async function campaignByIdOrSlug(db: Exec, key: string) {
  const row = await one(db, "SELECT * FROM campaigns WHERE id = ? OR slug = ?", [key, key]);
  return row ? mapCampaign(row) : undefined;
}

async function getCampaignOrThrow(db: Exec, key: string) {
  const campaign = await campaignByIdOrSlug(db, key);
  if (!campaign || campaign.status !== "active") {
    throw new AppError("E-CAMPAIGN-404", "Campaign is not available", 404);
  }
  return campaign;
}

async function getSlotOrThrow(db: Exec, slotId: string, campaignId: string) {
  const row = await one(db, "SELECT * FROM slots WHERE id = ? AND campaign_id = ?", [slotId, campaignId]);
  if (!row) throw new AppError("E-SLOT-404", "Selected slot was not found", 404);
  const slot = mapSlot(row);
  if (slot.status !== "active" || slot.remainingCapacity <= 0) {
    throw new AppError("E-SLOT-SOLD-OUT", "Selected slot is sold out", 409);
  }
  return slot;
}

async function findOrCreateUser(
  db: Exec,
  campaignId: string,
  phone: string,
  sessionId: string,
  name?: string,
  email?: string
): Promise<EndUser> {
  const normalized = normalizePhone(phone);
  if (!normalized) {
    throw new AppError("E-USER-PHONE", "A valid Philippine mobile number is required", 400);
  }
  const existingRow = await one(db, "SELECT * FROM users WHERE campaign_id = ? AND phone = ?", [campaignId, normalized]);
  if (existingRow) {
    const existing = mapUser(existingRow);
    await run(db, "UPDATE users SET name = ?, email = ?, session_id = ? WHERE id = ?", [
      name ?? existing.name ?? null,
      email ?? existing.email ?? null,
      sessionId || existing.sessionId,
      existing.id
    ]);
    return mapUser(await one(db, "SELECT * FROM users WHERE id = ?", [existing.id]));
  }
  const user: EndUser = {
    id: id("usr"),
    campaignId,
    phone: normalized,
    name,
    email,
    sessionId,
    createdAt: isoNow()
  };
  await run(db, "INSERT INTO users (id, campaign_id, name, phone, email, session_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)", [
    user.id,
    campaignId,
    name ?? null,
    normalized,
    email ?? null,
    sessionId,
    user.createdAt
  ]);
  return user;
}

export async function getOrCreateReferralIdentity(input: {
  phone: string;
  campaignSlug?: string;
  sessionId: string;
}) {
  return withTx(async (tx) => {
    const fallbackCampaignRow = input.campaignSlug
      ? undefined
      : await one(
          tx,
          // `campaigns` has no created_at column; id is the deterministic tiebreak.
          // Matches how listPublicCampaignCards orders the directory.
          `SELECT * FROM campaigns
           WHERE status = 'active'
           ORDER BY start_date DESC, id DESC
           LIMIT 1`,
        );
    const campaign = input.campaignSlug
      ? await getCampaignOrThrow(tx, input.campaignSlug)
      : fallbackCampaignRow
        ? mapCampaign(fallbackCampaignRow)
        : undefined;

    if (!campaign || campaign.status !== "active") {
      throw new AppError(
        "E-CAMPAIGN-404",
        "No active campaign is available for referrals",
        404,
      );
    }

    const user = await findOrCreateUser(
      tx,
      campaign.id,
      input.phone,
      input.sessionId,
    );
    const query = new URLSearchParams({
      campaign: campaign.slug,
      ref: user.id,
    });

    return {
      campaignSlug: campaign.slug,
      referrerUserId: user.id,
      visitPath: `/api/public/referral/visit?${query.toString()}`,
    };
  });
}

async function hasFinalVoucher(db: Exec, campaignId: string, userId: string) {
  return Boolean(await one(db, "SELECT 1 FROM vouchers WHERE campaign_id = ? AND user_id = ?", [campaignId, userId]));
}

async function countGrantedRewardsToday(db: Exec, campaignId: string, referrerUserId: string) {
  const row = await one(
    db,
    `SELECT COUNT(*) AS c FROM referral_rewards
     WHERE campaign_id = ? AND referrer_user_id = ? AND status = 'granted' AND created_at >= ?`,
    [campaignId, referrerUserId, startOfTodayIso()]
  );
  return Number(row.c);
}

async function countBonusAttemptsUsedToday(db: Exec, campaignId: string, userId: string) {
  const row = await one(
    db,
    `SELECT COUNT(*) AS c FROM attempts
     WHERE campaign_id = ? AND user_id = ? AND source_type = 'referral_bonus' AND created_at >= ?`,
    [campaignId, userId, startOfTodayIso()]
  );
  return Number(row.c);
}

async function remainingBonusAttempts(db: Exec, campaign: Campaign, userId: string) {
  const granted = Math.min(await countGrantedRewardsToday(db, campaign.id, userId), campaign.referralDailyLimit);
  const used = await countBonusAttemptsUsedToday(db, campaign.id, userId);
  return Math.max(0, granted - used);
}

async function insertReferralReward(
  db: Exec,
  campaignId: string,
  referrerUserId: string,
  visitorSessionId: string,
  status: "granted" | "rejected",
  reason?: string
) {
  const rewardId = id("ref");
  await run(
    db,
    `INSERT INTO referral_rewards (id, campaign_id, referrer_user_id, visitor_session_id, status, reason, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [rewardId, campaignId, referrerUserId, visitorSessionId, status, reason ?? null, isoNow()]
  );
  return rewardId;
}

/**
 * Records a visit to a shared referral link. Grants the referrer 1 extra
 * attempt if the visitor is a distinct session/device and the referrer's
 * daily referral limit has not been reached. Each (referrer, visitor) pair
 * can grant at most once, ever, so reloading a link cannot farm rewards.
 */
export function recordReferralOpen(input: { campaignSlug: string; ref: string; visitorSessionId: string }) {
  return withTx(async (tx) => {
    const campaign = await getCampaignOrThrow(tx, input.campaignSlug);
    const referrerRow = await one(tx, "SELECT * FROM users WHERE id = ? AND campaign_id = ?", [input.ref, campaign.id]);
    if (!referrerRow) throw new AppError("E-REFERRAL-404", "Referral link is invalid", 404);
    const referrer = mapUser(referrerRow);

    await addAnalytics(tx, campaign.id, "share_link_opened", { referrerUserId: referrer.id });

    const existingRow = await one(
      tx,
      "SELECT * FROM referral_rewards WHERE campaign_id = ? AND referrer_user_id = ? AND visitor_session_id = ?",
      [campaign.id, referrer.id, input.visitorSessionId]
    );
    if (existingRow) {
      const existing = mapReferralReward(existingRow);
      return { granted: existing.status === "granted", reason: existing.reason };
    }

    if (referrer.sessionId === input.visitorSessionId) {
      await insertReferralReward(tx, campaign.id, referrer.id, input.visitorSessionId, "rejected", "self_referral");
      return { granted: false, reason: "self_referral" };
    }

    if ((await countGrantedRewardsToday(tx, campaign.id, referrer.id)) >= campaign.referralDailyLimit) {
      await insertReferralReward(tx, campaign.id, referrer.id, input.visitorSessionId, "rejected", "daily_limit_reached");
      return { granted: false, reason: "daily_limit_reached" };
    }

    let loyaltyAwarded = false;
    try {
      const referralRewardId = await insertReferralReward(
        tx,
        campaign.id,
        referrer.id,
        input.visitorSessionId,
        "granted",
      );
      loyaltyAwarded = await awardReferralLoyaltyPoints(tx, {
        phone: referrer.phone,
        referralRewardId,
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        return { granted: false, reason: "already_processed" };
      }
      throw error;
    }
    await addAnalytics(tx, campaign.id, "extra_attempt_granted", { referrerUserId: referrer.id }, referrer.id);
    // The referrer is surfaced so the caller can notify them once this
    // transaction has committed — a push is a network call and must not be made
    // while holding a write transaction open.
    return {
      granted: true,
      referrerPhone: referrer.phone,
      campaignSlug: campaign.slug,
      loyaltyAwarded,
    };
  });
}

/** Reads referral progress using the exact referrer id encoded in the link. */
export async function getReferralSnapshot(input: {
  campaignSlug: string;
  ref: string;
}) {
  const db = await getDb();
  const campaign = await getCampaignOrThrow(db, input.campaignSlug);
  const userRow = await one(
    db,
    "SELECT * FROM users WHERE id = ? AND campaign_id = ?",
    [input.ref, campaign.id],
  );
  if (!userRow) {
    throw new AppError("E-REFERRAL-404", "Referral link is invalid", 404);
  }
  const sharesGrantedToday = await countGrantedRewardsToday(
    db,
    campaign.id,
    input.ref,
  );
  return {
    sharesGrantedToday,
    remainingBonusAttempts: await remainingBonusAttempts(
      db,
      campaign,
      input.ref,
    ),
  };
}

export async function publicSlots(campaignId: string) {
  const db = await getDb();
  const slots = (await all(db, "SELECT * FROM slots WHERE campaign_id = ?", [campaignId])).map(mapSlot);
  // Benefit pools are now campaign-level; a slot's "remaining" is its own capacity.
  return slots.map((slot) => ({ ...slot, remainingPoolQuantity: slot.remainingCapacity }));
}

export async function getPublicCampaign(slug: string) {
  const db = await getDb();
  const campaign = await getCampaignOrThrow(db, slug);
  const businessRow = await one(db, "SELECT * FROM businesses WHERE id = ?", [campaign.businessId]);
  // Page availability must not depend on a nonessential analytics write.
  // Client-side Link prefetch can issue concurrent reads, and a transient
  // analytics failure previously caused valid campaigns to render as 404.
  try {
    await addAnalytics(db, campaign.id, "campaign_page_view");
  } catch {
    // Best effort: never make the public campaign unavailable for telemetry.
  }
  return {
    campaign,
    business: businessRow ? mapBusiness(businessRow) : undefined,
    slots: await publicSlots(campaign.id),
    // Lets the landing page refuse a hunt it cannot finish, using the same
    // rule the draw applies, instead of spending an attempt to find out.
    availability:
      (await availabilityByCampaign(db, [campaign.id])).get(campaign.id) ??
      NO_AVAILABILITY
  };
}

export async function listCampaignSlots(slug: string) {
  const db = await getDb();
  const campaign = await getCampaignOrThrow(db, slug);
  return publicSlots(campaign.id);
}

/**
 * The prize tiers shown on the roulette reel. Public — every visitor sees the
 * labels and odds — but `viewerPhone` decides whether the ids come with them.
 */
export async function listPublicVoucherPools(slug: string, viewerPhone?: string | null) {
  const db = await getDb();
  const campaign = await getCampaignOrThrow(db, slug);
  return (
    await all(
      db,
      `SELECT * FROM pools
       WHERE campaign_id = ? AND status = 'active' AND remaining_quantity > 0
       ORDER BY probability_weight DESC, display_label ASC`,
      [campaign.id],
    )
  )
    .map(mapPool)
    .map((pool) => ({
      // The pool id is only useful to the dev tool that forces a draw to a
      // chosen tier, and publishing it alongside the weights hands an attacker
      // both halves of that override. Same gate as the override itself, so the
      // developer account gets ids in production and nobody else does.
      ...(devToolsEnabledFor(viewerPhone) ? { poolId: pool.id } : {}),
      benefitType: pool.benefitType,
      benefitValue: pool.benefitValue,
      displayLabel: pool.displayLabel,
      // The reel renders these as tickets, so it needs the badge the tier will
      // actually be won with, not one re-derived from the benefit value.
      rarity: pool.rarity,
      probabilityWeight: pool.probabilityWeight,
      remainingQuantity: pool.remainingQuantity,
    }));
}

/** Active campaigns for the public campaign switcher/tab bar. */
export async function listActiveCampaigns() {
  const db = await getDb();
  return (await all(db, "SELECT * FROM campaigns WHERE status = 'active' ORDER BY start_date DESC")).map(mapCampaign);
}

export type { CampaignAvailability, CampaignCard } from "@/types/voucher";

/**
 * Live availability for the given campaigns, keyed by campaign id.
 *
 * `bookable` deliberately repeats the predicate `generateCandidate` uses to
 * pick a tier: an active tier with stock, linked to an active upcoming slot
 * that still has capacity. Anything looser would advertise a hunt that the
 * draw then refuses. Batched by id so the directory costs one query rather
 * than one per card.
 */
async function availabilityByCampaign(db: Exec, campaignIds: string[]) {
  const availability = new Map<string, CampaignAvailability>();
  if (campaignIds.length === 0) return availability;

  const today = manilaDateString();
  const placeholders = campaignIds.map(() => "?").join(", ");
  const rows = await all(
    db,
    `SELECT c.id AS campaign_id,
            (SELECT COALESCE(SUM(s.remaining_capacity), 0) FROM slots s
              WHERE s.campaign_id = c.id AND s.status = 'active' AND s.date >= ?) AS remaining_capacity,
            (SELECT COALESCE(SUM(p.remaining_quantity), 0) FROM pools p
              WHERE p.campaign_id = c.id AND p.status = 'active') AS remaining_prizes,
            EXISTS (
              SELECT 1 FROM pools p
              JOIN pool_slots ps ON ps.pool_id = p.id
              JOIN slots s ON s.id = ps.slot_id
              WHERE p.campaign_id = c.id AND p.status = 'active' AND p.remaining_quantity > 0
                AND s.campaign_id = c.id AND s.status = 'active'
                AND s.date >= ? AND s.remaining_capacity > 0
            ) AS bookable
     FROM campaigns c
     WHERE c.id IN (${placeholders})`,
    [today, today, ...campaignIds]
  );

  for (const row of rows) {
    availability.set(String(row.campaign_id), {
      bookable: Number(row.bookable) === 1,
      remainingCapacity: Number(row.remaining_capacity),
      remainingPrizes: Number(row.remaining_prizes)
    });
  }
  return availability;
}

/** A campaign whose rows have gone missing reads as closed, never as open. */
const NO_AVAILABILITY: CampaignAvailability = {
  bookable: false,
  remainingCapacity: 0,
  remainingPrizes: 0
};

/**
 * How long a finished campaign stays in the directory after it ends. Long
 * enough that a customer who was hunting it last week finds out what happened
 * instead of watching the card disappear, short enough that the list stays a
 * directory rather than an archive.
 */
const ENDED_CARD_RETENTION_DAYS = 30;

/**
 * Campaigns joined with their business, for the public directory grid, most
 * recently started first. Three states share the list, in this order: ones a
 * customer can hunt now, ones that are merely full — their page stays reachable
 * for customers holding an unbooked voucher, and capacity comes back when a
 * booking is cancelled — and finally ones that are over, which the client shows
 * as closed rather than dropping. Paused campaigns are a business hiding a
 * campaign it intends to resume, so those stay out of the list entirely.
 */
export async function listPublicCampaignCards(): Promise<CampaignCard[]> {
  const db = await getDb();
  const today = manilaDateString();
  const rows = await all(
    db,
    `SELECT c.*, b.name AS business_name, b.logo_text AS business_logo, b.industry AS business_industry,
            b.address AS business_address, b.contact_number AS business_contact_number
     FROM campaigns c JOIN businesses b ON b.id = c.business_id
     WHERE c.status IN ('active', 'closed') AND c.end_date >= ?
     ORDER BY c.start_date DESC, c.id DESC`,
    [addCalendarDays(today, -ENDED_CARD_RETENTION_DAYS)]
  );
  const availability = await availabilityByCampaign(
    db,
    rows.map((r) => String(r.id))
  );
  return rows
    .map((r) => {
      const campaign = mapCampaign(r);
      const ended = campaign.status !== "active" || campaign.endDate < today;
      return {
        campaign,
        businessName: String(r.business_name),
        businessLogo: String(r.business_logo),
        businessIndustry: String(r.business_industry),
        businessAddress: r.business_address ? String(r.business_address) : undefined,
        businessContactNumber: r.business_contact_number
          ? String(r.business_contact_number)
          : undefined,
        // A campaign that is over cannot be hunted whatever its inventory says,
        // and the hunt endpoints agree: a closed one 404s. Saying so here keeps
        // the client from offering a call to action the server would refuse.
        availability: ended
          ? NO_AVAILABILITY
          : (availability.get(String(r.id)) ?? NO_AVAILABILITY),
        ended
      };
    })
    // Campaigns a customer cannot act on sink below the ones they can, and
    // finished ones sink below those again. Array#sort is stable, so date order
    // is preserved within each group.
    .sort(
      (a, b) =>
        Number(a.ended) - Number(b.ended) ||
        Number(b.availability.bookable) - Number(a.availability.bookable)
    );
}

export type ClaimedVoucherRecord = ClaimedVoucher;

/**
 * All issued vouchers owned by a verified phone number. Users are scoped per
 * campaign, so ownership is resolved by joining each voucher through its user.
 */
export async function listClaimedVouchersForPhone(
  phone: string,
): Promise<ClaimedVoucherRecord[]> {
  const db = await getDb();
  const rows = await all(
    db,
    `SELECT
       v.*,
       s.id AS joined_slot_id,
       s.campaign_id AS joined_slot_campaign_id,
       s.date AS joined_slot_date,
       s.start_time AS joined_slot_start_time,
       s.end_time AS joined_slot_end_time,
       s.timezone AS joined_slot_timezone,
       s.branch_id AS joined_slot_branch_id,
       s.total_capacity AS joined_slot_total_capacity,
       s.remaining_capacity AS joined_slot_remaining_capacity,
       s.status AS joined_slot_status,
       c.slug AS campaign_slug,
       c.title AS campaign_title,
       b.name AS business_name
     FROM vouchers v
     JOIN users u ON u.id = v.user_id
     JOIN slots s ON s.id = v.slot_id
     JOIN campaigns c ON c.id = v.campaign_id
     JOIN businesses b ON b.id = c.business_id
     WHERE u.phone = ?
     ORDER BY v.issued_at DESC`,
    [normalizePhone(phone)],
  );
  return rows.map((row) => ({
    voucher: mapVoucher(row),
    slot: {
      id: String(row.joined_slot_id),
      campaignId: String(row.joined_slot_campaign_id),
      date: String(row.joined_slot_date),
      startTime: String(row.joined_slot_start_time),
      endTime: String(row.joined_slot_end_time),
      timezone: String(row.joined_slot_timezone),
      branchId: row.joined_slot_branch_id
        ? String(row.joined_slot_branch_id)
        : undefined,
      totalCapacity: Number(row.joined_slot_total_capacity),
      remainingCapacity: Number(row.joined_slot_remaining_capacity),
      status: row.joined_slot_status as CampaignSlot["status"],
    },
    campaignSlug: String(row.campaign_slug),
    campaignTitle: String(row.campaign_title),
    businessName: String(row.business_name),
  }));
}

/**
 * Phone sign-in: identifies the user and returns their current hunt state. A
 * visitor who already holds a final voucher can still sign in (to view it) — the
 * one-voucher-per-campaign rule is enforced when generating candidates and at
 * final selection, not at sign-in. The returned state includes any issued voucher.
 */
export async function startHunt(input: {
  campaignSlug: string;
  phone: string;
  sessionId: string;
  name?: string;
  email?: string;
}) {
  const result = await withTx(async (tx) => {
    const campaign = await getCampaignOrThrow(tx, input.campaignSlug);
    const user = await findOrCreateUser(tx, campaign.id, input.phone, input.sessionId, input.name, input.email);
    await addAnalytics(tx, campaign.id, "hunt_started", { phone: user.phone }, user.id);
    return { campaign, user };
  });
  // Read the snapshot back through a transaction, not `getDb()` — see huntUserIn.
  return withReadTx((tx) => huntState(tx, result.campaign, result.user));
}

/**
 * Picks a benefit tier by weight.
 *
 * Uses the CSPRNG, not `Math.random()`. V8 seeds `Math.random` with xorshift128+
 * and its internal state is recoverable from a handful of consecutive outputs —
 * and every draw publishes its own output, since the response names the tier
 * that was won. With the pool weights already public on the campaign page, that
 * was enough to predict which attempt would land the top tier and to spend
 * attempts only when the prize was worth it.
 *
 * Weights are integers in practice, so the draw is done in integer space: one
 * uniform pick over the total weight, no float rounding to reason about.
 */
/** Fractional weights are supported, so the draw scales to integers rather than rounding them away. */
const WEIGHT_SCALE = 1_000_000;

function weightedPool(pools: VoucherPool[], existingLabels: Set<string>) {
  const uniqueFirst = pools.filter((pool) => !existingLabels.has(pool.displayLabel));
  const candidates = uniqueFirst.length > 0 ? uniqueFirst : pools;
  const weights = candidates.map((pool) =>
    Math.max(0, Math.round(pool.probabilityWeight * WEIGHT_SCALE)),
  );
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  if (total <= 0) return candidates[candidates.length - 1];

  // randomInt is uniform over [0, total) and drawn from the CSPRNG, so the
  // sequence of prizes carries no state an observer can recover. Integer space
  // throughout: no float rounding to bias the tail tier.
  let point = crypto.randomInt(0, total);
  for (let index = 0; index < candidates.length; index += 1) {
    point -= weights[index]!;
    if (point < 0) return candidates[index];
  }
  return candidates[candidates.length - 1];
}

export function generateCandidate(input: {
  campaignSlug: string;
  phone: string;
  sessionId: string;
  sourceType?: SourceType;
  devPoolId?: string;
}) {
  const sourceType = input.sourceType ?? "base";
  return withTx(async (tx) => {
    const campaign = await getCampaignOrThrow(tx, input.campaignSlug);
    const user = await findOrCreateUser(tx, campaign.id, input.phone, input.sessionId);
    if (await hasFinalVoucher(tx, campaign.id, user.id)) {
      throw new AppError("E-DUPLICATE-FINAL", "Final voucher already issued", 409);
    }
    await expireCandidates(tx);

    const attempts = (await all(tx, "SELECT * FROM attempts WHERE campaign_id = ? AND user_id = ?", [campaign.id, user.id])).map(
      mapAttempt
    );
    const activeAttempts = attempts.filter((a) => a.status === "Candidate" || a.status === "Held");
    if (sourceType === "base") {
      if (attempts.filter((a) => a.sourceType === "base").length >= campaign.baseAttempts) {
        throw new AppError("E-ATTEMPT-LIMIT", "Base voucher hunt attempts are already used", 409);
      }
    } else if (sourceType === "referral_bonus") {
      if ((await remainingBonusAttempts(tx, campaign, user.id)) <= 0) {
        throw new AppError("E-ATTEMPT-LIMIT", "No extra attempts earned yet. Share your link to earn one.", 409);
      }
    }

    // Candidates are drawn from campaign-wide benefit tiers; the slot is chosen
    // later (post-selection), filtered by the winning tier's availability.
    //
    // A tier with no bookable slot left is excluded rather than drawn: winning
    // one stranded the customer on an empty date picker, having already spent an
    // attempt and decremented the tier's stock, with nothing to do but wait for
    // the candidate to time out. Failing here instead surfaces it before any of
    // that is consumed.
    const pools = (
      await all(
        tx,
        `SELECT p.* FROM pools p
         WHERE p.campaign_id = ? AND p.status = 'active' AND p.remaining_quantity > 0
           AND EXISTS (
             SELECT 1 FROM pool_slots ps
             JOIN slots s ON s.id = ps.slot_id
             WHERE ps.pool_id = p.id
               AND s.campaign_id = p.campaign_id
               AND s.date >= ?
               AND s.status = 'active'
               AND s.remaining_capacity > 0
           )`,
        [campaign.id, manilaDateString()]
      )
    ).map(mapPool);
    if (pools.length === 0) throw new AppError("E-POOL-EMPTY", "No voucher benefits remain for this campaign", 409);

    if (input.devPoolId && !devToolsEnabledFor(input.phone)) {
      throw new AppError("E-DEV-OVERRIDE", "Voucher selection override is unavailable", 400);
    }
    const pool = input.devPoolId
      ? pools.find((candidate) => candidate.id === input.devPoolId)
      : weightedPool(pools, new Set(activeAttempts.map((a) => a.displayLabel)));
    if (!pool) {
      throw new AppError(
        "E-POOL-404",
        "The selected development voucher is unavailable for this campaign",
        409,
      );
    }

    // Conditional decrement: guards against over-issue across connections/processes.
    const dec = await run(
      tx,
      `UPDATE pools
       SET remaining_quantity = remaining_quantity - 1,
           status = CASE WHEN remaining_quantity - 1 <= 0 THEN 'depleted' ELSE status END
       WHERE id = ? AND remaining_quantity > 0`,
      [pool.id]
    );
    if (dec !== 1) throw new AppError("E-POOL-EMPTY", "No voucher benefits remain for this campaign", 409);

    const expires = now();
    expires.setMinutes(expires.getMinutes() + campaign.candidateTimeoutMinutes);
    const attempt: VoucherAttempt = {
      id: id("att"),
      campaignId: campaign.id,
      userId: user.id,
      attemptNumber: attempts.length + 1,
      sourceType,
      benefitType: pool.benefitType,
      benefitValue: pool.benefitValue,
      displayLabel: pool.displayLabel,
      rarity: pool.rarity,
      poolId: pool.id,
      status: "Candidate",
      expiresAt: expires.toISOString(),
      createdAt: isoNow()
    };
    await run(
      tx,
      `INSERT INTO attempts (id, campaign_id, slot_id, user_id, attempt_number, source_type, benefit_type, benefit_value, display_label, rarity, pool_id, status, expires_at, created_at)
       VALUES (@id, @campaignId, @slotId, @userId, @attemptNumber, @sourceType, @benefitType, @benefitValue, @displayLabel, @rarity, @poolId, @status, @expiresAt, @createdAt)`,
      { ...attempt, slotId: null }
    );
    await addAnalytics(tx, campaign.id, "voucher_candidate_generated", { benefit: attempt.displayLabel }, user.id);
    return attempt;
  });
}

/**
 * Lists the date/time slots at which the chosen candidate's benefit tier can be
 * redeemed, per pool_slots. Availability is independent of rarity — the draw is
 * campaign-wide and weighted only by probability_weight, so a tier's slot count
 * decides when it can be booked, never how often it is won.
 * Called after the user picks 1 of their candidates, before final confirmation.
 */
/**
 * The hunt user for a campaign, read through a transaction.
 *
 * The transaction is not for atomicity — this is a single statement. It is
 * because the plain read is not reliable against the deployed libSQL. Measured
 * in production on 2026-08-18: `SELECT * FROM users WHERE campaign_id = ? AND
 * phone = ?` returned no row through `getDb()` for every dashboard-created
 * campaign (dog-mania, pet-pamper-palooza, and a fresh one made minutes
 * earlier), while the identical statement with the same arguments returned the
 * row every time from inside a transaction — `findOrCreateUser` found it on
 * three consecutive calls. The three seeded campaigns were unaffected, and two
 * different phone numbers behaved the same, so it tracks the campaign rather
 * than the caller.
 *
 * The rows were demonstrably present: `PRAGMA integrity_check` returned ok,
 * there were no duplicate slugs, and `campaign_id`/`phone` matched byte for
 * byte with no stray whitespace. The customer-visible effect was that anyone on
 * a real campaign could draw a voucher and then never book it, because every
 * read path to this row 404'd.
 *
 * So the write path's view is the one to trust for identity. Only this lookup is
 * routed that way; the rows it guards (attempts, slots) are still read plainly,
 * since a stale read there degrades gracefully and this one does not.
 *
 * This treats a symptom — the root cause is below the application and is still
 * open with Turso. Remove it once a plain read of `users` is trustworthy.
 */
/**
 * A customer's hunt rows are read inside a read transaction, never through `getDb()`.
 *
 * The transaction is not for atomicity. It is because plain reads are not
 * reliable against the deployed libSQL, measured in production on 2026-08-18:
 *
 *  - `SELECT * FROM users WHERE campaign_id = ? AND phone = ?` returned no row
 *    through `getDb()` for every dashboard-created campaign, while the identical
 *    statement with the same arguments returned the row every time from inside a
 *    transaction. The three seeded campaigns were unaffected and two different
 *    phone numbers behaved the same, so it tracked the campaign, not the caller.
 *  - `attempts` then showed the same fault, and worse: two plain reads of that
 *    one table disagreed with each other in the same second. `huntState` listed
 *    an attempt that `listSlotsForAttempt` 404'd on, and found none of an
 *    attempt the write had just returned and that `listSlotsForAttempt` could
 *    read back perfectly.
 *
 * The rows were demonstrably present — `PRAGMA integrity_check` ok, no duplicate
 * slugs, byte-exact `campaign_id` and `phone`.
 *
 * Confirmed again on 2026-08-19 with only the identity read made transactional:
 * the user resolved correctly while `GET /hunt/state` returned `attempts: []`
 * for a live `Candidate` that the admin export read back from the same
 * deployment minutes later. Half of this is not enough — every read behind the
 * decision has to share the write path's view.
 *
 * Both faults are customer-visible and neither degrades gracefully. A stale
 * `users` read means a voucher can be won and never booked. A stale `attempts`
 * read means a drawn candidate vanishes: the campaign offers a fresh hunt for a
 * voucher already held, and the results screen shows nothing at all. So
 * `huntState` takes its whole snapshot from one transaction, and its parts
 * cannot disagree with each other either.
 *
 * A *read* transaction, deliberately. The first attempt at this used `withTx`,
 * whose write lock on a path this hot took production down inside a minute —
 * concurrent requests queued on the lock and failed at ~2s each. A read
 * transaction gives the same consistent snapshot and contends with nothing.
 *
 * This treats a symptom — the cause is below the application and is still open
 * with Turso. Remove it once a plain read of these tables is trustworthy.
 */
async function huntUserIn(db: Exec, campaignId: string, phone: string): Promise<EndUser> {
  const normalized = normalizePhone(phone);
  const userRow = normalized
    ? await one(db, "SELECT * FROM users WHERE campaign_id = ? AND phone = ?", [campaignId, normalized])
    : undefined;
  if (!userRow) throw new AppError("E-USER-404", "No hunt session found for this phone number", 404);
  return mapUser(userRow);
}

export async function listSlotsForAttempt(input: { campaignSlug: string; phone: string; attemptId: string }) {
  const db = await getDb();
  const campaign = await getCampaignOrThrow(db, input.campaignSlug);
  // One transaction for the identity, the attempt and its slots — see huntUserIn.
  return withReadTx(async (tx) => {
    const user = await huntUserIn(tx, campaign.id, input.phone);
    const attemptRow = await one(tx, "SELECT * FROM attempts WHERE id = ? AND campaign_id = ? AND user_id = ?", [
      input.attemptId,
      campaign.id,
      user.id
    ]);
    if (!attemptRow) throw new AppError("E-ATTEMPT-404", "Selected candidate was not found", 404);
    const attempt = mapAttempt(attemptRow);
    const slots = (
      await all(
        tx,
        `SELECT s.* FROM slots s
         JOIN pool_slots ps ON ps.slot_id = s.id
         WHERE ps.pool_id = ? AND s.campaign_id = ? AND s.date >= ?
         ORDER BY s.date, s.start_time`,
        [attempt.poolId, campaign.id, manilaDateString()]
      )
    ).map(mapSlot);
    return {
      attempt,
      slots: slots.map((slot) => ({ ...slot, remainingPoolQuantity: slot.remainingCapacity }))
    };
  });
}

export function selectFinalVoucher(input: {
  campaignSlug: string;
  attemptId: string;
  slotId: string;
  phone: string;
  sessionId: string;
  name: string;
  email?: string;
  guestCount?: number;
}) {
  return withTx(async (tx) => {
    const campaign = await getCampaignOrThrow(tx, input.campaignSlug);
    const user = await findOrCreateUser(tx, campaign.id, input.phone, input.sessionId, input.name, input.email);
    if (await hasFinalVoucher(tx, campaign.id, user.id)) {
      throw new AppError("E-DUPLICATE-FINAL", "This phone number already has a final voucher for this campaign", 409);
    }
    await expireCandidates(tx);

    const attemptRow = await one(tx, "SELECT * FROM attempts WHERE id = ? AND campaign_id = ? AND user_id = ?", [
      input.attemptId,
      campaign.id,
      user.id
    ]);
    if (!attemptRow) throw new AppError("E-ATTEMPT-404", "Selected candidate was not found", 404);
    const attempt = mapAttempt(attemptRow);
    if (attempt.status !== "Candidate" && attempt.status !== "Held") {
      throw new AppError("E-ATTEMPT-STATE", "Selected candidate is no longer available", 409);
    }
    if (new Date(attempt.expiresAt).getTime() < Date.now()) {
      await releaseAttempt(tx, attempt);
      throw new AppError("E-ATTEMPT-EXPIRED", "Selected candidate has expired", 409);
    }

    const slot = await getSlotOrThrow(tx, input.slotId, campaign.id);
    // The chosen slot must offer this benefit tier (rarity-gated availability).
    const offered = await one(tx, "SELECT 1 FROM pool_slots WHERE pool_id = ? AND slot_id = ?", [attempt.poolId, slot.id]);
    if (!offered) {
      throw new AppError("E-SLOT-TIER", "This voucher is not available at the selected date and time", 409);
    }

    // Conditional capacity decrement guards the slot against over-booking.
    const cap = await run(
      tx,
      `UPDATE slots
       SET remaining_capacity = remaining_capacity - 1,
           status = CASE WHEN remaining_capacity - 1 <= 0 THEN 'sold_out' ELSE status END
       WHERE id = ? AND remaining_capacity > 0`,
      [slot.id]
    );
    if (cap !== 1) throw new AppError("E-SLOT-SOLD-OUT", "Selected slot is sold out", 409);

    const voucher = {
      id: id("vch"),
      campaignId: campaign.id,
      slotId: slot.id,
      userId: user.id,
      selectedAttemptId: attempt.id,
      voucherCode: generateVoucherCode("BIZ"),
      qrToken: generateQrToken(),
      benefitType: attempt.benefitType,
      benefitValue: attempt.benefitValue,
      displayLabel: attempt.displayLabel,
      rarity: attempt.rarity,
      status: "Issued" as const,
      issuedAt: isoNow(),
      expiresAt: expiryFor(slot),
      redeemedAt: null as string | null
    };
    try {
      await run(
        tx,
        `INSERT INTO vouchers (id, campaign_id, slot_id, user_id, selected_attempt_id, voucher_code, qr_token, benefit_type, benefit_value, display_label, rarity, status, issued_at, expires_at, redeemed_at)
         VALUES (@id, @campaignId, @slotId, @userId, @selectedAttemptId, @voucherCode, @qrToken, @benefitType, @benefitValue, @displayLabel, @rarity, @status, @issuedAt, @expiresAt, @redeemedAt)`,
        voucher
      );
    } catch (error) {
      // UNIQUE(campaign_id, user_id) is the authoritative one-final-voucher guard under concurrency.
      if (isUniqueViolation(error)) {
        throw new AppError("E-DUPLICATE-FINAL", "This phone number already has a final voucher for this campaign", 409);
      }
      throw error;
    }

    await run(tx, "UPDATE attempts SET status = 'Selected' WHERE id = ?", [attempt.id]);
    // Release every other candidate for this user back to the pool.
    const others = (
      await all(tx, "SELECT * FROM attempts WHERE campaign_id = ? AND user_id = ? AND id != ?", [campaign.id, user.id, attempt.id])
    ).map(mapAttempt);
    for (const other of others) await releaseAttempt(tx, other);

    if (campaign.mode === "restaurant") {
      await run(
        tx,
        `INSERT INTO reservations (id, campaign_id, slot_id, user_id, voucher_id, guest_count, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'Reserved', ?)`,
        [id("res"), campaign.id, slot.id, user.id, voucher.id, input.guestCount ?? null, isoNow()]
      );
    }

    await addAnalytics(tx, campaign.id, "voucher_final_selected", { voucherCode: voucher.voucherCode }, user.id, slot.id);
    await addAnalytics(tx, campaign.id, "voucher_issued", { benefit: voucher.displayLabel }, user.id, slot.id);

    const freshSlot = mapSlot(await one(tx, "SELECT * FROM slots WHERE id = ?", [slot.id]));
    const freshVoucher = mapVoucher(await one(tx, "SELECT * FROM vouchers WHERE id = ?", [voucher.id]));
    return { voucher: freshVoucher, slot: freshSlot, campaign, user };
  });
}

/**
 * Sends the actual SMS confirmation for a just-issued voucher. Kept outside
 * selectFinalVoucher's transaction so a slow/failed provider network call never
 * holds a write transaction open or rolls back the (already committed) issuance;
 * the outcome is recorded in sms_logs instead.
 */
export async function sendVoucherConfirmationSms(voucherId: string): Promise<SmsResult> {
  const db = await getDb();
  const voucherRow = await one(db, "SELECT * FROM vouchers WHERE id = ?", [voucherId]);
  if (!voucherRow) throw new AppError("E-VOUCHER-404", "Voucher was not found", 404);
  const voucher = mapVoucher(voucherRow);
  const context = await loadSmsContext(db, voucher);
  const message = smsBody(context.business, context.campaign, voucher, context.slot);
  return dispatchSms(db, {
    campaignId: context.campaign.id,
    userId: context.user.id,
    voucherId: voucher.id,
    slotId: context.slot.id,
    phone: context.user.phone,
    message
  });
}

/**
 * Re-sends the SMS confirmation for an existing voucher.
 *
 * `phone` is required and must own the voucher. Without it this was an
 * unauthenticated send-an-SMS-to-a-stranger endpoint: anyone who guessed or
 * enumerated a code could bill us for a message and text its owner on repeat,
 * and the 404-vs-200 difference confirmed which guesses were real codes.
 * Ownership is checked against the voucher's own user row, so a valid code for
 * someone else's voucher resolves to the same "not found" a bad code gets.
 */
export async function resendVoucherSms(input: {
  codeOrToken: string;
  phone: string;
}): Promise<SmsResult & { voucherCode: string; to: string }> {
  const db = await getDb();
  const normalized = normalizePhone(input.phone);
  if (!normalized) {
    throw new AppError("E-USER-PHONE", "A valid Philippine mobile number is required", 400);
  }
  const voucher = await loadVoucherContext(db, input.codeOrToken);
  const context = await loadSmsContext(db, voucher);
  if (context.user.phone !== normalized) {
    // Deliberately the same error a missing code gets: whether a code exists is
    // exactly what an enumerating caller is trying to learn.
    throw new AppError("E-VOUCHER-404", "Voucher was not found", 404);
  }
  const message = smsBody(context.business, context.campaign, voucher, context.slot);
  const result = await dispatchSms(db, {
    campaignId: context.campaign.id,
    userId: context.user.id,
    voucherId: voucher.id,
    slotId: context.slot.id,
    phone: context.user.phone,
    message
  });
  return { ...result, voucherCode: voucher.voucherCode, to: context.user.phone };
}

async function loadSmsContext(db: Exec, voucher: Voucher) {
  const userRow = await one(db, "SELECT * FROM users WHERE id = ?", [voucher.userId]);
  const slotRow = await one(db, "SELECT * FROM slots WHERE id = ?", [voucher.slotId]);
  const campaignRow = await one(db, "SELECT * FROM campaigns WHERE id = ?", [voucher.campaignId]);
  if (!userRow || !slotRow || !campaignRow) {
    throw new AppError("E-VOUCHER-404", "Voucher context is incomplete", 404);
  }
  const campaign = mapCampaign(campaignRow);
  const businessRow = await one(db, "SELECT * FROM businesses WHERE id = ?", [campaign.businessId]);
  return {
    user: mapUser(userRow),
    slot: mapSlot(slotRow),
    campaign,
    business: businessRow ? mapBusiness(businessRow) : undefined
  };
}

/** Sends via the configured SMS provider and records the attempt in sms_logs. */
async function dispatchSms(
  db: Exec,
  params: { campaignId: string; userId: string; voucherId: string; slotId: string; phone: string; message: string }
): Promise<SmsResult> {
  const provider = process.env.SMS_PROVIDER ?? "mock";
  const smsLogId = id("sms");
  await run(
    db,
    `INSERT INTO sms_logs (id, campaign_id, user_id, voucher_id, to_number, body, provider, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
    [smsLogId, params.campaignId, params.userId, params.voucherId, params.phone, params.message, provider, isoNow()]
  );

  const result = await sendSms(params.phone, params.message);

  await run(db, `UPDATE sms_logs SET status = ?, provider_message_id = ?, failure_reason = ? WHERE id = ?`, [
    result.success ? "sent" : "failed",
    result.providerMessageId ?? null,
    result.error ?? null,
    smsLogId
  ]);

  if (result.success) {
    await addAnalytics(db, params.campaignId, "sms_sent", { provider }, params.userId, params.slotId);
  }

  return result;
}

// Kept deliberately compact so a typical confirmation fits one SMS part (≤160
// GSM chars) instead of several — full terms and the human-readable expiry time
// live on the confirmation page. Long shop URLs may still spill to a second part.
function smsBody(
  business: { name: string } | undefined,
  campaign: Campaign,
  voucher: { voucherCode: string; displayLabel: string; expiresAt: string },
  slot: CampaignSlot
) {
  const name = business?.name ?? "Voucher Hunt";
  const window = `${slot.date}, ${slot.startTime}-${slot.endTime}`;
  const validUntil = voucher.expiresAt.slice(0, 10); // date only (YYYY-MM-DD)
  const isRestaurant = campaign.mode === "restaurant";
  // Colon label so the date/time reads as a labelled slot, not a run-on verb.
  const windowLabel = isRestaurant ? `Visit: ${window}` : `Use: ${window}`;
  const action = isRestaurant
    ? "Show this SMS on arrival"
    : campaign.shopUrl
      ? `Shop: ${campaign.shopUrl}`
      : "Apply code at checkout";
  return `[${name}] Voucher confirmed! ${voucher.voucherCode} - ${voucher.displayLabel}. ${windowLabel}. ${action}. Valid til ${validUntil}.`;
}

async function releaseAttempt(db: Exec, attempt: VoucherAttempt) {
  if (attempt.status === "Candidate" || attempt.status === "Held") {
    await run(
      db,
      `UPDATE pools
       SET remaining_quantity = remaining_quantity + 1,
           status = CASE WHEN status = 'depleted' THEN 'active' ELSE status END
       WHERE id = ?`,
      [attempt.poolId]
    );
    await run(db, "UPDATE attempts SET status = 'Released' WHERE id = ?", [attempt.id]);
  }
}

/** Expire timed-out candidates and return their held stock. Runs inside a caller transaction. */
async function expireCandidates(db: Exec) {
  const stale = (await all(db, "SELECT * FROM attempts WHERE status IN ('Candidate', 'Held') AND expires_at < ?", [isoNow()])).map(
    mapAttempt
  );
  for (const attempt of stale) {
    await run(
      db,
      `UPDATE pools
       SET remaining_quantity = remaining_quantity + 1,
           status = CASE WHEN status = 'depleted' THEN 'active' ELSE status END
       WHERE id = ?`,
      [attempt.poolId]
    );
    await run(db, "UPDATE attempts SET status = 'Expired' WHERE id = ?", [attempt.id]);
  }
  return stale.length > 0;
}

export function expireOldCandidates() {
  return withTx((tx) => expireCandidates(tx));
}

async function loadVoucherContext(db: Exec, codeOrToken: string) {
  const upper = codeOrToken.trim().toUpperCase();
  const row = await one(db, "SELECT * FROM vouchers WHERE UPPER(voucher_code) = ? OR UPPER(qr_token) = ?", [upper, upper]);
  if (!row) throw new AppError("E-VOUCHER-404", "Voucher was not found", 404);
  return mapVoucher(row);
}

/**
 * The minimum spend the tier this voucher came from carries, if any.
 *
 * Held on the pool rather than the voucher, so it is reached through the
 * attempt that was selected. Returns undefined when the tier sets no minimum —
 * which is not the same as a minimum of 0 and must not collapse into it.
 */
async function minimumSpendFor(db: Exec, voucher: { selectedAttemptId: string }) {
  const row = await one(
    db,
    `SELECT p.minimum_spend AS minimum_spend
     FROM attempts a JOIN pools p ON p.id = a.pool_id
     WHERE a.id = ?`,
    [voucher.selectedAttemptId]
  );
  const value = row?.minimum_spend;
  return value === null || value === undefined ? undefined : Number(value);
}

/**
 * Whether the slot has not opened yet, judged in the slot's own timezone.
 *
 * Slots store a plain date and wall-clock times with the zone beside them
 * (`2026-08-14`, `19:00`, `Asia/Manila`), so this compares wall time rather than
 * building an instant: formatting `now` into the slot's zone and comparing the
 * strings needs no offset arithmetic and stays right across a DST boundary,
 * which Manila does not observe but another zone a campaign uses might.
 *
 * `h23` rather than `hour12: false` because that pair reports midnight as `24`
 * on some ICU builds, which would sort a midnight slot after every other time.
 */
export function slotNotStartedYet(
  slot: { date: string; startTime: string; timezone: string },
  now = new Date(),
) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: slot.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  const nowStamp = `${value("year")}-${value("month")}-${value("day")}T${value("hour")}:${value("minute")}`;
  // Both sides are zero-padded to the same shape, so lexical order is chronological.
  return nowStamp < `${slot.date}T${slot.startTime}`;
}

export function validateVoucher(input: { codeOrToken: string }) {
  return withTx(async (tx) => {
    const voucher = await loadVoucherContext(tx, input.codeOrToken);
    if (new Date(voucher.expiresAt).getTime() < Date.now() && voucher.status !== "Redeemed") {
      await run(tx, "UPDATE vouchers SET status = 'Expired' WHERE id = ?", [voucher.id]);
      voucher.status = "Expired";
    }
    const userRow = await one(tx, "SELECT * FROM users WHERE id = ?", [voucher.userId]);
    const slotRow = await one(tx, "SELECT * FROM slots WHERE id = ?", [voucher.slotId]);
    const campaignRow = await one(tx, "SELECT * FROM campaigns WHERE id = ?", [voucher.campaignId]);
    const campaign = campaignRow ? mapCampaign(campaignRow) : undefined;
    const businessRow = campaign ? await one(tx, "SELECT * FROM businesses WHERE id = ?", [campaign.businessId]) : undefined;
    const slot = slotRow ? mapSlot(slotRow) : undefined;
    return {
      voucher,
      user: userRow ? mapUser(userRow) : undefined,
      slot,
      campaign,
      business: businessRow ? mapBusiness(businessRow) : undefined,
      // A voucher scanned before its slot opens is still perfectly valid, so
      // this does not gate redemption — the checkout decides whether to serve an
      // early arrival. It exists so staff are told, rather than reading an
      // unremarkable "Valid & Confirmed" and only later noticing the date.
      slotNotStarted: slot ? slotNotStartedYet(slot) : false,
      // Surfaced so the checkout sees the condition before serving, not after.
      minimumSpend: await minimumSpendFor(tx, voucher)
    };
  });
}

export async function redeemVoucher(input: { codeOrToken: string; staffName: string; purchaseAmount?: number; note?: string }) {
  let earner: { phone: string; businessId: string; voucherId: string } | undefined;
  await withTx(async (tx) => {
    const voucher = await loadVoucherContext(tx, input.codeOrToken);
    if (voucher.status === "Redeemed") throw new AppError("E-VOUCHER-REDEEMED", "Voucher is already redeemed", 409);
    if (new Date(voucher.expiresAt).getTime() < Date.now()) throw new AppError("E-VOUCHER-EXPIRED", "Voucher is expired", 409);

    // A tier's minimum spend is the condition it was priced on — a 90%-off
    // voucher only survives contact with a ₱1,500 bill. Checked only when the
    // checkout actually entered an amount: with none supplied the server has nothing
    // to judge, and refusing there would block every redemption that skips the
    // optional field.
    const minimumSpend = await minimumSpendFor(tx, voucher);
    if (minimumSpend !== undefined && input.purchaseAmount !== undefined && input.purchaseAmount < minimumSpend) {
      throw new AppError(
        "E-VOUCHER-MIN-SPEND",
        `This voucher needs a minimum spend of ${minimumSpend}. The amount entered was ${input.purchaseAmount}.`,
        409
      );
    }
    // Conditional on the status we just read, so two checkouts scanning the same
    // code settle to one redemption rather than both passing the check above and
    // both writing. The read-then-write it replaces only held because SQLite
    // serialises write transactions — correctness should not rest on that.
    const claimed = await run(
      tx,
      "UPDATE vouchers SET status = 'Redeemed', redeemed_at = ? WHERE id = ? AND status <> 'Redeemed'",
      [isoNow(), voucher.id],
    );
    if (claimed !== 1) {
      throw new AppError("E-VOUCHER-REDEEMED", "Voucher is already redeemed", 409);
    }
    await run(tx, "UPDATE reservations SET status = 'Redeemed' WHERE voucher_id = ?", [voucher.id]);
    await run(
      tx,
      `INSERT INTO redemption_logs (id, voucher_id, staff_name, purchase_amount, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [id("red"), voucher.id, input.staffName, input.purchaseAmount ?? null, input.note ?? null, isoNow()]
    );
    await addAnalytics(tx, voucher.campaignId, "voucher_redeemed", { purchaseAmount: input.purchaseAmount }, voucher.userId, voucher.slotId);

    if (input.purchaseAmount && input.purchaseAmount > 0) {
      const row = await one(
        tx,
        `SELECT u.phone AS phone, c.business_id AS business_id
         FROM vouchers v JOIN users u ON u.id = v.user_id JOIN campaigns c ON c.id = v.campaign_id
         WHERE v.id = ?`,
        [voucher.id]
      );
      if (row) {
        earner = {
          phone: String(row.phone),
          businessId: String(row.business_id),
          voucherId: voucher.id
        };
      }
    }
  });

  // Loyalty Points are awarded after the redemption commits, and never inside
  // it. Awarding can legitimately fail — the partner's deposit may be used up,
  // or the sale too small to earn a point — and none of that is a reason to
  // refuse a voucher the customer has already been served against.
  let loyalty: { awarded: boolean; amount?: string; balance?: string; reason?: string } | undefined;
  if (earner) {
    try {
      const credited = await awardLoyaltyPointsForRedemption({
        phone: earner.phone,
        businessId: earner.businessId,
        purchaseAmount: input.purchaseAmount as number,
        staffName: input.staffName,
        voucherId: earner.voucherId
      });
      loyalty = credited.heldForReview
        ? { awarded: false, reason: "Held for fraud review" }
        : { awarded: true, amount: credited.rewardAmount, balance: credited.balance };
    } catch (error) {
      loyalty = {
        awarded: false,
        reason: error instanceof AppError ? error.message : "Loyalty Points could not be awarded"
      };
    }
  }

  return { ...(await validateVoucher({ codeOrToken: input.codeOrToken })), loyalty };
}

async function huntState(db: Exec, campaign: Campaign, user: EndUser) {
  const attempts = (await all(db, "SELECT * FROM attempts WHERE campaign_id = ? AND user_id = ?", [campaign.id, user.id])).map(
    mapAttempt
  );
  const voucherRow = await one(db, "SELECT * FROM vouchers WHERE campaign_id = ? AND user_id = ?", [campaign.id, user.id]);
  const voucher = voucherRow ? mapVoucher(voucherRow) : undefined;
  // Sent alongside the voucher so a client resuming the campaign can show the
  // booking it made. Reading it back out of the campaign's slot list is one
  // lookup that can miss — and a customer who cannot see the reservation they
  // already hold has, as far as they can tell, lost it.
  const bookedSlotRow = voucher ? await one(db, "SELECT * FROM slots WHERE id = ?", [voucher.slotId]) : null;
  return {
    user,
    campaign,
    attempts,
    voucher,
    voucherSlot: bookedSlotRow ? mapSlot(bookedSlotRow) : undefined,
    remainingBaseAttempts: Math.max(0, campaign.baseAttempts - attempts.filter((a) => a.sourceType === "base").length),
    remainingBonusAttempts: await remainingBonusAttempts(db, campaign, user.id),
    sharesGrantedToday: await countGrantedRewardsToday(db, campaign.id, user.id)
  };
}

/**
 * Read-only hunt/referral snapshot for an already signed-in user. Used by the
 * client to refresh candidates and earned-share counts without re-triggering
 * hunt_started analytics.
 */
export async function getHuntSnapshot(input: { campaignSlug: string; phone: string }) {
  const db = await getDb();
  const campaign = await getCampaignOrThrow(db, input.campaignSlug);
  // Identity and snapshot share one transaction so they cannot disagree — the
  // fault this guards against had two plain reads of `attempts` contradicting
  // each other in the same second. See huntUserIn.
  return withReadTx(async (tx) => {
    const user = await huntUserIn(tx, campaign.id, input.phone);
    return huntState(tx, campaign, user);
  });
}

/**
 * One campaign's share of a hunt reset. Runs inside the caller's transaction so
 * a reset spanning several campaigns is still all-or-nothing.
 *
 * Returns the stock it reclaimed to the pools/slots, which is the whole point —
 * deleting the rows alone would leak inventory:
 *  - attempts still holding stock (Candidate/Held/Selected) return it to their pool
 *  - each deleted voucher returns its seat to the slot (and un-sells-out the slot)
 * The user row itself is kept, so the visitor stays signed in.
 */
async function resetCampaignHunt(tx: Transaction | Client, user: EndUser) {
  const campaignId = user.campaignId;

  // Return pool stock held by any attempt that never made it back on its own.
  const attempts = (
    await all(tx, "SELECT * FROM attempts WHERE campaign_id = ? AND user_id = ?", [campaignId, user.id])
  ).map(mapAttempt);
  let poolsRestored = 0;
  for (const attempt of attempts) {
    if (attempt.status === "Candidate" || attempt.status === "Held" || attempt.status === "Selected") {
      await run(
        tx,
        `UPDATE pools
         SET remaining_quantity = remaining_quantity + 1,
             status = CASE WHEN status = 'depleted' THEN 'active' ELSE status END
         WHERE id = ?`,
        [attempt.poolId]
      );
      poolsRestored += 1;
    }
  }

  // Return each issued voucher's seat to its slot.
  const vouchers = (
    await all(tx, "SELECT * FROM vouchers WHERE campaign_id = ? AND user_id = ?", [campaignId, user.id])
  ).map(mapVoucher);
  for (const voucher of vouchers) {
    await run(
      tx,
      `UPDATE slots
       SET remaining_capacity = remaining_capacity + 1,
           status = CASE WHEN status = 'sold_out' THEN 'available' ELSE status END
       WHERE id = ?`,
      [voucher.slotId]
    );
  }

  await run(tx, "DELETE FROM reservations WHERE campaign_id = ? AND user_id = ?", [campaignId, user.id]);
  await run(tx, "DELETE FROM vouchers WHERE campaign_id = ? AND user_id = ?", [campaignId, user.id]);
  const attemptsCleared = await run(
    tx,
    "DELETE FROM attempts WHERE campaign_id = ? AND user_id = ?",
    [campaignId, user.id],
  );
  // A development reset represents a clean campaign run, including the bonus
  // spins earned during the run being cleared.
  await run(
    tx,
    "DELETE FROM referral_rewards WHERE campaign_id = ? AND referrer_user_id = ?",
    [campaignId, user.id],
  );

  const remainingAttempts = Number(
    (
      await one(
        tx,
        "SELECT COUNT(*) AS c FROM attempts WHERE campaign_id = ? AND user_id = ?",
        [campaignId, user.id],
      )
    )?.c ?? 0,
  );
  if (remainingAttempts !== 0) {
    throw new AppError(
      "E-RESET-INCOMPLETE",
      "Voucher hunt attempts could not be cleared",
      500,
    );
  }

  return { attemptsCleared, vouchersCleared: vouchers.length, poolsRestored };
}

/**
 * Development-only: wipe one phone number's hunt so it can be run again from
 * scratch.
 *
 * Every campaign the number has hunted is reset, not just the one whose page
 * the dev tools happen to be open on. A tester who has spun on two campaigns
 * wants "reset" to mean the demo is back at the start, and resetting them one
 * page at a time left half-finished hunts behind that then read as bugs. The
 * `users` table is keyed per campaign, so this is one row per campaign hunted.
 *
 * All of it runs in a single transaction: a reset that cleared two campaigns
 * and failed on the third would leave inventory in a state no page reflects.
 *
 * Refused in production except for the developer account, which may only ever
 * reset itself: the phone is the session's, and every row touched below is
 * keyed by it. The calling route checks the same gate.
 */
export async function resetHuntForPhone(input: { phone: string }) {
  assertDevToolsEnabledFor(input.phone, "Hunt reset");
  return withTx(async (tx) => {
    const normalized = normalizePhone(input.phone);
    const userRows = normalized
      ? await all(tx, "SELECT * FROM users WHERE phone = ? ORDER BY campaign_id", [normalized])
      : [];
    if (userRows.length === 0) {
      throw new AppError("E-USER-404", "No hunt session found for this phone number", 404);
    }

    const totals = { attemptsCleared: 0, vouchersCleared: 0, poolsRestored: 0 };
    for (const userRow of userRows) {
      const cleared = await resetCampaignHunt(tx, mapUser(userRow));
      totals.attemptsCleared += cleared.attemptsCleared;
      totals.vouchersCleared += cleared.vouchersCleared;
      totals.poolsRestored += cleared.poolsRestored;
    }

    return { campaignsReset: userRows.length, ...totals };
  });
}

const METRIC_EVENTS = ["campaign_page_view", "hunt_started", "voucher_candidate_generated"] as const;

/**
 * Every dashboard page that is scoped to a campaign renders from this, so it is
 * on the critical path of most navigations.
 *
 * The rollups run as one batch rather than one statement each: against remote
 * libSQL each statement is a network round trip, and this used to pay nine of
 * them in sequence. The counting is left to SQL for the same reason the reads
 * are batched — loading every voucher and attempt row only to `.filter()` them
 * in JS made the response grow with the campaign's whole history.
 */
export async function dashboardMetrics(campaignId: string) {
  const db = await getDb();
  const campaign = await getCampaignOrThrow(db, campaignId);
  const [slotRows, voucherRollup, attemptRollup, benefitRollup, eventRollup, noShowRows] =
    await batchAll(db, [
      { sql: "SELECT * FROM slots WHERE campaign_id = ?", args: [campaign.id] },
      {
        sql: `SELECT slot_id,
                     COUNT(*) AS issued,
                     SUM(CASE WHEN status = 'Redeemed' THEN 1 ELSE 0 END) AS redeemed
              FROM vouchers WHERE campaign_id = ? GROUP BY slot_id`,
        args: [campaign.id],
      },
      {
        sql: "SELECT slot_id, COUNT(*) AS attempts FROM attempts WHERE campaign_id = ? GROUP BY slot_id",
        args: [campaign.id],
      },
      {
        // MIN(rowid) preserves the order benefits were first drawn in, which is
        // the order this list has always rendered in.
        sql: `SELECT display_label,
                     COUNT(*) AS generated,
                     SUM(CASE WHEN status = 'Selected' THEN 1 ELSE 0 END) AS selected
              FROM attempts WHERE campaign_id = ?
              GROUP BY display_label ORDER BY MIN(rowid)`,
        args: [campaign.id],
      },
      {
        sql: `SELECT event_name, COUNT(*) AS c FROM analytics_events
              WHERE campaign_id = ? AND event_name IN (?, ?, ?) GROUP BY event_name`,
        args: [campaign.id, ...METRIC_EVENTS],
      },
      {
        sql: "SELECT COUNT(*) AS c FROM reservations WHERE campaign_id = ? AND status = 'No-show'",
        args: [campaign.id],
      },
    ]);

  // Benefit pools are campaign-level; a slot's "remaining" is its own capacity.
  const slots = slotRows
    .map(mapSlot)
    .map((slot) => ({ ...slot, remainingPoolQuantity: slot.remainingCapacity }));

  const vouchersBySlot = new Map(
    voucherRollup.map((row) => [
      row.slot_id as string,
      { issued: Number(row.issued), redeemed: Number(row.redeemed ?? 0) },
    ]),
  );
  const attemptsBySlot = new Map(
    attemptRollup.map((row) => [row.slot_id as string | null, Number(row.attempts)]),
  );
  const eventCounts = new Map(
    eventRollup.map((row) => [row.event_name as string, Number(row.c)]),
  );

  const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
  const finalVouchersIssued = sum([...vouchersBySlot.values()].map((entry) => entry.issued));
  const redemptions = sum([...vouchersBySlot.values()].map((entry) => entry.redeemed));

  return {
    campaign,
    summary: {
      visits: eventCounts.get("campaign_page_view") ?? 0,
      hunts: eventCounts.get("hunt_started") ?? 0,
      attemptsUsed: sum([...attemptsBySlot.values()]),
      candidatesGenerated: eventCounts.get("voucher_candidate_generated") ?? 0,
      finalVouchersIssued,
      redemptions,
      noShows: Number(noShowRows[0]?.c ?? 0)
    },
    slotPerformance: slots.map((slot) => ({
      slot,
      issued: vouchersBySlot.get(slot.id)?.issued ?? 0,
      attempts: attemptsBySlot.get(slot.id) ?? 0,
      redeemed: vouchersBySlot.get(slot.id)?.redeemed ?? 0
    })),
    benefitPerformance: benefitRollup.map((row) => ({
      label: String(row.display_label),
      generated: Number(row.generated),
      selected: Number(row.selected ?? 0)
    }))
  };
}

function csvRow(values: unknown[]) {
  return values.map((value) => `"${String(value ?? "").replaceAll('"', '""')}"`).join(",");
}

function csvSection(title: string, headers: string[], rows: unknown[][]) {
  return [`# ${title}`, csvRow(headers), ...rows.map(csvRow)].join("\n");
}

export async function exportCampaignCsv(campaignId: string) {
  const db = await getDb();
  const campaign = await getCampaignOrThrow(db, campaignId);

  const users = (await all(db, "SELECT * FROM users WHERE campaign_id = ?", [campaign.id])).map(mapUser);
  const usersById = new Map(users.map((user) => [user.id, user]));
  const slots = (await all(db, "SELECT * FROM slots WHERE campaign_id = ?", [campaign.id])).map(mapSlot);
  const slotsById = new Map(slots.map((slot) => [slot.id, slot]));
  const attempts = (await all(db, "SELECT * FROM attempts WHERE campaign_id = ?", [campaign.id])).map(mapAttempt);
  const vouchers = (await all(db, "SELECT * FROM vouchers WHERE campaign_id = ?", [campaign.id])).map(mapVoucher);
  const vouchersById = new Map(vouchers.map((voucher) => [voucher.id, voucher]));
  const redemptions = vouchers.length
    ? (
        await all(
          db,
          `SELECT * FROM redemption_logs WHERE voucher_id IN (${vouchers.map(() => "?").join(",")})`,
          vouchers.map((voucher) => voucher.id)
        )
      ).map(mapRedemptionLog)
    : [];

  const leadsSection = csvSection(
    "LEADS",
    ["user_id", "name", "phone", "email", "created_at"],
    users.map((user) => [user.id, user.name ?? "", toDisplayPhone(user.phone), user.email ?? "", user.createdAt])
  );

  const vouchersSection = csvSection(
    "VOUCHERS",
    ["voucher_code", "phone", "name", "benefit", "status", "issued_at", "expires_at", "redeemed_at", "slot_date", "slot_start", "slot_end"],
    vouchers.map((voucher) => {
      const user = usersById.get(voucher.userId);
      const slot = slotsById.get(voucher.slotId);
      return [
        voucher.voucherCode,
        user?.phone ? toDisplayPhone(user.phone) : "",
        user?.name ?? "",
        voucher.displayLabel,
        voucher.status,
        voucher.issuedAt,
        voucher.expiresAt,
        voucher.redeemedAt ?? "",
        slot?.date ?? "",
        slot?.startTime ?? "",
        slot?.endTime ?? ""
      ];
    })
  );

  const attemptsSection = csvSection(
    "ATTEMPTS",
    ["attempt_id", "phone", "attempt_number", "source_type", "benefit", "status", "slot_date", "created_at", "expires_at"],
    attempts.map((attempt) => {
      const user = usersById.get(attempt.userId);
      const slot = attempt.slotId ? slotsById.get(attempt.slotId) : undefined;
      return [
        attempt.id,
        user?.phone ? toDisplayPhone(user.phone) : "",
        attempt.attemptNumber,
        attempt.sourceType,
        attempt.displayLabel,
        attempt.status,
        slot?.date ?? "",
        attempt.createdAt,
        attempt.expiresAt
      ];
    })
  );

  const redemptionsSection = csvSection(
    "REDEMPTIONS",
    ["voucher_code", "phone", "staff_name", "purchase_amount", "note", "redeemed_at"],
    redemptions.map((redemption) => {
      const voucher = vouchersById.get(redemption.voucherId);
      const user = voucher ? usersById.get(voucher.userId) : undefined;
      return [
        voucher?.voucherCode ?? "",
        user?.phone ? toDisplayPhone(user.phone) : "",
        redemption.staffName,
        redemption.purchaseAmount ?? "",
        redemption.note ?? "",
        redemption.createdAt
      ];
    })
  );

  return [leadsSection, vouchersSection, attemptsSection, redemptionsSection].join("\n\n");
}

/**
 * Marks a confirmed restaurant reservation (and its voucher) as No-show.
 * Only a reservation still in the Reserved state can be flagged; a redeemed
 * voucher cannot be marked no-show.
 */
export function markNoShow(input: { codeOrToken: string; staffName?: string }) {
  return withTx(async (tx) => {
    const voucher = await loadVoucherContext(tx, input.codeOrToken);
    if (voucher.status === "Redeemed") {
      throw new AppError("E-VOUCHER-REDEEMED", "A redeemed voucher cannot be marked no-show", 409);
    }
    const reservationRow = await one(tx, "SELECT * FROM reservations WHERE voucher_id = ?", [voucher.id]);
    if (!reservationRow) throw new AppError("E-RESERVATION-404", "No reservation exists for this voucher", 404);
    const reservation = mapReservation(reservationRow);
    if (reservation.status !== "Reserved") {
      throw new AppError("E-RESERVATION-STATE", "Only a reserved booking can be marked no-show", 409);
    }
    await run(tx, "UPDATE reservations SET status = 'No-show' WHERE id = ?", [reservation.id]);
    await run(tx, "UPDATE vouchers SET status = 'NoShow' WHERE id = ?", [voucher.id]);
    await addAnalytics(tx, voucher.campaignId, "reservation_no_show", { staffName: input.staffName }, voucher.userId, voucher.slotId);
    return { voucherId: voucher.id, reservationId: reservation.id, status: "No-show" as const };
  });
}

/**
 * Moves an issued restaurant reservation to a different active slot, when the
 * campaign allows rescheduling. Capacity is transferred atomically: the new
 * slot is decremented with a guarded update and the old slot is returned.
 */
export function rescheduleReservation(input: { codeOrToken: string; newSlotId: string }) {
  return withTx(async (tx) => {
    const voucher = await loadVoucherContext(tx, input.codeOrToken);
    const campaign = mapCampaign(await one(tx, "SELECT * FROM campaigns WHERE id = ?", [voucher.campaignId]));
    if (!campaign.allowReschedule) {
      throw new AppError("E-RESCHEDULE-DISABLED", "Rescheduling is not enabled for this campaign", 403);
    }
    if (voucher.status !== "Issued") {
      throw new AppError("E-VOUCHER-STATE", "Only an active issued voucher can be rescheduled", 409);
    }
    if (input.newSlotId === voucher.slotId) {
      throw new AppError("E-RESCHEDULE-SAME", "Choose a slot different from the current one", 422);
    }
    const reservationRow = await one(tx, "SELECT * FROM reservations WHERE voucher_id = ?", [voucher.id]);
    if (!reservationRow) throw new AppError("E-RESERVATION-404", "No reservation exists for this voucher", 404);
    const reservation = mapReservation(reservationRow);
    if (reservation.status !== "Reserved") {
      throw new AppError("E-RESERVATION-STATE", "Only a reserved booking can be rescheduled", 409);
    }
    const newSlot = await getSlotOrThrow(tx, input.newSlotId, campaign.id);

    const cap = await run(
      tx,
      `UPDATE slots
       SET remaining_capacity = remaining_capacity - 1,
           status = CASE WHEN remaining_capacity - 1 <= 0 THEN 'sold_out' ELSE status END
       WHERE id = ? AND remaining_capacity > 0`,
      [newSlot.id]
    );
    if (cap !== 1) throw new AppError("E-SLOT-SOLD-OUT", "Selected slot is sold out", 409);

    await run(
      tx,
      `UPDATE slots
       SET remaining_capacity = remaining_capacity + 1,
           status = CASE WHEN status = 'sold_out' THEN 'active' ELSE status END
       WHERE id = ?`,
      [voucher.slotId]
    );

    await run(tx, "UPDATE vouchers SET slot_id = ? WHERE id = ?", [newSlot.id, voucher.id]);
    await run(tx, "UPDATE reservations SET slot_id = ? WHERE id = ?", [newSlot.id, reservation.id]);

    // Every voucher is slot-bound, so validity always follows the new slot.
    await run(tx, "UPDATE vouchers SET expires_at = ? WHERE id = ?", [expiryFor(newSlot), voucher.id]);

    await addAnalytics(tx, campaign.id, "reservation_rescheduled", { from: voucher.slotId, to: newSlot.id }, voucher.userId, newSlot.id);
    const freshVoucher = mapVoucher(await one(tx, "SELECT * FROM vouchers WHERE id = ?", [voucher.id]));
    const freshNewSlot = mapSlot(await one(tx, "SELECT * FROM slots WHERE id = ?", [newSlot.id]));
    return { voucher: freshVoucher, newSlot: freshNewSlot };
  });
}

export type RedemptionImportRow = {
  code: string;
  status: "redeemed" | "already_redeemed" | "expired" | "not_found";
};

/**
 * Bulk-marks vouchers as redeemed from a CSV export (e.g. a Shopify used-codes
 * report). Accepts one code per line, optional second column = purchase amount,
 * with an optional header row. Each valid code is redeemed transactionally.
 */
export async function importRedemptions(input: { campaignId: string; csv: string; staffName: string }) {
  const db = await getDb();
  const campaign = await getCampaignOrThrow(db, input.campaignId);
  const lines = input.csv.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const results: RedemptionImportRow[] = [];
  let redeemed = 0;

  for (const line of lines) {
    const cells = line.split(",").map((cell) => cell.trim().replace(/^"|"$/g, ""));
    const code = cells[0];
    const header = code?.toLowerCase();
    if (!code || header === "voucher_code" || header === "code") continue; // skip header row
    const amountRaw = cells[1] ? Number(cells[1]) : undefined;
    const amount = amountRaw !== undefined && Number.isFinite(amountRaw) ? amountRaw : undefined;

    const row = await one(db, "SELECT * FROM vouchers WHERE (UPPER(voucher_code) = ? OR UPPER(qr_token) = ?) AND campaign_id = ?", [
      code.toUpperCase(),
      code.toUpperCase(),
      campaign.id
    ]);
    if (!row) {
      results.push({ code, status: "not_found" });
      continue;
    }
    const voucher = mapVoucher(row);
    if (voucher.status === "Redeemed") {
      results.push({ code, status: "already_redeemed" });
      continue;
    }
    if (new Date(voucher.expiresAt).getTime() < Date.now()) {
      results.push({ code, status: "expired" });
      continue;
    }
    await withTx(async (tx) => {
      await run(tx, "UPDATE vouchers SET status = 'Redeemed', redeemed_at = ? WHERE id = ?", [isoNow(), voucher.id]);
      await run(tx, "UPDATE reservations SET status = 'Redeemed' WHERE voucher_id = ?", [voucher.id]);
      await run(
        tx,
        `INSERT INTO redemption_logs (id, voucher_id, staff_name, purchase_amount, note, created_at)
         VALUES (?, ?, ?, ?, 'csv_import', ?)`,
        [id("red"), voucher.id, input.staffName, amount ?? null, isoNow()]
      );
      await addAnalytics(tx, campaign.id, "voucher_redeemed", { source: "csv_import", purchaseAmount: amount }, voucher.userId, voucher.slotId);
    });
    results.push({ code, status: "redeemed" });
    redeemed += 1;
  }

  return { total: results.length, redeemed, skipped: results.length - redeemed, results };
}

/**
 * Makes this phone's issued vouchers usable again. Dev tools only, plus the
 * developer account in production — and only ever for its own vouchers.
 *
 * Deliberately *not* a relaxation of the expiry rule. Expiry is what stops a
 * 90%-off voucher being an open-ended liability for the partner, and the
 * expired path is worth seeing work — so instead of ignoring it in dev, this
 * moves the booking to the next slot that still has room and re-dates the
 * voucher to match. The result is a voucher that is valid for real reasons.
 */
export async function devRefreshIssuedVouchers(input: { phone: string }) {
  assertDevToolsEnabledFor(input.phone, "Refreshing vouchers");
  const normalized = normalizePhone(input.phone);
  if (!normalized) throw new AppError("E-USER-PHONE", "A valid Philippine mobile number is required", 400);

  const db = await getDb();
  // Expired vouchers are the whole point of the tool, and expiry is recorded on
  // the row — filtering to 'Issued' silently skipped every voucher worth
  // refreshing.
  const vouchers = await all(
    db,
    `SELECT v.id, v.voucher_code, v.status, v.campaign_id, v.slot_id, s.date AS slot_date
     FROM vouchers v JOIN users u ON u.id = v.user_id
     LEFT JOIN slots s ON s.id = v.slot_id
     WHERE u.phone = ? AND v.status IN ('Issued', 'Expired')`,
    [normalized]
  );

  const today = manilaDateString();
  const refreshed: Array<{ voucherCode: string; movedTo?: string; note?: string }> = [];
  for (const row of vouchers) {
    const voucherCode = String(row.voucher_code);
    let movedTo: string | undefined;
    let note: string | undefined;

    // Reinstate before rescheduling: that path only accepts an issued voucher,
    // and being issued again is what makes this one usable.
    if (String(row.status) === "Expired") {
      await run(db, "UPDATE vouchers SET status = 'Issued' WHERE id = ?", [String(row.id)]);
    }

    if (row.slot_date && String(row.slot_date) < today) {
      const nextSlot = await one(
        db,
        `SELECT id, date, start_time FROM slots
         WHERE campaign_id = ? AND status = 'active' AND date >= ? AND remaining_capacity > 0
         ORDER BY date ASC, start_time ASC LIMIT 1`,
        [String(row.campaign_id), today]
      );
      if (nextSlot) {
        try {
          // Rescheduling also re-dates a slot-bound voucher to its new slot's
          // window, which is exactly the expiry that stranded it.
          await rescheduleReservation({
            codeOrToken: voucherCode,
            newSlotId: String(nextSlot.id),
          });
          movedTo = `${nextSlot.date} ${nextSlot.start_time}`;
        } catch (error) {
          note = error instanceof AppError ? error.message : "Could not move the booking";
        }
      } else {
        note = "No upcoming slot with room";
      }
    }

    // Only force a date on vouchers the reschedule did not already fix, so a
    // slot-bound voucher keeps agreeing with its booking.
    const current = await one(db, "SELECT expires_at FROM vouchers WHERE id = ?", [String(row.id)]);
    if (!current || new Date(String(current.expires_at)).getTime() < Date.now()) {
      const expires = new Date();
      expires.setDate(expires.getDate() + 7);
      await run(db, "UPDATE vouchers SET expires_at = ? WHERE id = ?", [
        expires.toISOString(),
        String(row.id),
      ]);
    }
    refreshed.push({ voucherCode, movedTo, note });
  }

  return { refreshed };
}
