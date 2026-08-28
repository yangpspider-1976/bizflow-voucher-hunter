"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { LevelDefinition } from "@bizflow/shared";
import { api } from "@/lib/api-client";
import type { EconomyConfig } from "@/server/gamification/config";

/**
 * Publishes a new economy version.
 *
 * Everything here is stated in whole Loyalty Points, because that is the unit
 * operations think in; the API takes centavos, so the conversion happens on
 * submit rather than in anyone's head. Nothing is edited in place: submitting
 * writes a new version and retires the previous one.
 */
export function EconomyForm({
  economy,
  version,
}: {
  economy: EconomyConfig;
  version: number;
}) {
  const router = useRouter();
  const [xpPerLp, setXpPerLp] = useState(String(economy.xpPerLp));
  const [minLp, setMinLp] = useState(String(economy.minConversionCentavos / 100));
  const [presets, setPresets] = useState(
    economy.conversionPresetsCentavos.map((value) => value / 100).join(", "),
  );
  const [dailyCap, setDailyCap] = useState(String(economy.dailyLpGrantCapCentavos / 100));
  const [reviewAt, setReviewAt] = useState(String(economy.reviewThresholdCentavos / 100));
  const [quietStart, setQuietStart] = useState(economy.quietHours.start);
  const [quietEnd, setQuietEnd] = useState(economy.quietHours.end);
  const [risk, setRisk] = useState(economy.risk);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");

  async function publish() {
    setError("");
    setSaved("");
    setBusy(true);
    try {
      const result = await api<{ version: number }>("/api/admin/gamification/economy", {
        method: "POST",
        body: JSON.stringify({
          xpPerLp: Number(xpPerLp),
          minConversionCentavos: Math.round(Number(minLp) * 100),
          conversionPresetsCentavos: presets
            .split(",")
            .map((entry) => Math.round(Number(entry.trim()) * 100))
            .filter((entry) => Number.isFinite(entry) && entry > 0),
          dailyLpGrantCapCentavos: Math.round(Number(dailyCap) * 100),
          reviewThresholdCentavos: Math.round(Number(reviewAt) * 100),
          quietHours: { start: quietStart, end: quietEnd },
          risk,
          note: note || undefined,
        }),
      });
      setSaved(`Published as version ${result.version}.`);
      setNote("");
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The economy could not be published.");
    } finally {
      setBusy(false);
    }
  }

  /** Every risk threshold is the same control; only the label differs. */
  const riskFields: [keyof typeof risk, string][] = [
    ["adsPerDay", "Rewarded ads per day"],
    ["qrPerDay", "QR redemptions per day"],
    ["referralsPerDay", "Referrals per day"],
    ["reviewsPerDay", "Reviews per day"],
    ["walletsPerDevice", "Accounts sharing one device"],
    ["rejectedProofs", "Rejected evidence in a week"],
    ["holdScore", "Signal score that holds rewards"],
  ];

  return (
    <>
      <div className="admin-form-grid">
        <label className="field">
          <span>XP per Loyalty Point</span>
          <input onChange={(event) => setXpPerLp(event.target.value)} value={xpPerLp} />
        </label>
        <label className="field">
          <span>Minimum conversion (LP)</span>
          <input onChange={(event) => setMinLp(event.target.value)} value={minLp} />
        </label>
        <label className="field">
          <span>Quick-pick amounts (LP, comma separated)</span>
          <input onChange={(event) => setPresets(event.target.value)} value={presets} />
        </label>
        <label className="field">
          <span>Daily LP reward cap per player</span>
          <input onChange={(event) => setDailyCap(event.target.value)} value={dailyCap} />
        </label>
        <label className="field">
          <span>Hold a single grant above (LP)</span>
          <input onChange={(event) => setReviewAt(event.target.value)} value={reviewAt} />
        </label>
        <label className="field">
          <span>Quiet hours start (Manila)</span>
          <input onChange={(event) => setQuietStart(event.target.value)} value={quietStart} />
        </label>
        <label className="field">
          <span>Quiet hours end (Manila)</span>
          <input onChange={(event) => setQuietEnd(event.target.value)} value={quietEnd} />
        </label>
      </div>

      <h3>Risk thresholds</h3>
      <p className="muted">
        What the nightly detectors treat as too much for one player in a day.
        Raising one because a real campaign tripped it is a number an operator
        changes, not a deploy. Past the hold score a player keeps earning and
        their rewards wait for approval — nothing is taken.
      </p>
      <div className="admin-form-grid">
        {riskFields.map(([key, label]) => (
          <label className="field" key={key}>
            <span>{label}</span>
            <input
              onChange={(event) =>
                setRisk((current) => ({ ...current, [key]: Number(event.target.value) }))
              }
              type="number"
              value={risk[key]}
            />
          </label>
        ))}
      </div>

      <div className="admin-form-grid">
        <label className="field">
          <span>Why (recorded on the audit trail)</span>
          <input
            onChange={(event) => setNote(event.target.value)}
            placeholder="Reduced the ad payout after the November review"
            value={note}
          />
        </label>
      </div>

      <div className="admin-form-actions">
        <button className="button" disabled={busy} onClick={publish} type="button">
          {busy ? "Publishing…" : `Publish version ${version + 1}`}
        </button>
        {saved ? <span className="badge success">{saved}</span> : null}
        {error ? <span className="badge warning">{error}</span> : null}
      </div>
    </>
  );
}

