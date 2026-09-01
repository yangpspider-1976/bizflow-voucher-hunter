import { z } from "zod";
import { assertRewardsAdmin, requireAdmin } from "@/server/auth";
import { fail, ok } from "@/server/errors";
import { onPurchaseVerified } from "@/server/gamification/hooks";
import { notifyHeldPurchaseApproved } from "@/server/notifications";
import { centavosToLoyaltyPoints, reviewHeldRewardPurchase } from "@/server/rewards-network";

const schema = z.object({
  purchaseId: z.string().min(3),
  decision: z.enum(["approve", "reject"]),
  note: z.string().trim().optional(),
});

export async function POST(request: Request) {
  try {
    const session = await requireAdmin(request);
    assertRewardsAdmin(session);
    const input = schema.parse(await request.json());
    const result = await reviewHeldRewardPurchase({
      purchaseId: input.purchaseId,
      decision: input.decision,
      reviewer: session.email,
      note: input.note,
    });
    // Approval is the moment the customer's held LP actually lands. Notify after
    // the transaction has committed; a failed push must not fail the review.
    if (input.decision === "approve") {
      void notifyHeldPurchaseApproved({
        phone: result.wallet.phone,
        rewardAmount: centavosToLoyaltyPoints(result.purchase.rewardAmountCentavos),
        balance: result.balance,
      });
      // The approval is when a held scan becomes a verified purchase. The
      // credit route deliberately raises nothing for a held one, so without
      // this a mission built on `purchase_verified` would never hear about a
      // sale that was flagged and then cleared.
      //
      // Keyed on the purchase id in both places, so the two paths can never pay
      // the same sale twice. The event is stamped now rather than at the time
      // of the scan, because being verified is what the mission is counting,
      // and that happened here.
      await onPurchaseVerified({
        phone: result.wallet.phone,
        businessId: result.purchase.businessId,
        purchaseId: result.purchase.id,
        amountCentavos: result.purchase.purchaseAmountCentavos,
      });
    }
    return ok(result);
  } catch (error) {
    return fail(error);
  }
}
