import crypto from "node:crypto";
import type { InArgs } from "@/server/pg-driver";
import { benefitValueProblem, RARITY_WEIGHTS, type VoucherRarity } from "@bizflow/shared";
import { AppError } from "@/server/errors";
import {
  all,
  batchAll,
  getDb,
  manilaDateString,
  mapBusiness,
  mapCampaign,
  mapPool,
  mapSlot,
  one,
  run,
  type Exec
} from "@/server/db";
import type { Business, Campaign, CampaignSlot, VoucherPool } from "@/types/voucher";

const id = (prefix: string) => `${prefix}_${crypto.randomBytes(6).toString("hex")}`;

export type CreateBusinessInput = {
  name: string;
  /** Left out by the console; derived from the name. See `deriveLogoText`. */
  logoText?: string;
  industry: Business["industry"];
  address: string;
  contactNumber: string;
  latitude?: number;
  longitude?: number;
};

/** Venue details only. The staff PIN is rotated through its own flow, not here. */
export type UpdateBusinessInput = {
  name?: string;
  address?: string;
  contactNumber?: string;
  /** null clears the pin; undefined leaves it as it was. */
  latitude?: number | null;
  longitude?: number | null;
};

export async function listBusinesses(): Promise<Business[]> {
  const db = await getDb();
  return (await all(db, "SELECT * FROM businesses ORDER BY name")).map(mapBusiness);
}

/**
 * The short mark shown where a full business name will not fit.
 *
 * Operators no longer type this, so it comes from the name: initials of the
 * first four words, falling back to the leading characters for a single-word
 * name. `logo_text` is NOT NULL, so this always returns something.
 */
export function deriveLogoText(name: string): string {
  const words = name.trim().split(/\s+/).filter((word) => /[a-z0-9]/i.test(word));
  const initials = words
    .map((word) => word.replace(/[^a-z0-9]/gi, "").charAt(0))
    .join("")
    .slice(0, 4)
    .toUpperCase();
  if (initials.length > 1) return initials;
  const letters = name.replace(/[^a-z0-9]/gi, "").slice(0, 4).toUpperCase();
  return letters || "BIZ";
}

export async function createBusiness(input: CreateBusinessInput): Promise<Business> {
  const db = await getDb();
  const address = input.address.trim();
  if (!address) {
    throw new AppError("E-BUSINESS-ADDRESS", "Address is required", 422);
  }
  const contactNumber = input.contactNumber.trim();
  if (!contactNumber) {
    throw new AppError(
      "E-BUSINESS-CONTACT",
      "Contact number is required",
      422,
    );
  }
  const business: Business = {
    id: id("biz"),
    name: input.name,
    logoText: input.logoText?.trim() || deriveLogoText(input.name),
    industry: input.industry,
    address,
    contactNumber,
    latitude: input.latitude ?? undefined,
    longitude: input.longitude ?? undefined
  };
  await run(
    db,
    `INSERT INTO businesses (id, name, logo_text, industry, address, contact_number, latitude, longitude)
     VALUES (@id, @name, @logoText, @industry, @address, @contactNumber, @latitude, @longitude)`,
    {
      ...business,
      address: business.address ?? null,
      contactNumber: business.contactNumber ?? null,
      latitude: business.latitude ?? null,
      longitude: business.longitude ?? null
    }
  );
  return business;
}

/**
 * Updates the venue details a customer sees on the campaign page.
 *
 * Only the supplied fields change. Address and contact number cannot be
 * cleared; `undefined` leaves an existing value alone.
 */
