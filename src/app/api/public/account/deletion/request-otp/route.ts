import { z } from "zod";
import { accountExists } from "@/server/account-deletion";
import { fail, ok } from "@/server/errors";
import { requestAccountDeletionOtp } from "@/server/otp";
import { normalizePhone } from "@/server/phone";
import { enforceRateLimit } from "@/server/rate-limit";

/** Same reasoning as sign-in: the response waits on an SMPP bind plus a submit. */
export const maxDuration = 30;

const schema = z.object({ phone: z.string().min(7) });

/**
 * Step one of self-serve account deletion: prove the number.
 *
 * Deliberately answers the same way whether or not an account exists. Telling a
 * caller "no account for this number" turns the endpoint into a free lookup of
 * who is a customer, and there is nothing the real owner can do with the answer
 * that the code in their hand does not already tell them.
 */
export async function POST(request: Request) {
  try {
    await enforceRateLimit(request, "account/deletion/request-otp", {
      limit: 3,
      windowMs: 15 * 60_000,
    });
    const input = schema.parse(await request.json());
    // Tighter than sign-in, per number: nobody deletes an account three times,
    // and the text arriving unbidden is alarming in a way a sign-in code is not.
    await enforceRateLimit(request, "account/deletion/request-otp", {
      limit: 3,
      windowMs: 60 * 60_000,
      subject: normalizePhone(input.phone) ?? input.phone,
    });
    // No account, no SMS — but the same response either way, so the endpoint
    // cannot be used to ask whether a number is one of our customers.
    if (!(await accountExists(input.phone))) {
      return ok({ sent: true, expiresAt: new Date(Date.now() + 5 * 60_000).toISOString() });
    }
    const result = await requestAccountDeletionOtp(input);
    return ok({ sent: result.sent, expiresAt: result.expiresAt, devCode: result.devCode });
  } catch (error) {
    return fail(error);
  }
}
