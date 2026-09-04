import { z } from "zod";
import { ACHIEVEMENT_TIERS } from "@bizflow/shared";
import { requireSignedInCustomerPhone } from "@/server/customer-auth";
import { fail, ok } from "@/server/errors";
import { setBadgeFeatured } from "@/server/gamification/achievements";
import { featuresFor, resolveWallet } from "@/server/gamification/profile";
import { enforceRateLimit } from "@/server/rate-limit";

const bodySchema = z.object({
  groupKey: z.string().min(1).max(64),
  tier: z.enum(ACHIEVEMENT_TIERS as unknown as [string, ...string[]]),
  featured: z.boolean(),
});

export const dynamic = "force-dynamic";

/**
 * Puts one badge on the player's profile, or takes it off.
 *
 * §5.3's "select 1-3 featured badges". A toggle rather than a whole-list write:
 * sending the entire selection would make two devices racing overwrite each
 * other's choice wholesale, where a toggle only ever disagrees about the one
 * badge that was tapped.
 */
export async function POST(request: Request) {
  try {
    await enforceRateLimit(request, "gamification/badge-feature", {
      limit: 60,
      windowMs: 60_000,
    });
    const phone = await requireSignedInCustomerPhone(request);
    const body = bodySchema.parse(await request.json());

    const walletId = await resolveWallet(phone);
    // Featuring a badge is part of the achievement feature; with it switched
    // off the board is empty and there is nothing to choose from.
    if (!(await featuresFor(walletId)).achievements) {
      return ok({ featured: [] });
    }

    return ok(
      await setBadgeFeatured({
        walletId,
        groupKey: body.groupKey,
        tier: body.tier as (typeof ACHIEVEMENT_TIERS)[number],
        featured: body.featured,
      }),
    );
  } catch (error) {
    return fail(error);
  }
}
