import { z } from "zod";
import { deleteCustomerAccount } from "@/server/account-deletion";
import { fail, ok } from "@/server/errors";
import { verifyAccountDeletionOtp } from "@/server/otp";
import { normalizePhone } from "@/server/phone";
import { enforceRateLimit } from "@/server/rate-limit";

/** One transaction over every table a customer touches. */
export const maxDuration = 30;

const schema = z.object({
  phone: z.string().min(7),
  code: z.string().regex(/^\d{6}$/, "code must be 6 digits"),
});

/**
 * Step two: the code proves the number, and the account goes.
 *
 * Immediate, not "within 30 days". The published page promises the slower
 * figure because a support-inbox request cannot be faster than the person
 * reading it; this path has nobody in the middle, so there is no reason to make
 * someone wait for something they can be told is already done.
 *
 * The response carries the deletion reference. It is the only key that survives,
 * and a customer who later asks "did that actually happen?" has nothing else to
 * quote at us.
 */
export async function POST(request: Request) {
  try {
    await enforceRateLimit(request, "account/deletion/confirm", {
      limit: 10,
      windowMs: 5 * 60_000,
    });
    const input = schema.parse(await request.json());
    await enforceRateLimit(request, "account/deletion/confirm", {
      limit: 10,
      windowMs: 15 * 60_000,
      subject: normalizePhone(input.phone) ?? input.phone,
    });
    const { phone } = await verifyAccountDeletionOtp(input);
    const summary = await deleteCustomerAccount({ phone, via: "self-serve" });
    return ok({ ref: summary.ref, deletedAt: summary.deletedAt });
  } catch (error) {
    return fail(error);
  }
}
