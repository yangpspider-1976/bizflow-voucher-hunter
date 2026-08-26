import { z } from "zod";
import { requireSignedInCustomerPhone } from "@/server/customer-auth";
import { assertDevToolsEnabledFor } from "@/server/dev-tools";
import { fail, ok } from "@/server/errors";
import { enforceRateLimit } from "@/server/rate-limit";
import { grantDevBusinessLoyaltyPoints } from "@/server/rewards-network";

const schema = z.object({
  businessId: z.string().min(3),
  amount: z.union([z.string().trim().min(1), z.number()]),
});

/**
 * Dev-tools helper: tops one partner's bucket up directly.
 *
 * The bucket counterpart to `dev-credit`, which funds the global pot. Neither
 * bills the partner — use `dev-purchase` when the statement side matters — so
 * both carry the same gate, open to the production developer account for its
 * own wallet only.
 *
 * The gate runs after authentication rather than before it, because it is the
 * session that identifies the developer account — see the ordering note in
 * ../../hunt/reset/route.ts.
 *
 * Guarded here and again in `grantDevBusinessLoyaltyPoints`.
 */
export async function POST(request: Request) {
  try {
    await enforceRateLimit(request, "rewards/dev-business-credit", {
      limit: 30,
      windowMs: 60_000,
    });
    const phone = await requireSignedInCustomerPhone(request);
    assertDevToolsEnabledFor(phone, "Granting Loyalty Points");
    const input = schema.parse(await request.json());
    return ok(
      await grantDevBusinessLoyaltyPoints({
        phone,
        businessId: input.businessId,
        amount: input.amount,
      }),
    );
  } catch (error) {
    return fail(error);
  }
}
