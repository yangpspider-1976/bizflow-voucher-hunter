import { requireSignedInCustomerPhone } from "@/server/customer-auth";
import { withReadTx } from "@/server/db";
import { fail, ok } from "@/server/errors";
import { unseenUnlocks } from "@/server/gamification/achievements";
import { achievementCards, resolveWallet } from "@/server/gamification/profile";

export const dynamic = "force-dynamic";

/** Every badge group, all four tiers, and where this player stands on each. */
export async function GET(request: Request) {
  try {
    const phone = await requireSignedInCustomerPhone(request);
    const walletId = await resolveWallet(phone);
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
