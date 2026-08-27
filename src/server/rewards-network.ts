import crypto from "node:crypto";
import type { Client, Transaction } from "@/server/pg-driver";
import { generateVoucherCode } from "@/server/codes";
import { all, batchAll, getDb, one, run, withTx } from "@/server/db";
import {
  assertDevToolsEnabled,
  assertDevToolsEnabledFor,
  devToolsEnabled,
} from "@/server/dev-tools";
import { AppError } from "@/server/errors";
import { MAX_MONEY_CENTAVOS, MAX_MONEY_DISPLAY } from "@/lib/limits";
import { normalizePhone } from "@/server/phone";
import type {
  LoyaltyDailyStatus,
  RewardLedgerEntry,
  RewardPurchase,
  RewardSettlementStatus,
  RewardVoucher,
  RewardVoucherRedemption,
  RewardWallet,
} from "@/types/voucher";

type Exec = Client | Transaction;
type Row = any;

const LOYALTY_RATE_BPS = 500; // 5.00%
const SERVICE_FEE_BPS = 1_000; // 10.00%
/**
 * What a partner posts before joining the network. It is a floor to top back up
 * to, not a hard cut-off: trading continues below it (with a dashboard warning)
 * and only stops once the deposit is actually exhausted, so a busy day cannot
 * strand customers mid-transaction over a shortfall the partner can settle.
 */
export const MIN_DEPOSIT_CENTAVOS = 5_000_00; // PHP 5,000
/**
 * The daily app-use award is drawn fresh each day rather than paid flat, so
 * opening the app is a small gamble instead of a fixed chore. The top of the
 * band is what the flat award used to be, which keeps the advertised "up to
 * 600 LP in 30 days" ceiling honest.
 */
const DAILY_APP_USE_MIN_POINTS_CENTAVOS = 1_00; // 1 LP
const DAILY_APP_USE_MAX_POINTS_CENTAVOS = 10_00; // 10 LP
const DAILY_REFERRAL_POINTS_CENTAVOS = 10_00; // 10 LP
const MAX_PURCHASE_CENTAVOS = 1_000_000_00; // PHP 1,000,000 per scan
const MAX_REDEMPTION_CENTAVOS = 250_000_00; // 250,000 LP per voucher payment
const MIN_CONVERSION_CENTAVOS = 50_00; // 50 LP minimum voucher conversion
/**
 * Moving points out of a partner's pocket into the spend-anywhere one costs the
 * holder 10%. The fee is burned rather than collected: it is deducted from what
 * the global balance receives and belongs to nobody afterwards, which retires
 * the liability instead of moving it. The transfer writes a ledger entry on each
 * side, and both carry the fee in their metadata, so the gap between what left
 * one pot and what reached the other is explained rather than unaccounted.
 */
const LP_TRANSFER_FEE_BPS = 1_000; // 10.00%
/**
 * The smallest transfer worth processing. Below 0.1 LP the 10% fee floors to
 * nothing and the move is free, so a floor is needed regardless; 10 LP is set
 * well clear of that rounding edge rather than right against it.
 */
const MIN_TRANSFER_CENTAVOS = 10_00; // 10 LP
/**
 * What global Loyalty Points convert into.
 *
 * A catalogue rather than a pair of constants because the app now renders it as
 * a storefront alongside the partners, and a second denomination should be one
 * row here rather than a new code path. One entry today.
 *
 * Cost and value are deliberately separate numbers. The cost is global LP the
 * holder gives up; the value is what the voucher takes off a bill, which is
 * also what the partner is reimbursed on their statement. They are not the same
 * figure and nothing should assume they are.
 */
export type GlobalReward = {
  id: string;
  name: string;
  description: string;
  /** Global LP debited from the wallet. */
  costCentavos: number;
  /** Face value of the voucher minted, in pesos. */
  valueCentavos: number;
  /** The bill the voucher applies to, in pesos. */
  minimumSpendCentavos: number;
};

const GLOBAL_REWARDS: readonly GlobalReward[] = [
  {
    id: "global_voucher_100",
    name: "₱100 off",
    // The minimum spend is shown on its own line by the card, so repeating it
    // here just says the same thing twice.
    description: "Spend it at any partner.",
    costCentavos: 500_00,
    valueCentavos: 100_00,
    minimumSpendCentavos: 500_00,
  },
];

function globalRewardOrThrow(rewardId?: string) {
  // Defaulted rather than required, so a client that predates the catalogue
  // still converts instead of erroring on a missing field.
  const reward = rewardId
    ? GLOBAL_REWARDS.find((candidate) => candidate.id === rewardId)
    : GLOBAL_REWARDS[0];
  if (!reward) {
    throw new AppError("E-GLOBAL-REWARD-404", "That reward was not found", 404);
  }
  return reward;
}

/** The catalogue, with every amount preformatted for display. */
export function listGlobalRewards() {
  return GLOBAL_REWARDS.map((reward) => ({
    ...reward,
    cost: centavosToLoyaltyPoints(reward.costCentavos),
    value: centavosToMoney(reward.valueCentavos),
    minimumSpend: centavosToMoney(reward.minimumSpendCentavos),
  }));
}

const isoNow = () => new Date().toISOString();
const id = (prefix: string) => `${prefix}_${crypto.randomBytes(8).toString("hex")}`;
const token = (prefix: string) => `${prefix}_${crypto.randomBytes(18).toString("base64url")}`;

/**
 * The ceiling every parsed amount passes, whichever route it arrived on.
 *
 * Here rather than in the route schemas because this is the one funnel they all
 * share — purchases, transfers, deposits, item prices and dev grants each parse
 * through it, and a cap repeated in eight zod schemas is a cap that drifts.
 *
 * Measured on the magnitude: deposit adjustments are signed, and a mistyped
 * debit overflows the column exactly as readily as a credit does.
 */
function assertWithinMoneyLimit(centavos: number, fieldName: string) {
  if (Math.abs(centavos) > MAX_MONEY_CENTAVOS) {
    throw new AppError(
      "E-MONEY-TOO-LARGE",
      `The ${fieldName} must be less than ${MAX_MONEY_DISPLAY}`,
      400,
    );
  }
  return centavos;
}

export function moneyToCentavos(value: unknown, fieldName = "amount") {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new AppError("E-MONEY-INVALID", `Invalid ${fieldName}`, 400);
    return assertWithinMoneyLimit(Math.round(value * 100), fieldName);
  }

  if (typeof value !== "string") {
    throw new AppError("E-MONEY-INVALID", `Invalid ${fieldName}`, 400);
  }

  const trimmed = value.trim().replace(/^₱/u, "").replace(/^PHP/i, "").replace(/[,\s]/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) {
    throw new AppError("E-MONEY-INVALID", `Invalid ${fieldName}`, 400);
  }
  const [whole, decimals = ""] = trimmed.split(".");
  return assertWithinMoneyLimit(
    Number(whole) * 100 + Number(decimals.padEnd(2, "0")),
    fieldName,
  );
}

export function centavosToMoney(amountCentavos: number) {
  // The sign belongs outside the symbol: deposit ledger rows are signed, and
  // "₱-1,000.00" reads as a currency code rather than a debit.
  const sign = amountCentavos < 0 ? "-" : "";
  return `${sign}₱${(Math.abs(amountCentavos) / 100).toLocaleString("en-PH", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/** LP is stored in hundredths, just like currency, to keep 5% calculations exact. */
export function centavosToLoyaltyPoints(pointsCentavos: number) {
  return `${(pointsCentavos / 100).toLocaleString("en-PH", {
    minimumFractionDigits: Number.isInteger(pointsCentavos / 100) ? 0 : 2,
    maximumFractionDigits: 2,
  })} LP`;
}

export function loyaltyPointsToCentavos(value: unknown, fieldName = "LP amount") {
  if (typeof value === "string") {
    return moneyToCentavos(value.trim().replace(/\s*LP$/i, ""), fieldName);
  }
  return moneyToCentavos(value, fieldName);
}

export function manilaDateParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    month: "2-digit",
    timeZone: "Asia/Manila",
    year: "numeric",
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return {
    date: `${value("year")}-${value("month")}-${value("day")}`,
    day: Number(value("day")),
    period: `${value("year")}-${value("month")}`,
  };
}

function nextPeriod(period: string) {
  const [year, month] = period.split("-").map(Number);
  const next = new Date(Date.UTC(year, month, 1));
  return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, "0")}`;
}

function settlementWindowFor(createdAt: string) {
  const redemptionPeriod = manilaDateParts(new Date(createdAt)).period;
  const payoutPeriod = nextPeriod(redemptionPeriod);
  return `${payoutPeriod}-01 to ${payoutPeriod}-07`;
}

function isSettlementEligible(createdAt: string) {
  const today = manilaDateParts();
  const redemptionPeriod = manilaDateParts(new Date(createdAt)).period;
  return today.day <= 7 && redemptionPeriod < today.period;
}

export function maskPhone(phone: string) {
  const digits = phone.replace(/\D/g, "");
  if (digits.length <= 4) return "••••";
  return `${digits.slice(0, 4)}••••${digits.slice(-3)}`;
}

