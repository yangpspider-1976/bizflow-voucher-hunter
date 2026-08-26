import { z } from "zod";
import { assertBusinessAccess, requireAdmin } from "@/server/auth";
import { fail, ok } from "@/server/errors";
import { creditRewardFromPurchase } from "@/server/rewards-network";

const schema = z.object({
  walletToken: z.string().min(16),
  businessId: z.string().min(3),
  purchaseAmount: z.union([z.string().min(1), z.number().positive()]),
  idempotencyKey: z.string().min(12).max(120),
});

export async function POST(request: Request) {
  try {
    const session = await requireAdmin(request);
    const input = schema.parse(await request.json());
    assertBusinessAccess(session, input.businessId);
    const result = await creditRewardFromPurchase({ ...input, staffName: session.email });
    return ok({
      rewardAmount: result.rewardAmount,
      // Both pots, because the staff tool names both: `balance` is what the
      // customer holds at this business — where the award actually landed —
      // and `globalBalance` is the spend-anywhere pot a purchase never moves.
      balance: result.balance,
      globalBalance: result.globalBalance,
      fraudFlag: result.fraudFlag,
      heldForReview: result.heldForReview,
      idempotentReplay: result.idempotentReplay,
    });
  } catch (error) {
    return fail(error);
  }
}
