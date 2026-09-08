import { z } from "zod";
import { requireAdmin } from "@/server/auth";
import { fail, ok } from "@/server/errors";
import { enforceRateLimit } from "@/server/rate-limit";
import { validateRewardVoucher } from "@/server/rewards-network";

const schema = z.object({
  codeOrToken: z.string().min(3),
});

/**
 * Resolves an LP voucher code for staff at checkout.
 *
 * Unscoped by design — a plain LP voucher is spendable at any partner, so this
 * cannot be narrowed to the caller's own business the way campaign vouchers can.
 * That makes it the network's one code-lookup oracle, so it is budgeted per
 * account: a checkout scans a handful of codes an hour, and anything walking the
 * code space stops long before it finds a stranger's voucher.
 */
export async function POST(request: Request) {
  try {
    const session = await requireAdmin(request);
    await enforceRateLimit(request, "staff/rewards/validate-voucher", {
      limit: 60,
      windowMs: 60_000,
      subject: session.email,
    });
    const result = await validateRewardVoucher(schema.parse(await request.json()));
    return ok({
      voucher: {
        voucherCode: result.voucher.voucherCode,
        remainingCentavos: result.voucher.remainingCentavos,
        // Set on fixed-denomination vouchers; the checkout needs it to know a
        // purchase amount is required and what the floor is.
        minimumSpendCentavos: result.voucher.minimumSpendCentavos,
        status: result.voucher.status,
        expiresAt: result.voucher.expiresAt,
      },
      wallet: {
        maskedPhone: result.wallet.maskedPhone,
        status: result.wallet.status,
      },
      // The named item a storefront voucher buys, and the partner that sold it.
      // The engine has resolved this all along but the response dropped it, so
      // the checkout could neither name what to hand over nor tell the redeem
      // leg which partner was being credited.
      product: result.product,
    });
  } catch (error) {
    return fail(error);
  }
}