function mapWallet(row: Row): RewardWallet {
  return {
    id: row.id,
    phone: row.phone,
    maskedPhone: maskPhone(row.phone),
    name: row.name ?? undefined,
    email: row.email ?? undefined,
    walletToken: row.wallet_token,
    balanceCentavos: row.balance_centavos,
    lifetimeEarnedCentavos: row.lifetime_earned_centavos,
    lifetimeConvertedCentavos: row.lifetime_converted_centavos,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapLedger(row: Row): RewardLedgerEntry {
  return {
    id: row.id,
    walletId: row.wallet_id,
    type: row.type,
    deltaCentavos: row.delta_centavos,
    balanceAfterCentavos: row.balance_after_centavos,
    sourceType: row.source_type,
    sourceId: row.source_id ?? undefined,
    businessId: row.business_id ?? undefined,
    staffName: row.staff_name ?? undefined,
    metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
    createdAt: row.created_at,
  };
}

function mapPurchase(row: Row): RewardPurchase {
  return {
    id: row.id,
    walletId: row.wallet_id,
    businessId: row.business_id,
    purchaseAmountCentavos: row.purchase_amount_centavos,
    rewardAmountCentavos: row.reward_amount_centavos,
    staffName: row.staff_name,
    status: row.status,
    idempotencyKey: row.idempotency_key ?? undefined,
    fraudFlag: row.fraud_flag ?? undefined,
    reviewedBy: row.reviewed_by ?? undefined,
    reviewedAt: row.reviewed_at ?? undefined,
    reviewNote: row.review_note ?? undefined,
    createdAt: row.created_at,
  };
}

function mapRewardVoucher(row: Row): RewardVoucher {
  return {
    id: row.id,
    walletId: row.wallet_id,
    voucherCode: row.voucher_code,
    qrToken: row.qr_token,
    amountCentavos: row.amount_centavos,
    remainingCentavos: row.remaining_centavos,
    // Null on vouchers minted before fixed denominations existed; those stay
    // spendable on any bill.
    minimumSpendCentavos: row.minimum_spend_centavos ?? undefined,
    status: row.status,
    issuedAt: row.issued_at,
    expiresAt: row.expires_at ?? undefined,
    redeemedAt: row.redeemed_at ?? undefined,
    createdAt: row.created_at,
  };
}

function mapRedemption(row: Row): RewardVoucherRedemption {
  return {
    id: row.id,
    voucherId: row.voucher_id,
    walletId: row.wallet_id,
    businessId: row.business_id,
    amountCentavos: row.amount_centavos,
    serviceFeeCentavos: Number(row.service_fee_centavos ?? 0),
    settlementAmountCentavos: Number(
      row.settlement_amount_centavos ?? row.amount_centavos,
    ),
    staffName: row.staff_name,
    settlementStatus: row.settlement_status,
    settlementId: row.settlement_id ?? undefined,
    createdAt: row.created_at,
  };
}

/**
 * Appends one entry to the tamper-evident log.
 *
 * Exported as `recordRewardAudit` for callers outside this module — account
 * deletion writes here so that "this account was deleted" is itself chained,
 * and unforgeable after the fact. Everything the log holds is an id or an
 * amount; never a name, a number or an email, which is what lets a deleted
 * customer's entries stay in the chain untouched.
 */
async function audit(
  db: Exec,
  input: {
    actorType: "customer" | "staff" | "system" | "admin";
    actorId?: string;
    action: string;
    entityType: string;
    entityId: string;
    metadata?: Record<string, unknown>;
  },
) {
  const createdAt = isoNow();
  const previous = await one(db, "SELECT event_hash FROM reward_audit_logs WHERE event_hash IS NOT NULL ORDER BY created_at DESC, id DESC LIMIT 1");
  const metadata = input.metadata ? JSON.stringify(input.metadata) : null;
  const hashPayload = JSON.stringify({
    previousHash: previous?.event_hash ?? null,
    actorType: input.actorType,
    actorId: input.actorId ?? null,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId,
    metadata,
    createdAt,
  });
  const eventHash = crypto.createHash("sha256").update(hashPayload).digest("hex");
  await run(
    db,
    `INSERT INTO reward_audit_logs (id, actor_type, actor_id, action, entity_type, entity_id, metadata, previous_hash, event_hash, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id("raud"),
      input.actorType,
      input.actorId ?? null,
      input.action,
      input.entityType,
      input.entityId,
      metadata,
      previous?.event_hash ?? null,
      eventHash,
      createdAt,
    ],
  );
}

export { audit as recordRewardAudit };

async function getBusinessOrThrow(db: Exec, businessId: string) {
  const row = await one(
    db,
    "SELECT id, name, deposit_balance_centavos FROM businesses WHERE id = ?",
    [businessId],
  );
  if (!row) throw new AppError("E-BUSINESS-404", "Business was not found", 404);
  return {
    id: String(row.id),
    name: String(row.name),
    // The partner's funding position gates LP issuance, so every caller that
    // already loads the business gets it without a second query.
    deposit_balance_centavos: Number(row.deposit_balance_centavos ?? 0),
  };
}

// The reward endpoints authenticate the caller from the httpOnly sign-in cookie
// and pass the resolved phone in, so functions only need to normalize it.
function requireWalletPhone(phone: string) {
  const normalized = normalizePhone(phone);
  if (!normalized) throw new AppError("E-USER-PHONE", "A valid Philippine mobile number is required", 400);
  return normalized;
}

async function walletByPhone(db: Exec, phone: string) {
  const normalized = normalizePhone(phone);
  if (!normalized) throw new AppError("E-USER-PHONE", "A valid Philippine mobile number is required", 400);
  const row = await one(db, "SELECT * FROM reward_wallets WHERE phone = ?", [normalized]);
  return row ? mapWallet(row) : undefined;
}

async function walletByPhoneAndSecret(db: Exec, phone: string, walletSecret: string) {
  const normalized = normalizePhone(phone);
  if (!normalized) throw new AppError("E-USER-PHONE", "A valid Philippine mobile number is required", 400);
  const row = await one(db, "SELECT * FROM reward_wallets WHERE phone = ? AND wallet_secret = ?", [
    normalized,
    walletSecret.trim(),
  ]);
  if (!row) throw new AppError("E-REWARD-WALLET-AUTH", "Loyalty Points wallet authorization is required", 401);
  const wallet = mapWallet(row);
  if (wallet.status !== "Active") throw new AppError("E-REWARD-WALLET-SUSPENDED", "Loyalty Points wallet is suspended", 409);
  return wallet;
}

async function walletByToken(db: Exec, walletToken: string) {
  const row = await one(db, "SELECT * FROM reward_wallets WHERE wallet_token = ?", [walletToken.trim()]);
  if (!row) throw new AppError("E-REWARD-WALLET-404", "Loyalty Points wallet was not found", 404);
  const wallet = mapWallet(row);
  if (wallet.status !== "Active") throw new AppError("E-REWARD-WALLET-SUSPENDED", "Loyalty Points wallet is suspended", 409);
  return wallet;
}

export async function ensureRewardWallet(
  db: Exec,
  input: { phone: string; name?: string; email?: string },
) {
  const normalized = requireWalletPhone(input.phone);
  const now = isoNow();
  await run(
    db,
    `INSERT OR IGNORE INTO reward_wallets
     (id, phone, name, email, wallet_token, wallet_secret, balance_centavos, lifetime_earned_centavos, lifetime_converted_centavos, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, 0, 0, 'Active', ?, ?)`,
    [
      id("rwal"),
      normalized,
      input.name ?? null,
      input.email ?? null,
      token("rwallet"),
      token("rwsecret"),
      now,
      now,
    ],
  );
  await run(
    db,
    `UPDATE reward_wallets
     SET name = COALESCE(?, name), email = COALESCE(?, email), updated_at = ?
     WHERE phone = ?`,
    [input.name ?? null, input.email ?? null, now, normalized],
  );
  return mapWallet(
    await one(db, "SELECT * FROM reward_wallets WHERE phone = ?", [normalized]),
  );
}

/**
 * Today's app-use draw: whole LP only, inclusive at both ends.
 *
 * Whole points because the figure is shown in the award modal and summed in
 * the ledger, where "7 LP" reads better than a fraction of one.
 */
function drawDailyAppUsePointsCentavos() {
  const minPoints = DAILY_APP_USE_MIN_POINTS_CENTAVOS / 100;
  const maxPoints = DAILY_APP_USE_MAX_POINTS_CENTAVOS / 100;
  return crypto.randomInt(minPoints, maxPoints + 1) * 100;
}

/** What the app shows before the draw: the band, not a promise of the top. */
function dailyAppUseRangeLabel() {
  return `${DAILY_APP_USE_MIN_POINTS_CENTAVOS / 100}–${centavosToLoyaltyPoints(
    DAILY_APP_USE_MAX_POINTS_CENTAVOS,
  )}`;
}

async function awardDailyLoyaltyPoints(
  db: Exec,
  input: {
    walletId: string;
    rewardType: "app_use" | "referral";
    sourceId?: string;
  },
) {
  const activeWallet = await one(
    db,
    "SELECT status FROM reward_wallets WHERE id = ?",
    [input.walletId],
  );
  if (!activeWallet || activeWallet.status !== "Active") {
    throw new AppError(
      "E-REWARD-WALLET-SUSPENDED",
      "Loyalty Points wallet is suspended",
      409,
    );
  }
  const rewardDate = manilaDateParts().date;
  const pointsCentavos =
    input.rewardType === "app_use"
      ? drawDailyAppUsePointsCentavos()
      : DAILY_REFERRAL_POINTS_CENTAVOS;
  const rewardId = id("lday");
  const now = isoNow();
  const inserted = await run(
    db,
    `INSERT OR IGNORE INTO loyalty_daily_rewards
     (id, wallet_id, reward_type, reward_date, points_centavos, source_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      rewardId,
      input.walletId,
      input.rewardType,
      rewardDate,
      pointsCentavos,
      input.sourceId ?? null,
      now,
    ],
  );
  if (inserted !== 1) return false;

  await run(
    db,
    `UPDATE reward_wallets
     SET balance_centavos = balance_centavos + ?,
         lifetime_earned_centavos = lifetime_earned_centavos + ?,
         updated_at = ?
     WHERE id = ? AND status = 'Active'`,
    [pointsCentavos, pointsCentavos, now, input.walletId],
  );
  const wallet = mapWallet(
    await one(db, "SELECT * FROM reward_wallets WHERE id = ?", [input.walletId]),
  );
  await run(
    db,
    `INSERT INTO reward_ledger_entries
     (id, wallet_id, type, delta_centavos, balance_after_centavos, source_type, source_id, metadata, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id("rled"),
      input.walletId,
      input.rewardType === "app_use" ? "daily_app_use" : "referral_bonus",
      pointsCentavos,
      wallet.balanceCentavos,
      input.rewardType === "app_use" ? "daily_app_use" : "daily_referral",
      input.sourceId ?? rewardId,
      JSON.stringify({ rewardDate, pointsCentavos }),
      now,
    ],
  );
  await audit(db, {
    actorType: "system",
    action:
      input.rewardType === "app_use"
        ? "daily_app_use_lp_awarded"
        : "daily_referral_lp_awarded",
    entityType: "loyalty_daily_reward",
    entityId: rewardId,
    metadata: {
      walletId: input.walletId,
      rewardDate,
      pointsCentavos,
      sourceId: input.sourceId ?? null,
    },
  });
  return true;
}

async function loyaltyDailyStatus(
  db: Exec,
  walletId: string,
): Promise<LoyaltyDailyStatus> {
  const date = manilaDateParts().date;
  const rows = await all(
    db,
    `SELECT reward_type, points_centavos
     FROM loyalty_daily_rewards
     WHERE wallet_id = ? AND reward_date = ?`,
    [walletId, date],
  );
  const appUse = rows.find((row) => row.reward_type === "app_use");
  const referral = rows.find((row) => row.reward_type === "referral");
  const earned = rows.reduce(
    (sum, row) => sum + Number(row.points_centavos),
    0,
  );
  return {
    date,
    appUseAwarded: Boolean(appUse),
    referralAwarded: Boolean(referral),
    // Once drawn, the status carries what was actually awarded - the award
    // modal reads this field, so a constant here would announce the wrong
    // number to anyone who drew below the top of the band.
    appUsePoints: appUse
      ? centavosToLoyaltyPoints(Number(appUse.points_centavos))
      : dailyAppUseRangeLabel(),
    referralPoints: centavosToLoyaltyPoints(
      DAILY_REFERRAL_POINTS_CENTAVOS,
    ),
    earnedToday: centavosToLoyaltyPoints(earned),
    monthlyPotential: centavosToLoyaltyPoints(
      (DAILY_APP_USE_MAX_POINTS_CENTAVOS +
        DAILY_REFERRAL_POINTS_CENTAVOS) *
        30,
    ),
  };
}

/** Called only after a distinct referral visit has passed anti-abuse checks. */
export async function awardReferralLoyaltyPoints(
  db: Exec,
  input: { phone: string; referralRewardId: string },
) {
  const wallet = await ensureRewardWallet(db, { phone: input.phone });
  return awardDailyLoyaltyPoints(db, {
    walletId: wallet.id,
    rewardType: "referral",
    sourceId: input.referralRewardId,
  });
}

/**
 * The wallet's per-partner pots, newest-richest first.
 *
 * Joined to businesses so the holder sees "Mesa Manila: 250 LP" rather than an
 * id. Empty buckets are dropped: a partner they earned at once and spent out is
 * noise in a wallet, not a balance.
 */
async function businessBalancesFor(db: Exec, walletId: string) {
  const rows = await all(
    db,
    `SELECT b.id AS business_id, b.name AS business_name, rbb.balance_centavos AS balance_centavos
     FROM reward_business_balances rbb
     JOIN businesses b ON b.id = rbb.business_id
     WHERE rbb.wallet_id = ? AND rbb.balance_centavos > 0
     ORDER BY rbb.balance_centavos DESC`,
    [walletId],
  );
  return rows.map((row: Row) => ({
    businessId: String(row.business_id),
    businessName: String(row.business_name),
    balance: centavosToLoyaltyPoints(Number(row.balance_centavos)),
    balanceCentavos: Number(row.balance_centavos),
  }));
}

export async function getOrCreateRewardWallet(input: {
  phone: string;
  name?: string;
  email?: string;
}) {
  return withTx(async (tx) => {
    const initialWallet = await ensureRewardWallet(tx, input);
    const appUseAwardedNow = await awardDailyLoyaltyPoints(tx, {
      walletId: initialWallet.id,
      rewardType: "app_use",
    });
    const wallet = mapWallet(
      await one(tx, "SELECT * FROM reward_wallets WHERE id = ?", [
        initialWallet.id,
      ]),
    );
    const secretRow = await one(tx, "SELECT wallet_secret FROM reward_wallets WHERE id = ?", [wallet.id]);
    const [ledger, vouchers] = await Promise.all([
      all(tx, "SELECT * FROM reward_ledger_entries WHERE wallet_id = ? ORDER BY created_at DESC LIMIT 12", [wallet.id]),
      all(tx, "SELECT * FROM reward_vouchers WHERE wallet_id = ? ORDER BY created_at DESC LIMIT 20", [wallet.id]),
    ]);

    await audit(tx, {
      actorType: "customer",
      actorId: wallet.id,
      action: "wallet_upserted",
      entityType: "reward_wallet",
      entityId: wallet.id,
    });

    return {
      wallet,
      walletSecret: String(secretRow.wallet_secret),
      /** The global pot: spend-anywhere, and the only one convertible to a voucher. */
      balance: centavosToLoyaltyPoints(wallet.balanceCentavos),
      // The app opens the wallet through this endpoint, not the snapshot, so
      // omitting the buckets here left every partner balance invisible on the
      // phone — and the storefront pricing itself off the wrong pot.
      businessBalances: await businessBalancesFor(tx, wallet.id),
      ledger: ledger.map(mapLedger),
      vouchers: vouchers.map(mapRewardVoucher),
      dailyStatus: await loyaltyDailyStatus(tx, wallet.id),
      appUseAwardedNow,
    };
  });
}

export async function rewardWalletSnapshot(input: {
  phone: string;
  walletSecret: string;
}) {
  const db = await getDb();
  const wallet = await walletByPhoneAndSecret(db, requireWalletPhone(input.phone), input.walletSecret);
  const [ledger, vouchers, businessBalances] = await Promise.all([
    all(db, "SELECT * FROM reward_ledger_entries WHERE wallet_id = ? ORDER BY created_at DESC LIMIT 12", [wallet.id]),
    all(db, "SELECT * FROM reward_vouchers WHERE wallet_id = ? ORDER BY created_at DESC LIMIT 20", [wallet.id]),
    businessBalancesFor(db, wallet.id),
  ]);
  return {
    wallet,
    walletSecret: input.walletSecret,
    /** The global pot: spend-anywhere, and the only one convertible to a voucher. */
    balance: centavosToLoyaltyPoints(wallet.balanceCentavos),
    /** Per-partner pots, spendable at that partner or transferable for a fee. */
    businessBalances,
    ledger: ledger.map(mapLedger),
    vouchers: vouchers.map(mapRewardVoucher),
    dailyStatus: await loyaltyDailyStatus(db, wallet.id),
  };
}

function fraudFlag(input: { purchaseCentavos: number; recentCount: number }) {
  if (input.purchaseCentavos > 100_000_00) return "high_payment_amount";
  if (input.recentCount >= 5) return "duplicate_scan_velocity";
  return undefined;
}

export async function creditRewardFromPurchase(input: {
  walletToken: string;
  businessId: string;
  purchaseAmount: string | number;
  staffName: string;
  idempotencyKey: string;
}) {
  return withTx(async (tx) => {
    const idempotencyKey = input.idempotencyKey.trim();
    if (idempotencyKey.length < 12 || idempotencyKey.length > 120) {
      throw new AppError("E-IDEMPOTENCY-KEY", "A valid idempotency key is required for purchase scans", 400);
    }
    const existingRow = await one(tx, "SELECT * FROM reward_purchases WHERE business_id = ? AND idempotency_key = ?", [
      input.businessId,
      idempotencyKey,
    ]);
    if (existingRow) {
      const existing = mapPurchase(existingRow);
      const wallet = mapWallet(await one(tx, "SELECT * FROM reward_wallets WHERE id = ?", [existing.walletId]));
      return {
        wallet,
        purchase: existing,
        rewardAmount: centavosToLoyaltyPoints(existing.rewardAmountCentavos),
        // The pot the scan credited, which is this partner's bucket — the checkout
        // is reporting what the customer just earned here, not their global pot.
        balance: centavosToLoyaltyPoints(
          await businessBalanceCentavos(tx, existing.walletId, input.businessId),
        ),
        globalBalance: centavosToLoyaltyPoints(wallet.balanceCentavos),
        fraudFlag: existing.fraudFlag,
        heldForReview: existing.status === "Held",
        idempotentReplay: true,
      };
    }

    const wallet = await walletByToken(tx, input.walletToken);
    const business = await getBusinessOrThrow(tx, input.businessId);
    // Issuing LP creates a liability the partner settles from their deposit. An
    // exhausted deposit means the next point issued is unfunded, so the checkout
    // stops earning until they top up. Being under the minimum is only a
    // warning — see MIN_DEPOSIT_CENTAVOS.
    if (Number(business.deposit_balance_centavos ?? 0) <= 0) {
      throw new AppError(
        "E-DEPOSIT-EXHAUSTED",
        "This partner's network deposit is used up. Loyalty Points cannot be issued until it is topped up.",
        409,
      );
    }
    const staffName = input.staffName.trim();
    if (staffName.length < 2) throw new AppError("E-STAFF-NAME", "Staff name is required", 400);

    const purchaseCentavos = moneyToCentavos(input.purchaseAmount, "purchase amount");
    if (purchaseCentavos <= 0 || purchaseCentavos > MAX_PURCHASE_CENTAVOS) {
      throw new AppError(
        "E-MONEY-RANGE",
        `Purchase amount must be between ₱0.01 and ${centavosToMoney(MAX_PURCHASE_CENTAVOS)} per scan`,
        400
      );
    }
    const rewardCentavos = Math.floor(
      (purchaseCentavos * LOYALTY_RATE_BPS) / 10_000,
    );
    if (rewardCentavos <= 0) {
      throw new AppError(
        "E-REWARD-TOO-SMALL",
        "Purchase amount is too small to earn Loyalty Points",
        400,
      );
    }

    const recentSince = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const recent = Number(
      (await one(
        tx,
        `SELECT COUNT(*) AS count FROM reward_purchases
         WHERE wallet_id = ? AND business_id = ? AND created_at >= ?`,
        [wallet.id, input.businessId, recentSince],
      )).count,
    );
    const flag = fraudFlag({ purchaseCentavos, recentCount: recent });
    const purchaseId = id("rpur");
    const now = isoNow();

    await run(
      tx,
      `INSERT INTO reward_purchases
       (id, wallet_id, business_id, purchase_amount_centavos, reward_amount_centavos, staff_name, idempotency_key, status, fraud_flag, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [purchaseId, wallet.id, input.businessId, purchaseCentavos, rewardCentavos, staffName, idempotencyKey, flag ? "Held" : "Accepted", flag ?? null, now],
    );

    let updated = wallet;
    // A held scan credits nothing yet, so the bucket reads whatever it already
    // held; review is what releases the points.
    let businessBalance = await businessBalanceCentavos(tx, wallet.id, input.businessId);
    if (!flag) {
      const credited = await applyRewardCredit(tx, {
        walletId: wallet.id,
        businessId: input.businessId,
        purchaseId,
        purchaseCentavos,
        rewardCentavos,
        staffName,
        metadata: { fraudFlag: null, idempotencyKey },
      });
      updated = credited.wallet;
      businessBalance = credited.businessBalance;
    }
    await audit(tx, {
      actorType: "staff",
      actorId: staffName,
      action: flag ? "reward_credit_held_for_review" : "reward_credit_issued",
      entityType: "reward_purchase",
      entityId: purchaseId,
      metadata: { walletId: wallet.id, businessId: input.businessId, purchaseCentavos, rewardCentavos, fraudFlag: flag, idempotencyKey },
    });

    return {
      wallet: updated,
      purchase: mapPurchase(await one(tx, "SELECT * FROM reward_purchases WHERE id = ?", [purchaseId])),
      rewardAmount: centavosToLoyaltyPoints(rewardCentavos),
      balance: centavosToLoyaltyPoints(businessBalance),
      globalBalance: centavosToLoyaltyPoints(updated.balanceCentavos),
      fraudFlag: flag,
      heldForReview: Boolean(flag),
      idempotentReplay: false,
    };
  });
}

/**
 * The wallet's bucket for one partner, created empty on first touch.
 *
 * `INSERT OR IGNORE` against the (wallet_id, business_id) unique index rather
 * than a read-then-insert: two checkouts scanning the same customer at the same
 * partner would both find nothing and both insert.
 */
async function ensureBusinessBalance(tx: Exec, walletId: string, businessId: string) {
  const now = isoNow();
  await run(
    tx,
    `INSERT OR IGNORE INTO reward_business_balances
     (id, wallet_id, business_id, balance_centavos, lifetime_earned_centavos, lifetime_transferred_centavos, created_at, updated_at)
     VALUES (?, ?, ?, 0, 0, 0, ?, ?)`,
    [id("rbb"), walletId, businessId, now, now],
  );
  return businessBalanceCentavos(tx, walletId, businessId);
}

async function businessBalanceCentavos(tx: Exec, walletId: string, businessId: string) {
  const row = await one(
    tx,
    "SELECT balance_centavos FROM reward_business_balances WHERE wallet_id = ? AND business_id = ?",
    [walletId, businessId],
  );
  return Number(row?.balance_centavos ?? 0);
}

/**
 * Credits points earned at a partner into that partner's bucket.
 *
 * The wallet's own `balance_centavos` is deliberately untouched: earning no
 * longer feeds the global pot directly, so the only ways in are a transfer
 * (which pays a fee) and the global-only sources, referrals and daily rewards.
 * `lifetime_earned_centavos` still counts everything, since it is a total across
 * partners rather than a spendable figure.
 *
 * `balance_after_centavos` on the ledger row is the balance of whichever pot
 * moved — here the partner bucket. Entries carry `business_id` when they refer
 * to a bucket and leave it null for the global pot, so the two stay tellable
 * apart when the ledger is read back.
 */
async function applyRewardCredit(
  tx: Exec,
  input: {
    walletId: string;
    businessId: string;
    purchaseId: string;
    purchaseCentavos: number;
    rewardCentavos: number;
    staffName: string;
    metadata?: Record<string, unknown>;
  },
) {
  const now = isoNow();
  await ensureBusinessBalance(tx, input.walletId, input.businessId);
  await run(
    tx,
    `UPDATE reward_business_balances
     SET balance_centavos = balance_centavos + ?,
         lifetime_earned_centavos = lifetime_earned_centavos + ?,
         updated_at = ?
     WHERE wallet_id = ? AND business_id = ?`,
    [input.rewardCentavos, input.rewardCentavos, now, input.walletId, input.businessId],
  );
  await run(
    tx,
    `UPDATE reward_wallets
     SET lifetime_earned_centavos = lifetime_earned_centavos + ?,
         updated_at = ?
     WHERE id = ?`,
    [input.rewardCentavos, now, input.walletId],
  );
  const businessBalance = await businessBalanceCentavos(tx, input.walletId, input.businessId);
  const updated = mapWallet(await one(tx, "SELECT * FROM reward_wallets WHERE id = ?", [input.walletId]));
  await run(
    tx,
    `INSERT INTO reward_ledger_entries
     (id, wallet_id, type, delta_centavos, balance_after_centavos, source_type, source_id, business_id, staff_name, metadata, created_at)
     VALUES (?, ?, 'credit_earned', ?, ?, 'staff_scan_purchase', ?, ?, ?, ?, ?)`,
    [
      id("rled"),
      input.walletId,
      input.rewardCentavos,
      businessBalance,
      input.purchaseId,
      input.businessId,
      input.staffName,
      JSON.stringify({ purchaseCentavos: input.purchaseCentavos, loyaltyRateBps: LOYALTY_RATE_BPS, ...(input.metadata ?? {}) }),
      now,
    ],
  );
  return { wallet: updated, businessBalance };
}

/**
 * Moves points out of one partner's bucket into the global pot, less the fee.
 *
 * The fee comes out of what arrives rather than being added on top: 1,000 LP
 * leaves the bucket and 900 lands. Charging it on top would leave the last
 * points in a bucket permanently untransferable, since there would be nothing
 * left to pay the fee with.
 */
export async function transferBusinessLpToGlobal(input: {
  phone: string;
  walletSecret: string;
  businessId: string;
  amount: string | number;
}) {
  return withTx(async (tx) => {
    const wallet = await walletByPhoneAndSecret(tx, requireWalletPhone(input.phone), input.walletSecret);
    const business = await getBusinessOrThrow(tx, input.businessId);
    const amountCentavos = loyaltyPointsToCentavos(input.amount, "transfer amount");

    // Dust transfers are refused outright: repeated below the rounding edge they
    // are a free route out of a bucket, and the fee is the whole point.
    if (amountCentavos < MIN_TRANSFER_CENTAVOS) {
      throw new AppError(
        "E-LP-TRANSFER-TOO-SMALL",
        `Transfer at least ${centavosToLoyaltyPoints(MIN_TRANSFER_CENTAVOS)} so the ${LP_TRANSFER_FEE_BPS / 100}% fee applies`,
        400,
      );
    }
    const feeCentavos = Math.floor((amountCentavos * LP_TRANSFER_FEE_BPS) / 10_000);
    const creditedCentavos = amountCentavos - feeCentavos;

    const now = isoNow();
    // Guarded UPDATE rather than a read-then-write: two transfers racing on the
    // same bucket would both read a sufficient balance and both proceed.
    const debited = await run(
      tx,
      `UPDATE reward_business_balances
       SET balance_centavos = balance_centavos - ?,
           lifetime_transferred_centavos = lifetime_transferred_centavos + ?,
           updated_at = ?
       WHERE wallet_id = ? AND business_id = ? AND balance_centavos >= ?`,
      [amountCentavos, amountCentavos, now, wallet.id, input.businessId, amountCentavos],
    );
    if (debited !== 1) {
      throw new AppError(
        "E-LP-BUSINESS-BALANCE",
        `Not enough Loyalty Points at ${business.name}`,
        409,
      );
    }

    const credited = await run(
      tx,
      `UPDATE reward_wallets
       SET balance_centavos = balance_centavos + ?, updated_at = ?
       WHERE id = ? AND status = 'Active'`,
      [creditedCentavos, now, wallet.id],
    );
    // A suspended wallet must not silently swallow the debit above. Throwing
    // rolls the whole transaction back rather than burning the points.
    if (credited !== 1) {
      throw new AppError("E-REWARD-WALLET-INACTIVE", "This wallet is not active", 409);
    }

    const bucketBalance = await businessBalanceCentavos(tx, wallet.id, input.businessId);
    const updated = mapWallet(await one(tx, "SELECT * FROM reward_wallets WHERE id = ?", [wallet.id]));
    const feeMetadata = {
      feeCentavos,
      grossCentavos: amountCentavos,
      creditedCentavos,
      feeBps: LP_TRANSFER_FEE_BPS,
    };
    await run(
      tx,
      `INSERT INTO reward_ledger_entries
       (id, wallet_id, type, delta_centavos, balance_after_centavos, source_type, source_id, business_id, metadata, created_at)
       VALUES (?, ?, 'transfer_out', ?, ?, 'customer_transfer', ?, ?, ?, ?)`,
      [id("rled"), wallet.id, -amountCentavos, bucketBalance, wallet.id, input.businessId, JSON.stringify(feeMetadata), now],
    );
    await run(
      tx,
      `INSERT INTO reward_ledger_entries
       (id, wallet_id, type, delta_centavos, balance_after_centavos, source_type, source_id, metadata, created_at)
       VALUES (?, ?, 'transfer_in', ?, ?, 'customer_transfer', ?, ?, ?)`,
      [id("rled"), wallet.id, creditedCentavos, updated.balanceCentavos, wallet.id, JSON.stringify(feeMetadata), now],
    );
    await audit(tx, {
      actorType: "customer",
      actorId: wallet.id,
      action: "loyalty_points_transferred",
      entityType: "reward_wallet",
      entityId: wallet.id,
      metadata: { businessId: input.businessId, ...feeMetadata },
    });

    return {
      wallet: updated,
      businessId: input.businessId,
      businessName: business.name,
      transferred: centavosToLoyaltyPoints(amountCentavos),
      fee: centavosToLoyaltyPoints(feeCentavos),
      credited: centavosToLoyaltyPoints(creditedCentavos),
      businessBalance: centavosToLoyaltyPoints(bucketBalance),
      balance: centavosToLoyaltyPoints(updated.balanceCentavos),
    };
  });
}

/**
 * Spends global LP on one voucher from the global catalogue.
 *
 * The cost leaves the wallet; the voucher is minted at its own face value, which
 * is the smaller number and the one the partner is later reimbursed. Fixed
 * denominations rather than an open amount, so the voucher reads as a coupon at
 * checkout instead of a balance to draw down, and so the minimum spend means the
 * same thing on every one issued.
 */
export async function convertRewardCreditToVoucher(input: {
  phone: string;
  walletSecret: string;
  rewardId?: string;
}) {
  return withTx(async (tx) => {
    const wallet = await walletByPhoneAndSecret(tx, requireWalletPhone(input.phone), input.walletSecret);
    const reward = globalRewardOrThrow(input.rewardId);

    const now = isoNow();
    const affected = await run(
      tx,
      `UPDATE reward_wallets
       SET balance_centavos = balance_centavos - ?,
           lifetime_converted_centavos = lifetime_converted_centavos + ?,
           updated_at = ?
       WHERE id = ? AND balance_centavos >= ? AND status = 'Active'`,
      [reward.costCentavos, reward.costCentavos, now, wallet.id, reward.costCentavos],
    );
    if (affected !== 1) {
      throw new AppError(
        "E-REWARD-BALANCE",
        `You need ${centavosToLoyaltyPoints(reward.costCentavos)} in Global LP for this voucher`,
        409,
      );
    }

    const updated = mapWallet(await one(tx, "SELECT * FROM reward_wallets WHERE id = ?", [wallet.id]));
    const voucherId = id("rvch");
    const voucherCode = generateVoucherCode("RWD");
    const qrToken = token("rvoucher");
    const expires = new Date();
    expires.setFullYear(expires.getFullYear() + 1);

    await run(
      tx,
      `INSERT INTO reward_vouchers
       (id, wallet_id, voucher_code, qr_token, amount_centavos, remaining_centavos, minimum_spend_centavos, status, issued_at, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'Active', ?, ?, ?)`,
      [voucherId, wallet.id, voucherCode, qrToken, reward.valueCentavos, reward.valueCentavos, reward.minimumSpendCentavos, now, expires.toISOString(), now],
    );
    await run(
      tx,
      `INSERT INTO reward_ledger_entries
       (id, wallet_id, type, delta_centavos, balance_after_centavos, source_type, source_id, metadata, created_at)
       VALUES (?, ?, 'voucher_converted', ?, ?, 'customer_conversion', ?, ?, ?)`,
      [
        id("rled"),
        wallet.id,
        -reward.costCentavos,
        updated.balanceCentavos,
        voucherId,
        // Both figures, because the ledger delta is the cost and the voucher is
        // worth something else — without this the gap looks like a bug.
        JSON.stringify({
          voucherCode,
          rewardId: reward.id,
          costCentavos: reward.costCentavos,
          valueCentavos: reward.valueCentavos,
        }),
        now,
      ],
    );
    await audit(tx, {
      actorType: "customer",
      actorId: wallet.id,
      action: "loyalty_points_converted",
      entityType: "reward_voucher",
      entityId: voucherId,
      metadata: {
        rewardId: reward.id,
        costCentavos: reward.costCentavos,
        valueCentavos: reward.valueCentavos,
      },
    });

    return {
      wallet: updated,
      reward,
      voucher: mapRewardVoucher(await one(tx, "SELECT * FROM reward_vouchers WHERE id = ?", [voucherId])),
      cost: centavosToLoyaltyPoints(reward.costCentavos),
      balance: centavosToLoyaltyPoints(updated.balanceCentavos),
    };
  });
}

async function loadRewardVoucher(db: Exec, codeOrToken: string) {
  const value = codeOrToken.trim();
  const upper = value.toUpperCase();
  const row = await one(db, "SELECT * FROM reward_vouchers WHERE UPPER(voucher_code) = ? OR qr_token = ?", [upper, value]);
  if (!row) throw new AppError("E-REWARD-VOUCHER-404", "LP voucher was not found", 404);
  return mapRewardVoucher(row);
}

export async function validateRewardVoucher(input: { codeOrToken: string }) {
  return withTx(async (tx) => {
    const voucher = await loadRewardVoucher(tx, input.codeOrToken);
    if (voucher.expiresAt && new Date(voucher.expiresAt).getTime() < Date.now() && voucher.status === "Active") {
      await run(tx, "UPDATE reward_vouchers SET status = 'Expired' WHERE id = ?", [voucher.id]);
      voucher.status = "Expired";
    }
    const wallet = mapWallet(await one(tx, "SELECT * FROM reward_wallets WHERE id = ?", [voucher.walletId]));
    // A storefront voucher buys one named item. Staff scanning it need to know
    // what to hand over; the amount alone does not say.
    const productRow = await one(
      tx,
      `SELECT p.id, p.name, p.description, b.id AS business_id, b.name AS business_name
       FROM reward_vouchers v
       JOIN reward_products p ON p.id = v.product_id
       JOIN businesses b ON b.id = v.business_id
       WHERE v.id = ?`,
      [voucher.id],
    );
    const product = productRow
      ? {
          id: String(productRow.id),
          name: String(productRow.name),
          description: productRow.description ? String(productRow.description) : "",
          businessId: String(productRow.business_id),
          businessName: String(productRow.business_name),
        }
      : undefined;
    return { voucher, wallet, product };
  });
}

export async function redeemRewardVoucher(input: {
  codeOrToken: string;
  businessId: string;
  amount: string | number;
  staffName: string;
  /**
   * The bill being paid, needed only by vouchers carrying a minimum spend.
   * Distinct from `amount`, which is how much of the voucher is being spent:
   * a ₱100 voucher against a ₱600 tab has `amount` 100 and this 600.
   */
  purchaseAmount?: string | number;
}) {
  return withTx(async (tx) => {
    await getBusinessOrThrow(tx, input.businessId);
    const staffName = input.staffName.trim();
    if (staffName.length < 2) throw new AppError("E-STAFF-NAME", "Staff name is required", 400);
    const amountCentavos = loyaltyPointsToCentavos(
      input.amount,
      "LP payment amount",
    );
    if (amountCentavos <= 0 || amountCentavos > MAX_REDEMPTION_CENTAVOS) {
      throw new AppError("E-MONEY-RANGE", "Voucher payment amount is outside the allowed range", 400);
    }

    const voucher = await loadRewardVoucher(tx, input.codeOrToken);
    if (voucher.status !== "Active") throw new AppError("E-REWARD-VOUCHER-INACTIVE", "LP voucher is not active", 409);
    if (voucher.expiresAt && new Date(voucher.expiresAt).getTime() < Date.now()) {
      await run(tx, "UPDATE reward_vouchers SET status = 'Expired' WHERE id = ?", [voucher.id]);
      throw new AppError("E-REWARD-VOUCHER-EXPIRED", "LP voucher is expired", 409);
    }
    if (amountCentavos > voucher.remainingCentavos) {
      throw new AppError(
        "E-REWARD-VOUCHER-BALANCE",
        "LP voucher does not have enough remaining points",
        409,
      );
    }

    // A voucher bought against a specific item is not a balance to spend down:
    // it is that item, at that partner. Redeeming part of it would leave a
    // remainder the customer could never use and bill the partner for less
    // than the item cost; redeeming it elsewhere would bill the wrong partner.
    const pinned = await one(
      tx,
      "SELECT business_id, product_id FROM reward_vouchers WHERE id = ?",
      [voucher.id],
    );
    if (pinned?.product_id) {
      if (String(pinned.business_id) !== input.businessId) {
        throw new AppError(
          "E-REWARD-VOUCHER-BUSINESS",
          "This item was bought from another partner and can only be collected there",
          409,
        );
      }
      if (amountCentavos !== voucher.remainingCentavos) {
        throw new AppError(
          "E-REWARD-VOUCHER-PARTIAL",
          "An item voucher must be redeemed in full",
          409,
        );
      }
    }

    // A fixed-denomination voucher is a coupon, not a balance: it is worth ₱100
    // off a qualifying bill or it is worth nothing. Both halves matter — without
    // the full-amount rule a customer could split one across several small bills
    // and dodge the floor entirely.
    if (voucher.minimumSpendCentavos) {
      if (input.purchaseAmount === undefined || input.purchaseAmount === "") {
        throw new AppError(
          "E-REWARD-VOUCHER-SPEND-REQUIRED",
          `Enter the purchase amount: this voucher has a ${centavosToMoney(voucher.minimumSpendCentavos)} minimum spend`,
          400,
        );
      }
      const purchaseCentavos = moneyToCentavos(input.purchaseAmount, "purchase amount");
      if (purchaseCentavos < voucher.minimumSpendCentavos) {
        throw new AppError(
          "E-REWARD-VOUCHER-MIN-SPEND",
          `This voucher has a ${centavosToMoney(voucher.minimumSpendCentavos)} minimum spend. The amount entered was ${centavosToMoney(purchaseCentavos)}.`,
          409,
        );
      }
      if (amountCentavos !== voucher.remainingCentavos) {
        throw new AppError(
          "E-REWARD-VOUCHER-PARTIAL",
          `This is a ${centavosToMoney(voucher.amountCentavos)} voucher and must be redeemed in full`,
          409,
        );
      }
    }

    // The service fee is no longer charged here. It is charged once a month, on
    // the net of LP issued against LP redeemed, so a partner whose customers
    // spend less than their checkout hands out pays no fee at all. Redemptions
    // therefore record their full value and `closeBusinessStatement` does the
    // arithmetic. See BusinessStatementTotals.
    const serviceFeeCentavos = 0;
    const settlementAmountCentavos = amountCentavos;
    const remaining = voucher.remainingCentavos - amountCentavos;
    const status = remaining === 0 ? "Redeemed" : "Active";
    const now = isoNow();
    const updatedRows = await run(
      tx,
      `UPDATE reward_vouchers
       SET remaining_centavos = ?, status = ?, redeemed_at = CASE WHEN ? = 0 THEN ? ELSE redeemed_at END
       WHERE id = ? AND remaining_centavos >= ? AND status = 'Active'`,
      [remaining, status, remaining, now, voucher.id, amountCentavos],
    );
    if (updatedRows !== 1) {
      throw new AppError("E-REWARD-VOUCHER-RACE", "LP voucher changed while redeeming. Validate it again.", 409);
    }

    const redemptionId = id("rred");
    await run(
      tx,
      `INSERT INTO reward_voucher_redemptions
       (id, voucher_id, wallet_id, business_id, amount_centavos, service_fee_centavos, settlement_amount_centavos, staff_name, settlement_status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Pending', ?)`,
      [
        redemptionId,
        voucher.id,
        voucher.walletId,
        input.businessId,
        amountCentavos,
        serviceFeeCentavos,
        settlementAmountCentavos,
        staffName,
        now,
      ],
    );
    await audit(tx, {
      actorType: "staff",
      actorId: staffName,
      action: "reward_voucher_redeemed",
      entityType: "reward_voucher_redemption",
      entityId: redemptionId,
      metadata: {
        voucherId: voucher.id,
        businessId: input.businessId,
        amountCentavos,
        serviceFeeBps: SERVICE_FEE_BPS,
        serviceFeeCentavos,
        settlementAmountCentavos,
        settlementStatus: "Pending",
      },
    });

    return {
      voucher: mapRewardVoucher(await one(tx, "SELECT * FROM reward_vouchers WHERE id = ?", [voucher.id])),
      redemption: mapRedemption(await one(tx, "SELECT * FROM reward_voucher_redemptions WHERE id = ?", [redemptionId])),
      amount: centavosToLoyaltyPoints(amountCentavos),
      serviceFee: centavosToLoyaltyPoints(serviceFeeCentavos),
      settlementAmount: centavosToLoyaltyPoints(
        settlementAmountCentavos,
      ),
    };
  });
}

export async function reviewHeldRewardPurchase(input: {
  purchaseId: string;
  decision: "approve" | "reject";
  reviewer: string;
  note?: string;
}) {
  return withTx(async (tx) => {
    const row = await one(tx, "SELECT * FROM reward_purchases WHERE id = ?", [input.purchaseId]);
    if (!row) throw new AppError("E-REWARD-PURCHASE-404", "Reward purchase was not found", 404);
    const purchase = mapPurchase(row);
    if (purchase.status !== "Held") throw new AppError("E-REWARD-PURCHASE-NOT-HELD", "Only held purchases can be reviewed", 409);
    const reviewer = input.reviewer.trim() || "Rewards Reviewer";
    const now = isoNow();

    let wallet = mapWallet(await one(tx, "SELECT * FROM reward_wallets WHERE id = ?", [purchase.walletId]));
    if (input.decision === "approve") {
      ({ wallet } = await applyRewardCredit(tx, {
        walletId: purchase.walletId,
        businessId: purchase.businessId,
        purchaseId: purchase.id,
        purchaseCentavos: purchase.purchaseAmountCentavos,
        rewardCentavos: purchase.rewardAmountCentavos,
        staffName: purchase.staffName,
        metadata: { fraudFlag: purchase.fraudFlag ?? null, reviewedBy: reviewer },
      }));
      await run(
        tx,
        "UPDATE reward_purchases SET status = 'Accepted', reviewed_by = ?, reviewed_at = ?, review_note = ? WHERE id = ?",
        [reviewer, now, input.note ?? null, purchase.id],
      );
    } else {
      await run(
        tx,
        "UPDATE reward_purchases SET status = 'Rejected', reviewed_by = ?, reviewed_at = ?, review_note = ? WHERE id = ?",
        [reviewer, now, input.note ?? null, purchase.id],
      );
    }

    await audit(tx, {
      actorType: "staff",
      actorId: reviewer,
      action: input.decision === "approve" ? "held_reward_approved" : "held_reward_rejected",
      entityType: "reward_purchase",
      entityId: purchase.id,
      metadata: { walletId: purchase.walletId, businessId: purchase.businessId, note: input.note ?? null },
    });

    return {
      wallet,
      purchase: mapPurchase(await one(tx, "SELECT * FROM reward_purchases WHERE id = ?", [purchase.id])),
      balance: centavosToLoyaltyPoints(wallet.balanceCentavos),
    };
  });
}

export async function adjustRewardRedemption(input: { redemptionId: string; reviewer: string; note: string }) {
  return withTx(async (tx) => {
    const row = await one(tx, "SELECT * FROM reward_voucher_redemptions WHERE id = ?", [input.redemptionId]);
    if (!row) throw new AppError("E-REDEMPTION-404", "Reward redemption was not found", 404);
    const reviewer = input.reviewer.trim() || "Settlement Reviewer";
    const note = input.note.trim();
    if (note.length < 3) throw new AppError("E-ADJUSTMENT-NOTE", "Adjustment note is required", 400);
    const now = isoNow();
    await run(
      tx,
      `UPDATE reward_voucher_redemptions
       SET settlement_status = 'Adjusted', settlement_verified_by = ?, settlement_verified_at = ?, adjustment_note = ?
       WHERE id = ?`,
      [reviewer, now, note, input.redemptionId],
    );
    await audit(tx, {
      actorType: "staff",
      actorId: reviewer,
      action: "reward_redemption_adjusted",
      entityType: "reward_voucher_redemption",
      entityId: input.redemptionId,
      metadata: { note },
    });
    return { redemptionId: input.redemptionId, status: "Adjusted" as const };
  });
}

export async function rewardsNetworkOverview() {
  const db = await getDb();
  // Five independent rollups for one page: batched so they cost one round trip
  // rather than five sequential ones.
  const [totalsRows, pendingRows, heldRows, purchaseRows, redemptionRows] = await batchAll(db, [
    {
      sql: `SELECT
        COALESCE(SUM(balance_centavos), 0) AS global_credit,
        -- Partner buckets are where earning lands now, so a liability read off
        -- the wallet's global pot alone describes a shrinking fraction of what
        -- the network actually owes. Both pots are spendable LP; they differ
        -- only in where they can be spent, so the headline total is their sum.
        (SELECT COALESCE(SUM(balance_centavos), 0) FROM reward_business_balances) AS partner_credit,
        COALESCE(SUM(lifetime_earned_centavos), 0) AS lifetime_earned,
        COALESCE(SUM(lifetime_converted_centavos), 0) AS lifetime_converted,
        COUNT(*) AS wallets
       FROM reward_wallets`,
    },
    {
      sql: `SELECT
         COALESCE(SUM(settlement_amount_centavos), 0) AS total,
         COALESCE(SUM(service_fee_centavos), 0) AS fees,
         COUNT(*) AS count
       FROM reward_voucher_redemptions
       WHERE settlement_status = 'Pending'`,
    },
    { sql: "SELECT COUNT(*) AS count FROM reward_purchases WHERE status = 'Held'" },
    {
      sql: `SELECT p.*, w.phone, b.name AS business_name
       FROM reward_purchases p
       JOIN reward_wallets w ON w.id = p.wallet_id
       JOIN businesses b ON b.id = p.business_id
       ORDER BY p.created_at DESC
       LIMIT 20`,
    },
    {
      sql: `SELECT r.*, w.phone, b.name AS business_name, v.voucher_code
       FROM reward_voucher_redemptions r
       JOIN reward_wallets w ON w.id = r.wallet_id
       JOIN businesses b ON b.id = r.business_id
       JOIN reward_vouchers v ON v.id = r.voucher_id
       ORDER BY r.created_at DESC
       LIMIT 20`,
    },
  ]);
  const totals = totalsRows[0];
  const pending = pendingRows[0];
  const held = heldRows[0];
  const purchases = purchaseRows.map((row) => ({
    ...mapPurchase(row),
    maskedPhone: maskPhone(row.phone),
    businessName: row.business_name,
    purchaseAmount: centavosToMoney(row.purchase_amount_centavos),
    rewardAmount: centavosToLoyaltyPoints(row.reward_amount_centavos),
  }));
  const redemptions = redemptionRows.map((row) => ({
    ...mapRedemption(row),
    maskedPhone: maskPhone(row.phone),
    businessName: row.business_name,
    voucherCode: row.voucher_code,
    amount: centavosToLoyaltyPoints(row.amount_centavos),
    serviceFee: centavosToLoyaltyPoints(
      Number(row.service_fee_centavos ?? 0),
    ),
    settlementAmount: centavosToLoyaltyPoints(
      Number(row.settlement_amount_centavos ?? row.amount_centavos),
    ),
    settlementPeriod: manilaDateParts(new Date(String(row.created_at))).period,
    settlementWindow: settlementWindowFor(String(row.created_at)),
    settlementEligible: isSettlementEligible(String(row.created_at)),
  }));

  const globalCredit = Number(totals.global_credit);
  const partnerCredit = Number(totals.partner_credit);

  return {
    summary: {
      wallets: Number(totals.wallets),
      /** Every LP a customer can still spend, in either pot. */
      outstandingCredit: centavosToLoyaltyPoints(globalCredit + partnerCredit),
      /** The spend-anywhere share of it. */
      outstandingGlobalCredit: centavosToLoyaltyPoints(globalCredit),
      /** The share locked to the partner it was earned at. */
      outstandingPartnerCredit: centavosToLoyaltyPoints(partnerCredit),
      lifetimeEarned: centavosToLoyaltyPoints(
        Number(totals.lifetime_earned),
      ),
      lifetimeConverted: centavosToLoyaltyPoints(
        Number(totals.lifetime_converted),
      ),
      pendingSettlement: centavosToLoyaltyPoints(Number(pending.total)),
      pendingServiceFees: centavosToLoyaltyPoints(Number(pending.fees)),
      pendingSettlementCount: Number(pending.count),
      heldReviewCount: Number(held.count),
    },
    purchases,
    redemptions,
  };
}

export async function listRewardSettlementRows(input: { businessId?: string; status?: RewardSettlementStatus } = {}) {
  const db = await getDb();
  const filters: string[] = [];
  const args: string[] = [];
  if (input.businessId) {
    filters.push("r.business_id = ?");
    args.push(input.businessId);
  }
  if (input.status) {
    filters.push("r.settlement_status = ?");
    args.push(input.status);
  }
  const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
  return (
    await all(
      db,
      `SELECT r.*, w.phone, b.name AS business_name, v.voucher_code
       FROM reward_voucher_redemptions r
       JOIN reward_wallets w ON w.id = r.wallet_id
       JOIN businesses b ON b.id = r.business_id
       JOIN reward_vouchers v ON v.id = r.voucher_id
       ${where}
       ORDER BY r.created_at DESC
       LIMIT 200`,
      args,
    )
  ).map((row) => ({
    redemptionId: row.id,
    settlementId: row.settlement_id ?? undefined,
    date: row.created_at,
    customerReference: maskPhone(row.phone),
    voucherCode: row.voucher_code,
    voucherAmount: centavosToLoyaltyPoints(row.amount_centavos),
    amountCentavos: row.amount_centavos,
    serviceFee: centavosToLoyaltyPoints(
      Number(row.service_fee_centavos ?? 0),
    ),
    serviceFeeCentavos: Number(row.service_fee_centavos ?? 0),
    storeBranch: row.business_name,
    settlementAmount: centavosToLoyaltyPoints(
      Number(row.settlement_amount_centavos ?? row.amount_centavos),
    ),
    settlementAmountCentavos: Number(
      row.settlement_amount_centavos ?? row.amount_centavos,
    ),
    settlementWindow: settlementWindowFor(String(row.created_at)),
    settlementEligible: isSettlementEligible(String(row.created_at)),
    status: row.settlement_status,
    verifiedBy: row.settlement_verified_by ?? undefined,
    verifiedAt: row.settlement_verified_at ?? undefined,
    adjustmentNote: row.adjustment_note ?? undefined,
  }));
}

export async function listRewardAuditRows() {
  const db = await getDb();
  return (
    await all(
      db,
      `SELECT * FROM reward_audit_logs
       ORDER BY created_at DESC, id DESC
       LIMIT 500`,
    )
  ).map((row) => ({
    id: row.id,
    createdAt: row.created_at,
    actorType: row.actor_type,
    actorId: row.actor_id ?? "",
    action: row.action,
    entityType: row.entity_type,
    entityId: row.entity_id,
    metadata: row.metadata ?? "",
    previousHash: row.previous_hash ?? "",
    eventHash: row.event_hash ?? "",
  }));
}

export function rewardAuditRowsToCsv(rows: Awaited<ReturnType<typeof listRewardAuditRows>>) {
  const headers = ["createdAt", "actorType", "actorId", "action", "entityType", "entityId", "metadata", "previousHash", "eventHash"];
  const escape = (value: unknown) => `"${String(value ?? "").replace(/"/g, '""')}"`;
  return [
    headers.join(","),
    ...rows.map((row) => headers.map((header) => escape(row[header as keyof typeof row])).join(",")),
  ].join("\n");
}

// ---- Partner deposits ----

export type BusinessDepositEntry = {
  id: string;
  businessId: string;
  type: "TopUp" | "StatementDeduction" | "Adjustment" | "Refund";
  amountCentavos: number;
  amount: string;
  balanceAfterCentavos: number;
  balanceAfter: string;
  reference: string;
  note: string;
  recordedBy: string;
  statementId: string;
  createdAt: string;
};

function mapDepositEntry(row: Row): BusinessDepositEntry {
  return {
    id: row.id,
    businessId: row.business_id,
    type: row.type,
    amountCentavos: Number(row.amount_centavos),
    amount: centavosToMoney(Number(row.amount_centavos)),
    balanceAfterCentavos: Number(row.balance_after_centavos),
    balanceAfter: centavosToMoney(Number(row.balance_after_centavos)),
    reference: row.reference ?? "",
    note: row.note ?? "",
    recordedBy: row.recorded_by,
    statementId: row.statement_id ?? "",
    createdAt: row.created_at,
  };
}

/**
 * Moves a partner's deposit and records the movement in one step. `amountCentavos`
 * is signed, and a statement deduction is allowed to push the balance negative:
 * that shortfall is real money owed, and hiding it behind a floor of zero would
 * quietly forgive it. New LP issuance is what stops at zero, not this.
 */
async function applyDepositMovement(
  db: Exec,
  input: {
    businessId: string;
    type: BusinessDepositEntry["type"];
    amountCentavos: number;
    reference?: string;
    note?: string;
    recordedBy: string;
    statementId?: string;
  },
) {
  const business = await getBusinessOrThrow(db, input.businessId);
  const balanceBefore = Number(business.deposit_balance_centavos ?? 0);
  const balanceAfter = balanceBefore + input.amountCentavos;
  const entryId = id("bdep");
  await run(db, "UPDATE businesses SET deposit_balance_centavos = ? WHERE id = ?", [
    balanceAfter,
    input.businessId,
  ]);
  await run(
    db,
    `INSERT INTO business_deposit_entries
     (id, business_id, type, amount_centavos, balance_after_centavos, reference, note, recorded_by, statement_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      entryId,
      input.businessId,
      input.type,
      input.amountCentavos,
      balanceAfter,
      input.reference?.trim() || null,
      input.note?.trim() || null,
      input.recordedBy,
      input.statementId ?? null,
      isoNow(),
    ],
  );
  await audit(db, {
    actorType: "staff",
    actorId: input.recordedBy,
    action: "business_deposit_movement",
    entityType: "business_deposit_entry",
    entityId: entryId,
    metadata: {
      businessId: input.businessId,
      type: input.type,
      amountCentavos: input.amountCentavos,
      balanceBeforeCentavos: balanceBefore,
      balanceAfterCentavos: balanceAfter,
      statementId: input.statementId ?? null,
    },
  });
  return { entryId, balanceBefore, balanceAfter };
}

export type BusinessDepositStatus = {
  businessId: string;
  balanceCentavos: number;
  balance: string;
  minimumCentavos: number;
  minimum: string;
  /** Under the network minimum: trading continues, the dashboard nags. */
  belowMinimum: boolean;
  /** Exhausted: no further LP can be issued at this partner's checkout. */
  blocked: boolean;
  topUpDueCentavos: number;
  topUpDue: string;
};

export function depositStatusFor(
  businessId: string,
  balanceCentavos: number,
): BusinessDepositStatus {
  return {
    businessId,
    balanceCentavos,
    balance: centavosToMoney(balanceCentavos),
    minimumCentavos: MIN_DEPOSIT_CENTAVOS,
    minimum: centavosToMoney(MIN_DEPOSIT_CENTAVOS),
    belowMinimum: balanceCentavos < MIN_DEPOSIT_CENTAVOS,
    blocked: balanceCentavos <= 0,
    topUpDueCentavos: Math.max(0, MIN_DEPOSIT_CENTAVOS - balanceCentavos),
    topUpDue: centavosToMoney(Math.max(0, MIN_DEPOSIT_CENTAVOS - balanceCentavos)),
  };
}

export async function businessDepositStatus(businessId: string) {
  const db = await getDb();
  const business = await getBusinessOrThrow(db, businessId);
  return depositStatusFor(businessId, Number(business.deposit_balance_centavos ?? 0));
}

export async function recordBusinessDeposit(input: {
  businessId: string;
  amount: string | number;
  reference?: string;
  note?: string;
  recordedBy: string;
}) {
  return withTx(async (tx) => {
    const amountCentavos = moneyToCentavos(input.amount, "deposit amount");
    if (amountCentavos <= 0) {
      throw new AppError("E-DEPOSIT-AMOUNT", "Deposit amount must be greater than zero", 400);
    }
    const recordedBy = input.recordedBy.trim() || "Finance";
    const movement = await applyDepositMovement(tx, {
      businessId: input.businessId,
      type: "TopUp",
      amountCentavos,
      reference: input.reference,
      note: input.note,
      recordedBy,
    });
    return {
      entryId: movement.entryId,
      amount: centavosToMoney(amountCentavos),
      status: depositStatusFor(input.businessId, movement.balanceAfter),
    };
  });
}

export async function listBusinessDepositEntries(businessId: string, limit = 50) {
  const db = await getDb();
  const rows = await all(
    db,
    // Newest first, breaking ties on insertion order rather than id: a top-up
    // and the deduction that follows it can land in the same second, and a
    // random-hex id would then order the ledger arbitrarily.
    `SELECT * FROM business_deposit_entries
     WHERE business_id = ?
     ORDER BY created_at DESC, seq DESC
     LIMIT ?`,
    [businessId, limit],
  );
  return rows.map(mapDepositEntry);
}

// ---- Monthly statements ----

/**
 * A partner's two sides for a calendar month, in LP hundredths:
 *
 *   issued    LP their checkout handed out on purchases â€” money they owe us, since
 *             we carry the liability until the customer spends it.
 *   redeemed  LP their customers spent with them â€” money we owe them.
 *
 * The sides are netted once, at close. The 10% service fee is charged on the
 * net payout only: a month the partner finishes owing us costs them no fee,
 * and a month they finish owed PHP 1,000 pays out PHP 900.
 */
export type BusinessStatementTotals = {
  businessId: string;
  period: string;
  issuedCentavos: number;
  issued: string;
  issuedCount: number;
  redeemedCentavos: number;
  redeemed: string;
  redeemedCount: number;
  /** Positive: we owe the partner. Negative: the partner owes us. */
  netCentavos: number;
  net: string;
  direction: "Payout" | "Collection" | "Balanced";
  serviceFeeCentavos: number;
  serviceFee: string;
  /** What we hand over after the fee, when the net runs their way. */
  payoutCentavos: number;
  payout: string;
  /** What comes off the deposit, when the net runs our way. */
  depositDeductionCentavos: number;
  depositDeduction: string;
};

function settleNet(
  businessId: string,
  period: string,
  issued: { centavos: number; count: number },
  redeemed: { centavos: number; count: number },
): BusinessStatementTotals {
  const netCentavos = redeemed.centavos - issued.centavos;
  const serviceFeeCentavos =
    netCentavos > 0 ? Math.floor((netCentavos * SERVICE_FEE_BPS) / 10_000) : 0;
  const payoutCentavos = netCentavos > 0 ? netCentavos - serviceFeeCentavos : 0;
  const depositDeductionCentavos = netCentavos < 0 ? Math.abs(netCentavos) : 0;
  return {
    businessId,
    period,
    issuedCentavos: issued.centavos,
    issued: centavosToMoney(issued.centavos),
    issuedCount: issued.count,
    redeemedCentavos: redeemed.centavos,
    redeemed: centavosToMoney(redeemed.centavos),
    redeemedCount: redeemed.count,
    netCentavos,
    net: centavosToMoney(Math.abs(netCentavos)),
    direction:
      netCentavos > 0 ? "Payout" : netCentavos < 0 ? "Collection" : "Balanced",
    serviceFeeCentavos,
    serviceFee: centavosToMoney(serviceFeeCentavos),
    payoutCentavos,
    payout: centavosToMoney(payoutCentavos),
    depositDeductionCentavos,
    depositDeduction: centavosToMoney(depositDeductionCentavos),
  };
}

/**
 * The month's running totals, straight from the source rows. Only accepted
 * purchases count: one still Held for fraud review has not credited the
 * customer's wallet either, so billing the partner for it would have to be
 * clawed back if the review rejects it. An approved review flips the row to
 * Accepted, which brings it into the next total.
 */
async function statementTotals(db: Exec, businessId: string, period: string) {
  const issuedRow = await one(
    db,
    `SELECT COALESCE(SUM(reward_amount_centavos), 0) AS total, COUNT(*) AS count
     FROM reward_purchases
     WHERE business_id = ? AND status = 'Accepted'
       AND substr(created_at, 1, 7) = ?`,
    [businessId, period],
  );
  const redeemedRow = await one(
    db,
    `SELECT COALESCE(SUM(amount_centavos), 0) AS total, COUNT(*) AS count
     FROM reward_voucher_redemptions
     WHERE business_id = ? AND substr(created_at, 1, 7) = ?`,
    [businessId, period],
  );
  return settleNet(
    businessId,
    period,
    {
      centavos: Number(issuedRow?.total ?? 0),
      count: Number(issuedRow?.count ?? 0),
    },
    {
      centavos: Number(redeemedRow?.total ?? 0),
      count: Number(redeemedRow?.count ?? 0),
    },
  );
}

/** Live totals for a month that has not been closed yet. */
export async function businessStatementPreview(input: {
  businessId: string;
  period?: string;
}) {
  const db = await getDb();
  await getBusinessOrThrow(db, input.businessId);
  const period = input.period ?? manilaDateParts().period;
  return statementTotals(db, input.businessId, period);
}

export type BusinessStatement = BusinessStatementTotals & {
  id: string;
  status: string;
  paymentReference: string;
  paymentRecordedBy: string;
  paidAt: string;
  createdAt: string;
  processedAt: string;
};

function mapStatement(row: Row): BusinessStatement {
  const issued = Number(row.lp_issued_centavos ?? 0);
  const redeemed = Number(
    row.lp_redeemed_centavos ?? row.gross_amount_centavos ?? 0,
  );
  return {
    ...settleNet(
      row.business_id,
      row.period,
      { centavos: issued, count: 0 },
      { centavos: redeemed, count: 0 },
    ),
    id: row.id,
    status: row.status,
    paymentReference: row.payment_reference ?? row.gcash_reference ?? "",
    paymentRecordedBy: row.payment_recorded_by ?? "",
    paidAt: row.paid_at ?? "",
    createdAt: row.created_at,
    processedAt: row.processed_at ?? "",
  };
}

/**
 * Closes a month for one partner: nets the two sides, charges the fee if the
 * balance runs their way, and draws the deposit down if it runs ours. Runs in
 * the same 1st-7th window as the legacy payout run, and refuses a month that
 * has not finished â€” a period still taking transactions cannot be reconciled.
 */
export async function closeBusinessStatement(input: {
  businessId: string;
  period: string;
  reviewer: string;
  /**
   * Skips the 1st-7th gate. Refused outside development: the window is a real
   * finance rule, but it also makes the settlement leg untestable for three
   * weeks of every month.
   */
  devIgnoreWindow?: boolean;
}) {
  return withTx(async (tx) => {
    await getBusinessOrThrow(tx, input.businessId);
    const reviewer = input.reviewer.trim() || "Settlement Reviewer";
    const today = manilaDateParts();
    if (input.period >= today.period) {
      throw new AppError(
        "E-STATEMENT-PERIOD",
        "Only a completed month can be closed",
        409,
      );
    }
    const ignoreWindow = input.devIgnoreWindow === true && devToolsEnabled();
    if (today.day > 7 && !ignoreWindow) {
      throw new AppError(
        "E-STATEMENT-WINDOW",
        "Statements can only be closed during the first 7 days of each month",
        409,
      );
    }
    const existing = await one(
      tx,
      "SELECT * FROM reward_settlements WHERE business_id = ? AND period = ?",
      [input.businessId, input.period],
    );
    if (existing) {
      throw new AppError(
        "E-STATEMENT-CLOSED",
        "This period has already been closed for this business",
        409,
      );
    }

    const totals = await statementTotals(tx, input.businessId, input.period);
    const statementId = id("rset");
    const now = isoNow();
    await run(
      tx,
      `INSERT INTO reward_settlements
       (id, business_id, period, gross_amount_centavos, service_fee_centavos, total_amount_centavos,
        lp_issued_centavos, lp_redeemed_centavos, net_centavos, direction, deposit_deduction_centavos,
        status, created_at, processed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        statementId,
        input.businessId,
        input.period,
        totals.redeemedCentavos,
        totals.serviceFeeCentavos,
        totals.payoutCentavos,
        totals.issuedCentavos,
        totals.redeemedCentavos,
        totals.netCentavos,
        totals.direction,
        totals.depositDeductionCentavos,
        // A collection is settled the moment the deposit is drawn; a payout
        // waits on a manual transfer being recorded against it.
        totals.direction === "Payout" ? "Processed" : "Collected",
        now,
        now,
      ],
    );

    if (totals.depositDeductionCentavos > 0) {
      await applyDepositMovement(tx, {
        businessId: input.businessId,
        type: "StatementDeduction",
        amountCentavos: -totals.depositDeductionCentavos,
        note: `Net LP owed for ${input.period}`,
        recordedBy: reviewer,
        statementId,
      });
    }

    await run(
      tx,
      `UPDATE reward_voucher_redemptions
       SET settlement_status = 'Processed', settlement_id = ?, settlement_verified_by = ?, settlement_verified_at = ?
       WHERE business_id = ? AND substr(created_at, 1, 7) = ? AND settlement_status = 'Pending'`,
      [statementId, reviewer, now, input.businessId, input.period],
    );

    await audit(tx, {
      actorType: "staff",
      actorId: reviewer,
      action: "business_statement_closed",
      entityType: "reward_settlement",
      entityId: statementId,
      metadata: {
        businessId: input.businessId,
        period: input.period,
        issuedCentavos: totals.issuedCentavos,
        redeemedCentavos: totals.redeemedCentavos,
        netCentavos: totals.netCentavos,
        serviceFeeBps: SERVICE_FEE_BPS,
        serviceFeeCentavos: totals.serviceFeeCentavos,
        payoutCentavos: totals.payoutCentavos,
        depositDeductionCentavos: totals.depositDeductionCentavos,
      },
    });

    return { statementId, ...totals };
  });
}

