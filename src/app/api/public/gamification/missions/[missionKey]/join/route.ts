import { z } from "zod";
import { requireSignedInCustomerPhone } from "@/server/customer-auth";
import { fail, ok } from "@/server/errors";
import { joinMission } from "@/server/gamification/missions";
import { enforceRateLimit } from "@/server/rate-limit";

const paramsSchema = z.object({ missionKey: z.string().min(1).max(64) });

/**
 * The phone's own position, sent only for a mission confined to an area.
 *
 * Optional on purpose: most campaigns have no radius, and asking a player for
 * location consent they do not need is the kind of permission prompt that gets
 * an app uninstalled. `mocked` is the device's own flag, forwarded rather than
 * trusted — the server decides what to do about it.
 */
const locationSchema = z
  .object({
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
    accuracyMeters: z.number().min(0).max(100_000).optional(),
    mocked: z.boolean().optional(),
  })
  .optional();

const bodySchema = z.object({ location: locationSchema }).default({});

export const dynamic = "force-dynamic";

/**
 * Joins an urgent mission, taking a quota place if the campaign reserves on
 * join. Every eligibility rule — level, segment, schedule, area, inventory,
 * budget — is checked here rather than trusted from the card the app happened
 * to render.
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
    const body = bodySchema.parse(await request.json().catch(() => ({})));
    return ok(await joinMission({ phone, missionKey, location: body.location ?? null }));
  } catch (error) {
    return fail(error);
  }
}
