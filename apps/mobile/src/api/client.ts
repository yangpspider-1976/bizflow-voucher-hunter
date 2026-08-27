import type {
  AchievementCard,
  AchievementUnlockNotice,
  Business,
  Campaign,
  CampaignAvailability,
  CampaignCard,
  CampaignSlot,
  ClaimedVoucher,
  EndUser,
  ErrorResponse,
  GamificationProfile,
  LoyaltyDailyStatus,
  MissionCard,
  MissionClaimResult,
  MissionState,
  PointConversionResult,
  RewardLedgerEntry,
  RewardVoucher,
  RewardWallet,
  SuccessResponse,
  Voucher,
  VoucherAttempt,
  VoucherPool,
} from "@bizflow/shared";

const configuredBaseUrl = process.env.EXPO_PUBLIC_API_BASE_URL?.trim().replace(/\/+$/, "");

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: unknown;

  constructor(code: string, message: string, status: number, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

type ApiOptions = Omit<RequestInit, "body"> & {
  body?: unknown;
  token?: string | null;
};

type UnauthorizedListener = () => void;

const unauthorizedListeners = new Set<UnauthorizedListener>();

export function subscribeToUnauthorized(listener: UnauthorizedListener) {
  unauthorizedListeners.add(listener);
  return () => {
    unauthorizedListeners.delete(listener);
  };
}

function notifyUnauthorized() {
  unauthorizedListeners.forEach((listener) => listener());
}

function getApiBaseUrl(): string {
  if (!configuredBaseUrl) {
    throw new ApiError(
      "E-MOBILE-CONFIG",
      "Set EXPO_PUBLIC_API_BASE_URL before starting the mobile app.",
      0,
    );
  }
  if (!__DEV__ && !configuredBaseUrl.startsWith("https://")) {
    throw new ApiError(
      "E-MOBILE-CONFIG",
      "The production API URL must use HTTPS.",
      0,
    );
  }
  return configuredBaseUrl;
}

/**
 * Absolutises an asset path the API serves. Campaign artwork is stored either as
 * a `data:` URI (uploaded) or as a root-relative path like
 * `/images/campaigns/x.png`, which only resolves against the backend's origin —
 * the app has no origin of its own.
 */
export function resolveAssetUrl(src: string): string {
  if (src.startsWith("data:") || /^https?:\/\//.test(src)) return src;
  return `${getApiBaseUrl()}${src.startsWith("/") ? src : `/${src}`}`;
}

/**
 * The account-deletion instructions the backend serves. Play requires this to be
 * reachable from inside the app as well as from the store listing, so the page
 * is the single source of truth for both.
 */
export function buildDeleteAccountUrl() {
  return `${getApiBaseUrl()}/delete-account`;
}

/**
 * The customer landing page, which explains what the app does and lists the
 * partner offers. It is the same page the store listing points at, so there is
 * one description of the product rather than a second copy inside the app.
 */
export function buildClientLandingUrl() {
  return `${getApiBaseUrl()}/client`;
}

export function buildReferralLink(campaignSlug: string, referrerUserId: string) {
  const query = new URLSearchParams({
    campaign: campaignSlug,
    ref: referrerUserId,
  });
  return `${getApiBaseUrl()}/api/public/referral/visit?${query.toString()}`;
}

export type ReferralLinkIdentity = {
  campaignSlug: string;
  referrerUserId: string;
  visitPath: string;
};

export function getReferralLinkIdentity(
  token: string,
  sessionId: string,
  campaignSlug?: string,
): Promise<ReferralLinkIdentity> {
  return apiRequest<ReferralLinkIdentity>("/api/public/referral/link", {
    method: "POST",
    body: { campaignSlug, sessionId },
    token,
  });
}

export async function apiRequest<T>(path: string, options: ApiOptions = {}): Promise<T> {
  const { body, headers, token, ...requestOptions } = options;
  const requestHeaders = new Headers(headers);
  requestHeaders.set("Accept", "application/json");

  if (body !== undefined) {
    requestHeaders.set("Content-Type", "application/json");
  }
  if (token) {
    requestHeaders.set("Authorization", `Bearer ${token}`);
  }

  let response: Response;
  try {
    response = await fetch(`${getApiBaseUrl()}${path}`, {
      ...requestOptions,
      headers: requestHeaders,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(
      "E-NETWORK",
      "Could not reach Voucher Hunt. Check your connection and API URL.",
      0,
    );
  }

  // A bearer token rejected by the server has been revoked, expired, or wiped by
  // an admin reset. Notify the auth provider before the request error reaches the
  // screen so the locally cached SecureStore session cannot keep the app signed in.
  if (response.status === 401 && token) {
    notifyUnauthorized();
  }

  let payload: SuccessResponse<T> | ErrorResponse;
  try {
    payload = (await response.json()) as SuccessResponse<T> | ErrorResponse;
  } catch {
    throw new ApiError("E-INVALID-RESPONSE", "The server returned an invalid response.", response.status);
  }

  if (!response.ok || !payload.success) {
    const apiFailure = payload as ErrorResponse;
    throw new ApiError(
      apiFailure.error?.code ?? "E-REQUEST",
      apiFailure.error?.message ?? "The request could not be completed.",
      response.status,
      apiFailure.error?.details,
    );
  }

  return payload.data;
}

export type OtpRequestResult = {
  sent: boolean;
  expiresAt: string;
  devCode?: string;
};

export type OtpVerifyResult = {
  phone: string;
  token: string;
};

export function requestOtp(phone: string): Promise<OtpRequestResult> {
  return apiRequest<OtpRequestResult>("/api/public/signin/request-otp", {
    method: "POST",
    headers: { "X-Client": "mobile" },
    body: { phone },
  });
}

export function verifyOtp(phone: string, code: string): Promise<OtpVerifyResult> {
  return apiRequest<OtpVerifyResult>("/api/public/signin/verify-otp", {
    method: "POST",
    headers: { "X-Client": "mobile" },
    body: { phone, code, issueToken: true },
  });
}

export function revokeSession(token: string): Promise<{ signedOut: boolean }> {
  return apiRequest<{ signedOut: boolean }>("/api/public/signin/signout", {
    method: "POST",
    token,
  });
}

/* Hunt flow ---------------------------------------------------------------- */

export type PublicSlot = CampaignSlot & { remainingPoolQuantity: number };

export type PublicCampaign = {
  campaign: Campaign;
  business?: Business;
  slots: PublicSlot[];
  availability: CampaignAvailability;
};

export type HuntState = {
  user: EndUser;
  campaign: Campaign;
  attempts: VoucherAttempt[];
  /** Present once this phone has issued a final voucher for the campaign. */
  voucher?: Voucher;
  /**
   * The slot that voucher was booked at, carried with it so a resumed campaign
   * can show the booking without depending on the campaign's slot list still
   * holding that row.
   */
  voucherSlot?: CampaignSlot;
  remainingBaseAttempts: number;
  remainingBonusAttempts: number;
  /**
   * Hunts the player's level grants today, and how many are left. A third
   * source alongside the campaign's base attempts and share bonuses, kept
   * separate so the hunt screen can say where an attempt came from. Optional so
   * a response from a server older than levels still renders.
   */
  remainingLevelAttempts?: number;
  levelAttemptAllowance?: number;
  sharesGrantedToday: number;
};

export type AttemptSlots = {
  attempt: VoucherAttempt;
  slots: PublicSlot[];
};

export type IssuedVoucher = {
  voucher: Voucher;
  slot: CampaignSlot;
  campaign: Campaign;
  user: EndUser;
};

/** Pool previews that fill the reel. Public, so no token is needed. */
export type RoulettePreview = Pick<
  VoucherPool,
  "benefitType" | "benefitValue" | "displayLabel" | "rarity"
> & {
  poolId?: string;
  probabilityWeight?: number;
  remainingQuantity?: number;
};

export function listCampaigns(token: string): Promise<CampaignCard[]> {
  return apiRequest<CampaignCard[]>("/api/public/campaigns", { token });
}

export function getCampaign(slug: string, token: string): Promise<PublicCampaign> {
  return apiRequest<PublicCampaign>(
    `/api/public/campaigns/${encodeURIComponent(slug)}`,
    { token },
  );
}

export function getCampaignPools(
  slug: string,
  token: string,
): Promise<RoulettePreview[]> {
  return apiRequest<RoulettePreview[]>(
    `/api/public/campaigns/${encodeURIComponent(slug)}/pools`,
    { token },
  );
}

export function startHunt(
  input: { campaignSlug: string; sessionId: string; name?: string; email?: string },
  token: string,
): Promise<HuntState> {
  return apiRequest<HuntState>("/api/public/hunt/start", {
    method: "POST",
    body: input,
    token,
  });
}

export function getHuntState(
  campaignSlug: string,
  token: string,
): Promise<HuntState> {
  return apiRequest<HuntState>(
    `/api/public/hunt/state?campaignSlug=${encodeURIComponent(campaignSlug)}`,
    { token },
  );
}

export function drawAttempt(
  input: {
    campaignSlug: string;
    sessionId: string;
    sourceType?: "base" | "referral_bonus" | "level_bonus";
    /** Development-only: forces the draw to a specific pool. */
    devPoolId?: string;
  },
  token: string,
  signal?: AbortSignal,
): Promise<VoucherAttempt> {
  return apiRequest<VoucherAttempt>("/api/public/hunt/attempt", {
    method: "POST",
    body: input,
    signal,
    token,
  });
}

export type CustomerSession = {
  phone: string;
  /**
   * Whether this number is a configured developer account — the answer the More
   * tab's dev panel renders from, on every backend. Not "may use the dev tools":
   * a dev deployment opens them for everyone, but showing the panel to every
   * test account signed in there is not the point of it.
   */
  devTools?: boolean;
};

export function validateCustomerSession(
  token: string,
): Promise<CustomerSession> {
  return apiRequest<CustomerSession>("/api/public/signin/session", {
    token,
  });
}

export function getAttemptSlots(
  input: { campaignSlug: string; attemptId: string },
  token: string,
): Promise<AttemptSlots> {
  const query = new URLSearchParams({
    campaignSlug: input.campaignSlug,
    attemptId: input.attemptId,
  });
  return apiRequest<AttemptSlots>(`/api/public/hunt/slots?${query.toString()}`, {
    token,
  });
}

export function selectVoucher(
  input: {
    campaignSlug: string;
    attemptId: string;
    slotId: string;
    sessionId: string;
    name: string;
    email?: string;
    guestCount?: number;
  },
  token: string,
): Promise<IssuedVoucher> {
  return apiRequest<IssuedVoucher>("/api/public/hunt/select", {
    method: "POST",
    body: input,
    token,
  });
}

/* Customer wallet ---------------------------------------------------------- */

export type BusinessBalance = {
  businessId: string;
  businessName: string;
  balance: string;
  balanceCentavos: number;
};

export type RewardWalletSnapshot = {
  wallet: RewardWallet;
  walletSecret: string;
  /** The global pot: spendable anywhere, and the only one that converts. */
  balance: string;
  /**
   * Points held at individual partners, spendable on that partner's storefront
   * items or transferable to the global pot for a fee. Absent on responses from
   * a server older than this field.
   */
  businessBalances?: BusinessBalance[];
  ledger: RewardLedgerEntry[];
  vouchers: RewardVoucher[];
  dailyStatus: LoyaltyDailyStatus;
  /** True only when this request created today's app-use award. */
  appUseAwardedNow: boolean;
};

/**
 * What the holder can actually spend at one partner's storefront.
 *
 * Items are bought from the bucket earned at that partner, never from the
 * global pot, so this — not `wallet.wallet.balanceCentavos` — is the figure
 * every price, shortfall hint and Buy button on the shop screens is measured
 * against. Reading the global pot instead disabled Buy on items the bucket
 * could afford, and enabled it on items the server then refused.
 *
 * Falls back to zero when the field is missing, which only happens against a
 * server older than the buckets. Everything then reads as unaffordable, which
 * is the safe direction: the alternative is offering a purchase the server
 * rejects.
 */
export function partnerBalance(
  wallet: RewardWalletSnapshot | null | undefined,
  businessId: string,
): Pick<BusinessBalance, "balance" | "balanceCentavos"> {
  const bucket = wallet?.businessBalances?.find(
    (candidate) => candidate.businessId === businessId,
  );
  // The API omits empty buckets, so a partner the holder has never earned at
  // has no row rather than a zero one. " LP" is the server's own suffix on
  // every formatted amount, so the placeholder matches what it would send.
  return bucket ?? { balance: "0 LP", balanceCentavos: 0 };
}

export function listClaimedVouchers(token: string): Promise<ClaimedVoucher[]> {
  return apiRequest<ClaimedVoucher[]>("/api/public/vouchers", { token });
}

export function getOrCreateRewardWallet(
  token: string,
): Promise<RewardWalletSnapshot> {
  return apiRequest<RewardWalletSnapshot>("/api/public/rewards/wallet", {
    method: "POST",
    body: {},
    token,
  });
}

export type GlobalReward = {
  id: string;
  name: string;
  description: string;
  /** Global LP this costs, e.g. "500 LP". */
  cost: string;
  costCentavos: number;
  /** What the voucher takes off a bill, e.g. "₱100.00". */
  value: string;
  valueCentavos: number;
  /** The bill it applies to, e.g. "₱500.00". */
  minimumSpend: string;
  minimumSpendCentavos: number;
};

/** What Global LP can be turned into. One entry today; the app renders a list. */
export function listGlobalRewards(token: string): Promise<GlobalReward[]> {
  return apiRequest<GlobalReward[]>("/api/public/rewards/global", { token });
}

export type GlobalRewardPurchase = {
  reward: GlobalReward;
  voucher: RewardVoucher;
  /** Global LP given up, which is not the voucher's face value. */
  cost: string;
  balance: string;
};

/** Spends Global LP on one catalogue voucher. */
export function convertRewardCredit(
  input: { walletSecret: string; rewardId?: string },
  token: string,
): Promise<GlobalRewardPurchase> {
  return apiRequest<GlobalRewardPurchase>("/api/public/rewards/convert", {
    method: "POST",
    body: input,
    token,
  });
}

/**
 * Moves points from one partner's pot into the global one, less a 10% fee that
 * is taken out of what arrives.
 */
export function transferBusinessLp(
  input: { walletSecret: string; businessId: string; amount: string },
  token: string,
): Promise<{
  transferred: string;
  fee: string;
  credited: string;
  businessBalance: string;
  balance: string;
}> {
  return apiRequest("/api/public/rewards/transfer", {
    method: "POST",
    body: input,
    token,
  });
}

/* LP storefront ------------------------------------------------------------ */

export type RewardProduct = {
  id: string;
  businessId: string;
  businessName: string;
  /**
   * The partner's trade (`restaurant`, `beauty`, …), which colours its
   * storefront. Optional so a response from a server older than this field
   * falls back to the neutral tone rather than crashing the screen.
   */
  businessIndustry?: string;
  name: string;
  description: string;
  imageUrl: string;
  priceCentavos: number;
  /** Already formatted, e.g. "500 LP". */
  price: string;
  status: "Active" | "Hidden";
  /** The partner's current campaign artwork, for the storefront cards. */
  campaign?: Pick<Campaign, "heroImage" | "slug" | "title" | "mode">;
};

export type RewardProductPurchase = {
  wallet: RewardWallet;
  product: RewardProduct;
  voucher: RewardVoucher;
  balance: string;
};

/** Omit `businessId` for the whole network; pass one for a single storefront. */
export function listRewardProducts(
  token: string,
  businessId?: string,
): Promise<RewardProduct[]> {
  const query = businessId
    ? `?businessId=${encodeURIComponent(businessId)}`
    : "";
  return apiRequest<RewardProduct[]>(`/api/public/rewards/products${query}`, {
    token,
  });
}

export type RewardPurchasedItem = {
  voucherId: string;
  voucherCode: string;
  qrToken: string;
  /**
   * `item` is collected at the partner that sold it. `global_voucher` came from
   * Global LP and is spendable at any partner, so it has no product or business.
   * Optional so a response from a server older than this field still renders.
   */
  kind?: "item" | "global_voucher";
  /** Set only on a global voucher: the bill it applies to. */
  minimumSpend?: string;
  productId: string;
  productName: string;
  productDescription: string;
  productImageUrl: string;
  businessId: string;
  businessName: string;
  priceCentavos: number;
  price: string;
  status: "Active" | "Redeemed" | "Expired" | string;
  /** False once redeemed or expired: staff can no longer scan it. */
  collectable: boolean;
  issuedAt: string;
  redeemedAt: string;
  expiresAt: string;
  campaign?: RewardProduct["campaign"];
};

export function listRewardPurchases(
  token: string,
): Promise<RewardPurchasedItem[]> {
  return apiRequest<RewardPurchasedItem[]>("/api/public/rewards/purchases", {
    token,
  });
}

export function getRewardProduct(
  token: string,
  productId: string,
): Promise<RewardProduct> {
  return apiRequest<RewardProduct>(
    `/api/public/rewards/products/${encodeURIComponent(productId)}`,
    { token },
  );
}

export function purchaseRewardProduct(
  input: { walletSecret: string; productId: string },
  token: string,
): Promise<RewardProductPurchase> {
  return apiRequest<RewardProductPurchase>(
    "/api/public/rewards/products/purchase",
    { method: "POST", body: input, token },
  );
}

/* Gamification: levels, missions, achievements ------------------------------ */

export function getGamificationProfile(token: string): Promise<GamificationProfile> {
  return apiRequest<GamificationProfile>("/api/public/gamification/profile", { token });
}

export function listMissions(
  token: string,
  type?: MissionCard["type"],
): Promise<MissionCard[]> {
  const query = type ? `?type=${encodeURIComponent(type)}` : "";
  return apiRequest<MissionCard[]>(`/api/public/gamification/missions${query}`, { token });
}

/**
 * Claims a mission the player has to tap for.
 *
 * Most daily missions pay themselves the moment their event lands, so this is
 * only reached by the ones configured not to. The server is the authority on
 * whether a claim is allowed; the button is only ever a request.
 */
export function claimMission(
  input: { missionKey: string; missionDate?: string },
  token: string,
): Promise<MissionClaimResult> {
  return apiRequest<MissionClaimResult>(
    `/api/public/gamification/missions/${encodeURIComponent(input.missionKey)}/claim`,
    { method: "POST", body: { missionDate: input.missionDate }, token },
  );
}

export function joinMission(
  missionKey: string,
  token: string,
): Promise<{ missionKey: string; state: MissionState }> {
  return apiRequest(
    `/api/public/gamification/missions/${encodeURIComponent(missionKey)}/join`,
    { method: "POST", body: {}, token },
  );
}

/**
 * Spends Loyalty Points on experience.
 *
 * `idempotencyKey` is generated once per confirmation, not per request, so a
 * retry after a timeout is recognised as the same tap rather than converting a
 * second time. The conversion cannot be undone, which the confirmation screen
 * says before this is called.
 */
export function convertPointsToXp(
  input: {
    businessId: string | null;
    amount: string | number;
    idempotencyKey: string;
  },
  token: string,
): Promise<PointConversionResult> {
  return apiRequest<PointConversionResult>(
    "/api/public/gamification/levels/convert-points",
    { method: "POST", body: input, token },
  );
}

export function listAchievements(token: string): Promise<{
  achievements: AchievementCard[];
  unseenUnlocks: AchievementUnlockNotice[];
}> {
  return apiRequest("/api/public/gamification/achievements", { token });
}

/**
 * Tells the server which celebration screens have been shown.
 *
 * Acknowledged server-side rather than in device storage: a badge unlocked
 * while the app was closed should be celebrated on whichever device is opened
 * next, exactly once, and an uninstall should not resurrect a year of confetti.
 */
export function acknowledgeUnlocks(
  input: { groupKeys?: string[]; levelUp?: boolean },
  token: string,
): Promise<{ acknowledged: number }> {
  return apiRequest("/api/public/gamification/achievements/seen", {
    method: "POST",
    body: input,
    token,
  });
}

/**
 * The signed `custom_data` an AdMob rewarded ad has to carry.
 *
 * The reward is not granted by the app finishing an ad — it is granted when
 * Google's server-side verification callback reaches the backend carrying this
 * value. Nothing here can shortcut that.
 */
export function requestAdNonce(
  token: string,
): Promise<{ customData: string; viewsToday: number }> {
  return apiRequest("/api/public/gamification/ads/nonce", {
    method: "POST",
    body: {},
    token,
  });
}
