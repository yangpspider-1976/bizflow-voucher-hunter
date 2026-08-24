import { sweepExpiredPersonalData } from "@/server/account-deletion";
import { assertCronAuth } from "@/server/cron-auth";
import { fail, ok } from "@/server/errors";
import { runReconciliation } from "@/server/reconciliation";

export const dynamic = "force-dynamic";
export const revalidate = 0;
/** Whole-table scans over the ledger and the audit chain; well past the default budget. */
export const maxDuration = 60;

/**
 * Nightly housekeeping: enforce the retention promises, then check the books.
 *
 * Two jobs in one route because they share a schedule and a secret, and because
 * Vercel's Hobby plan allows two cron entries in total — one of which is the
 * notification fan-out. Splitting them would cost the ability to run either.
 *
 * The sweep runs first. If reconciliation throws, the retention deletions have
 * already committed, which is the right way round: a missed alert can be caught
 * tomorrow, a retention promise missed for a day is a promise broken.
 */
async function run(request: Request) {
  try {
    assertCronAuth(request);
    const purged = await sweepExpiredPersonalData();
    const reconciliation = await runReconciliation();
    return ok({
      purged,
      reconciliation: {
        clean: reconciliation.clean,
        balanceDrift: reconciliation.balanceDrift.length,
        settlementDrift: reconciliation.settlementDrift.length,
        auditEntries: reconciliation.chain.entries,
        auditBroken:
          reconciliation.chain.tampered.length +
          reconciliation.chain.missingPredecessor.length +
          reconciliation.chain.forked.length,
      },
    });
  } catch (error) {
    return fail(error);
  }
}

export const POST = run;
/** Vercel Cron issues GET. */
export const GET = run;
