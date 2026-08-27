import { requireSignedInCustomerPhone } from "@/server/customer-auth";
import { fail, ok } from "@/server/errors";
import { gamificationProfile } from "@/server/gamification/profile";

export const dynamic = "force-dynamic";

/**
 * Level, today's missions and achievement progress in one response.
 *
 * One call rather than three because the app renders them on one screen, and
 * three requests landing at different moments would show three different
 * versions of the same player. Reading also creates today's mission instances,
 * which is how the daily reset happens without a job.
 */
export async function GET(request: Request) {
  try {
    const phone = await requireSignedInCustomerPhone(request);
    return ok(await gamificationProfile({ phone }));
  } catch (error) {
    return fail(error);
  }
}
