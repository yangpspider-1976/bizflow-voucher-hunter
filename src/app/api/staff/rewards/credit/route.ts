import { z } from "zod";
import { assertBusinessAccess, requireAdmin } from "@/server/auth";
import { fail, ok } from "@/server/errors";
import { onPurchaseVerified } from "@/server/gamification/hooks";
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
    // The scan at the till is the fact a `purchase_verified` mission is written
    // against, and this is the only place a real checkout produces one.
    //
    // A held scan is deliberately not one yet: it has credited nothing and a
    // person still has to look at it, so paying a mission on it would pay for a
    // sale the platform has not itself honoured. The event waits for the review
    // that releases it, in /api/dashboard/rewards/purchases/review.
    //
    // Raised after the credit transaction has committed and awaited like the
    // redemption hook beside it. `onPurchaseVerified` swallows its own faults,
    // so a rules-engine problem cannot fail a scan the partner is already
    // billed for, and the event row is retried by the maintenance cron.
    if (!result.heldForReview) {
      await onPurchaseVerified({
        phone: result.wallet.phone,
        businessId: input.businessId,
        purchaseId: result.purchase.id,
        amountCentavos: result.purchase.purchaseAmountCentavos,
      });
    }
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
