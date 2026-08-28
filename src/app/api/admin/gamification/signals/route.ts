import { z } from "zod";
import { assertRewardsAdmin, requireAdmin } from "@/server/auth";
import { fail, ok } from "@/server/errors";
import { actionFraudSignal, listFraudSignals, runAnomalyScan } from "@/server/gamification/anomaly";

export const dynamic = "force-dynamic";
/** A full sweep touches several whole-table aggregates. */
export const maxDuration = 60;

/**
 * The abuse queue.
 *
 * Operations only. A partner has no business seeing that one of its customers
 * is under investigation — the signals are about a player's behaviour across
 * the whole network, not about that partner's campaign.
 */
export async function GET(request: Request) {
  try {
    const session = await requireAdmin(request);
    assertRewardsAdmin(session);
    const params = new URL(request.url).searchParams;
    return ok(
      await listFraudSignals({
        status: params.get("status") ?? "Open",
        limit: Number(params.get("limit") ?? 100),
      }),
    );
  } catch (error) {
    return fail(error);
  }
}

const bodySchema = z.union([
  z.object({ action: z.literal("scan") }),
  z.object({
    signalId: z.string().min(4).max(64),
    /**
     * `clear` closes a signal and, if it was the last one open, lets the wallet
     * back to Clear. `hold` and `suspend` tighten. `release` lifts a hold while
     * leaving the signal on the record.
     */
    action: z.enum(["clear", "hold", "release", "suspend"]),
    note: z.string().min(4).max(280),
  }),
]);

/** Runs a sweep, or records a decision about one signal. */
export async function POST(request: Request) {
  try {
    const session = await requireAdmin(request);
    assertRewardsAdmin(session);
    const input = bodySchema.parse(await request.json());

    if (input.action === "scan") return ok(await runAnomalyScan());
    return ok(await actionFraudSignal({ ...input, actor: session.email }));
  } catch (error) {
    return fail(error);
  }
}
