export type CampaignMode = "restaurant" | "online_shop" | "beauty" | "pet" | "retail" | "other";
export type CampaignStatus = "active" | "paused" | "closed";
export type SlotStatus = "active" | "sold_out" | "closed" | "paused";
export type AttemptStatus = "Candidate" | "Held" | "Selected" | "Released" | "Expired";
export type VoucherStatus = "Issued" | "Delivered" | "Redeemed" | "Expired" | "Cancelled" | "NoShow";
export type SourceType = "base" | "referral_bonus" | "admin_bonus";

export type Business = {
  id: string;
  name: string;
  logoText: string;
  industry: CampaignMode;
  /** Street address of the venue. Shown on the campaign page and used to build a maps link. */
  address?: string;
  /** Public contact number for the venue, dialled straight from the campaign page. */
  contactNumber?: string;
  /** Pin dropped on the map in the dashboard; preferred over the address when opening a map. */
  latitude?: number;
  longitude?: number;
};

export type Campaign = {
  id: string;
  businessId: string;
  slug: string;
  title: string;
  offerMessage: string;
  heroImage: string;
  mode: CampaignMode;
  /** Human-readable location shown on the campaign directory card (e.g. "Makati"). */
  location?: string;
  status: CampaignStatus;
  startDate: string;
  endDate: string;
  baseAttempts: number;
  referralDailyLimit: number;
  candidateTimeoutMinutes: number;
  terms: string;
  shopUrl?: string;
  /** When true, an issued restaurant reservation can be moved to another slot. */
  allowReschedule: boolean;
};

export type CampaignSlot = {
  id: string;
  campaignId: string;
  date: string;
  startTime: string;
  endTime: string;
  timezone: string;
  branchId?: string;
  totalCapacity: number;
  remainingCapacity: number;
  status: SlotStatus;
};

/**
 * Whether a campaign can still be hunted, derived live rather than stored: slot
 * capacity comes back when a booking is cancelled or rescheduled, so a campaign
 * that is full now may be open again minutes later. Never cache this as a
 * campaign status.
 */
export type CampaignAvailability = {
  /**
   * A hunt started now can end in an issued, bookable voucher — the same
   * condition the draw itself enforces before spending an attempt.
   */
  bookable: boolean;
  /** Capacity left across upcoming, active slots. */
  remainingCapacity: number;
  /** Voucher stock left across active benefit tiers. */
  remainingPrizes: number;
};

export type CampaignCard = {
  campaign: Campaign;
  businessName: string;
  businessLogo: string;
  businessIndustry: string;
  /** Venue details, carried from the business so the campaign page can show where to go. */
  businessAddress?: string;
  businessContactNumber?: string;
  availability: CampaignAvailability;
  /**
   * The campaign is over: closed by the business, or past its end date. Unlike
   * `availability`, this never flips back — a finished campaign keeps its place
   * in the directory for a short while, marked as such and no longer openable,
   * rather than vanishing on the customer who was hunting it.
   */
  ended: boolean;
};

/**
 * How rare a benefit tier is. Set per tier by the admin, and the single source
 * of both the customer-facing badge and the tier's odds in the draw.
 */
export type VoucherRarity = "standard" | "rare" | "epic" | "legendary";

export type VoucherPool = {
  id: string;
  campaignId: string;
  benefitType: "discount_percent" | "fixed_amount" | "free_item" | "free_shipping";
  benefitValue: string;
  displayLabel: string;
  totalQuantity: number;
  remainingQuantity: number;
  /**
   * How often this tier comes up, and the badge customers see. Chosen per tier;
   * `probabilityWeight` is derived from it via RARITY_WEIGHTS rather than typed
   * in, so the odds and the badge can never disagree.
   */
  rarity: VoucherRarity;
  probabilityWeight: number;
  minimumSpend?: number;
  status: "active" | "paused" | "depleted";
  restriction?: string;
};

export type EndUser = {
  id: string;
  campaignId: string;
  name?: string;
  phone: string;
  email?: string;
  sessionId: string;
  createdAt: string;
};

export type VoucherAttempt = {
  id: string;
  campaignId: string;
  /** Chosen only at final confirmation; a fresh candidate has no slot yet. */
  slotId?: string;
  userId: string;
  attemptNumber: number;
  sourceType: SourceType;
  benefitType: VoucherPool["benefitType"];
  benefitValue: string;
  displayLabel: string;
  /** Copied from the pool at draw time, like the benefit fields beside it. */
  rarity: VoucherRarity;
  poolId: string;
  status: AttemptStatus;
  expiresAt: string;
  createdAt: string;
};

export type Voucher = {
  id: string;
  campaignId: string;
  slotId: string;
  userId: string;
  selectedAttemptId: string;
  voucherCode: string;
  qrToken: string;
  benefitType: VoucherPool["benefitType"];
  benefitValue: string;
  displayLabel: string;
  /** Copied at issue, so a wallet ticket keeps the badge it was won with. */
  rarity: VoucherRarity;
  status: VoucherStatus;
  issuedAt: string;
  expiresAt: string;
  redeemedAt?: string;
};

export type ClaimedVoucher = {
  voucher: Voucher;
  slot: CampaignSlot;
  campaignSlug: string;
  campaignTitle: string;
  businessName: string;
};

