import { z } from "zod";
import { assertRewardsAdmin, assertSuperAdmin, requireAdmin } from "@/server/auth";
import { withTx } from "@/server/db";
import { AppError, fail, ok } from "@/server/errors";
import { reverseReward } from "@/server/gamification/rewards";

const paramsSchema = z.object({ rewardTxId: z.string().min(3).max(64) });
const bodySchema = z.object({
  reason: z.string().min(8).max(280),
  /**
   * The second pair of eyes. A reversal moves real balances, so the requirements
   * class it as a privileged operation needing dual approval; recorded on the
   * audit row rather than merely asserted in a chat message.
   */
  secondApprover: z.string().email(),
});

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: { rewardTxId: string } },
) {
  try {
    const session = await requireAdmin(request);
    assertRewardsAdmin(session);
    // Reversal is the one gamification action that takes value back, so it is
    // held to the highest role rather than to the rewards role alone.
    assertSuperAdmin(session);
    const { rewardTxId } = paramsSchema.parse(params);
    const body = bodySchema.parse(await request.json());
    if (body.secondApprover.toLowerCase() === session.email.toLowerCase()) {
      throw new AppError(
        "E-DUAL-APPROVAL",
        "A reversal needs a second approver who is not you",
        403,
      );
    }

    return ok(
      await withTx((tx) =>
        reverseReward(tx, {
          rewardTxId,
          actor: session.email,
          reason: `${body.reason} (approved with ${body.secondApprover})`,
        }),
      ),
    );
  } catch (error) {
    return fail(error);
  }
}
