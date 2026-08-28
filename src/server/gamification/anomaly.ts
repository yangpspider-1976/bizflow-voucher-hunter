/**
 * Anomaly detection and graduated holds.
 *
 * Seven detectors run over yesterday's and today's activity, each answering one
 * question about one player. None of them decides anything on its own: they
 * raise signals, signals carry a score, and the score is what moves a wallet
 * along Clear → Watch → Held. Suspension stays a human decision.
 *
 * Two properties matter more than the detectors themselves.
 *
 * **Re-running is free.** Every signal is keyed on (detector, wallet, day), so
 * a sweep that runs hourly raises one row per day per finding, and an operator
 * clearing a signal is not undone by the next pass.
 *
 * **A hold is not a punishment.** A held wallet still earns; its rewards are
 * written REVIEW_REQUIRED instead of paid, exactly as an over-threshold single
 * grant already is. Nothing is taken, nothing is lost, and an operator either
 * releases it or reverses it. Getting this wrong in the other direction —
 * silently dropping rewards a legitimate player earned — is the failure that
 * generates support tickets nobody can answer.
 */
import crypto from "node:crypto";
import { all, getDb, one, run, withTx, type Exec } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordRewardAudit } from "@/server/rewards-network";
import { loadEconomy, type RiskThresholds } from "./config";
import { publishEvent } from "./events";
import { addManilaDays, manilaDate, manilaMidnightUtc } from "./time";

const isoNow = () => new Date().toISOString();
const id = (prefix: string) => `${prefix}_${crypto.randomBytes(8).toString("hex")}`;

export type RiskState = "Clear" | "Watch" | "Held" | "Suspended";

export type SignalKey =
  | "ad_replay"
  | "shared_device"
  | "qr_velocity"
  | "referral_ring"
  | "review_velocity"
  | "lp_velocity"
  | "proof_rejections";

/** What each detector contributes to a wallet's score when it fires. */
const SIGNAL_SCORE: Record<SignalKey, number> = {
  // A replayed ad is the cheapest abuse to automate and the one the economy
  // pays for three times a day, so it is weighted hardest.
  ad_replay: 4,
  shared_device: 3,
  qr_velocity: 2,
  referral_ring: 3,
  review_velocity: 2,
  // Past the daily cap means the cap did not hold, which is either abuse or a
  // bug. Either way somebody should look today.
  lp_velocity: 4,
  proof_rejections: 2,
};

type Finding = {
  signalKey: SignalKey;
  walletId: string | null;
  phone: string | null;
  observation: Record<string, unknown>;
};

/**
 * Runs every detector over one Manila day and records what it found.
 *
 * Defaults to yesterday plus today: yesterday because a day is only complete
 * once it has ended, today because a burst worth catching is worth catching
 * while it is happening.
 */
export async function runAnomalyScan(input: { dates?: string[] } = {}) {
  const db = await getDb();
  const { economy } = await loadEconomy(db);
  const risk = economy.risk;
  const today = manilaDate();
  const dates = input.dates ?? [addManilaDays(today, -1), today];

  let raised = 0;
  const held: string[] = [];
  for (const date of dates) {
    const findings = [
      ...(await detectAdReplay(db, date, risk)),
      ...(await detectSharedDevices(db, date, risk)),
      ...(await detectEventVelocity(db, date, risk)),
      ...(await detectLpVelocity(db, date, economy.dailyLpGrantCapCentavos)),
      ...(await detectProofRejections(db, date, risk)),
    ];
    for (const finding of findings) {
      if (await recordSignal(finding, date)) raised += 1;
    }
    for (const walletId of new Set(
      findings.map((finding) => finding.walletId).filter((value): value is string => Boolean(value)),
    )) {
      const state = await applyGraduatedHold(walletId, risk);
      if (state === "Held") held.push(walletId);
    }
  }

  return { raised, held: held.length, dates };
}

/**
 * Writes one signal, once per detector per player per day.
 *
 * Returns false when the row already existed, which is what makes the whole
 * scan idempotent: a detector that fires on every pass over the same day still
 * produces one row and one score.
 */
async function recordSignal(finding: Finding, date: string) {
  const db = await getDb();
  const score = SIGNAL_SCORE[finding.signalKey];
  const inserted = await run(
    db,
    `INSERT OR IGNORE INTO fraud_signals
     (id, wallet_id, phone, signal_key, severity, score, detected_on, observation, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Open', ?)`,
    [
      id("sig"),
      finding.walletId,
      finding.phone,
      finding.signalKey,
      score >= 4 ? "critical" : score >= 3 ? "warn" : "info",
      score,
      date,
      JSON.stringify(finding.observation),
      isoNow(),
    ],
  );
  if (inserted !== 1) return false;

  if (finding.walletId) {
    await withTx((tx) =>
      publishEvent(tx, {
        eventName: "fraud_flagged",
        walletId: finding.walletId,
        phone: finding.phone,
        source: "anomaly",
        objectType: "fraud_signal",
        objectId: `${finding.signalKey}:${finding.walletId}:${date}`,
        idempotencyKey: `fraud_flagged:${finding.signalKey}:${finding.walletId}:${date}`,
        metadata: finding.observation,
        status: "Processed",
      }),
    );
  }
  return true;
}