export async function updateBusiness(
  businessId: string,
  input: UpdateBusinessInput
): Promise<Business> {
  const db = await getDb();
  const existing = await one(db, "SELECT * FROM businesses WHERE id = ?", [businessId]);
  if (!existing) throw new AppError("E-BUSINESS-404", "Business not found", 404);

  const assignments: string[] = [];
  const args: Record<string, string | number | null> = { id: businessId };
  if (input.name !== undefined) {
    const name = input.name.trim();
    if (!name) throw new AppError("E-BUSINESS-NAME", "Business name cannot be empty", 422);
    assignments.push("name = @name");
    args.name = name;
  }
  if (input.address !== undefined) {
    const address = input.address.trim();
    if (!address) {
      throw new AppError("E-BUSINESS-ADDRESS", "Address is required", 422);
    }
    assignments.push("address = @address");
    args.address = address;
  }
  if (input.contactNumber !== undefined) {
    const contactNumber = input.contactNumber.trim();
    if (!contactNumber) {
      throw new AppError(
        "E-BUSINESS-CONTACT",
        "Contact number is required",
        422,
      );
    }
    assignments.push("contact_number = @contactNumber");
    args.contactNumber = contactNumber;
  }

  // Latitude and longitude move together: a pin is one thing, and letting one
  // half change alone would leave a coordinate that points nowhere.
  if (input.latitude !== undefined || input.longitude !== undefined) {
    assignments.push("latitude = @latitude", "longitude = @longitude");
    args.latitude = input.latitude ?? null;
    args.longitude = input.longitude ?? null;
  }

  if (assignments.length > 0) {
    await run(db, `UPDATE businesses SET ${assignments.join(", ")} WHERE id = @id`, args);
  }
  const updated = await one(db, "SELECT * FROM businesses WHERE id = ?", [businessId]);
  return mapBusiness(updated);
}

export async function listCampaigns(): Promise<Campaign[]> {
  const db = await getDb();
  return (await all(db, "SELECT * FROM campaigns ORDER BY start_date DESC")).map(mapCampaign);
}

/**
 * Campaigns annotated with their owning business's industry. The industry is the
 * customer-facing category (drives the directory's colour/icon), which can
 * differ from a campaign's `mode` — e.g. a beauty clinic running an
 * appointment-based campaign in restaurant `mode`. The admin campaign selector
 * uses `industry` so it matches what customers see.
 */
export type CampaignWithIndustry = Campaign & { industry: string };

export async function listCampaignsWithIndustry(): Promise<CampaignWithIndustry[]> {
  const db = await getDb();
  const rows = await all(
    db,
    `SELECT c.*, b.industry AS business_industry
     FROM campaigns c JOIN businesses b ON b.id = c.business_id
     ORDER BY c.start_date DESC`,
  );
  return rows.map((row) => ({
    ...mapCampaign(row),
    industry: String(row.business_industry),
  }));
}

export type CreateCampaignInput = {
  businessId: string;
  slug: string;
  title: string;
  offerMessage: string;
  heroImage: string;
  mode: Campaign["mode"];
  location?: string;
  startDate: string;
  endDate: string;
  baseAttempts: number;
  referralDailyLimit: number;
  candidateTimeoutMinutes: number;
  terms: string;
  shopUrl?: string;
  status?: Campaign["status"];
  allowReschedule?: boolean;
};

export type CreateSlotInput = {
  date: string;
  startTime: string;
  endTime: string;
  timezone?: string;
  branchId?: string;
  totalCapacity: number;
  status?: CampaignSlot["status"];
};

export type CreatePoolInput = {
  benefitType: VoucherPool["benefitType"];
  benefitValue: string;
  displayLabel: string;
  totalQuantity: number;
  /** Sets both the tier's odds and the badge customers see. */
  rarity: VoucherRarity;
  minimumSpend?: number;
  restriction?: string;
  status?: VoucherPool["status"];
  /** Slots at which this benefit tier is offered (rarity-gated availability). */
  slotIds?: string[];
};

export type PoolWithSlots = VoucherPool & { slotIds: string[] };

