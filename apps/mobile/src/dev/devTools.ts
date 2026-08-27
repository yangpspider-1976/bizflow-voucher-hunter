import * as SecureStore from "expo-secure-store";

import { apiRequest, type RoulettePreview } from "@/api/client";

/**
 * Helpers behind the More tab's dev panel, mirroring the web's
 * `.dev-voucher-picker`. Every endpoint here is gated server-side as well.
 *
 * Whether the panel appears at all is one question, answered only by the session
 * (`useAuth().devTools`): the signed-in number is a configured developer account,
 * or it is not. `__DEV__` deliberately does not answer it — a dev build says
 * something about the bundle, not about who is signed into it, and every
 * ordinary test account used locally was seeing the panel because of it.
 *
 * `devBuild` answers the narrower second question of which tools the panel then
 * offers. The self-scoped tools — the hunt helpers plus the two LP grants, which
 * mint points but bill nobody — run wherever the account does, production
 * included. The partner-checkout helpers bill a real partner and stay refused in
 * production for every account, so the panel hides them rather than offering a
 * button that always 403s.
 */
export const devBuild = __DEV__;

const DEV_POOL_KEY = "voucher_hunt_dev_pool_choices";

type PoolChoices = Record<string, string>;

/**
 * The forced pool is chosen on the global More tab but consumed by the roulette,
 * which is campaign-scoped and a separate navigator — so the choice is keyed by
 * slug and persisted rather than passed through navigation.
 *
 * SecureStore only stores strings, so the whole map is one JSON blob.
 */
async function readChoices(): Promise<PoolChoices> {
  try {
    const raw = await SecureStore.getItemAsync(DEV_POOL_KEY);
    return raw ? (JSON.parse(raw) as PoolChoices) : {};
  } catch {
    return {};
  }
}

/**
 * No `__DEV__` guard: a release build signed in as the developer account has to
 * be able to read back the choice it just made. Only the panel writes this
 * store, and the server rejects a forced draw from anyone not entitled to one.
 */
export async function getDevPoolId(campaignSlug: string): Promise<string> {
  const choices = await readChoices();
  return choices[campaignSlug] ?? "";
}

export async function setDevPoolId(campaignSlug: string, poolId: string) {
  const choices = await readChoices();
  if (poolId) {
    choices[campaignSlug] = poolId;
  } else {
    delete choices[campaignSlug];
  }
  await SecureStore.setItemAsync(DEV_POOL_KEY, JSON.stringify(choices));
}

/**
 * Every campaign's forced pool, dropped together with a hunt reset and with the
 * session itself.
 *
 * Swallows storage failures, like the hunt progress store it sits beside: this
 * runs as part of signing out, and a handset that cannot write its keychain must
 * still end up signed out.
 */
export async function clearDevPoolIds() {
  try {
    await SecureStore.deleteItemAsync(DEV_POOL_KEY);
  } catch {
    // Nothing here is authoritative; the server gates every forced draw anyway.
  }
}

export type HuntResetResult = {
  campaignsReset: number;
  attemptsCleared: number;
  vouchersCleared: number;
};

/**
 * Clears this phone's hunt across every campaign it has hunted and returns the
 * held stock to the pools. Not scoped to a campaign — the token identifies the
 * phone, and a reset is meant to put the whole demo back at the start.
 */
export function resetHunt(token: string): Promise<HuntResetResult> {
  return apiRequest<HuntResetResult>("/api/public/hunt/reset", {
    method: "POST",
    token,
  });
}

export type DevPoolOption = RoulettePreview & { poolId: string };

/** Pools that can be forced. Entries without a `poolId` cannot be targeted. */
export function listDevPools(
  campaignSlug: string,
  token: string,
): Promise<DevPoolOption[]> {
  return apiRequest<RoulettePreview[]>(
    `/api/public/campaigns/${encodeURIComponent(campaignSlug)}/pools`,
    { token },
  ).then((pools) =>
    pools.filter((pool): pool is DevPoolOption => Boolean(pool.poolId)),
  );
}

export type DevLoyaltyGrant = {
  granted: string;
  balance: string;
};

/**
 * Tops the signed-in wallet up with LP. Earning it properly needs a partner to
 * scan a purchase, which is impractical when testing the storefront — the
 * cheapest demo item costs 150 LP and a day's app-use award is 10.
 *
 * Server-side this is gated per caller, so the production developer account may
 * fund its own wallet; everyone else is refused outside a dev deployment.
 */
export function grantLoyaltyPoints(
  amount: string,
  token: string,
): Promise<DevLoyaltyGrant> {
  return apiRequest<DevLoyaltyGrant>("/api/public/rewards/dev-credit", {
    method: "POST",
    body: { amount },
    token,
  });
}

export type DevBusinessGrant = {
  businessId: string;
  businessName: string;
  granted: string;
  /** That partner's bucket after the grant, not the global pot. */
  balance: string;
};

/**
 * Tops one partner's bucket up directly, which is what the storefront spends.
 * `grantLoyaltyPoints` funds the global pot instead, and the two are not
 * interchangeable — which is why both are offered, and both carry the same gate.
 */
export function grantBusinessLoyaltyPoints(
  input: { businessId: string; amount: string },
  token: string,
): Promise<DevBusinessGrant> {
  return apiRequest<DevBusinessGrant>(
    "/api/public/rewards/dev-business-credit",
    { method: "POST", body: input, token },
  );
}

export type DevPurchaseResult = {
  rewardAmount: string;
  balance: string;
  heldForReview: boolean;
};

/**
 * Stands in for a partner scanning the wallet QR at their checkout. Runs the real
 * earning path, so the partner is billed for the LP — which is what makes the
 * settlement side testable, unlike `grantLoyaltyPoints`.
 */
export function simulatePurchase(
  input: { businessId: string; purchaseAmount: string },
  token: string,
): Promise<DevPurchaseResult> {
  return apiRequest<DevPurchaseResult>("/api/public/rewards/dev-purchase", {
    method: "POST",
    body: input,
    token,
  });
}

export type DevCollectResult = {
  product?: { name: string; businessName: string };
  businessName: string;
  amount: string;
};

/** Stands in for partner staff scanning an item voucher at handover. */
export function simulateCollection(
  voucherCode: string,
  token: string,
): Promise<DevCollectResult> {
  return apiRequest<DevCollectResult>("/api/public/rewards/dev-collect", {
    method: "POST",
    body: { voucherCode },
    token,
  });
}

export type DevVoucherRefresh = {
  refreshed: Array<{ voucherCode: string; movedTo?: string; note?: string }>;
};

/**
 * Makes this number's issued vouchers usable again by moving past bookings to
 * the next slot with room and re-dating them. Expiry itself still applies —
 * see `devRefreshIssuedVouchers` for why it is not simply switched off in dev.
 */
export function refreshMyVouchers(token: string): Promise<DevVoucherRefresh> {
  return apiRequest<DevVoucherRefresh>(
    "/api/public/hunt/dev-refresh-vouchers",
    { method: "POST", body: {}, token },
  );
}