/**
 * Moves a wallet along the risk ladder from its open signals.
 *
 * Only ever tightens automatically. Loosening is an operator action, because a
 * detector going quiet is not evidence that anything was resolved — it is
 * evidence that nothing new happened today.
 */
export async function applyGraduatedHold(walletId: string, risk: RiskThresholds) {
  const db = await getDb();
  const row = await one(
    db,
    "SELECT COALESCE(SUM(score), 0) AS total FROM fraud_signals WHERE wallet_id = ? AND status = 'Open'",
    [walletId],
  );
  const total = Number(row?.total ?? 0);
  const current = await one(db, "SELECT risk_state FROM reward_wallets WHERE id = ?", [walletId]);
  const state = String(current?.risk_state ?? "Clear") as RiskState;
  if (state === "Suspended" || state === "Held") return state;

  const next: RiskState = total >= risk.holdScore ? "Held" : total > 0 ? "Watch" : "Clear";
  if (next === state) return state;

  await run(
    db,
    "UPDATE reward_wallets SET risk_state = ?, risk_reason = ?, risk_updated_at = ? WHERE id = ?",
    [next, `Automatic: open signal score ${total}`, isoNow(), walletId],
  );
  if (next === "Held") {
    await withTx((tx) =>
      publishEvent(tx, {
        eventName: "reward_held",
        walletId,
        source: "anomaly",
        objectType: "reward_wallet",
        objectId: walletId,
        idempotencyKey: `reward_held:${walletId}:${manilaDate()}`,
        metadata: { score: total },
        status: "Processed",
      }),
    );
  }
  return next;
}

/* Detectors ----------------------------------------------------------------- */

/**
 * More verified rewarded ads in a day than the economy has ad missions.
 *
 * The SSV path already refuses a replayed transaction id, so this is not the
 * first line of defence — it is the one that notices a farm working through
 * genuinely distinct ad views faster than a person watches ads.
 */
async function detectAdReplay(db: Exec, date: string, risk: RiskThresholds): Promise<Finding[]> {
  const rows = await all(
    db,
    `SELECT av.wallet_id, w.phone, COUNT(*) AS views
     FROM ad_verifications av
     JOIN reward_wallets w ON w.id = av.wallet_id
     WHERE av.manila_date = ?
     GROUP BY av.wallet_id, w.phone
     HAVING COUNT(*) > ?`,
    [date, risk.adsPerDay],
  );
  return rows.map((row) => ({
    signalKey: "ad_replay" as const,
    walletId: String(row.wallet_id),
    phone: String(row.phone),
    observation: { views: Number(row.views), threshold: risk.adsPerDay },
  }));
}

/**
 * One device hash behind several wallets.
 *
 * The requirements' "multiple accounts" control. A signal is raised against
 * every wallet in the cluster rather than against the device, because a wallet
 * is the thing that earns and the thing an operator can hold — and because a
 * shared family phone is a real explanation somebody has to be able to accept.
 */
async function detectSharedDevices(
  db: Exec,
  date: string,
  risk: RiskThresholds,
): Promise<Finding[]> {
  const from = manilaMidnightUtc(date);
  const to = manilaMidnightUtc(addManilaDays(date, 1));
  const clusters = await all(
    db,
    `SELECT device_id_hash, COUNT(DISTINCT wallet_id) AS wallets
     FROM gamification_events
     WHERE device_id_hash IS NOT NULL
       AND occurred_at_utc >= ? AND occurred_at_utc < ?
     GROUP BY device_id_hash
     HAVING COUNT(DISTINCT wallet_id) >= ?`,
    [from, to, risk.walletsPerDevice],
  );

  const findings: Finding[] = [];
  for (const cluster of clusters) {
    const members = await all(
      db,
      `SELECT DISTINCT e.wallet_id, w.phone
       FROM gamification_events e
       JOIN reward_wallets w ON w.id = e.wallet_id
       WHERE e.device_id_hash = ?
         AND e.occurred_at_utc >= ? AND e.occurred_at_utc < ?`,
      [String(cluster.device_id_hash), from, to],
    );
    for (const member of members) {
      findings.push({
        signalKey: "shared_device",
        walletId: String(member.wallet_id),
        phone: String(member.phone),
        observation: {
          walletsOnDevice: Number(cluster.wallets),
          threshold: risk.walletsPerDevice,
          // The hash, never the device. It is already a one-way digest and it
          // is what links the cluster together for an investigator.
          deviceIdHash: String(cluster.device_id_hash),
        },
      });
    }
  }
  return findings;
}

