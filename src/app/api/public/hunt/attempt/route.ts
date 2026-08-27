import { z } from "zod";
import { requireSignedInCustomerPhone } from "@/server/customer-auth";
import { fail, ok } from "@/server/errors";
import { enforceRateLimit } from "@/server/rate-limit";
import { onHuntComplete } from "@/server/gamification/hooks";
import { generateCandidate } from "@/server/voucher-engine";

const schema = z.object({
  campaignSlug: z.string().min(1),
  sessionId: z.string().min(1),
  sourceType: z.enum(["base", "referral_bonus", "level_bonus"]).optional(),
  devPoolId: z.string().min(1).optional()
});

export async function POST(request: Request) {
  try {
    await enforceRateLimit(request, "hunt/attempt", { limit: 20, windowMs: 60_000 });
    const phone = await requireSignedInCustomerPhone(request);
    const input = schema.parse(await request.json());
    const attempt = await generateCandidate({ ...input, phone });
    // The draw is the hunt result, so this is where "complete a hunt" is done.
    // Awaited rather than fired off: the app shows the mission payout on the
    // same screen, and a reward that arrives a second later reads as a bug.
    await onHuntComplete({
      phone,
      attemptId: attempt.id,
      campaignId: attempt.campaignId,
    });
    return ok(attempt);
  } catch (error) {
    return fail(error);
  }
}
