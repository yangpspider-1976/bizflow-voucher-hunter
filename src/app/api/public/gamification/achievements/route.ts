import { requireSignedInCustomerPhone } from "@/server/customer-auth";
import { withReadTx } from "@/server/db";
import { fail, ok } from "@/server/errors";
import { unseenUnlocks } from "@/server/gamification/achievements";
import { achievementCards, featuresFor, resolveWallet } from "@/server/gamification/profile";

export const dynamic = "force-dynamic";

/** Every badge group, all four tiers, and where this player stands on each. */
export async function GET(request: Request) {
  try {
    const phone = await requireSignedInCustomerPhone(request);
    const walletId = await resolveWallet(phone);

    // Counters stop moving when achievements are off, so a populated board
    // would be a frozen one: every bar stuck where it was, with nothing to
    // say why. Empty, and the app hides the section.
    if (!(await featuresFor(walletId)).achievements) {
      return ok({ achievements: [], unseenUnlocks: [] });
    }

    return ok(
      await withReadTx(async (tx) => ({
        achievements: await achievementCards(tx, walletId),
        unseenUnlocks: await unseenUnlocks(tx, walletId),
      })),
    );
  } catch (error) {
    return fail(error);
  }
}
