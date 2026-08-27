import { z } from "zod";
import { assertRewardsAdmin, requireAdmin } from "@/server/auth";
import { fail, ok } from "@/server/errors";
import {
  listBackfillJobs,
  runBackfillToCompletion,
  startBackfill,
} from "@/server/gamification/backfill";

const schema = z.object({
  note: z.string().max(280).optional(),
  /** Milliseconds to spend before returning; the job resumes on the next call. */
  budgetMs: z.number().int().min(1000).max(50_000).optional(),
});

export const dynamic = "force-dynamic";
/** Walks every wallet; well past the default budget even in batches. */
export const maxDuration = 60;

export async function GET(request: Request) {
  try {
    const session = await requireAdmin(request);
    assertRewardsAdmin(session);
    return ok(await listBackfillJobs());
  } catch (error) {
    return fail(error);
  }
}

/**
 * Starts or resumes the achievement backfill.
 *
 * Returns after its time budget rather than running to completion, because a
 * serverless invocation will be killed long before a large population is done.
 * Calling again resumes from the cursor - which is also what makes a killed
 * invocation harmless.
 */
export async function POST(request: Request) {
  try {
    const session = await requireAdmin(request);
    assertRewardsAdmin(session);
    const input = schema.parse(await request.json().catch(() => ({})));
    const job = await startBackfill({ actor: session.email, note: input.note });
    const progress = await runBackfillToCompletion({
      jobId: job.id,
      budgetMs: input.budgetMs ?? 20_000,
    });
    return ok(progress);
  } catch (error) {
    return fail(error);
  }
}
