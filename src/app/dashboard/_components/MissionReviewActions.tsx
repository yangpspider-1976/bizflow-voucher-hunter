"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { api } from "@/lib/api-client";

/**
 * Operations' decision on a mission a partner sent for review, and the stop
 * control for one that is already running.
 *
 * Both ask for a reason before they will act. The requirements treat mission
 * approval and mission stops as privileged operations, and a privileged
 * operation with no recorded "why" is an audit row that answers the wrong
 * question three months later.
 */
export function MissionReviewActions({
  missionKey,
  definitionVersion,
  status,
  canApprove,
}: {
  missionKey: string;
  definitionVersion: number;
  status: string;
  canApprove: boolean;
}) {
  const router = useRouter();
  const [note, setNote] = useState("");
  const [cancelInProgress, setCancelInProgress] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function send(body: Record<string, unknown>) {
    if (note.trim().length < 4) {
      setError("Say why, in a few words.");
      return;
    }
    setError("");
    setBusy(true);
    try {
      await api("/api/admin/gamification/missions", {
        method: "PATCH",
        body: JSON.stringify({ missionKey, definitionVersion, ...body }),
      });
      setNote("");
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "That did not work.");
    } finally {
      setBusy(false);
    }
  }

  const reviewable = status === "Review" && canApprove;
  const stoppable = status === "Active" || status === "Scheduled";
  if (!reviewable && !stoppable) return null;

  return (
    <div className="admin-form-actions">
      <input
        onChange={(event) => setNote(event.target.value)}
        placeholder="Reason"
        value={note}
      />
      {reviewable ? (
        <>
          <button
            className="button"
            disabled={busy}
            onClick={() => send({ action: "review", decision: "Approved", activate: true, note })}
            type="button"
          >
            Approve and start
          </button>
          <button
            className="button secondary"
            disabled={busy}
            onClick={() => send({ action: "review", decision: "Approved", activate: false, note })}
            type="button"
          >
            Approve, start later
          </button>
          <button
            className="button secondary"
            disabled={busy}
            onClick={() => send({ action: "review", decision: "Rejected", note })}
            type="button"
          >
            Send back
          </button>
        </>
      ) : null}
      {stoppable ? (
        <>
          <label className="field">
            <span>Also cancel players mid-mission</span>
            <input
              checked={cancelInProgress}
              onChange={(event) => setCancelInProgress(event.target.checked)}
              type="checkbox"
            />
          </label>
          <button
            className="button danger"
            disabled={busy}
            onClick={() => send({ action: "stop", cancelInProgress, reason: note })}
            type="button"
          >
            Stop
          </button>
        </>
      ) : null}
      {error ? <span className="badge warning">{error}</span> : null}
    </div>
  );
}