export async function createCampaign(input: CreateCampaignInput): Promise<Campaign> {
  const db = await getDb();
  if (new Date(input.endDate).getTime() < new Date(input.startDate).getTime()) {
    throw new AppError("E-CAMPAIGN-DATES", "Campaign end date must be on or after the start date", 422);
  }
  if (input.baseAttempts < 1) throw new AppError("E-CAMPAIGN-ATTEMPTS", "baseAttempts must be at least 1", 422);
  if (!(await one(db, "SELECT 1 FROM businesses WHERE id = ?", [input.businessId]))) {
    throw new AppError("E-BUSINESS-404", "Referenced business does not exist", 422);
  }
  if (await one(db, "SELECT 1 FROM campaigns WHERE slug = ?", [input.slug])) {
    throw new AppError("E-CAMPAIGN-SLUG", "Campaign slug is already in use", 409);
  }
  const campaign: Campaign = {
    id: id("camp"),
    businessId: input.businessId,
    slug: input.slug,
    title: input.title,
    offerMessage: input.offerMessage,
    heroImage: input.heroImage,
    mode: input.mode,
    location: input.location?.trim() || undefined,
    status: input.status ?? "active",
    startDate: input.startDate,
    endDate: input.endDate,
    baseAttempts: input.baseAttempts,
    referralDailyLimit: input.referralDailyLimit,
    candidateTimeoutMinutes: input.candidateTimeoutMinutes,
    terms: input.terms,
    shopUrl: input.shopUrl,
    allowReschedule: input.allowReschedule ?? false
  };
  await run(
    db,
    `INSERT INTO campaigns (id, business_id, slug, title, offer_message, hero_image, mode, location, status, start_date, end_date, base_attempts, referral_daily_limit, candidate_timeout_minutes, terms, shop_url, allow_reschedule)
     VALUES (@id, @businessId, @slug, @title, @offerMessage, @heroImage, @mode, @location, @status, @startDate, @endDate, @baseAttempts, @referralDailyLimit, @candidateTimeoutMinutes, @terms, @shopUrl, @allowReschedule)`,
    {
      id: campaign.id,
      businessId: campaign.businessId,
      slug: campaign.slug,
      title: campaign.title,
      offerMessage: campaign.offerMessage,
      heroImage: campaign.heroImage,
      mode: campaign.mode,
      location: campaign.location ?? null,
      status: campaign.status,
      startDate: campaign.startDate,
      endDate: campaign.endDate,
      baseAttempts: campaign.baseAttempts,
      referralDailyLimit: campaign.referralDailyLimit,
      candidateTimeoutMinutes: campaign.candidateTimeoutMinutes,
      terms: campaign.terms,
      shopUrl: campaign.shopUrl ?? null,
      allowReschedule: campaign.allowReschedule ? 1 : 0
    }
  );
  return campaign;
}

export async function getCampaignFromDb(db: Exec, idOrSlug: string): Promise<Campaign> {
  const row = await one(db, "SELECT * FROM campaigns WHERE id = ? OR slug = ?", [idOrSlug, idOrSlug]);
  if (!row) throw new AppError("E-CAMPAIGN-404", "Campaign was not found", 404);
  return mapCampaign(row);
}

export async function getCampaign(idOrSlug: string): Promise<Campaign> {
  return getCampaignFromDb(await getDb(), idOrSlug);
}

const CAMPAIGN_PATCH_COLUMNS: Record<string, string> = {
  title: "title",
  offerMessage: "offer_message",
  heroImage: "hero_image",
  status: "status",
  startDate: "start_date",
  endDate: "end_date",
  baseAttempts: "base_attempts",
  referralDailyLimit: "referral_daily_limit",
  candidateTimeoutMinutes: "candidate_timeout_minutes",
  terms: "terms",
  shopUrl: "shop_url",
  allowReschedule: "allow_reschedule"
};

const CAMPAIGN_BOOLEAN_KEYS = new Set(["allowReschedule"]);

export async function updateCampaign(idOrSlug: string, patch: Partial<CreateCampaignInput>): Promise<Campaign> {
  const db = await getDb();
  const current = await getCampaign(idOrSlug);
  const startDate = patch.startDate ?? current.startDate;
  const endDate = patch.endDate ?? current.endDate;
  if (new Date(endDate).getTime() < new Date(startDate).getTime()) {
    throw new AppError("E-CAMPAIGN-DATES", "Campaign end date must be on or after the start date", 422);
  }
  if (patch.baseAttempts !== undefined && patch.baseAttempts < 1) {
    throw new AppError("E-CAMPAIGN-ATTEMPTS", "baseAttempts must be at least 1", 422);
  }
  // Only when the window itself moves: an admin editing the title of a campaign
  // that is already inconsistent should not be blocked by a slot they are not
  // touching. Narrowing the dates onto a bookable slot is the case worth
  // refusing, and it is the one that strands the campaign.
  if (patch.startDate !== undefined || patch.endDate !== undefined) {
    const stranded = await upcomingSlotsOutsideWindow(db, current.id, startDate, endDate);
    if (stranded.length > 0) {
      throw new AppError(
        "E-CAMPAIGN-WINDOW-SLOTS",
        `Campaign window ${startDate} to ${endDate} would leave ${stranded.length === 1 ? "an upcoming slot" : "upcoming slots"} outside it: ${stranded.join(", ")}. Widen the dates to cover them, or close those slots first.`,
        422,
        { strandedSlotDates: stranded }
      );
    }
  }
  const sets: string[] = [];
  const values: Array<string | number> = [];
  for (const [key, column] of Object.entries(CAMPAIGN_PATCH_COLUMNS)) {
    const value = (patch as Record<string, unknown>)[key];
    if (value !== undefined) {
      sets.push(`${column} = ?`);
      values.push(CAMPAIGN_BOOLEAN_KEYS.has(key) ? (value ? 1 : 0) : (value as string | number));
    }
  }
  if (sets.length === 0) return current;
  values.push(current.id);
  await run(db, `UPDATE campaigns SET ${sets.join(", ")} WHERE id = ?`, values as InArgs);
  return getCampaign(current.id);
}

