import { z } from "zod";
import { assertBusinessAccess, requireAdmin } from "@/server/auth";
import { fail, ok } from "@/server/errors";
import { enforceRateLimit } from "@/server/rate-limit";
import { onQrRedeemedByWallet } from "@/server/gamification/hooks";
import { redeemRewardVoucher } from "@/server/rewards-network";

const schema = z.object({
  codeOrToken: z.string().min(3),
  businessId: z.string().min(3),
  amount: z.union([z.string().min(1), z.number().positive()]),
  // The bill being paid, as opposed to `amount`, which is how much of the
  // voucher is spent. Only fixed-denomination vouchers require it, so it stays
  // optional here and the engine rejects the ones that need it and lack it.
  purchaseAmount: z.union([z.string().min(1), z.number().positive()]).optional(),
});

export async function POST(request: Request) {
  try {
    const session = await requireAdmin(request);
    // Spending a stranger's LP at your own checkout is the payoff for guessing a
    // code, so the redeem leg is budgeted per account too, not just the lookup.
    await enforceRateLimit(request, "staff/rewards/redeem", {
      limit: 60,
      windowMs: 60_000,
      subject: session.email,
    });
    const input = schema.parse(await request.json());
    assertBusinessAccess(session, input.businessId);
    const result = await redeemRewardVoucher({ ...input, staffName: session.email });
    // Spending an LP voucher is a visit too, so it counts toward Voucher User
    // and City Explorer alongside campaign vouchers.
    await onQrRedeemedByWallet({
      walletId: result.redemption.walletId,
      businessId: input.businessId,
      objectType: "reward_voucher_redemption",
      objectId: result.redemption.id,
      amountCentavos: result.redemption.amountCentavos,
    });
    return ok({
      voucher: {
        voucherCode: result.voucher.voucherCode,
        remainingCentavos: result.voucher.remainingCentavos,
        status: result.voucher.status,
        expiresAt: result.voucher.expiresAt,
      },
      amount: result.amount,
      serviceFee: result.serviceFee,
      settlementAmount: result.settlementAmount,
    });
  } catch (error) {
    return fail(error);
  }
}
