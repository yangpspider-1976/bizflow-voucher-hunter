/**
 * Achievement backfill.
 *
 * At release, every existing player should already own the badges their history
 * earned — a Voucher User who has redeemed forty vouchers should not be shown a
 * locked Bronze tier. The job walks wallets in batches, rebuilds their counters
 * from the tables that already record what happened, and unlocks whatever that
 * clears.
 *
 * Restartable and idempotent by construction: the cursor is the last wallet id
 * processed, counters are set to the historical total rather than added to, and
 * unlocks are guarded by the same unique key the live path uses. A job that
 * dies halfway is resumed by running it again, and a job run twice by mistake
 * changes nothing the first run did not already do.
 */
import crypto from "node:crypto";
import { all, getDb, one, run, withTx } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordRewardAudit } from "@/server/rewards-network";
import { backfillWallet } from "./achievements";

const isoNow = () => new Date().toISOString();
const id = (prefix: string) => `${prefix}_${crypto.randomBytes(8).toString("hex")}`;

export type BackfillJob = {
  id: string;
  status: "Running" | "Completed" | "Failed";
  walletsDone: number;
  unlocksGranted: number;
  cursorWalletId: string | null;
  startedAt: string;
  finishedAt: string | null;
};

/** Starts a job, or returns the one already running. One at a time, by design. */
export async function startBackfill(input: { actor: string; note?: string }) {
  const db = await getDb();
  const running = await one(
    db,
    "SELECT * FROM achievement_backfill_jobs WHERE status = 'Running' ORDER BY started_at DESC LIMIT 1",
  );
  if (running) return mapJob(running);

  const jobId = id("bfill");
  await run(
    db,
    `INSERT INTO achievement_backfill_jobs (id, status, wallets_done, unlocks_granted, note, started_by, started_at)
     VALUES (?, 'Running', 0, 0, ?, ?, ?)`,
    [jobId, input.note ?? null, input.actor, isoNow()],
  );
  await recordRewardAudit(db, {
    actorType: "admin",
    actorId: input.actor,
    action: "achievement_backfill_started",
    entityType: "achievement_backfill_job",
    entityId: jobId,
    metadata: { note: input.note ?? null },
  });
  return mapJob(
    (await one(db, "SELECT * FROM achievement_backfill_jobs WHERE id = ?", [jobId]))!,
  );
}

/**
 * Processes one batch and returns whether more work remains.
 *
 * Batched rather than one long transaction so a slow wallet cannot hold a write
 * lock across the whole population, and so progress survives a serverless
 * invocation timing out mid-run.
 */
export async function runBackfillBatch(input: { jobId: string; batchSize?: number }) {
  const batchSize = Math.min(200, Math.max(1, input.batchSize ?? 50));
  const db = await getDb();
  const job = await one(db, "SELECT * FROM achievement_backfill_jobs WHERE id = ?", [
    input.jobId,
  ]);
  if (!job) throw new AppError("E-BACKFILL-404", "Backfill job was not found", 404);
  if (String(job.status) !== "Running") return { done: true, job: mapJob(job) };

  const cursor = job.cursor_wallet_id ? String(job.cursor_wallet_id) : "";
  const wallets = await all(
    db,
    `SELECT id, phone FROM reward_wallets
     WHERE id > ?
     ORDER BY id ASC
     LIMIT ?`,
    [cursor, batchSize],
  );

  if (wallets.length === 0) {
    await run(
      db,
      "UPDATE achievement_backfill_jobs SET status = 'Completed', finished_at = ? WHERE id = ?",
      [isoNow(), input.jobId],
    );
    const finished = await one(db, "SELECT * FROM achievement_backfill_jobs WHERE id = ?", [
      input.jobId,
    ]);
    await recordRewardAudit(db, {
      actorType: "system",
      action: "achievement_backfill_completed",
      entityType: "achievement_backfill_job",
      entityId: input.jobId,
      metadata: {
        walletsDone: Number(finished?.wallets_done ?? 0),
        unlocksGranted: Number(finished?.unlocks_granted ?? 0),
      },
    });
    return { done: true, job: mapJob(finished!) };
  }

  let unlocks = 0;
  for (const wallet of wallets) {
    // One transaction per wallet: a wallet whose history trips a bug fails
    // alone, and the cursor still advances past the ones that worked.
    const notices = await withTx((tx) =>
      backfillWallet(tx, {
        walletId: String(wallet.id),
        phone: String(wallet.phone),
        backfillJobId: input.jobId,
      }),
    );
    unlocks += notices.length;
  }

  await run(
    db,
    `UPDATE achievement_backfill_jobs
     SET cursor_wallet_id = ?, wallets_done = wallets_done + ?, unlocks_granted = unlocks_granted + ?
     WHERE id = ?`,
    [String(wallets[wallets.length - 1]!.id), wallets.length, unlocks, input.jobId],
  );

  const updated = await one(db, "SELECT * FROM achievement_backfill_jobs WHERE id = ?", [
    input.jobId,
  ]);
  return { done: false, job: mapJob(updated!) };
}

/** Runs batches until the job finishes or the time budget is spent. */
export async function runBackfillToCompletion(input: {
  jobId: string;
  budgetMs?: number;
  batchSize?: number;
}) {
  const deadline = Date.now() + (input.budgetMs ?? 20_000);
  let last = await runBackfillBatch(input);
  while (!last.done && Date.now() < deadline) {
    last = await runBackfillBatch(input);
  }
  return last;
}

export async function listBackfillJobs(limit = 20) {
  const db = await getDb();
  const rows = await all(
    db,
    "SELECT * FROM achievement_backfill_jobs ORDER BY started_at DESC LIMIT ?",
    [limit],
  );
  return rows.map(mapJob);
}

function mapJob(row: Record<string, unknown>): BackfillJob {
  return {
    id: String(row.id),
    status: String(row.status) as BackfillJob["status"],
    walletsDone: Number(row.wallets_done ?? 0),
    unlocksGranted: Number(row.unlocks_granted ?? 0),
    cursorWalletId: row.cursor_wallet_id ? String(row.cursor_wallet_id) : null,
    startedAt: String(row.started_at),
    finishedAt: row.finished_at ? String(row.finished_at) : null,
  };
}
