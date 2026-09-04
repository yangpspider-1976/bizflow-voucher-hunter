import { z } from "zod";
import { requireSignedInCustomerPhone } from "@/server/customer-auth";
import { assertDevToolsEnabled } from "@/server/dev-tools";
import { AppError, fail, ok } from "@/server/errors";
import { onQrRedeemedByWallet } from "@/server/gamification/hooks";
import { enforceRateLimit } from "@/server/rate-limit";
import {
  listWalletPurchases,
  redeemRewardVoucher,
  validateRewardVoucher,
} from "@/server/rewards-network";

const schema = z.object({ voucherCode: z.string().trim().min(3) });

/**
 * Development-only helper: stands in for partner staff scanning an item
 * voucher at handover, the last step of the loop and the one that puts the
 * amount on the partner's statement.
 *
 * The voucher is checked against this customer's own purchases first, so the
 * tool can only collect items belonging to the signed-in wallet — it is a
 * testing shortcut, not a way to redeem someone else's code.
 */
export async function POST(request: Request) {
  try {
    assertDevToolsEnabled("Simulated collection");
    await enforceRateLimit(request, "rewards/dev-collect", {
      limit: 30,
      windowMs: 60_000,
    });
    const phone = await requireSignedInCustomerPhone(request);
    const input = schema.parse(await request.json());

    const owned = (await listWalletPurchases({ phone })).find(
      (item) =>
        item.voucherCode.toUpperCase() === input.voucherCode.toUpperCase(),
    );
    if (!owned) {
      throw new AppError(
        "E-REWARD-VOUCHER-404",
        "No item of yours matches that voucher code",
        404,
      );
    }

    const validated = await validateRewardVoucher({
      codeOrToken: owned.voucherCode,
    });
    const redeemed = await redeemRewardVoucher({
      codeOrToken: owned.voucherCode,
      businessId: owned.businessId,
      // Item vouchers are all-or-nothing; the partner is billed the full price.
      amount: owned.priceCentavos / 100,
      staffName: "Dev Tools Staff",
    });
    // This tool stands in for the partner's scanner, so it has to raise what
    // the scanner raises. Without it the leg it simulates looked complete while
    // the scan mission and the visit counters saw nothing.
    await onQrRedeemedByWallet({
      walletId: redeemed.redemption.walletId,
      businessId: owned.businessId,
      objectType: "reward_voucher_redemption",
      objectId: redeemed.redemption.id,
      amountCentavos: redeemed.redemption.amountCentavos,
    });
    return ok({
      product: validated.product,
      businessName: owned.businessName,
      amount: redeemed.amount,
      voucher: redeemed.voucher,
    });
  } catch (error) {
    return fail(error);
  }
}
