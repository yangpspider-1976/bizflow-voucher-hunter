import { z } from "zod";
import { assertRewardsAdmin, requireAdmin } from "@/server/auth";
import { getDb, withTx } from "@/server/db";
import { fail, ok } from "@/server/errors";
import { DEFAULT_RISK, loadEconomy, publishEconomy } from "@/server/gamification/config";
import { recordRewardAudit } from "@/server/rewards-network";

const schema = z.object({
  xpPerLp: z.number().positive().max(1000),
  minConversionCentavos: z.number().int().positive(),
  conversionPresetsCentavos: z.array(z.number().int().positive()).min(1).max(6),
  dailyLpGrantCapCentavos: z.number().int().nonnegative(),
  reviewThresholdCentavos: z.number().int().nonnegative(),
  quietHours: z.object({
    start: z.string().regex(/^\d{2}:\d{2}$/),
    end: z.string().regex(/^\d{2}:\d{2}$/),
  }),
  // Optional so an older client that does not know about risk thresholds keeps
  // publishing valid economy versions; the loader fills the defaults back in.
  risk: z
    .object({
      adsPerDay: z.number().int().min(1).max(500),
      walletsPerDevice: z.number().int().min(2).max(100),
      qrPerDay: z.number().int().min(1).max(500),
      referralsPerDay: z.number().int().min(1).max(500),
      reviewsPerDay: z.number().int().min(1).max(500),
      rejectedProofs: z.number().int().min(1).max(100),
      holdScore: z.number().int().min(1).max(100),
    })
    .optional(),
  note: z.string().max(280).optional(),
  effectiveAt: z.string().datetime().optional(),
});

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const session = await requireAdmin(request);
    assertRewardsAdmin(session);
    return ok(await loadEconomy(await getDb()));
  } catch (error) {
    return fail(error);
  }
}

/**
 * Publishes a new economy version.
 *
 * Never an edit. Historical transactions record the version they ran under, so
 * changing values in place would silently rewrite what a settled month meant.
 * A future `effectiveAt` stages the change instead of applying it.
 */
export async function POST(request: Request) {
  try {
    const session = await requireAdmin(request);
    assertRewardsAdmin(session);
    const { note, effectiveAt, risk, ...rest } = schema.parse(await request.json());
    const economy = { ...rest, risk: risk ?? DEFAULT_RISK };

    const version = await withTx(async (tx) => {
      const published = await publishEconomy(tx, {
        economy,
        actor: session.email,
        note,
        effectiveAt,
      });
      await recordRewardAudit(tx, {
        actorType: "admin",
        actorId: session.email,
        action: "gamification_economy_published",
        entityType: "gamification_config",
        entityId: `economy:${published}`,
        metadata: { ...economy, note: note ?? null, effectiveAt: effectiveAt ?? null },
      });
      return published;
    });

    return ok({ version });
  } catch (error) {
    return fail(error);
  }
}
