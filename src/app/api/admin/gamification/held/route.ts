import { z } from "zod";
import { assertRewardsAdmin, requireAdmin } from "@/server/auth";
import { getDb, withTx } from "@/server/db";
import { fail, ok } from "@/server/errors";
import { listHeldRewards, settleHeldReward } from "@/server/gamification/rewards";

export const dynamic = "force-dynamic";

/** Rewards parked for a person to decide on, oldest first — a queue. */
export async function GET(request: Request) {
  try {
    const session = await requireAdmin(request);
    assertRewardsAdmin(session);
    const db = await getDb();
    const params = new URL(request.url).searchParams;
    return ok(await listHeldRewards(db, Number(params.get("limit") ?? 100)));
  } catch (error) {
    return fail(error);
  }
}

const schema = z.object({
  rewardTxId: z.string().min(4).max(64),
  decision: z.enum(["Approve", "Reject"]),
  reason: z.string().min(4).max(280),
  /** The finance reference number §6.2 asks to be recorded against an approval. */
  reference: z.string().max(64).optional(),
});

/**
 * Approves or rejects a held reward.
 *
 * Approving pays what the transaction asked for rather than what is recorded on
 * it — a held row carries zeroes precisely because nothing was paid — and
 * applies the daily LP cap as of today, because the cap is a fact about the day
 * the money actually moves.
 */
export async function POST(request: Request) {
  try {
    const session = await requireAdmin(request);
    assertRewardsAdmin(session);
    const input = schema.parse(await request.json());
    return ok(await withTx((tx) => settleHeldReward(tx, { ...input, actor: session.email })));
  } catch (error) {
    return fail(error);
  }
}
