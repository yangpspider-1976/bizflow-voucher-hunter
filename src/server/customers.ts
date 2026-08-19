// Customer-facing people, as the dashboard sees them.
//
// `users` is keyed per campaign — UNIQUE (campaign_id, phone) — so one person
// who joins three campaigns has three rows. Everything here groups by phone,
// because "this person's activity" is the question the dashboard is asking.

import { all, getDb, one } from "@/server/db";
import { AppError } from "@/server/errors";
import type { VoucherStatus } from "@/types/voucher";

type Row = Record<string, any>;

export type CustomerSummary = {
  phone: string;
  /** Most recently supplied name; a customer can enter a different one per campaign. */
  name?: string;
  email?: string;
  campaignCount: number;
  voucherCount: number;
  redeemedCount: number;
  /** Loyalty balance in centavos, when this phone has a wallet. */
  loyaltyBalanceCentavos?: number;
  firstSeenAt: string;
  lastActivityAt: string;
};

export type CustomerVoucher = {
  id: string;
  code: string;
  displayLabel: string;
  status: VoucherStatus;
  issuedAt: string;
  expiresAt: string;
  redeemedAt?: string;
  campaignTitle: string;
  campaignSlug: string;
  businessName: string;
  slotDate?: string;
  slotStartTime?: string;
};

export type CustomerCampaign = {
  campaignId: string;
  campaignTitle: string;
  campaignSlug: string;
  businessName: string;
  joinedAt: string;
  attemptCount: number;
  hasVoucher: boolean;
};

export type CustomerDetail = {
  summary: CustomerSummary;
  campaigns: CustomerCampaign[];
  vouchers: CustomerVoucher[];
};

/**
 * Restricts results to the campaigns a session may see.
 *
 * Staff are bound to their own businesses; admins see everything. Returning the
 * fragment plus its arguments keeps the two call sites from drifting apart.
 */
function businessScope(session: { role: string; businessIds: string[] }) {
  if (session.role !== "staff") return { clause: "", args: [] as string[] };
  const ids = session.businessIds.filter((id) => id !== "*");
  if (ids.length === 0) {
    // A staff account with no business must see nobody, not everybody.
    return { clause: " AND 1 = 0", args: [] as string[] };
  }
  return {
    clause: ` AND c.business_id IN (${ids.map(() => "?").join(", ")})`,
    args: ids,
  };
}

export async function listCustomers(
  session: { role: string; businessIds: string[] },
  search?: string,
): Promise<CustomerSummary[]> {
  const db = await getDb();
  const scope = businessScope(session);

  const term = search?.trim();
  const searchClause = term ? " AND (u.phone LIKE ? OR u.name LIKE ?)" : "";
  const searchArgs = term ? [`%${term}%`, `%${term}%`] : [];

  // Two passes on purpose. Ordering by MAX(u.created_at) means the sort cannot
  // begin until every customer has been grouped, so a single-statement version
  // pays the voucher join, the wallet join and three COUNT(DISTINCT) temp
  // B-trees for the whole table before LIMIT discards all but 500 rows — the
  // limit saved transfer, not work, and the page got linearly slower forever
  // (measured: 96ms at 20k customers, 309ms at 60k).
  //
  // `page` therefore picks the 500 phones on this page while touching only
  // `users`, and the aggregate query below joins vouchers and wallets for those
  // 500 alone. The search filter is applied in both halves rather than only the
  // first, so the counts still describe the matching rows exactly as before.
  const rows = await all(
    db,
    `WITH page AS (
       SELECT
         u.phone AS phone,
         MAX(u.created_at) AS last_activity_at,
         MIN(u.created_at) AS first_seen_at
       FROM users u
       JOIN campaigns c ON c.id = u.campaign_id
       WHERE 1 = 1${scope.clause}${searchClause}
       GROUP BY u.phone
       ORDER BY last_activity_at DESC
       LIMIT 500
     )
     SELECT
       p.phone AS phone,
       -- Grouped by phone, so pick the latest non-null name/email this person
       -- gave across their campaign rows. Without these the list always fell
       -- back to rendering the phone number even for named customers.
       MAX(u.name) AS name,
       MAX(u.email) AS email,
       p.last_activity_at AS last_activity_at,
       p.first_seen_at AS first_seen_at,
       COUNT(DISTINCT u.campaign_id) AS campaign_count,
       COUNT(DISTINCT v.id) AS voucher_count,
       COUNT(DISTINCT CASE WHEN v.status = 'Redeemed' THEN v.id END) AS redeemed_count,
       w.balance_centavos AS loyalty_balance_centavos
     FROM page p
     JOIN users u ON u.phone = p.phone
     JOIN campaigns c ON c.id = u.campaign_id
     LEFT JOIN vouchers v ON v.user_id = u.id
     LEFT JOIN reward_wallets w ON w.phone = p.phone
     WHERE 1 = 1${scope.clause}${searchClause}
     GROUP BY p.phone, p.last_activity_at, p.first_seen_at, w.balance_centavos
     ORDER BY p.last_activity_at DESC`,
    [...scope.args, ...searchArgs, ...scope.args, ...searchArgs],
  );

  return rows.map(mapSummary);
}

