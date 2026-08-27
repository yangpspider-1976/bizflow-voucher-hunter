import { z } from "zod";
import { requireSignedInCustomerPhone } from "@/server/customer-auth";
import { fail, ok } from "@/server/errors";
import { convertPointsToXp } from "@/server/gamification/levels";
import { enforceRateLimit } from "@/server/rate-limit";

const schema = z.object({
  /** Null or absent converts from the spend-anywhere global pot. */
  businessId: z.string().min(1).nullable().optional(),
  amount: z.union([z.string().min(1), z.number().positive()]),
  /**
   * The client's key for this tap. Required rather than optional: without one a
   * retry after a timeout converts twice, and the customer has no way to know
   * which of the two happened.
   */
  idempotencyKey: z.string().min(8).max(128),
});

export const dynamic = "force-dynamic";

/**
 * Spends Loyalty Points on experience.
 *
 * Irreversible by design and stated as such on the confirmation screen: the LP
 * is extinguished, not held, and the XP it becomes has no cash value. The
 * server does the whole thing in one transaction — lock, debit, credit,
 * recalculate — so a promotion is never announced against points that did not
 * actually leave.
 */
export async function POST(request: Request) {
  try {
    // Rate-limited even though every path is idempotent: the limit is what
    // stops a client burning a wallet down with a thousand distinct keys.
    await enforceRateLimit(request, "gamification/convert-points", {
      limit: 20,
      windowMs: 60_000,
    });
    const phone = await requireSignedInCustomerPhone(request);
    const input = schema.parse(await request.json());
    return ok(
      await convertPointsToXp({
        phone,
        businessId: input.businessId ?? null,
        amount: input.amount,
        idempotencyKey: input.idempotencyKey,
      }),
    );
  } catch (error) {
    return fail(error);
  }
}
