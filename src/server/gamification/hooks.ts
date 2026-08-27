/**
 * Where the existing product meets the rules engine.
 *
 * Every gamification trigger in the app is one call from this file, so "what
 * feeds missions and achievements" is a list you can read rather than a search
 * across the codebase. Each hook is fire-and-safe: it can fail without failing
 * the hunt, redemption or referral that called it, because the event row it
 * writes is retried by `processPendingEvents` afterwards.
 *
 * The idempotency keys here are the important part. Each one names the fact
 * rather than the moment — an attempt id, a voucher id, a redemption id — so a
 * retried request, a double-submitted form and a replayed webhook all describe
 * the same event and are counted once.
 */
import { getDb, one } from "@/server/db";
import { ingestEventQuietly, type IngestResult, IGNORED_RESULT } from "./events";

/** A finished hunt spin: the player has seen what they drew. */
export function onHuntComplete(input: {
  phone: string;
  attemptId: string;
  campaignId: string;
  businessId?: string | null;
  occurredAt?: string;
}): Promise<IngestResult> {
  return ingestEventQuietly({
    eventName: "hunt_complete",
    phone: input.phone,
    source: "voucher-engine",
    partnerId: input.businessId ?? null,
    objectType: "attempt",
    objectId: input.attemptId,
    occurredAt: input.occurredAt,
    idempotencyKey: `hunt_complete:${input.attemptId}`,
    metadata: { campaignId: input.campaignId },
  });
}

/** A hunt result turned into a booked voucher. */
export function onVoucherSelected(input: {
  phone: string;
  voucherId: string;
  campaignId: string;
  businessId?: string | null;
}): Promise<IngestResult> {
  return ingestEventQuietly({
    eventName: "voucher_select",
    phone: input.phone,
    source: "voucher-engine",
    partnerId: input.businessId ?? null,
    objectType: "voucher",
    objectId: input.voucherId,
    idempotencyKey: `voucher_select:${input.voucherId}`,
    metadata: { campaignId: input.campaignId },
  });
}

/**
 * A QR actually scanned at a partner.
 *
 * Both kinds count: a campaign voucher redeemed at the till and an LP voucher
 * spent from the storefront are the same thing to a player — they went
 * somewhere and used something — and the requirements count both toward Voucher
 * User and City Explorer.
 */
export function onQrRedeemed(input: {
  phone: string;
  businessId: string;
  objectType: string;
  objectId: string;
  amountCentavos?: number | null;
}): Promise<IngestResult> {
  return ingestEventQuietly({
    eventName: "qr_redeem",
    phone: input.phone,
    source: "redemption",
    partnerId: input.businessId,
    objectType: input.objectType,
    objectId: input.objectId,
    amountCentavos: input.amountCentavos ?? null,
    idempotencyKey: `qr_redeem:${input.objectType}:${input.objectId}`,
  });
}

/** The wallet-id form, for callers that never had a phone number to hand. */
export async function onQrRedeemedByWallet(input: {
  walletId: string;
  businessId: string;
  objectType: string;
  objectId: string;
  amountCentavos?: number | null;
}): Promise<IngestResult> {
  const db = await getDb();
  const wallet = await one(db, "SELECT phone FROM reward_wallets WHERE id = ?", [
    input.walletId,
  ]);
  if (!wallet) return IGNORED_RESULT;
  return onQrRedeemed({ ...input, phone: String(wallet.phone) });
}

/** A share that produced a real, checked visit — not a click. */
export function onReferralVerified(input: {
  phone: string;
  referralRewardId: string;
  campaignId?: string;
}): Promise<IngestResult> {
  return ingestEventQuietly({
    eventName: "referral_verified",
    phone: input.phone,
    source: "referral",
    objectType: "referral_reward",
    objectId: input.referralRewardId,
    idempotencyKey: `referral_verified:${input.referralRewardId}`,
    metadata: input.campaignId ? { campaignId: input.campaignId } : undefined,
  });
}

/** A staff-verified purchase, which is also what accrues the 5% loyalty. */
export function onPurchaseVerified(input: {
  phone: string;
  businessId: string;
  purchaseId: string;
  amountCentavos: number;
}): Promise<IngestResult> {
  return ingestEventQuietly({
    eventName: "purchase_verified",
    phone: input.phone,
    source: "rewards-network",
    partnerId: input.businessId,
    objectType: "reward_purchase",
    objectId: input.purchaseId,
    amountCentavos: input.amountCentavos,
    idempotencyKey: `purchase_verified:${input.purchaseId}`,
  });
}