function mapSummary(row: Row): CustomerSummary {
  return {
    phone: String(row.phone),
    name: row.name ?? undefined,
    email: row.email ?? undefined,
    campaignCount: Number(row.campaign_count ?? 0),
    voucherCount: Number(row.voucher_count ?? 0),
    redeemedCount: Number(row.redeemed_count ?? 0),
    loyaltyBalanceCentavos:
      row.loyalty_balance_centavos === null || row.loyalty_balance_centavos === undefined
        ? undefined
        : Number(row.loyalty_balance_centavos),
    firstSeenAt: String(row.first_seen_at),
    lastActivityAt: String(row.last_activity_at),
  };
}

export async function getCustomer(
  session: { role: string; businessIds: string[] },
  phone: string,
): Promise<CustomerDetail> {
  const db = await getDb();
  const scope = businessScope(session);

  const summaryRow = await one(
    db,
    `SELECT
       u.phone AS phone,
       MAX(u.created_at) AS last_activity_at,
       MIN(u.created_at) AS first_seen_at,
       COUNT(DISTINCT u.campaign_id) AS campaign_count,
       COUNT(DISTINCT v.id) AS voucher_count,
       COUNT(DISTINCT CASE WHEN v.status = 'Redeemed' THEN v.id END) AS redeemed_count,
       w.balance_centavos AS loyalty_balance_centavos
     FROM users u
     JOIN campaigns c ON c.id = u.campaign_id
     LEFT JOIN vouchers v ON v.user_id = u.id
     LEFT JOIN reward_wallets w ON w.phone = u.phone
     WHERE u.phone = ?${scope.clause}
     GROUP BY u.phone, w.balance_centavos`,
    [phone, ...scope.args],
  );

  // Staff querying someone who only ever used another business's campaigns get
  // the same 404 as a phone that does not exist: the scope must not be probeable.
  if (!summaryRow) throw new AppError("E-CUSTOMER-404", "Customer not found", 404);

  // The latest non-empty name/email wins: a customer can type a different name
  // per campaign, and the most recent is the best guess at what to call them.
  const identityRow = await one(
    db,
    `SELECT u.name AS name, u.email AS email
     FROM users u
     JOIN campaigns c ON c.id = u.campaign_id
     WHERE u.phone = ?${scope.clause}
     ORDER BY (u.name IS NULL OR u.name = ''), u.created_at DESC
     LIMIT 1`,
    [phone, ...scope.args],
  );

  const campaignRows = await all(
    db,
    `SELECT
       u.campaign_id AS campaign_id,
       c.title AS campaign_title,
       c.slug AS campaign_slug,
       b.name AS business_name,
       u.created_at AS joined_at,
       COUNT(DISTINCT a.id) AS attempt_count,
       COUNT(DISTINCT v.id) AS voucher_count
     FROM users u
     JOIN campaigns c ON c.id = u.campaign_id
     JOIN businesses b ON b.id = c.business_id
     LEFT JOIN attempts a ON a.user_id = u.id
     LEFT JOIN vouchers v ON v.user_id = u.id
     WHERE u.phone = ?${scope.clause}
     GROUP BY u.campaign_id, c.title, c.slug, b.name, u.created_at
     ORDER BY joined_at DESC`,
    [phone, ...scope.args],
  );

  const voucherRows = await all(
    db,
    `SELECT
       v.id AS id,
       v.voucher_code AS code,
       v.display_label AS display_label,
       v.status AS status,
       v.issued_at AS issued_at,
       v.expires_at AS expires_at,
       v.redeemed_at AS redeemed_at,
       c.title AS campaign_title,
       c.slug AS campaign_slug,
       b.name AS business_name,
       s.date AS slot_date,
       s.start_time AS slot_start_time
     FROM vouchers v
     JOIN users u ON u.id = v.user_id
     JOIN campaigns c ON c.id = v.campaign_id
     JOIN businesses b ON b.id = c.business_id
     LEFT JOIN slots s ON s.id = v.slot_id
     WHERE u.phone = ?${scope.clause}
     ORDER BY v.issued_at DESC`,
    [phone, ...scope.args],
  );

  return {
    summary: {
      ...mapSummary(summaryRow),
      name: identityRow?.name || undefined,
      email: identityRow?.email || undefined,
    },
    campaigns: campaignRows.map((row) => ({
      campaignId: String(row.campaign_id),
      campaignTitle: String(row.campaign_title),
      campaignSlug: String(row.campaign_slug),
      businessName: String(row.business_name),
      joinedAt: String(row.joined_at),
      attemptCount: Number(row.attempt_count ?? 0),
      hasVoucher: Number(row.voucher_count ?? 0) > 0,
    })),
    vouchers: voucherRows.map((row) => ({
      id: String(row.id),
      code: String(row.code),
      displayLabel: String(row.display_label),
      status: row.status as VoucherStatus,
      issuedAt: String(row.issued_at),
      expiresAt: String(row.expires_at),
      redeemedAt: row.redeemed_at ? String(row.redeemed_at) : undefined,
      campaignTitle: String(row.campaign_title),
      campaignSlug: String(row.campaign_slug),
      businessName: String(row.business_name),
      slotDate: row.slot_date ? String(row.slot_date) : undefined,
      slotStartTime: row.slot_start_time ? String(row.slot_start_time) : undefined,
    })),
  };
}
