import { redirect } from "next/navigation";
import { currentSession } from "@/server/dashboard-data";
import { getDb } from "@/server/db";
import { listFraudSignals } from "@/server/gamification/anomaly";
import { listHeldRewards, summarise } from "@/server/gamification/rewards";
import { parseRewardLines } from "@/server/gamification/config";
import { centavosToLoyaltyPoints, maskPhone } from "@/server/rewards-network";
import { HeldRewardActions } from "../../_components/HeldRewardActions";
import { RunScanButton, SignalActions } from "../../_components/SignalActions";
import { GamificationNav } from "../_nav";

export const dynamic = "force-dynamic";

/** Human-readable names for what each detector looks for. */
const SIGNAL_LABEL: Record<string, string> = {
  ad_replay: "More rewarded ads in a day than a person watches",
  shared_device: "One device behind several accounts",
  qr_velocity: "An implausible number of QR redemptions",
  referral_ring: "A burst of referrals from one account",
  review_velocity: "An implausible number of reviews",
  lp_velocity: "More Loyalty Points granted than the daily cap allows",
  proof_rejections: "Evidence turned down repeatedly",
};

/**
 * The abuse queue.
 *
 * A signal is a question, not a verdict. Most of them have a dull answer — a
 * family sharing a phone, a genuinely busy weekend — and the screen is built
 * around that: the observation that triggered it is shown in full, the wallet's
 * current standing beside it, and every action takes a reason.
 *
 * Held is not suspended. A held wallet keeps earning; its rewards are written
 * for review instead of paid, so nothing is lost while somebody decides.
 */
export default async function AbusePage({
  searchParams,
}: {
  searchParams: { status?: string };
}) {
  const session = await currentSession();
  if (!session || session.role === "staff") redirect("/dashboard");

  const status =
    searchParams.status === "Cleared" || searchParams.status === "Actioned"
      ? searchParams.status
      : "Open";
  const [signals, held] = await Promise.all([
    listFraudSignals({ status, limit: 200 }),
    listHeldRewards(await getDb(), 100),
  ]);

  return (
    <>
      <header className="admin-topbar">
        <div>
          <h1>Abuse</h1>
          <p className="muted">
            Seven detectors run every night over the previous day and today.
            Nothing here decides anything on its own — a signal raises a
            question, a score decides whether rewards wait, and a person decides
            the rest.
          </p>
        </div>
      </header>

      <GamificationNav active="/dashboard/gamification/abuse" />

      {held.length > 0 ? (
        <section className="panel">
          <h2>{held.length} rewards waiting to be paid</h2>
          <p className="muted">
            Held either because a single grant was above the review threshold or
            because the player is flagged. Nothing has been taken: the reward
            exists and is owed until somebody here says otherwise. Paying it
            applies today&apos;s daily cap, which is the day the money moves.
          </p>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Held</th>
                  <th>Player</th>
                  <th>From</th>
                  <th>Owed</th>
                  <th>Why</th>
                  <th>Decision</th>
                </tr>
              </thead>
              <tbody>
                {held.map((row) => {
                  const owed = summarise(parseRewardLines(String(row.reward_json ?? "[]")));
                  return (
                    <tr key={String(row.id)}>
                      <td>{String(row.created_at).replace("T", " ").slice(0, 16)}</td>
                      <td>
                        {maskPhone(String(row.phone))}
                        {String(row.risk_state ?? "Clear") !== "Clear" ? (
                          <>
                            {" "}
                            <span className="badge warning">{String(row.risk_state)}</span>
                          </>
                        ) : null}
                      </td>
                      <td className="muted">
                        {String(row.source_type)} · {String(row.source_id)}
                        {row.partner_name ? ` · ${String(row.partner_name)}` : ""}
                      </td>
                      <td>
                        {owed.xp > 0 ? `${owed.xp} XP` : ""}
                        {owed.xp > 0 && owed.lpCentavos > 0 ? " + " : ""}
                        {owed.lpCentavos > 0
                          ? centavosToLoyaltyPoints(owed.lpCentavos)
                          : ""}
                      </td>
                      <td className="muted">{String(row.hold_reason ?? "")}</td>
                      <td>
                        <HeldRewardActions rewardTxId={String(row.id)} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      <section className="panel">
        <h2>
          {status} · {signals.length}
        </h2>
        <RunScanButton />
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Day</th>
                <th>Signal</th>
                <th>Player</th>
                <th>Standing</th>
                <th>What was seen</th>
                <th>Decision</th>
              </tr>
            </thead>
            <tbody>
              {signals.map((signal) => (
                <tr key={signal.id}>
                  <td>{signal.detectedOn}</td>
                  <td>
                    <strong>{SIGNAL_LABEL[signal.signalKey] ?? signal.signalKey}</strong>
                    <br />
                    <span
                      className={
                        signal.severity === "critical"
                          ? "badge danger"
                          : signal.severity === "warn"
                            ? "badge warning"
                            : "badge neutral"
                      }
                    >
                      {signal.severity} · {signal.score}
                    </span>
                  </td>
                  <td>{signal.phone ? maskPhone(signal.phone) : "—"}</td>
                  <td>
                    <span
                      className={
                        signal.riskState === "Clear" ? "badge success" : "badge warning"
                      }
                    >
                      {signal.riskState}
                    </span>
                  </td>
                  <td className="muted">
                    {Object.entries(signal.observation)
                      .map(([key, value]) => `${key}: ${String(value)}`)
                      .join(" · ")}
                  </td>
                  <td>
                    {status === "Open" ? (
                      <SignalActions signalId={signal.id} />
                    ) : (
                      <span className="muted">
                        {signal.actionTaken} by {signal.actionedBy}
                        {signal.note ? ` — ${signal.note}` : ""}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
              {signals.length === 0 ? (
                <tr>
                  <td colSpan={6}>
                    <span className="muted">Nothing flagged.</span>
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
