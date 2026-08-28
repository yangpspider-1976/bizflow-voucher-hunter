import { sweepExpiredPersonalData } from "@/server/account-deletion";
import { assertCronAuth } from "@/server/cron-auth";
import { runAnomalyScan } from "@/server/gamification/anomaly";
import { fail, ok } from "@/server/errors";
import { processPendingEvents } from "@/server/gamification/events";
import { expireMissions } from "@/server/gamification/missions";
import { sweepExpiredProofFiles } from "@/server/gamification/proofs";
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
    // Evidence images have their own retention clock: the decision row outlives
    // the photo, so this drops the picture and keeps why it was approved.
    const proofFiles = await sweepExpiredProofFiles();
    // Missions whose day ended without being finished, and any event the rules
    // engine could not apply first time. Both are cheap and both are the kind
    // of arrears that compound quietly if nothing sweeps them.
    const missions = await expireMissions();
    const events = await processPendingEvents();
    // Yesterday and today, every night. Signals are keyed per detector per
    // player per day, so a scan that overlaps the previous one raises nothing
    // twice and cannot undo a decision an operator already made.
    const anomalies = await runAnomalyScan();
    const reconciliation = await runReconciliation();
    return ok({
      purged,
      proofFilesPurged: proofFiles,
      missionsExpired: missions.expired,
      quotaReleased: missions.released,
      events,
      anomalies,
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
