import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { enforceRateLimit } from "@/server/rate-limit";
import { AppError, fail, ok } from "@/server/errors";
import { notifyReferralConverted } from "@/server/notifications";
import { onReferralVerified } from "@/server/gamification/hooks";
import { recordReferralOpen } from "@/server/voucher-engine";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const VISITOR_COOKIE = "bizflow_visitor_session";
const schema = z.object({
  campaign: z.string().min(1),
  ref: z.string().min(1),
});

function campaignPath(campaign: string, ref?: string) {
  const query = ref
    ? `?${new URLSearchParams({ ref }).toString()}`
    : "";
  return `/campaign/${encodeURIComponent(campaign)}${query}`;
}

function relativeRedirect(path: string) {
  return new NextResponse(null, {
    status: 307,
    headers: {
      location: path,
      "cache-control": "private, no-cache, no-store, max-age=0",
    },
  });
}

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const parsed = schema.safeParse({
    campaign: url.searchParams.get("campaign"),
    ref: url.searchParams.get("ref"),
  });
  if (!parsed.success) return relativeRedirect("/");

  const visitorSessionId = request.cookies.get(VISITOR_COOKIE)?.value;
  if (!visitorSessionId) {
    return relativeRedirect(campaignPath(parsed.data.campaign, parsed.data.ref));
  }

  let recorded = false;
  try {
    await enforceRateLimit(request, "referral/claim", {
      limit: 15,
      windowMs: 60_000,
    });
    const outcome = await recordReferralOpen({
      campaignSlug: parsed.data.campaign,
      ref: parsed.data.ref,
      visitorSessionId,
    });
    recorded = true;
    // Fire-and-forget, after the grant has committed. The visitor is mid-redirect;
    // their referrer's notification must not delay or fail that.
    if (outcome.granted && outcome.referrerPhone) {
      // The Connector achievement counts verified referrals, and this is the
      // only place one is verified — so this one is awaited. Left unawaited it
      // was a local write racing the end of the request: on serverless the
      // process can be frozen once the response is sent, and a referral reward
      // that sometimes does not arrive is indistinguishable from a broken
      // achievement. It is a database round trip and it cannot throw.
      await onReferralVerified({
        phone: outcome.referrerPhone,
        referralRewardId: outcome.referralRewardId ?? "",
        campaignId: outcome.campaignId,
      });
      // The push stays fire-and-forget: it is a call out to Expo rather than a
      // local write, and a missed notification costs nothing that a missed
      // reward does.
      void notifyReferralConverted({
        phone: outcome.referrerPhone,
        campaignSlug: outcome.campaignSlug ?? parsed.data.campaign,
        loyaltyAwarded: Boolean(outcome.loyaltyAwarded),
      });
    }
  } catch {
    // The landing-page fallback will retry transient failures.
  }

  return relativeRedirect(
    campaignPath(parsed.data.campaign, recorded ? undefined : parsed.data.ref),
  );
}

/**
 * Client-side fallback for reverse-proxy/cookie handoff failures.
 *
 * It has no caller since the web customer flow was removed — the campaign page
 * that posted here is gone, and the app never touches referral endpoints (see
 * `useDeepLinkGate`). Kept because the GET handoff above can still strand a
 * grant on a proxy that drops the cookie, and this is the only recovery path;
 * it is covered by `tests/integration/referral-flow.test.ts`. Delete it if that
 * recovery is judged unnecessary rather than leaving it half-wired.
 */
export async function POST(request: NextRequest) {
  try {
    const input = schema.parse(await request.json());
    const visitorSessionId = request.cookies.get(VISITOR_COOKIE)?.value;
    if (!visitorSessionId) {
      throw new AppError(
        "E-REFERRAL-SESSION",
        "Visitor session is not ready",
        409,
      );
    }
    await enforceRateLimit(request, "referral/claim", {
      limit: 15,
      windowMs: 60_000,
    });
    const outcome = await recordReferralOpen({
      campaignSlug: input.campaign,
      ref: input.ref,
      visitorSessionId,
    });
    if (outcome.granted && outcome.referrerPhone) {
      // Awaited for the same reason as the sibling call above: the reward is a
      // local write and must not race the end of the request.
      await onReferralVerified({
        phone: outcome.referrerPhone,
        referralRewardId: outcome.referralRewardId ?? "",
        campaignId: outcome.campaignId,
      });
      void notifyReferralConverted({
        phone: outcome.referrerPhone,
        campaignSlug: outcome.campaignSlug ?? input.campaign,
        loyaltyAwarded: Boolean(outcome.loyaltyAwarded),
      });
    }
    return ok(outcome);
  } catch (error) {
    return fail(error);
  }
}
