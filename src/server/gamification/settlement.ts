/**
 * The gamification lines on a partner's monthly statement.
 *
 * §6.2 asks the settlement report to separate five things: purchase accruals,
 * voucher use, mission rewards, level conversions, and reversals or
 * adjustments. The first two already drive the net that `rewards-network.ts`
 * computes. The last three are new with levels and missions, and this module
 * reports them.
 *
 * **It reports them; it does not net them.** §1.2 says the monthly
 * partner-settlement policy stays as it is until a separate change is approved,
 * so partner-funded mission rewards and level conversions appear as their own
 * lines, marked as memo rather than billed, and the amount a partner pays is
 * exactly what it was before this feature existed. Whether they should move
 * into the net is a finance decision, and the report is what that decision
 * needs to be made from.
 */
import { all, getDb, one } from "@/server/db";
import { centavosToLoyaltyPoints } from "@/server/rewards-network";

export type StatementLineKind =
  | "purchase_accrual"
  | "voucher_use"
  | "mission_reward"
  | "achievement_reward"
  | "level_conversion"
  | "reversal";

export type StatementLine = {
  kind: StatementLineKind;
  label: string;
  /** Signed from the partner's point of view: positive is LP they put out. */
  centavos: number;
  amount: string;
  count: number;
  /** True when this line is already inside the month's billed net. */
  billed: boolean;
  note: string;
};

export type PartnerGamificationStatement = {
  businessId: string;
  period: string;
  lines: StatementLine[];
  /** What the partner owes under the current policy — the billed lines only. */
  billedCentavos: number;
  billed: string;
  /** What the memo lines would add if the policy changed to include them. */
  memoCentavos: number;
  memo: string;
};

/**
 * Every LP movement one partner was party to in a month, by cause.
 *
 * Periods are `YYYY-MM` and matched on the stored timestamp prefix, exactly as
 * `statementTotals` does — the two have to agree about which month a row falls
 * in, and the cheapest way to guarantee that is to ask the same question.
 */
