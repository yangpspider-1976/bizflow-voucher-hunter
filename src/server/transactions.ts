// Every movement a customer made at a checkout, in one list.
//
// Three tables record money changing hands and none of them knew about the
// others: `redemption_logs` when a campaign voucher is marked used,
// `reward_purchases` when a sale earns 5% Loyalty Points, and
// `reward_voucher_redemptions` when LP is spent back. They are unioned here
// rather than in the page so the sort, the filters and the paging happen once,
// in the database, over the whole set instead of over three separate windows.

import { transactionKindLabel, type TransactionKind } from "@/lib/transaction-kinds";
import { all, getDb } from "@/server/db";

type Row = Record<string, any>;

export type { TransactionKind };

export type Transaction = {
  id: string;
  kind: TransactionKind;
  createdAt: string;
  phone: string;
  customerName?: string;
  businessId: string;
  businessName: string;
  campaignTitle?: string;
  /** Voucher code, where the movement has one. */
  reference?: string;
  /** What was handed over: the benefit tier, the LP product, or how LP was earned. */
  detail?: string;
  note?: string;
  /** The bill the customer paid, in centavos. Absent when the checkout recorded none. */
  purchaseCentavos?: number;
  /** Signed LP movement in centavos: positive earned, negative spent. */
  loyaltyDeltaCentavos?: number;
  serviceFeeCentavos?: number;
  settlementCentavos?: number;
  staffName: string;
  status: string;
  /**
   * An LP-earned row awarded by a voucher redemption, which has its own row in
   * this same list. The bill behind the two is one bill, so it is counted once.
   */
  linkedToVoucher: boolean;
};

export type TransactionTotals = {
  count: number;
  voucherRedemptionCount: number;
  /** Bills recorded, with the voucher/LP double-count removed. */
  salesCentavos: number;
  lpEarnedCentavos: number;
  lpSpentCentavos: number;
  /**
   * Charged once on the month's net rather than at checkout, so this is zero
   * for anything booked since that rule changed and non-zero only on the rows
   * that predate it.
   */
  serviceFeeCentavos: number;
  settlementCentavos: number;
};

export type TransactionFilters = {
  businessId?: string;
  kind?: TransactionKind;
  /** Manila calendar dates, inclusive, as YYYY-MM-DD. */
  from?: string;
  to?: string;
  /** Matches phone, customer name, voucher code or staff name. */
  search?: string;
  page?: number;
};

export const TRANSACTIONS_PAGE_SIZE = 50;

/** Rows an export may carry, so one click cannot pull the whole table into memory. */
const EXPORT_LIMIT = 5000;

/**
 * The three sources as one result set.
 *
 * Every branch selects the same columns in the same order — SQLite matches a
 * UNION by position, not by name, so a column added to one branch has to be
 * added to all three.
 *
 * `redemption_logs.purchase_amount` is written in pesos (the checkout posts the
 * figure a customer typed), while both reward tables hold centavos. It is
 * scaled here so every amount downstream is centavos and nothing has to
 * remember which row it came from.
 */
const UNION_SQL = `
  SELECT
    'voucher_redemption' AS kind,
    rl.id AS id,
    rl.created_at AS created_at,
    u.phone AS phone,
    u.name AS customer_name,
    c.business_id AS business_id,
    b.name AS business_name,
    c.title AS campaign_title,
    v.voucher_code AS reference,
    v.display_label AS detail,
    rl.note AS note,
    -- Widened before the multiply, not after: the column is int4 and holds
    -- pesos, so any sale over ₱21,474,836 overflowed 2^31 on the way to
    -- centavos and took the whole page down with a 22003 rather than showing
    -- the row. Both queries below embed this union, so the totals died with it.
    CASE WHEN rl.purchase_amount IS NULL THEN NULL ELSE rl.purchase_amount::bigint * 100 END AS purchase_centavos,
    -- Typed, not bare: Postgres unions these pairwise, and an untyped NULL
    -- here meets an untyped NULL in the next branch, resolves the pair to text,
    -- and then cannot be matched to the third branch's integer.
    NULL::bigint AS loyalty_delta_centavos,
    NULL::bigint AS service_fee_centavos,
    NULL::bigint AS settlement_centavos,
    rl.staff_name AS staff_name,
    'Redeemed' AS status,
    0 AS linked_to_voucher
  FROM redemption_logs rl
  JOIN vouchers v ON v.id = rl.voucher_id
  JOIN users u ON u.id = v.user_id
  JOIN campaigns c ON c.id = v.campaign_id
  JOIN businesses b ON b.id = c.business_id

  UNION ALL

  SELECT
    'lp_earned',
    p.id,
    p.created_at,
    w.phone,
    w.name,
    p.business_id,
    b.name,
    NULL,
    NULL,
    -- Described here rather than in the page, so the table and the CSV export
    -- say the same thing about the same row.
    CASE
      WHEN p.idempotency_key LIKE 'voucher-redemption-%' THEN 'Earned with a voucher redemption'
      ELSE 'Earned on a walk-in sale'
    END,
    p.review_note,
    p.purchase_amount_centavos,
    p.reward_amount_centavos,
    NULL,
    NULL,
    p.staff_name,
    p.status,
    -- creditRewardFromPurchase keys a voucher-driven award this way, and it is
    -- the only trace linking the award back to the redemption that caused it.
    CASE WHEN p.idempotency_key LIKE 'voucher-redemption-%' THEN 1 ELSE 0 END
  FROM reward_purchases p
  JOIN reward_wallets w ON w.id = p.wallet_id
  JOIN businesses b ON b.id = p.business_id

  UNION ALL

  SELECT
    'lp_spent',
    r.id,
    r.created_at,
    w.phone,
    w.name,
    r.business_id,
    b.name,
    NULL,
    rv.voucher_code,
    -- Item vouchers name what was handed over; a plain LP voucher is just money.
    COALESCE(pr.name, 'LP payment'),
    r.adjustment_note,
    NULL,
    -r.amount_centavos,
    r.service_fee_centavos,
    r.settlement_amount_centavos,
    r.staff_name,
    r.settlement_status,
    0
  FROM reward_voucher_redemptions r
  JOIN reward_vouchers rv ON rv.id = r.voucher_id
  JOIN reward_wallets w ON w.id = r.wallet_id
  JOIN businesses b ON b.id = r.business_id
  LEFT JOIN reward_products pr ON pr.id = rv.product_id
`;

