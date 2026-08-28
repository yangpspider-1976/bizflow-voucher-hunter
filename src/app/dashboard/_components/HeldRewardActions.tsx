"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { api } from "@/lib/api-client";

/**
 * Approve or reject one reward that was parked for review.
 *
 * Both need a reason and both write an audit row. Approving also takes a
 * finance reference, which is what §6.2 asks to be recorded against a released
 * payout — optional in the form because a small release inside the normal course
 * of business does not always have one, and blocking on it would leave the
 * reward held instead.
 */
export function HeldRewardActions({ rewardTxId }: { rewardTxId: string }) {
  const router = useRouter();
  const [reason, setReason] = useState("");
  const [reference, setReference] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function decide(decision: "Approve" | "Reject") {
    if (reason.trim().length < 4) {
      setError("Record why.");
      return;
    }
    setError("");
    setBusy(true);
    try {
      await api("/api/admin/gamification/held", {
        method: "POST",
        body: JSON.stringify({
          rewardTxId,
          decision,
          reason: reason.trim(),
          reference: reference.trim() || undefined,
        }),
      });
      setReason("");
      setReference("");
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "That did not save.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="admin-form-actions">
      <input onChange={(event) => setReason(event.target.value)} placeholder="Reason" value={reason} />
      <input
        onChange={(event) => setReference(event.target.value)}
        placeholder="Reference (optional)"
        value={reference}
      />
      <button className="button" disabled={busy} onClick={() => decide("Approve")} type="button">
        Pay it
      </button>
      <button
        className="button secondary"
        disabled={busy}
        onClick={() => decide("Reject")}
        type="button"
      >
        Refuse
      </button>
      {error ? <span className="badge warning">{error}</span> : null}
    </div>
  );
}