export async function partnerGamificationStatement(input: {
  businessId: string;
  period: string;
}): Promise<PartnerGamificationStatement> {
  const db = await getDb();
  const { businessId, period } = input;

  const [accruals, redemptions, missions, achievements, conversions, reversals] =
    await Promise.all([
      one(
        db,
        `SELECT COALESCE(SUM(reward_amount_centavos), 0) AS total, COUNT(*) AS count
         FROM reward_purchases
         WHERE business_id = ? AND status = 'Accepted' AND substr(created_at, 1, 7) = ?`,
        [businessId, period],
      ),
      one(
        db,
        `SELECT COALESCE(SUM(amount_centavos), 0) AS total, COUNT(*) AS count
         FROM reward_voucher_redemptions
         WHERE business_id = ? AND substr(created_at, 1, 7) = ?`,
        [businessId, period],
      ),
      one(
        db,
        `SELECT COALESCE(SUM(lp_centavos), 0) AS total, COUNT(*) AS count
         FROM reward_transactions
         WHERE partner_id = ? AND funding_source = 'PARTNER' AND status = 'GRANTED'
           AND source_type = 'mission' AND substr(created_at, 1, 7) = ?`,
        [businessId, period],
      ),
      one(
        db,
        `SELECT COALESCE(SUM(lp_centavos), 0) AS total, COUNT(*) AS count
         FROM reward_transactions
         WHERE partner_id = ? AND funding_source = 'PARTNER' AND status = 'GRANTED'
           AND source_type = 'achievement' AND substr(created_at, 1, 7) = ?`,
        [businessId, period],
      ),
      one(
        db,
        `SELECT COALESCE(SUM(lp_centavos), 0) AS total, COUNT(*) AS count
         FROM point_xp_conversions
         WHERE business_id = ? AND status = 'Completed' AND substr(created_at, 1, 7) = ?`,
        [businessId, period],
      ),
      one(
        db,
        `SELECT COALESCE(SUM(lp_centavos), 0) AS total, COUNT(*) AS count
         FROM reward_transactions
         WHERE partner_id = ? AND status = 'REVERSED' AND substr(created_at, 1, 7) = ?`,
        [businessId, period],
      ),
    ]);

  const lines: StatementLine[] = [
    {
      kind: "purchase_accrual",
      label: "Purchase accruals",
      centavos: Number(accruals?.total ?? 0),
      amount: centavosToLoyaltyPoints(Number(accruals?.total ?? 0)),
      count: Number(accruals?.count ?? 0),
      billed: true,
      note: "5% of verified in-store payments, issued by this partner's checkout.",
    },
    {
      kind: "voucher_use",
      label: "Voucher use",
      centavos: -Number(redemptions?.total ?? 0),
      amount: centavosToLoyaltyPoints(Number(redemptions?.total ?? 0)),
      count: Number(redemptions?.count ?? 0),
      billed: true,
      note: "Loyalty Points customers spent at this partner, owed back to them.",
    },
    {
      kind: "mission_reward",
      label: "Mission rewards",
      centavos: Number(missions?.total ?? 0),
      amount: centavosToLoyaltyPoints(Number(missions?.total ?? 0)),
      count: Number(missions?.count ?? 0),
      billed: false,
      note: "Partner-funded urgent-mission payouts, drawn from the campaign budget.",
    },
    {
      kind: "achievement_reward",
      label: "Achievement rewards",
      centavos: Number(achievements?.total ?? 0),
      amount: centavosToLoyaltyPoints(Number(achievements?.total ?? 0)),
      count: Number(achievements?.count ?? 0),
      billed: false,
      note: "Partner-funded badge rewards. Zero unless a tier was configured to pay LP.",
    },
    {
      kind: "level_conversion",
      label: "Level conversions",
      centavos: -Number(conversions?.total ?? 0),
      amount: centavosToLoyaltyPoints(Number(conversions?.total ?? 0)),
      count: Number(conversions?.count ?? 0),
      billed: false,
      note: "This partner's Loyalty Points spent on experience. Extinguishes the liability — it can never be redeemed at the till.",
    },
    {
      kind: "reversal",
      label: "Reversals and adjustments",
      centavos: -Number(reversals?.total ?? 0),
      amount: centavosToLoyaltyPoints(Number(reversals?.total ?? 0)),
      count: Number(reversals?.count ?? 0),
      billed: false,
      note: "Rewards an administrator reversed, with a reason on the audit row.",
    },
  ];

  const billedCentavos = lines
    .filter((line) => line.billed)
    .reduce((total, line) => total + line.centavos, 0);
  const memoCentavos = lines
    .filter((line) => !line.billed)
    .reduce((total, line) => total + line.centavos, 0);

  return {
    businessId,
    period,
    lines,
    billedCentavos,
    billed: centavosToLoyaltyPoints(Math.abs(billedCentavos)),
    memoCentavos,
    memo: centavosToLoyaltyPoints(Math.abs(memoCentavos)),
  };
}

/**
 * Every partner-funded mission payout in a month, one row each.
 *
 * The detail behind the "Mission rewards" line: which campaign, when, and for
 * how much. Finance asks this the first time a partner queries the summary.
 */
export async function partnerMissionRewardDetail(input: {
  businessId: string;
  period: string;
  limit?: number;
}) {
  const db = await getDb();
  return all(
    db,
    `SELECT rt.id, rt.source_id, rt.lp_centavos, rt.xp_amount, rt.status, rt.created_at,
            rt.metadata, w.phone
     FROM reward_transactions rt
     JOIN reward_wallets w ON w.id = rt.wallet_id
     WHERE rt.partner_id = ? AND rt.funding_source = 'PARTNER'
       AND rt.source_type IN ('mission', 'achievement')
       AND substr(rt.created_at, 1, 7) = ?
     ORDER BY rt.created_at ASC
     LIMIT ?`,
    [input.businessId, input.period, Math.min(5000, input.limit ?? 2000)],
  );
}

/** The statement as a CSV, for the finance export. */
export function statementToCsv(statement: PartnerGamificationStatement) {
  const header = ["period", "line", "count", "loyalty_points", "centavos", "billed", "note"];
  const body = statement.lines.map((line) => [
    statement.period,
    line.label,
    line.count,
    line.amount,
    line.centavos,
    line.billed ? "yes" : "memo",
    line.note,
  ]);
  return [header, ...body]
    .map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(","))
    .join("\n");
}
