"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { api } from "@/lib/api-client";

/**
 * Approve or reject one piece of evidence.
 *
 * A rejection needs a reason and the reason is shown to the player verbatim, so
 * the placeholder asks for the thing they can act on: not "invalid" but "the
 * receipt is from a different branch". A rejected mission stays open for a
 * second attempt, which only works if they know what to fix.
 */
export function ProofReviewActions({ proofId }: { proofId: string }) {
  const router = useRouter();
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function decide(decision: "Approved" | "Rejected") {
    if (decision === "Rejected" && reason.trim().length < 4) {
      setError("Tell them what to fix.");
      return;
    }
    setError("");
    setBusy(true);
    try {
      await api("/api/admin/gamification/proofs", {
        method: "POST",
        body: JSON.stringify({ proofId, decision, reason: reason.trim() || undefined }),
      });
      setReason("");
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "That decision did not save.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="admin-form-actions">
      <input
        onChange={(event) => setReason(event.target.value)}
        placeholder="Why, if you are turning it down"
        value={reason}
      />
      <button className="button" disabled={busy} onClick={() => decide("Approved")} type="button">
        Approve
      </button>
      <button
        className="button secondary"
        disabled={busy}
        onClick={() => decide("Rejected")}
        type="button"
      >
        Reject
      </button>
      {error ? <span className="badge warning">{error}</span> : null}
    </div>
  );
}
