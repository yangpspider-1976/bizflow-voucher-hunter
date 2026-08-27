import { z } from "zod";
import { requireSignedInCustomerPhone } from "@/server/customer-auth";
import { fail, ok } from "@/server/errors";
import { joinMission } from "@/server/gamification/missions";
import { enforceRateLimit } from "@/server/rate-limit";

const paramsSchema = z.object({ missionKey: z.string().min(1).max(64) });

export const dynamic = "force-dynamic";

/**
 * Joins an urgent mission, taking a quota place if the campaign reserves on
 * join. Every eligibility rule - level, schedule, inventory, budget - is
 * checked here rather than trusted from the card the app happened to render.
 */
export async function POST(
  request: Request,
  { params }: { params: { missionKey: string } },
) {
  try {
    await enforceRateLimit(request, "gamification/mission-join", {
      limit: 30,
      windowMs: 60_000,
    });
    const phone = await requireSignedInCustomerPhone(request);
    const { missionKey } = paramsSchema.parse(params);
    return ok(await joinMission({ phone, missionKey }));
  } catch (error) {
    return fail(error);
  }
}
