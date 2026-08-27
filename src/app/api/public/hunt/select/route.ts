import { z } from "zod";
import { requireSignedInCustomerPhone } from "@/server/customer-auth";
import { fail, ok } from "@/server/errors";
import { enforceRateLimit } from "@/server/rate-limit";
import { onVoucherSelected } from "@/server/gamification/hooks";
import { selectFinalVoucher, sendVoucherConfirmationSms } from "@/server/voucher-engine";

// The phone comes from the OTP-verified session cookie, never the body.
const schema = z.object({
  campaignSlug: z.string().min(1),
  attemptId: z.string().min(1),
  slotId: z.string().min(1),
  sessionId: z.string().min(1),
  name: z.string().min(2),
  email: z.string().email().optional().or(z.literal("")),
  guestCount: z.coerce.number().int().min(1).max(20).optional()
});

/**
 * How long the response will wait on the SMS provider before returning anyway.
 * The voucher is already committed by then, so this only decides whether the
 * visitor waits for delivery. Without a cap an unreachable SMSC stalls the
 * confirm for the full SMPP bind + submit timeout (30s each by default), which
 * the visitor experiences as the button hanging.
 */
const smsResponseBudgetMs = Number(process.env.SMS_RESPONSE_BUDGET_MS ?? 4000);

/**
 * The response is capped at `smsResponseBudgetMs`, but the confirmation SMS keeps
 * going after it — and a cold SMPP bind alone can outlast Vercel's default 10s
 * ceiling, which would kill the instance mid-submit and lose the message. Matches
 * the sign-in route so both SMS paths get the same budget.
 */
export const maxDuration = 30;

export async function POST(request: Request) {
  try {
    await enforceRateLimit(request, "hunt/select", { limit: 15, windowMs: 60_000 });
    const phone = await requireSignedInCustomerPhone(request);
    const input = schema.parse(await request.json());
    const result = await selectFinalVoucher({ ...input, phone });
    await onVoucherSelected({
      phone,
      voucherId: result.voucher.id,
      campaignId: result.campaign.id,
      businessId: result.campaign.businessId,
    });
    // Voucher issuance already succeeded; an SMS delivery failure is logged
    // in sms_logs and must not fail this request. A healthy provider resolves
    // well inside the budget; a slow one keeps going in the background while
    // the visitor gets their confirmation.
    const delivery = sendVoucherConfirmationSms(result.voucher.id).catch(
      () => undefined,
    );
    let budgetTimer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      delivery,
      new Promise((resolve) => {
        budgetTimer = setTimeout(resolve, smsResponseBudgetMs);
      }),
    ]);
    clearTimeout(budgetTimer);
    return ok(result);
  } catch (error) {
    return fail(error);
  }
}
