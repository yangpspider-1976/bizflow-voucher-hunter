import { z } from "zod";
import { requireAdmin } from "@/server/auth";
import { fail, ok } from "@/server/errors";
import { notifyProofReviewed } from "@/server/gamification/notify";
import { listProofQueue, reviewMissionProof } from "@/server/gamification/proofs";

export const dynamic = "force-dynamic";

/**
 * Which partners' evidence this account may see.
 *
 * Null is operations — everything. A partner account gets its own businesses,
 * and an account scoped to none gets an empty list, which the queue reads as
 * "nothing" rather than as "no filter".
 */
function partnerScope(session: Awaited<ReturnType<typeof requireAdmin>>) {
  const operations =
    session.role === "super_admin" ||
    (session.role === "admin" && session.businessIds.includes("*"));
  return operations ? null : session.businessIds.filter((value) => value !== "*");
}

/** The review queue, oldest submission first — a queue, not a feed. */
export async function GET(request: Request) {
  try {
    const session = await requireAdmin(request);
    const params = new URL(request.url).searchParams;
    return ok(
      await listProofQueue({
        status: params.get("status") ?? "Pending",
        partnerIds: partnerScope(session),
        limit: Number(params.get("limit") ?? 100),
      }),
    );
  } catch (error) {
    return fail(error);
  }
}

const decisionSchema = z.object({
  proofId: z.string().min(4).max(72),
  decision: z.enum(["Approved", "Rejected"]),
  /** Shown to the player verbatim, so it has to say something useful. */
  reason: z.string().max(280).optional(),
});

/**
 * Approves or rejects one submission.
 *
 * Approving pays the mission in the same transaction as the decision. The push
 * that tells the player goes out afterwards, outside it: a notification is a
 * network call, and holding a write transaction open across one is how a
 * throughput problem becomes a correctness problem.
 */
export async function POST(request: Request) {
  try {
    const session = await requireAdmin(request);
    const input = decisionSchema.parse(await request.json());

    const result = await reviewMissionProof({
      proofId: input.proofId,
      decision: input.decision,
      reviewer: session.email,
      reason: input.reason,
      allowedPartnerIds: partnerScope(session),
    });

    if (result.phone) {
      await notifyProofReviewed({
        phone: result.phone,
        approved: result.decision === "Approved",
        missionTitle: result.missionTitle,
        reason: input.reason,
      });
    }
    return ok(result);
  } catch (error) {
    return fail(error);
  }
}
