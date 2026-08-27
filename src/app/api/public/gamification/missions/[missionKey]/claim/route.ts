import { z } from "zod";
import { requireSignedInCustomerPhone } from "@/server/customer-auth";
import { fail, ok } from "@/server/errors";
import { claimMission } from "@/server/gamification/missions";
import { enforceRateLimit } from "@/server/rate-limit";

const paramsSchema = z.object({ missionKey: z.string().min(1).max(64) });
const bodySchema = z.object({ missionDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() });

export const dynamic = "force-dynamic";

/**
 * Claims a finished mission.
 *
 * Only reachable for missions that do not pay automatically. A second tap on a
 * claimed mission is answered with REWARD_ALREADY_GRANTED rather than a second
 * payout, and the reward transaction's unique key would refuse it even if this
 * check somehow passed.
 */
export async function POST(
  request: Request,
  { params }: { params: { missionKey: string } },
) {
  try {
    await enforceRateLimit(request, "gamification/mission-claim", {
      limit: 60,
      windowMs: 60_000,
    });
    const phone = await requireSignedInCustomerPhone(request);
    const { missionKey } = paramsSchema.parse(params);
    const body = bodySchema.parse(await request.json().catch(() => ({})));
    return ok(await claimMission({ phone, missionKey, missionDate: body.missionDate }));
  } catch (error) {
    return fail(error);
  }
}
