import { z } from "zod";
import { requireSignedInCustomerPhone } from "@/server/customer-auth";
import { assertDevToolsEnabledFor } from "@/server/dev-tools";
import { fail, ok } from "@/server/errors";
import { enforceRateLimit } from "@/server/rate-limit";
import { grantDevLoyaltyPoints } from "@/server/rewards-network";

const schema = z.object({
  amount: z.union([z.string().trim().min(1), z.number()]),
});

/**
 * Dev-tools helper behind the More tab's dev tools: tops the signed-in wallet up
 * with LP so the storefront and settlement flows can be exercised without
 * scanning purchases at a partner checkout.
 *
 * Open to the production developer account for its own wallet only. The grant
 * credits the caller's own balance and bills no partner — see the note on
 * `devAccountPhones`, which draws the line at `dev-purchase`/`dev-collect`,
 * where a real partner ends up on the hook.
 *
 * The gate runs after authentication rather than before it, because it is the
 * session that identifies the developer account — see the ordering note in
 * ../../hunt/reset/route.ts.
 *
 * Guarded here and again in `grantDevLoyaltyPoints`.
 */
export async function POST(request: Request) {
  try {
    await enforceRateLimit(request, "rewards/dev-credit", {
      limit: 30,
      windowMs: 60_000,
    });
    const phone = await requireSignedInCustomerPhone(request);
    assertDevToolsEnabledFor(phone, "Granting Loyalty Points");
    const input = schema.parse(await request.json());
    return ok(await grantDevLoyaltyPoints({ phone, amount: input.amount }));
  } catch (error) {
    return fail(error);
  }
}