export type Reservation = {
  id: string;
  campaignId: string;
  slotId: string;
  userId: string;
  voucherId: string;
  guestCount?: number;
  status: "Reserved" | "Redeemed" | "Cancelled" | "No-show";
  createdAt: string;
};

export type SmsLog = {
  id: string;
  campaignId: string;
  userId: string;
  voucherId: string;
  to: string;
  body: string;
  provider: string;
  status: "pending" | "sent" | "failed";
  providerMessageId?: string;
  createdAt: string;
  failureReason?: string;
  // SMPP delivery-receipt (DLR) outcome, populated asynchronously by the SMSC.
  deliveryStatus?: string;
  deliveryError?: string;
  deliveryReceipt?: string;
  deliveredAt?: string;
};

export type RedemptionLog = {
  id: string;
  voucherId: string;
  staffName: string;
  purchaseAmount?: number;
  note?: string;
  createdAt: string;
};

export type AnalyticsEvent = {
  id: string;
  campaignId: string;
  eventName: string;
  userId?: string;
  slotId?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
};

export type ReferralReward = {
  id: string;
  campaignId: string;
  referrerUserId: string;
  visitorSessionId: string;
  status: "granted" | "rejected";
  reason?: string;
  createdAt: string;
};

export type RewardWalletStatus = "Active" | "Suspended";
export type RewardLedgerType =
  | "credit_earned"
  | "voucher_converted"
  | "product_purchased"
  | "daily_app_use"
  | "referral_bonus"
  // Two pots, so a movement between them writes one entry on each side.
  | "transfer_out"
  | "transfer_in"
  // The one-off migration that rebuilt partner buckets from the ledger, for
  // wallets that earned their points before the buckets existed.
  | "backfill_out"
  | "backfill_in"
  | "dev_grant"
  | "adjustment";
export type RewardVoucherStatus = "Active" | "Redeemed" | "Expired" | "Cancelled";
export type RewardTransactionStatus = "Accepted" | "Held" | "Rejected" | "Adjusted" | "Cancelled";
export type RewardSettlementStatus = "Pending" | "Processed" | "Completed" | "Adjusted";

export type RewardWallet = {
  id: string;
  phone: string;
  maskedPhone: string;
  name?: string;
  email?: string;
  walletToken: string;
  balanceCentavos: number;
  lifetimeEarnedCentavos: number;
  lifetimeConvertedCentavos: number;
  status: RewardWalletStatus;
  createdAt: string;
  updatedAt: string;
};

export type RewardLedgerEntry = {
  id: string;
  walletId: string;
  type: RewardLedgerType;
  deltaCentavos: number;
  balanceAfterCentavos: number;
  sourceType: string;
  sourceId?: string;
  businessId?: string;
  staffName?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
};

export type RewardPurchase = {
  id: string;
  walletId: string;
  businessId: string;
  purchaseAmountCentavos: number;
  rewardAmountCentavos: number;
  staffName: string;
  status: RewardTransactionStatus;
  idempotencyKey?: string;
  fraudFlag?: string;
  reviewedBy?: string;
  reviewedAt?: string;
  reviewNote?: string;
  createdAt: string;
};

export type RewardVoucher = {
  id: string;
  walletId: string;
  voucherCode: string;
  qrToken: string;
  amountCentavos: number;
  remainingCentavos: number;
  /**
   * The smallest bill this voucher applies to. Set on fixed-denomination
   * vouchers converted from global LP; absent on the open-amount vouchers
   * minted before those existed, which carry no floor.
   */
  minimumSpendCentavos?: number;
  status: RewardVoucherStatus;
  issuedAt: string;
  expiresAt?: string;
  redeemedAt?: string;
  createdAt: string;
};

export type RewardVoucherRedemption = {
  id: string;
  voucherId: string;
  walletId: string;
  businessId: string;
  amountCentavos: number;
  serviceFeeCentavos: number;
  settlementAmountCentavos: number;
  staffName: string;
  settlementStatus: RewardSettlementStatus;
  settlementId?: string;
  createdAt: string;
};

export type RewardSettlement = {
  id: string;
  businessId: string;
  period: string;
  grossAmountCentavos: number;
  serviceFeeCentavos: number;
  totalAmountCentavos: number;
  status: RewardSettlementStatus;
  gcashReference?: string;
  createdAt: string;
  processedAt?: string;
};

export type LoyaltyDailyStatus = {
  date: string;
  appUseAwarded: boolean;
  referralAwarded: boolean;
  /**
   * Today's app-use award once it has been drawn ("7 LP"); before the draw,
   * the band it is drawn from ("1-10 LP"). Display copy either way - nothing
   * should parse a number back out of it.
   */
  appUsePoints: string;
  referralPoints: string;
  earnedToday: string;
  monthlyPotential: string;
};

export type AppDb = {
  businesses: Business[];
  campaigns: Campaign[];
  slots: CampaignSlot[];
  pools: VoucherPool[];
  users: EndUser[];
  attempts: VoucherAttempt[];
  vouchers: Voucher[];
  reservations: Reservation[];
  smsLogs: SmsLog[];
  redemptionLogs: RedemptionLog[];
  analyticsEvents: AnalyticsEvent[];
  referralRewards: ReferralReward[];
};

export type SuccessResponse<T> = {
  success: true;
  data: T;
};

export type ErrorResponse = {
  success: false;
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
};