/**
 * Publishes a level ladder.
 *
 * Edited as a whole rather than row by row: the thresholds only make sense
 * against each other, and a half-applied ladder — one level moved, the next not
 * yet — would put real players on levels that overlap.
 */
export function LevelLadderForm({
  levels,
  version,
}: {
  levels: LevelDefinition[];
  version: number;
}) {
  const router = useRouter();
  const [draft, setDraft] = useState(levels);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");

  function update(index: number, patch: Partial<LevelDefinition>) {
    setDraft((current) =>
      current.map((level, at) => (at === index ? { ...level, ...patch } : level)),
    );
  }

  async function publish() {
    setError("");
    setSaved("");
    setBusy(true);
    try {
      const result = await api<{ version: number }>("/api/admin/gamification/levels", {
        method: "POST",
        body: JSON.stringify({ levels: draft }),
      });
      setSaved(`Published as version ${result.version}.`);
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The ladder could not be published.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <table className="data-table">
        <thead>
          <tr>
            <th>Level</th>
            <th>Name</th>
            <th>Cumulative XP</th>
            <th>Bonus hunts / day</th>
            <th>Early access (min)</th>
          </tr>
        </thead>
        <tbody>
          {draft.map((level, index) => (
            <tr key={level.level}>
              <td>Lv.{level.level}</td>
              <td>
                <input
                  onChange={(event) => update(index, { name: event.target.value })}
                  value={level.name}
                />
              </td>
              <td>
                <input
                  onChange={(event) => update(index, { minXp: Number(event.target.value) })}
                  type="number"
                  value={level.minXp}
                />
              </td>
              <td>
                <input
                  onChange={(event) =>
                    update(index, { bonusHunts: Number(event.target.value) })
                  }
                  type="number"
                  value={level.bonusHunts}
                />
              </td>
              <td>
                <input
                  onChange={(event) =>
                    update(index, { earlyAccessMinutes: Number(event.target.value) })
                  }
                  type="number"
                  value={level.earlyAccessMinutes}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="admin-form-actions">
        <button className="button" disabled={busy} onClick={publish} type="button">
          {busy ? "Publishing…" : `Publish version ${version + 1}`}
        </button>
        {saved ? <span className="badge success">{saved}</span> : null}
        {error ? <span className="badge warning">{error}</span> : null}
      </div>
    </>
  );
}

/**
 * Runs the achievement backfill in time-boxed batches.
 *
 * The request returns after its budget rather than when the job finishes,
 * because a serverless invocation would be killed long before a large
 * population is walked. Pressing it again resumes from the cursor.
 */
export function BackfillButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");

  async function run() {
    setError("");
    setBusy(true);
    try {
      const result = await api<{
        done: boolean;
        job: { walletsDone: number; unlocksGranted: number };
      }>("/api/admin/gamification/backfill", { method: "POST", body: JSON.stringify({}) });
      setStatus(
        result.done
          ? `Finished. ${result.job.walletsDone} wallets, ${result.job.unlocksGranted} unlocks.`
          : `In progress: ${result.job.walletsDone} wallets so far. Run again to continue.`,
      );
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The backfill could not be started.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="admin-form-actions">
      <button className="button secondary" disabled={busy} onClick={run} type="button">
        {busy ? "Running…" : "Run backfill"}
      </button>
      {status ? <span className="badge">{status}</span> : null}
      {error ? <span className="badge warning">{error}</span> : null}
    </div>
  );
}
