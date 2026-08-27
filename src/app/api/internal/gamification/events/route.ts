import crypto from "node:crypto";
import { z } from "zod";
import { assertCronAuth } from "@/server/cron-auth";
import { fail, ok } from "@/server/errors";
import { ingestEvent } from "@/server/gamification/events";

const schema = z.object({
  eventName: z.enum([
    "ad_reward_verified",
    "hunt_complete",
    "voucher_select",
    "qr_redeem",
    "booking_complete",
    "purchase_verified",
    "review_verified",
    "referral_verified",
  ]),
  phone: z.string().min(6),
  occurredAt: z.string().datetime().optional(),
  partnerId: z.string().min(1).nullable().optional(),
  objectType: z.string().min(1).max(64).optional(),
  objectId: z.string().min(1).max(128).optional(),
  idempotencyKey: z.string().min(8).max(160),
  amountCentavos: z.number().int().nonnegative().optional(),
  metadata: z.record(z.unknown()).optional(),
});

export const dynamic = "force-dynamic";

/**
 * Service-to-service intake for verified domain events.
 *
 * Authenticated with the same shared secret the scheduled jobs use, because it
 * has the same trust level: whatever calls this is asserting that a fact has
 * already been verified somewhere trustworthy, and that assertion pays out real
 * Loyalty Points. It is deliberately not reachable with a customer session -
 * the client never gets to tell the server what it did.
 */
export async function POST(request: Request) {
  try {
    assertCronAuth(request);
    const input = schema.parse(await request.json());
    const result = await ingestEvent({
      ...input,
      source: "internal-api",
      // Included in the audit trail so a disputed grant can be traced back to
      // the caller that asserted it, not just to the event name.
      metadata: {
        ...(input.metadata ?? {}),
        callerFingerprint: crypto
          .createHash("sha256")
          .update(request.headers.get("user-agent") ?? "unknown")
          .digest("hex")
          .slice(0, 16),
      },
    });
    return ok(result);
  } catch (error) {
    return fail(error);
  }
}