/**
 * Records a payout we have actually sent. The transfer itself is manual, so
 * this row is the only proof it happened â€” a reference is required.
 */
export async function recordStatementPayment(input: {
  statementId: string;
  reference: string;
  recordedBy: string;
}) {
  return withTx(async (tx) => {
    const reference = input.reference.trim();
    if (reference.length < 4) {
      throw new AppError(
        "E-STATEMENT-REFERENCE",
        "A payment reference is required",
        400,
      );
    }
    const row = await one(tx, "SELECT * FROM reward_settlements WHERE id = ?", [
      input.statementId,
    ]);
    if (!row) throw new AppError("E-STATEMENT-404", "Statement was not found", 404);
    if (row.direction === "Collection" || row.direction === "Balanced") {
      throw new AppError(
        "E-STATEMENT-DIRECTION",
        "This period was settled against the partner's deposit, so there is nothing to pay",
        409,
      );
    }
    if (row.paid_at) {
      throw new AppError(
        "E-STATEMENT-PAID",
        "This statement is already marked paid",
        409,
      );
    }
    const recordedBy = input.recordedBy.trim() || "Finance";
    const now = isoNow();
    await run(
      tx,
      `UPDATE reward_settlements
       SET status = 'Paid', paid_at = ?, payment_reference = ?, payment_recorded_by = ?, gcash_reference = ?
       WHERE id = ?`,
      [now, reference, recordedBy, reference, input.statementId],
    );
    await audit(tx, {
      actorType: "staff",
      actorId: recordedBy,
      action: "business_statement_paid",
      entityType: "reward_settlement",
      entityId: input.statementId,
      metadata: {
        businessId: row.business_id,
        period: row.period,
        payoutCentavos: Number(row.total_amount_centavos ?? 0),
        reference,
      },
    });
    return mapStatement(
      await one(tx, "SELECT * FROM reward_settlements WHERE id = ?", [
        input.statementId,
      ]),
    );
  });
}