/**
 * The WHERE fragment applied to the union, and its arguments.
 *
 * The business scope is the security boundary, so it is derived from the
 * session rather than from anything the caller passed: a staff account asking
 * for another partner's id narrows to its own businesses instead of widening.
 */
function whereFor(
  session: { role: string; businessIds: string[] },
  filters: TransactionFilters,
) {
  const clauses: string[] = [];
  const args: (string | number)[] = [];

  const scoped = session.role === "staff";
  const allowed = scoped
    ? session.businessIds.filter((businessId) => businessId !== "*")
    : [];

  if (scoped && allowed.length === 0) {
    // A staff account assigned to no business sees nothing, not everything.
    clauses.push("1 = 0");
  } else if (scoped) {
    const requested = filters.businessId;
    const ids = requested && allowed.includes(requested) ? [requested] : allowed;
    clauses.push(`business_id IN (${ids.map(() => "?").join(", ")})`);
    args.push(...ids);
  } else if (filters.businessId) {
    clauses.push("business_id = ?");
    args.push(filters.businessId);
  }

  if (filters.kind) {
    clauses.push("kind = ?");
    args.push(filters.kind);
  }

  // Dates are read as Manila days, which is how a cashier means them. The
  // stored timestamps are UTC ISO strings, so a bare string compare would put a
  // 7am sale on the previous day for anyone reading this in Manila.
  //
  // Named zone rather than the '+8 hours' this used to add by hand: the two
  // agree today because the Philippines has no daylight saving, and the named
  // one keeps agreeing if that ever stops being true.
  const manilaDay =
    "(created_at::timestamptz AT TIME ZONE 'Asia/Manila')::date";
  if (filters.from) {
    clauses.push(`${manilaDay} >= ?::date`);
    args.push(filters.from);
  }
  if (filters.to) {
    clauses.push(`${manilaDay} <= ?::date`);
    args.push(filters.to);
  }

  const term = filters.search?.trim();
  if (term) {
    clauses.push(
      "(phone LIKE ? OR customer_name LIKE ? OR reference LIKE ? OR staff_name LIKE ?)",
    );
    const like = `%${term}%`;
    args.push(like, like, like, like);
  }

  return { clause: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", args };
}

function mapTransaction(row: Row): Transaction {
  const number = (value: unknown) =>
    value === null || value === undefined ? undefined : Number(value);
  return {
    id: String(row.id),
    kind: row.kind as TransactionKind,
    createdAt: String(row.created_at),
    phone: String(row.phone ?? ""),
    customerName: row.customer_name || undefined,
    businessId: String(row.business_id),
    businessName: String(row.business_name),
    campaignTitle: row.campaign_title || undefined,
    reference: row.reference || undefined,
    detail: row.detail || undefined,
    note: row.note || undefined,
    purchaseCentavos: number(row.purchase_centavos),
    loyaltyDeltaCentavos: number(row.loyalty_delta_centavos),
    serviceFeeCentavos: number(row.service_fee_centavos),
    settlementCentavos: number(row.settlement_centavos),
    staffName: String(row.staff_name ?? ""),
    status: String(row.status ?? ""),
    linkedToVoucher: Number(row.linked_to_voucher ?? 0) === 1,
  };
}

/**
 * One page of transactions, plus the totals for everything the filters match.
 *
 * The totals deliberately describe the whole filtered set rather than the page:
 * "what did this partner take last month" is the question the filters were set
 * to ask, and answering it for fifty rows at a time would be misleading.
 */
export async function listTransactions(
  session: { role: string; businessIds: string[] },
  filters: TransactionFilters = {},
): Promise<{
  rows: Transaction[];
  totals: TransactionTotals;
  page: number;
  hasMore: boolean;
}> {
  const db = await getDb();
  const where = whereFor(session, filters);
  const page = Math.max(1, Math.floor(filters.page ?? 1));
  const offset = (page - 1) * TRANSACTIONS_PAGE_SIZE;

  // One row past the page, so "is there a next page" costs no second count.
  const rows = await all(
    db,
    `SELECT * FROM (${UNION_SQL}) AS t ${where.clause}
     ORDER BY created_at DESC, id DESC
     LIMIT ? OFFSET ?`,
    [...where.args, TRANSACTIONS_PAGE_SIZE + 1, offset],
  );

  const totalsRow = await all(
    db,
    `SELECT
       COUNT(*) AS count,
       COUNT(CASE WHEN kind = 'voucher_redemption' THEN 1 END) AS voucher_redemption_count,
       -- A voucher redemption and the LP it awarded carry the same bill. Only
       -- the redemption's copy is summed, so the sales figure is what the checkout
       -- actually took.
       COALESCE(SUM(CASE WHEN linked_to_voucher = 0 THEN purchase_centavos END), 0) AS sales_centavos,
       -- A rejected award was reversed off the wallet, so it is shown in the
       -- list but left out of what customers actually earned.
       COALESCE(SUM(CASE WHEN loyalty_delta_centavos > 0 AND status <> 'Rejected' THEN loyalty_delta_centavos END), 0) AS lp_earned_centavos,
       COALESCE(-SUM(CASE WHEN loyalty_delta_centavos < 0 THEN loyalty_delta_centavos END), 0) AS lp_spent_centavos,
       COALESCE(SUM(service_fee_centavos), 0) AS service_fee_centavos,
       COALESCE(SUM(settlement_centavos), 0) AS settlement_centavos
     FROM (${UNION_SQL}) AS t ${where.clause}`,
    where.args,
  );
  const totals = totalsRow[0] ?? {};

  return {
    rows: rows.slice(0, TRANSACTIONS_PAGE_SIZE).map(mapTransaction),
    totals: {
      count: Number(totals.count ?? 0),
      voucherRedemptionCount: Number(totals.voucher_redemption_count ?? 0),
      salesCentavos: Number(totals.sales_centavos ?? 0),
      lpEarnedCentavos: Number(totals.lp_earned_centavos ?? 0),
      lpSpentCentavos: Number(totals.lp_spent_centavos ?? 0),
      serviceFeeCentavos: Number(totals.service_fee_centavos ?? 0),
      settlementCentavos: Number(totals.settlement_centavos ?? 0),
    },
    page,
    hasMore: rows.length > TRANSACTIONS_PAGE_SIZE,
  };
}

/** Every matching transaction, for the CSV export, capped so one click stays bounded. */
export async function listTransactionsForExport(
  session: { role: string; businessIds: string[] },
  filters: TransactionFilters = {},
): Promise<Transaction[]> {
  const db = await getDb();
  const where = whereFor(session, filters);
  const rows = await all(
    db,
    `SELECT * FROM (${UNION_SQL}) AS t ${where.clause}
     ORDER BY created_at DESC, id DESC
     LIMIT ?`,
    [...where.args, EXPORT_LIMIT],
  );
  return rows.map(mapTransaction);
}

const CSV_HEADERS = [
  "recorded_at",
  "type",
  "business",
  "campaign",
  "customer_phone",
  "customer_name",
  "reference",
  "detail",
  "purchase_amount",
  "loyalty_points",
  "service_fee",
  "partner_payout",
  "staff",
  "status",
  "note",
];

/** A leading =, +, - or @ makes a spreadsheet treat the cell as a formula. */
function csvCell(value: string | number | undefined) {
  const text = value === undefined || value === null ? "" : String(value);
  const guarded = /^[=+\-@]/.test(text) ? `'${text}` : text;
  return `"${guarded.replace(/"/g, '""')}"`;
}

const pesos = (centavos?: number) =>
  centavos === undefined ? "" : (centavos / 100).toFixed(2);

export function transactionsToCsv(rows: Transaction[]) {
  return [
    CSV_HEADERS.join(","),
    ...rows.map((row) =>
      [
        row.createdAt,
        transactionKindLabel(row.kind),
        row.businessName,
        row.campaignTitle,
        row.phone,
        row.customerName,
        row.reference,
        row.detail,
        pesos(row.purchaseCentavos),
        pesos(row.loyaltyDeltaCentavos),
        pesos(row.serviceFeeCentavos),
        pesos(row.settlementCentavos),
        row.staffName,
        row.status,
        row.note,
      ]
        .map(csvCell)
        .join(","),
    ),
  ].join("\n");
}
