import { z } from "zod";
import { assertRewardsAdmin, requireAdmin } from "@/server/auth";
import { getDb, withTx } from "@/server/db";
import { fail, ok } from "@/server/errors";
import { loadLevels, publishLevels } from "@/server/gamification/config";
import { recordRewardAudit } from "@/server/rewards-network";

const levelSchema = z.object({
  level: z.number().int().min(1).max(50),
  minXp: z.number().int().min(0),
  name: z.string().min(1).max(40),
  benefits: z.array(z.string().min(1).max(40)).max(20),
  bonusHunts: z.number().int().min(0).max(10),
  earlyAccessMinutes: z.number().int().min(0).max(1440),
});

const schema = z.object({
  levels: z.array(levelSchema).min(1).max(20),
  effectiveAt: z.string().datetime().optional(),
});

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const session = await requireAdmin(request);
    assertRewardsAdmin(session);
    return ok(await loadLevels(await getDb()));
  } catch (error) {
    return fail(error);
  }
}

/**
 * Publishes a level ladder.
 *
 * Validated hard before it lands: a duplicated threshold or a ladder that does
 * not start at zero would put real players on a level that does not exist and
 * change what they are allowed to buy, so it is refused rather than accepted
 * and worked around later.
 */
export async function POST(request: Request) {
  try {
    const session = await requireAdmin(request);
    assertRewardsAdmin(session);
    const input = schema.parse(await request.json());

    const version = await withTx(async (tx) => {
      const published = await publishLevels(tx, {
        levels: input.levels as Parameters<typeof publishLevels>[1]["levels"],
        effectiveAt: input.effectiveAt,
      });
      await recordRewardAudit(tx, {
        actorType: "admin",
        actorId: session.email,
        action: "gamification_levels_published",
        entityType: "level_definitions",
        entityId: String(published),
        metadata: { levels: input.levels, effectiveAt: input.effectiveAt ?? null },
      });
      return published;
    });

    return ok({ version });
  } catch (error) {
    return fail(error);
  }
}