export async function listBusinessStatements(input: { businessId?: string } = {}) {
  const db = await getDb();
  const rows = input.businessId
    ? await all(
        db,
        "SELECT * FROM reward_settlements WHERE business_id = ? ORDER BY period DESC, created_at DESC",
        [input.businessId],
      )
    : await all(
        db,
        "SELECT * FROM reward_settlements ORDER BY period DESC, created_at DESC",
      );
  return rows.map(mapStatement);
}

/** Everything the partner-facing billing page needs, in one pass. */
export async function businessBillingOverview(businessId: string) {
  const db = await getDb();
  const business = await getBusinessOrThrow(db, businessId);
  const period = manilaDateParts().period;
  const [current, statements, deposits] = await Promise.all([
    statementTotals(db, businessId, period),
    listBusinessStatements({ businessId }),
    listBusinessDepositEntries(businessId),
  ]);
  return {
    business: { id: businessId, name: String(business.name) },
    deposit: depositStatusFor(
      businessId,
      Number(business.deposit_balance_centavos ?? 0),
    ),
    current,
    statements,
    deposits,
  };
}

// ---- LP storefront ----

export type RewardProduct = {
  id: string;
  businessId: string;
  businessName: string;
  /** The partner's trade (`restaurant`, `beauty`, …), used to colour its storefront. */
  businessIndustry: string;
  name: string;
  description: string;
  imageUrl: string;
  priceCentavos: number;
  price: string;
  status: "Active" | "Hidden";
  createdAt: string;
  /**
   * Artwork for the partner, borrowed from their current campaign. Items have
   * no photography of their own, and an unillustrated storefront next to the
   * campaign directory reads as broken rather than minimal.
   */
  campaign?: {
    heroImage: string;
    slug: string;
    title: string;
    mode: string;
  };
};

