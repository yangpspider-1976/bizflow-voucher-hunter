import { requireSignedInCustomerPhone } from "@/server/customer-auth";
import { getDb } from "@/server/db";
import { fail, ok } from "@/server/errors";
import { adViewsToday, issueAdNonce } from "@/server/gamification/ad-verification";
import { resolveWallet } from "@/server/gamification/profile";
import { enforceRateLimit } from "@/server/rate-limit";

export const dynamic = "force-dynamic";

/**
 * Mints the `custom_data` value the app hands to AdMob before showing a
 * rewarded ad.
 *
 * This is the only link between a signed-in customer and the callback Google
 * later sends us, and it is deliberately short-lived and signed rather than
 * stored: nothing to clean up when an ad is abandoned, and nothing personal
 * travelling through a third party's URL.
 */
export async function POST(request: Request) {
  try {
    await enforceRateLimit(request, "gamification/ad-nonce", {
      limit: 30,
      windowMs: 60_000,
    });
    const phone = await requireSignedInCustomerPhone(request);
    const db = await getDb();
    const walletId = await resolveWallet(phone);
    return ok({
      customData: issueAdNonce(walletId),
      viewsToday: await adViewsToday(db, walletId),
    });
  } catch (error) {
    return fail(error);
  }
}
