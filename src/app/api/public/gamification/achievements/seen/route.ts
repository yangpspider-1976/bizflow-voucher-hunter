import { z } from "zod";
import { requireSignedInCustomerPhone } from "@/server/customer-auth";
import { getDb } from "@/server/db";
import { fail, ok } from "@/server/errors";
import { markUnlocksSeen } from "@/server/gamification/achievements";
import { acknowledgeLevelUp } from "@/server/gamification/levels";
import { resolveWallet } from "@/server/gamification/profile";

const schema = z.object({
  groupKeys: z.array(z.string().min(1).max(64)).max(50).optional(),
  /** Set when the app has shown the level-up screen as well. */
  levelUp: z.boolean().optional(),
});

export const dynamic = "force-dynamic";

/**
 * Acknowledges celebration screens the app has shown - badge unlocks, and the
 * level-up screen alongside them.
 *
 * Kept server-side rather than in device storage so an unlock celebrated on one
 * device is not replayed on the next one the customer signs in on - and so an
 * uninstall does not resurrect a year of confetti.
 */
export async function POST(request: Request) {
  try {
    const phone = await requireSignedInCustomerPhone(request);
    const input = schema.parse(await request.json().catch(() => ({})));
    const db = await getDb();
    const walletId = await resolveWallet(phone);
    return ok({
      acknowledged: await markUnlocksSeen(db, walletId, input.groupKeys),
      levelUp: input.levelUp ? await acknowledgeLevelUp(db, walletId) : null,
    });
  } catch (error) {
    return fail(error);
  }
}