/**
 * The two ways a slot's date can be one nobody will ever book on.
 *
 * A campaign's window has to contain every slot customers can still book. Both
 * halves of that are the same defect seen from opposite ends: a slot dated
 * outside its campaign is invisible in the public directory, because the
 * directory drops campaigns whose `end_date` has passed while the draw happily
 * keeps offering the stranded slot. The campaign then reads as fully bookable in
 * the dashboard and does not exist at all in the app, with nothing anywhere
 * saying why.
 *
 * A date that has already passed is the same dead slot arrived at by the other
 * route, and the window alone never catches it: a campaign running to December
 * accepts a slot dated last week quite happily. It takes capacity, sorts to the
 * top of the slot list where dates ascend, and can never be reserved. Checked
 * against the Manila day because that is the timezone slots are kept in, so a
 * reviewer in another one cannot approve yesterday by being west of it.
 *
 * Dates are ISO `YYYY-MM-DD`, so string comparison is chronological.
 */
export type SlotDateProblem = { reason: "past" | "window"; message: string };

export function slotDateProblem(
  date: string,
  campaign: Pick<Campaign, "startDate" | "endDate">,
  today = manilaDateString()
): SlotDateProblem | null {
  if (date < today) {
    return { reason: "past", message: `Slot date ${date} has already passed.` };
  }
  if (date < campaign.startDate || date > campaign.endDate) {
    return {
      reason: "window",
      message: `Slot date ${date} is outside the campaign window (${campaign.startDate} to ${campaign.endDate}).`
    };
  }
  return null;
}

/**
 * Upcoming slots only. Past slots are a record of what already happened, and the
 * bundled demo campaigns deliberately leave their original fixture dates behind
 * when the window rolls forward — validating those would make every demo
 * campaign permanently uneditable.
 */
async function upcomingSlotsOutsideWindow(
  db: Exec,
  campaignId: string,
  startDate: string,
  endDate: string
): Promise<string[]> {
  const rows = await all(
    db,
    `SELECT DISTINCT date FROM slots
     WHERE campaign_id = ? AND date >= ? AND (date < ? OR date > ?)
     ORDER BY date`,
    [campaignId, manilaDateString(), startDate, endDate]
  );
  return rows.map((row) => String(row.date));
}

export async function listSlots(campaignIdOrSlug: string): Promise<CampaignSlot[]> {
  const db = await getDb();
  const campaign = await getCampaign(campaignIdOrSlug);
  return (await all(db, "SELECT * FROM slots WHERE campaign_id = ? ORDER BY date, start_time", [campaign.id])).map(mapSlot);
}

export async function createSlot(campaignIdOrSlug: string, input: CreateSlotInput, executor?: Exec): Promise<CampaignSlot> {
  const db = executor ?? await getDb();
  const campaign = await getCampaignFromDb(db, campaignIdOrSlug);
  if (input.totalCapacity < 1) throw new AppError("E-SLOT-CAPACITY", "totalCapacity must be at least 1", 422);
  if (input.endTime <= input.startTime) {
    throw new AppError("E-SLOT-TIME", "Slot endTime must be after startTime", 422);
  }
  const dateProblem = slotDateProblem(input.date, campaign);
  if (dateProblem) {
    throw new AppError(
      "E-SLOT-WINDOW",
      `${dateProblem.message} ${
        dateProblem.reason === "past"
          ? "Pick a date from today onward."
          : "Extend the campaign dates first, or pick a date inside them."
      }`,
      422
    );
  }
  const slot: CampaignSlot = {
    id: id("slot"),
    campaignId: campaign.id,
    date: input.date,
    startTime: input.startTime,
    endTime: input.endTime,
    timezone: input.timezone ?? "Asia/Manila",
    branchId: input.branchId,
    totalCapacity: input.totalCapacity,
    remainingCapacity: input.totalCapacity,
    status: input.status ?? "active"
  };
  await run(
    db,
    `INSERT INTO slots (id, campaign_id, date, start_time, end_time, timezone, branch_id, total_capacity, remaining_capacity, status)
     VALUES (@id, @campaignId, @date, @startTime, @endTime, @timezone, @branchId, @totalCapacity, @remainingCapacity, @status)`,
    { ...slot, branchId: slot.branchId ?? null }
  );
  return slot;
}