function mapRewardProduct(row: Row): RewardProduct {
  return {
    campaign: row.campaign_slug
      ? {
          heroImage: String(row.campaign_hero_image ?? ""),
          slug: String(row.campaign_slug),
          title: String(row.campaign_title ?? ""),
          mode: String(row.campaign_mode ?? "other"),
        }
      : undefined,
    id: row.id,
    businessId: row.business_id,
    businessName: row.business_name ?? "",
    // The partner's own trade, not the campaign's mode: a partner keeps its
    // industry whether or not it is running a campaign, so the storefront can
    // colour itself consistently either way.
    businessIndustry: String(row.business_industry ?? "other"),
    name: row.name,
    description: row.description ?? "",
    imageUrl: row.image_url ?? "",
    priceCentavos: Number(row.price_centavos),
    price: centavosToLoyaltyPoints(Number(row.price_centavos)),
    status: row.status,
    createdAt: row.created_at,
  };
}

/**
 * Storefront rows always carry their partner's name and current campaign
 * artwork; the campaign join picks the newest active one, and stays a LEFT JOIN
 * so a partner between campaigns still sells.
 */
const PRODUCT_SELECT = `SELECT p.*, b.name AS business_name, b.industry AS business_industry,
            c.hero_image AS campaign_hero_image, c.slug AS campaign_slug,
            c.title AS campaign_title, c.mode AS campaign_mode
     FROM reward_products p
     JOIN businesses b ON b.id = p.business_id
     LEFT JOIN campaigns c ON c.id = (
       SELECT id FROM campaigns
       WHERE business_id = p.business_id AND status = 'active'
       ORDER BY start_date DESC, id DESC
       LIMIT 1
     )`;

