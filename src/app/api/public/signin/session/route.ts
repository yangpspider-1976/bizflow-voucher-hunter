import { requireSignedInCustomerPhone } from "@/server/customer-auth";
import { isDevAccountPhone } from "@/server/dev-tools";
import { fail, ok } from "@/server/errors";

/**
 * Lightweight mobile session check used after foregrounding and admin resets.
 *
 * Also carries `devTools`, which is what both clients render their dev panel
 * from: a build-time answer (`NODE_ENV`, `__DEV__`) cannot tell a production
 * build that this particular number is a developer account, and cannot tell a
 * development build that the number signed in is not.
 *
 * Deliberately `isDevAccountPhone` rather than `devToolsEnabledFor`: the wider
 * gate opens for every account on a development deployment, which would put the
 * panel in front of the ordinary test accounts too. Enforcement still uses the
 * wider gate — this answer is advisory, and every tool re-checks server-side.
 */
export async function GET(request: Request) {
  try {
    const phone = await requireSignedInCustomerPhone(request);
    return ok({ phone, devTools: isDevAccountPhone(phone) });
  } catch (error) {
    return fail(error);
  }
}