/** QR, referral and review counts that are implausible for one person in a day. */
async function detectEventVelocity(
  db: Exec,
  date: string,
  risk: RiskThresholds,
): Promise<Finding[]> {
  const from = manilaMidnightUtc(date);
  const to = manilaMidnightUtc(addManilaDays(date, 1));
  const limits: Array<[string, SignalKey, number]> = [
    ["qr_redeem", "qr_velocity", risk.qrPerDay],
    ["referral_verified", "referral_ring", risk.referralsPerDay],
    ["review_verified", "review_velocity", risk.reviewsPerDay],
  ];

  const findings: Finding[] = [];
  for (const [eventName, signalKey, threshold] of limits) {
    const rows = await all(
      db,
      `SELECT e.wallet_id, w.phone, COUNT(*) AS total
       FROM gamification_events e
       JOIN reward_wallets w ON w.id = e.wallet_id
       WHERE e.event_name = ?
         AND e.occurred_at_utc >= ? AND e.occurred_at_utc < ?
       GROUP BY e.wallet_id, w.phone
       HAVING COUNT(*) > ?`,
      [eventName, from, to, threshold],
    );
    for (const row of rows) {
      findings.push({
        signalKey,
        walletId: String(row.wallet_id),
        phone: String(row.phone),
        observation: { eventName, count: Number(row.total), threshold },
      });
    }
  }
  return findings;
}

/**
 * More LP granted in a day than the daily cap allows.
 *
 * This should be impossible — `applyDailyLpCap` trims every grant — so a
 * finding here is not really a fraud signal at all. It is the cap's own alarm,
 * and it is in this sweep because this is the sweep somebody reads.
 */
async function detectLpVelocity(db: Exec, date: string, capCentavos: number): Promise<Finding[]> {
  if (capCentavos <= 0) return [];
  const from = manilaMidnightUtc(date);
  const to = manilaMidnightUtc(addManilaDays(date, 1));
  const rows = await all(
    db,
    `SELECT rt.wallet_id, w.phone, COALESCE(SUM(rt.lp_centavos), 0) AS total
     FROM reward_transactions rt
     JOIN reward_wallets w ON w.id = rt.wallet_id
     WHERE rt.status = 'GRANTED'
       AND rt.created_at >= ? AND rt.created_at < ?
     GROUP BY rt.wallet_id, w.phone
     HAVING COALESCE(SUM(rt.lp_centavos), 0) > ?`,
    [from, to, capCentavos],
  );
  return rows.map((row) => ({
    signalKey: "lp_velocity" as const,
    walletId: String(row.wallet_id),
    phone: String(row.phone),
    observation: { grantedCentavos: Number(row.total), capCentavos },
  }));
}

/** A player whose evidence keeps being turned down. */
async function detectProofRejections(
  db: Exec,
  date: string,
  risk: RiskThresholds,
): Promise<Finding[]> {
  const from = manilaMidnightUtc(addManilaDays(date, -6));
  const to = manilaMidnightUtc(addManilaDays(date, 1));
  const rows = await all(
    db,
    `SELECT p.wallet_id, w.phone, COUNT(*) AS total
     FROM mission_proofs p
     JOIN reward_wallets w ON w.id = p.wallet_id
     WHERE p.review_status = 'Rejected'
       AND p.reviewed_at >= ? AND p.reviewed_at < ?
     GROUP BY p.wallet_id, w.phone
     HAVING COUNT(*) >= ?`,
    [from, to, risk.rejectedProofs],
  );
  return rows.map((row) => ({
    signalKey: "proof_rejections" as const,
    walletId: String(row.wallet_id),
    phone: String(row.phone),
    observation: { rejectedInLastWeek: Number(row.total), threshold: risk.rejectedProofs },
  }));
}

/* Operator actions ---------------------------------------------------------- */

export type FraudSignalRow = {
  id: string;
  walletId: string | null;
  phone: string;
  signalKey: string;
  severity: string;
  score: number;
  detectedOn: string;
  observation: Record<string, unknown>;
  status: string;
  actionTaken: string;
  actionedBy: string;
  actionedAt: string;
  note: string;
  riskState: RiskState;
  createdAt: string;
};