/**
 * The storefront. Hidden items stay in the table rather than being deleted so
 * that a voucher already bought against one still resolves to its product.
 */
export async function listRewardProducts(
  input: { businessId?: string; includeHidden?: boolean } = {},
) {
  const db = await getDb();
  const clauses: string[] = [];
  const args: Array<string> = [];
  if (input.businessId) {
    clauses.push("p.business_id = ?");
    args.push(input.businessId);
  }
  if (!input.includeHidden) clauses.push("p.status = 'Active'");
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = await all(
    db,
    `${PRODUCT_SELECT}
     ${where}
     ORDER BY p.price_centavos ASC, p.name ASC`,
    args,
  );
  return rows.map(mapRewardProduct);
}

export async function getRewardProduct(productId: string) {
  const db = await getDb();
  const row = await one(db, `${PRODUCT_SELECT} WHERE p.id = ?`, [productId]);
  if (!row) throw new AppError("E-PRODUCT-404", "Item was not found", 404);
  return mapRewardProduct(row);
}

export async function saveRewardProduct(input: {
  id?: string;
  businessId: string;
  name: string;
  description?: string;
  imageUrl?: string;
  price: string | number;
  status?: "Active" | "Hidden";
  actor: string;
}) {
  return withTx(async (tx) => {
    await getBusinessOrThrow(tx, input.businessId);
    const name = input.name.trim();
    if (name.length < 2) {
      throw new AppError("E-PRODUCT-NAME", "An item name is required", 400);
    }
    const priceCentavos = loyaltyPointsToCentavos(input.price, "item price");
    if (priceCentavos < MIN_CONVERSION_CENTAVOS) {
      throw new AppError(
        "E-PRODUCT-PRICE",
        `An item must cost at least ${centavosToLoyaltyPoints(MIN_CONVERSION_CENTAVOS)}`,
        400,
      );
    }
    const now = isoNow();
    const productId = input.id ?? id("rprod");
    if (input.id) {
      const updated = await run(
        tx,
        `UPDATE reward_products
         SET name = ?, description = ?, image_url = ?, price_centavos = ?, status = ?, updated_at = ?
         WHERE id = ? AND business_id = ?`,
        [
          name,
          input.description?.trim() || null,
          input.imageUrl?.trim() || null,
          priceCentavos,
          input.status ?? "Active",
          now,
          input.id,
          input.businessId,
        ],
      );
      if (updated !== 1) {
        throw new AppError("E-PRODUCT-404", "Item was not found", 404);
      }
    } else {
      await run(
        tx,
        `INSERT INTO reward_products
         (id, business_id, name, description, image_url, price_centavos, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          productId,
          input.businessId,
          name,
          input.description?.trim() || null,
          input.imageUrl?.trim() || null,
          priceCentavos,
          input.status ?? "Active",
          now,
          now,
        ],
      );
    }
    await audit(tx, {
      actorType: "staff",
      actorId: input.actor,
      action: input.id ? "reward_product_updated" : "reward_product_created",
      entityType: "reward_product",
      entityId: productId,
      metadata: { businessId: input.businessId, name, priceCentavos },
    });
    return getRewardProductIn(tx, productId);
  });
}

async function getRewardProductIn(db: Exec, productId: string) {
  const row = await one(db, `${PRODUCT_SELECT} WHERE p.id = ?`, [productId]);
  if (!row) throw new AppError("E-PRODUCT-404", "Item was not found", 404);
  return mapRewardProduct(row);
}

/**
 * Buys a storefront item with LP. Mechanically this is a conversion pinned to
 * one item: the points leave the wallet now and become a voucher the partner's
 * staff scans at handover, which is what puts the amount on their statement.
 * Pinning `business_id` stops an item bought at one partner being spent at
 * another, which a plain LP voucher deliberately allows.
 */
export async function purchaseRewardProduct(input: {
  phone: string;
  walletSecret: string;
  productId: string;
}) {
  return withTx(async (tx) => {
    const wallet = await walletByPhoneAndSecret(
      tx,
      requireWalletPhone(input.phone),
      input.walletSecret,
    );
    const product = await getRewardProductIn(tx, input.productId);
    if (product.status !== "Active") {
      throw new AppError("E-PRODUCT-UNAVAILABLE", "This item is not available", 409);
    }

    const now = isoNow();
    const amountCentavos = product.priceCentavos;
    // A storefront item is bought with the points earned at the partner selling
    // it, not from the global pot. That is what makes a partner's bucket worth
    // holding: spending it here is face value, while moving it to the global pot
    // costs the transfer fee.
    const business = await getBusinessOrThrow(tx, product.businessId);
    await ensureBusinessBalance(tx, wallet.id, product.businessId);
    const affected = await run(
      tx,
      `UPDATE reward_business_balances
       SET balance_centavos = balance_centavos - ?, updated_at = ?
       WHERE wallet_id = ? AND business_id = ? AND balance_centavos >= ?`,
      [amountCentavos, now, wallet.id, product.businessId, amountCentavos],
    );
    if (affected !== 1) {
      throw new AppError(
        "E-REWARD-BALANCE",
        `Not enough ${business.name} Loyalty Points for this item`,
        409,
      );
    }
    // The wallet's lifetime figures still span every pot, so a purchase from a
    // bucket counts as converted even though the global balance did not move.
    await run(
      tx,
      `UPDATE reward_wallets
       SET lifetime_converted_centavos = lifetime_converted_centavos + ?, updated_at = ?
       WHERE id = ? AND status = 'Active'`,
      [amountCentavos, now, wallet.id],
    );

    const updated = mapWallet(
      await one(tx, "SELECT * FROM reward_wallets WHERE id = ?", [wallet.id]),
    );
    const voucherId = id("rvch");
    const voucherCode = generateVoucherCode("RWD");
    const qrToken = token("rvoucher");
    const expires = new Date();
    expires.setFullYear(expires.getFullYear() + 1);

    await run(
      tx,
      `INSERT INTO reward_vouchers
       (id, wallet_id, business_id, product_id, voucher_code, qr_token, amount_centavos, remaining_centavos, status, issued_at, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Active', ?, ?, ?)`,
      [
        voucherId,
        wallet.id,
        product.businessId,
        product.id,
        voucherCode,
        qrToken,
        amountCentavos,
        amountCentavos,
        now,
        expires.toISOString(),
        now,
      ],
    );
    await run(
      tx,
      `INSERT INTO reward_ledger_entries
       (id, wallet_id, type, delta_centavos, balance_after_centavos, source_type, source_id, business_id, metadata, created_at)
       VALUES (?, ?, 'product_purchased', ?, ?, 'customer_purchase', ?, ?, ?, ?)`,
      [
        id("rled"),
        wallet.id,
        -amountCentavos,
        await businessBalanceCentavos(tx, wallet.id, product.businessId),
        voucherId,
        product.businessId,
        JSON.stringify({ voucherCode, productId: product.id, productName: product.name }),
        now,
      ],
    );
    await audit(tx, {
      actorType: "customer",
      actorId: wallet.id,
      action: "reward_product_purchased",
      entityType: "reward_voucher",
      entityId: voucherId,
      metadata: {
        productId: product.id,
        businessId: product.businessId,
        amountCentavos,
      },
    });

    return {
      wallet: updated,
      product,
      voucher: mapRewardVoucher(
        await one(tx, "SELECT * FROM reward_vouchers WHERE id = ?", [voucherId]),
      ),
      // The pot that paid, so the storefront can show what is left to spend at
      // this partner rather than an unchanged global figure.
      balance: centavosToLoyaltyPoints(
        await businessBalanceCentavos(tx, wallet.id, product.businessId),
      ),
      globalBalance: centavosToLoyaltyPoints(updated.balanceCentavos),
    };
  });
}

/**
 * Tops a wallet up with Loyalty Points, for the dev tools.
 *
 * Earning LP legitimately means a partner scanning a purchase, which puts a
 * matching liability on that partner's statement. This grants points with no
 * purchase behind them, so nothing is billed to anyone — which is why the
 * ledger entry is labelled as a grant rather than dressed up as a purchase.
 *
 * Gated per caller, not per deployment: a dev environment opens it for everyone,
 * and a configured developer account carries it into production for its own
 * wallet. Nobody else can reach it anywhere.
 */
/**
 * Dev-tools helper: tops a partner's bucket up directly.
 *
 * The counterpart to `grantDevLoyaltyPoints`, which credits the global pot. The
 * two pots buy different things — a bucket buys that partner's storefront items,
 * the global pot converts to the ₱100 voucher — so testing the shop needs a way
 * to fund a bucket specifically.
 *
 * A simulated purchase already funds one, but only at 5% of the amount entered:
 * reaching a 1,200 LP item that way means posting a ₱24,000 sale. This sets the
 * balance directly instead. Nothing is billed to the partner, which is why the
 * ledger entry is labelled a grant rather than dressed up as a purchase.
 *
 * Carries the same per-caller gate as `grantDevLoyaltyPoints`, so the pair stays
 * usable together: funding one pot without the other leaves half the shop
 * untestable.
 */
export async function grantDevBusinessLoyaltyPoints(input: {
  phone: string;
  businessId: string;
  amount: string | number;
}) {
  assertDevToolsEnabledFor(input.phone, "Granting Loyalty Points");
  return withTx(async (tx) => {
    const wallet = await walletByPhone(tx, requireWalletPhone(input.phone));
    if (!wallet) {
      throw new AppError(
        "E-REWARD-WALLET-404",
        "This number has no Loyalty Points wallet yet. Open the More tab once to create it.",
        404,
      );
    }
    const business = await getBusinessOrThrow(tx, input.businessId);
    const amountCentavos = loyaltyPointsToCentavos(input.amount, "LP amount");
    if (amountCentavos <= 0 || amountCentavos > MAX_REDEMPTION_CENTAVOS) {
      throw new AppError(
        "E-MONEY-RANGE",
        `Grant must be between 0.01 LP and ${centavosToLoyaltyPoints(MAX_REDEMPTION_CENTAVOS)}`,
        400,
      );
    }

    const now = isoNow();
    await ensureBusinessBalance(tx, wallet.id, input.businessId);
    await run(
      tx,
      `UPDATE reward_business_balances
       SET balance_centavos = balance_centavos + ?,
           lifetime_earned_centavos = lifetime_earned_centavos + ?,
           updated_at = ?
       WHERE wallet_id = ? AND business_id = ?`,
      [amountCentavos, amountCentavos, now, wallet.id, input.businessId],
    );
    // The wallet's lifetime figure spans every pot, so it moves with the bucket
    // even though the global balance does not.
    await run(
      tx,
      `UPDATE reward_wallets
       SET lifetime_earned_centavos = lifetime_earned_centavos + ?, updated_at = ?
       WHERE id = ? AND status = 'Active'`,
      [amountCentavos, now, wallet.id],
    );
    const bucketBalance = await businessBalanceCentavos(
      tx,
      wallet.id,
      input.businessId,
    );
    // business_id set, per the ledger's convention that an entry naming a
    // business refers to that bucket rather than the global pot.
    await run(
      tx,
      `INSERT INTO reward_ledger_entries
       (id, wallet_id, type, delta_centavos, balance_after_centavos, source_type, source_id, business_id, metadata, created_at)
       VALUES (?, ?, 'dev_grant', ?, ?, 'dev_tool', NULL, ?, ?, ?)`,
      [
        id("rled"),
        wallet.id,
        amountCentavos,
        bucketBalance,
        input.businessId,
        JSON.stringify({ grantedBy: "dev_tools", businessId: input.businessId }),
        now,
      ],
    );
    await audit(tx, {
      actorType: "system",
      actorId: "dev_tools",
      action: "business_loyalty_points_granted_dev",
      entityType: "reward_wallet",
      entityId: wallet.id,
      metadata: { businessId: input.businessId, amountCentavos },
    });

    return {
      businessId: input.businessId,
      businessName: business.name,
      granted: centavosToLoyaltyPoints(amountCentavos),
      balance: centavosToLoyaltyPoints(bucketBalance),
    };
  });
}

export async function grantDevLoyaltyPoints(input: {
  phone: string;
  amount: string | number;
}) {
  assertDevToolsEnabledFor(input.phone, "Granting Loyalty Points");
  return withTx(async (tx) => {
    const wallet = await walletByPhone(tx, requireWalletPhone(input.phone));
    if (!wallet) {
      throw new AppError(
        "E-REWARD-WALLET-404",
        "This number has no Loyalty Points wallet yet. Open the More tab once to create it.",
        404,
      );
    }
    const amountCentavos = loyaltyPointsToCentavos(input.amount, "LP amount");
    if (amountCentavos <= 0 || amountCentavos > MAX_REDEMPTION_CENTAVOS) {
      throw new AppError(
        "E-MONEY-RANGE",
        `Grant must be between 0.01 LP and ${centavosToLoyaltyPoints(MAX_REDEMPTION_CENTAVOS)}`,
        400,
      );
    }

    const now = isoNow();
    await run(
      tx,
      `UPDATE reward_wallets
       SET balance_centavos = balance_centavos + ?,
           lifetime_earned_centavos = lifetime_earned_centavos + ?,
           updated_at = ?
       WHERE id = ? AND status = 'Active'`,
      [amountCentavos, amountCentavos, now, wallet.id],
    );
    const updated = mapWallet(
      await one(tx, "SELECT * FROM reward_wallets WHERE id = ?", [wallet.id]),
    );
    await run(
      tx,
      `INSERT INTO reward_ledger_entries
       (id, wallet_id, type, delta_centavos, balance_after_centavos, source_type, source_id, metadata, created_at)
       VALUES (?, ?, 'dev_grant', ?, ?, 'dev_tool', NULL, ?, ?)`,
      [
        id("rled"),
        wallet.id,
        amountCentavos,
        updated.balanceCentavos,
        JSON.stringify({ grantedBy: "dev_tools" }),
        now,
      ],
    );
    await audit(tx, {
      actorType: "system",
      actorId: "dev_tools",
      action: "loyalty_points_granted_dev",
      entityType: "reward_wallet",
      entityId: wallet.id,
      metadata: { amountCentavos },
    });

    return {
      wallet: updated,
      granted: centavosToLoyaltyPoints(amountCentavos),
      balance: centavosToLoyaltyPoints(updated.balanceCentavos),
    };
  });
}

export type RewardPurchasedItem = {
  voucherId: string;
  voucherCode: string;
  qrToken: string;
  /**
   * `item` is bought from one partner's storefront and collected there.
   * `global_voucher` is converted from Global LP and spendable at any partner,
   * so it carries no product and no business.
   */
  kind: "item" | "global_voucher";
  productId: string;
  productName: string;
  productDescription: string;
  productImageUrl: string;
  businessId: string;
  businessName: string;
  /** Set only on a global voucher: the bill it applies to. */
  minimumSpend?: string;
  priceCentavos: number;
  price: string;
  /** Active | Redeemed | Expired â€” the voucher's own state. */
  status: string;
  /** Whether staff can still scan it. */
  collectable: boolean;
  issuedAt: string;
  redeemedAt: string;
  expiresAt: string;
  campaign?: RewardProduct["campaign"];
};

/**
 * Everything this wallet has bought from the storefront, newest first.
 *
 * Joined from `reward_vouchers` rather than kept in a separate purchases table:
 * the voucher *is* the purchase â€” it holds the QR staff scan, and its status is
 * what tells the customer whether the item is still waiting to be collected.
 * Only vouchers with a `product_id` are storefront buys; a plain LP conversion
 * has none and belongs in the wallet, not here.
 */
export async function listWalletPurchases(input: { phone: string }) {
  const db = await getDb();
  const wallet = await walletByPhone(db, requireWalletPhone(input.phone));
  if (!wallet) return [];

  const rows = await all(
    db,
    // Outer joins throughout: a voucher converted from Global LP has no product
    // and no business, and it belongs on this screen just as much as a bought
    // item — it is the other thing LP turns into, and the empty state promises
    // both.
    `SELECT v.id, v.voucher_code, v.qr_token, v.status, v.issued_at, v.redeemed_at, v.expires_at,
            v.amount_centavos, v.minimum_spend_centavos,
            p.id AS product_id, p.name AS product_name, p.description AS product_description,
            p.image_url AS product_image_url,
            b.id AS business_id, b.name AS business_name,
            c.hero_image AS campaign_hero_image, c.slug AS campaign_slug,
            c.title AS campaign_title, c.mode AS campaign_mode
     FROM reward_vouchers v
     LEFT JOIN reward_products p ON p.id = v.product_id
     LEFT JOIN businesses b ON b.id = v.business_id
     LEFT JOIN campaigns c ON c.id = (
       SELECT id FROM campaigns
       WHERE business_id = b.id AND status = 'active'
       ORDER BY start_date DESC, id DESC
       LIMIT 1
     )
     WHERE v.wallet_id = ?
     ORDER BY v.issued_at DESC, v.seq DESC`,
    [wallet.id],
  );

  const now = Date.now();
  return rows.map((row): RewardPurchasedItem => {
    const expired =
      row.expires_at && new Date(String(row.expires_at)).getTime() < now;
    // Expiry is enforced lazily at redemption, so a voucher can still read
    // "Active" here after its date has passed. Report what staff would find.
    const status = expired && row.status === "Active" ? "Expired" : String(row.status);
    const isItem = Boolean(row.product_id);
    const minimumSpendCentavos = Number(row.minimum_spend_centavos ?? 0);
    return {
      voucherId: String(row.id),
      voucherCode: String(row.voucher_code),
      qrToken: String(row.qr_token),
      kind: isItem ? ("item" as const) : ("global_voucher" as const),
      productId: isItem ? String(row.product_id) : "",
      // A global voucher has no product row, so it is named by what it does.
      productName: isItem
        ? String(row.product_name)
        : `${centavosToMoney(Number(row.amount_centavos))} off`,
      productDescription: isItem
        ? row.product_description
          ? String(row.product_description)
          : ""
        : "Spend it at any partner.",
      productImageUrl: row.product_image_url ? String(row.product_image_url) : "",
      businessId: isItem ? String(row.business_id) : "",
      businessName: isItem ? String(row.business_name) : "",
      minimumSpend:
        !isItem && minimumSpendCentavos > 0
          ? centavosToMoney(minimumSpendCentavos)
          : undefined,
      priceCentavos: Number(row.amount_centavos),
      // A bought item's amount is the LP paid; a global voucher's is pesos off.
      price: isItem
        ? centavosToLoyaltyPoints(Number(row.amount_centavos))
        : centavosToMoney(Number(row.amount_centavos)),
      status,
      collectable: status === "Active",
      issuedAt: String(row.issued_at),
      redeemedAt: row.redeemed_at ? String(row.redeemed_at) : "",
      expiresAt: row.expires_at ? String(row.expires_at) : "",
      campaign: row.campaign_slug
        ? {
            heroImage: String(row.campaign_hero_image ?? ""),
            slug: String(row.campaign_slug),
            title: String(row.campaign_title ?? ""),
            mode: String(row.campaign_mode ?? "other"),
          }
        : undefined,
    };
  });
}

/**
 * Development-only: moves a partner's current-month LP activity into last
 * month, so the settlement leg can be exercised without waiting for a real
 * month to end.
 *
 * Only timestamps move — no amounts, no statuses, and none of the netting
 * logic is reimplemented here. Whatever `closeBusinessStatement` then produces
 * is the same arithmetic production runs.
 */
export async function devBackdateLpActivity(input: { businessId: string }) {
  assertDevToolsEnabled("Backdating LP activity");
  return withTx(async (tx) => {
    await getBusinessOrThrow(tx, input.businessId);
    const current = manilaDateParts().period;
    const [year, month] = current.split("-").map(Number);
    const previous = new Date(Date.UTC(year, month - 2, 1));
    const period = `${previous.getUTCFullYear()}-${String(previous.getUTCMonth() + 1).padStart(2, "0")}`;
    // Mid-month, so the shifted rows cannot land outside the target period in
    // any timezone.
    const stamp = `${period}-15T04:00:00.000Z`;

    const purchases = await run(
      tx,
      `UPDATE reward_purchases SET created_at = ?
       WHERE business_id = ? AND substr(created_at, 1, 7) = ?`,
      [stamp, input.businessId, current],
    );
    const redemptions = await run(
      tx,
      `UPDATE reward_voucher_redemptions SET created_at = ?
       WHERE business_id = ? AND substr(created_at, 1, 7) = ?`,
      [stamp, input.businessId, current],
    );
    return { period, purchases, redemptions };
  });
}

/**
 * Awards the 5% when staff mark a campaign voucher as used.
 *
 * A thin wrapper over `creditRewardFromPurchase` rather than a second earning
 * path: the partner must be billed, fraud-flagged and audited identically
 * however the sale reached us. Two differences are deliberate:
 *
 * - The wallet is created if the customer has never opened one, but without the
 *   daily app-use bonus that opening the app grants. Points are for the sale.
 * - The voucher id is the idempotency key, so a replayed redemption cannot
 *   award the same sale twice.
 */
export async function awardLoyaltyPointsForRedemption(input: {
  phone: string;
  businessId: string;
  purchaseAmount: string | number;
  staffName: string;
  voucherId: string;
}) {
  const db = await getDb();
  const wallet = await ensureRewardWallet(db, { phone: input.phone });
  return creditRewardFromPurchase({
    walletToken: wallet.walletToken,
    businessId: input.businessId,
    purchaseAmount: input.purchaseAmount,
    staffName: input.staffName,
    idempotencyKey: `voucher-redemption-${input.voucherId}`,
  });
}