/** Lists a campaign's benefit tiers, each with the slot IDs it is offered at. */
export async function listPools(campaignIdOrSlug: string): Promise<PoolWithSlots[]> {
  const db = await getDb();
  const campaign = await getCampaign(campaignIdOrSlug);
  // The link read is joined back to pools rather than selecting the whole
  // pool_slots table: it used to return every campaign's links and throw all but
  // this one's away in JS.
  const [poolRows, links] = await batchAll(db, [
    { sql: "SELECT * FROM pools WHERE campaign_id = ?", args: [campaign.id] },
    {
      sql: `SELECT ps.pool_id, ps.slot_id FROM pool_slots ps
            JOIN pools p ON p.id = ps.pool_id WHERE p.campaign_id = ?`,
      args: [campaign.id],
    },
  ]);
  const pools = poolRows.map(mapPool);
  return pools.map((pool) => ({
    ...pool,
    slotIds: links.filter((l) => l.pool_id === pool.id).map((l) => l.slot_id as string)
  }));
}

export async function createPool(campaignIdOrSlug: string, input: CreatePoolInput, executor?: Exec): Promise<PoolWithSlots> {
  const db = executor ?? await getDb();
  const campaign = await getCampaignFromDb(db, campaignIdOrSlug);
  if (input.totalQuantity < 1) throw new AppError("E-POOL-QUANTITY", "totalQuantity must be at least 1", 422);
  // Enforced here rather than only in the route schema: approving a staff change
  // request casts its stored payload straight to CreatePoolInput, so a request
  // filed before this rule existed would otherwise bypass it entirely.
  const benefitProblem = benefitValueProblem(input.benefitType, input.benefitValue);
  if (benefitProblem) throw new AppError("E-POOL-BENEFIT-VALUE", benefitProblem, 422);

  const slotIds = input.slotIds ?? [];
  if (slotIds.length > 0) {
    const owned = await all(
      db,
      `SELECT id FROM slots WHERE campaign_id = ? AND id IN (${slotIds.map(() => "?").join(",")})`,
      [campaign.id, ...slotIds]
    );
    if (owned.length !== slotIds.length) {
      throw new AppError("E-POOL-SLOTS", "One or more assigned slots do not belong to this campaign", 422);
    }
  }

  const pool: VoucherPool = {
    id: id("pool"),
    campaignId: campaign.id,
    benefitType: input.benefitType,
    benefitValue: input.benefitValue,
    displayLabel: input.displayLabel,
    totalQuantity: input.totalQuantity,
    remainingQuantity: input.totalQuantity,
    rarity: input.rarity,
    // Never typed in: a hand-set weight is what let a tier's odds contradict the
    // badge it showed. RARITY_WEIGHTS is the only thing that decides this.
    probabilityWeight: RARITY_WEIGHTS[input.rarity],
    minimumSpend: input.minimumSpend,
    status: input.status ?? "active",
    restriction: input.restriction
  };
  await run(
    db,
    `INSERT INTO pools (id, campaign_id, benefit_type, benefit_value, display_label, total_quantity, remaining_quantity, rarity, probability_weight, minimum_spend, status, restriction)
     VALUES (@id, @campaignId, @benefitType, @benefitValue, @displayLabel, @totalQuantity, @remainingQuantity, @rarity, @probabilityWeight, @minimumSpend, @status, @restriction)`,
    { ...pool, minimumSpend: pool.minimumSpend ?? null, restriction: pool.restriction ?? null }
  );
  for (const slotId of slotIds) {
    await run(db, "INSERT OR IGNORE INTO pool_slots (pool_id, slot_id) VALUES (?, ?)", [pool.id, slotId]);
  }
  return { ...pool, slotIds };
}