export async function listFraudSignals(
  input: { status?: string; limit?: number } = {},
): Promise<FraudSignalRow[]> {
  const db = await getDb();
  const rows = await all(
    db,
    `SELECT s.*, w.risk_state
     FROM fraud_signals s
     LEFT JOIN reward_wallets w ON w.id = s.wallet_id
     WHERE s.status = ?
     ORDER BY s.severity DESC, s.created_at DESC
     LIMIT ?`,
    [input.status ?? "Open", Math.min(500, Math.max(1, input.limit ?? 100))],
  );
  return rows.map((row) => ({
    id: String(row.id),
    walletId: row.wallet_id ? String(row.wallet_id) : null,
    phone: String(row.phone ?? ""),
    signalKey: String(row.signal_key),
    severity: String(row.severity),
    score: Number(row.score),
    detectedOn: String(row.detected_on),
    observation: safeJson(String(row.observation ?? "{}")),
    status: String(row.status),
    actionTaken: String(row.action_taken ?? ""),
    actionedBy: String(row.actioned_by ?? ""),
    actionedAt: String(row.actioned_at ?? ""),
    note: String(row.note ?? ""),
    riskState: String(row.risk_state ?? "Clear") as RiskState,
    createdAt: String(row.created_at),
  }));
}

function safeJson(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * An operator's decision about one signal, and optionally about the wallet.
 *
 * Clearing a signal lowers the score, so releasing a wallet and clearing what
 * held it are the same action done in the right order — the release is applied
 * after the signal is closed, or the recomputed score would put it straight
 * back.
 */
export async function actionFraudSignal(input: {
  signalId: string;
  actor: string;
  action: "clear" | "hold" | "release" | "suspend";
  note: string;
}) {
  if (!input.note.trim()) {
    throw new AppError("E-VALIDATION-400", "Record why this decision was made", 400);
  }

  return withTx(async (tx) => {
    const signal = await one(tx, "SELECT * FROM fraud_signals WHERE id = ? FOR UPDATE", [
      input.signalId,
    ]);
    if (!signal) {
      throw new AppError("E-NOT-FOUND", "That signal no longer exists", 404);
    }
    const walletId = signal.wallet_id ? String(signal.wallet_id) : null;
    const now = isoNow();

    await run(
      tx,
      `UPDATE fraud_signals
       SET status = ?, action_taken = ?, actioned_by = ?, actioned_at = ?, note = ?
       WHERE id = ?`,
      [
        input.action === "clear" ? "Cleared" : "Actioned",
        input.action,
        input.actor,
        now,
        input.note.trim(),
        input.signalId,
      ],
    );

    if (walletId) {
      const state: RiskState | null =
        input.action === "hold"
          ? "Held"
          : input.action === "suspend"
            ? "Suspended"
            : input.action === "release"
              ? "Clear"
              : null;
      if (state) {
        await run(
          tx,
          "UPDATE reward_wallets SET risk_state = ?, risk_reason = ?, risk_updated_at = ? WHERE id = ?",
          [state, `${input.actor}: ${input.note.trim()}`, now, walletId],
        );
      }
      if (input.action === "clear") {
        // The score just dropped. Recompute rather than leaving a wallet held
        // by a signal nobody stands behind any more.
        const remaining = await one(
          tx,
          "SELECT COALESCE(SUM(score), 0) AS total FROM fraud_signals WHERE wallet_id = ? AND status = 'Open'",
          [walletId],
        );
        if (Number(remaining?.total ?? 0) === 0) {
          await run(
            tx,
            `UPDATE reward_wallets SET risk_state = 'Clear', risk_reason = NULL, risk_updated_at = ?
             WHERE id = ? AND risk_state IN ('Watch', 'Held')`,
            [now, walletId],
          );
        }
      }
      if (input.action === "suspend") {
        await publishEvent(tx, {
          eventName: "account_suspended",
          walletId,
          phone: signal.phone ? String(signal.phone) : null,
          source: "admin",
          objectType: "reward_wallet",
          objectId: walletId,
          idempotencyKey: `account_suspended:${walletId}:${now}`,
          metadata: { signalId: input.signalId },
          status: "Processed",
        });
      }
    }

    await recordRewardAudit(tx, {
      actorType: "admin",
      actorId: input.actor,
      action: `gamification_signal_${input.action}`,
      entityType: "fraud_signal",
      entityId: input.signalId,
      metadata: { note: input.note.trim(), walletId },
    });

    return { signalId: input.signalId, action: input.action };
  });
}

/** The risk standing of one wallet, for the reward engine and support screens. */
export async function riskStateFor(db: Exec, walletId: string): Promise<RiskState> {
  const row = await one(db, "SELECT risk_state FROM reward_wallets WHERE id = ?", [walletId]);
  return String(row?.risk_state ?? "Clear") as RiskState;
}
