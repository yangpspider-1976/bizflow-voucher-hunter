"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { api } from "@/lib/api-client";

/**
 * The four decisions an operator can make about a signal.
 *
 * `clear` says the detector was wrong and lifts the hold if nothing else is
 * holding the wallet. `hold` parks future rewards for review without taking
 * anything. `release` lifts a hold while leaving the signal on the record.
 * `suspend` stops the wallet outright and is the only one that is not
 * reversible from this screen.
 *
 * All four need a reason, and all four write an audit row. Nothing here deletes
 * anything: the signal, the decision and the person who made it stay.
 */
export function SignalActions({ signalId }: { signalId: string }) {
  const router = useRouter();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function act(action: "clear" | "hold" | "release" | "suspend") {
    if (note.trim().length < 4) {
      setError("Record why.");
      return;
    }
    setError("");
    setBusy(true);
    try {
      await api("/api/admin/gamification/signals", {
        method: "POST",
        body: JSON.stringify({ signalId, action, note: note.trim() }),
      });
      setNote("");
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "That did not save.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="admin-form-actions">
      <input onChange={(event) => setNote(event.target.value)} placeholder="Reason" value={note} />
      <button className="button secondary" disabled={busy} onClick={() => act("clear")} type="button">
        Clear
      </button>
      <button className="button secondary" disabled={busy} onClick={() => act("hold")} type="button">
        Hold
      </button>
      <button className="button secondary" disabled={busy} onClick={() => act("release")} type="button">
        Release
      </button>
      <button className="button danger" disabled={busy} onClick={() => act("suspend")} type="button">
        Suspend
      </button>
      {error ? <span className="badge warning">{error}</span> : null}
    </div>
  );
}

/** Runs the detectors now instead of waiting for the nightly sweep. */
export function RunScanButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");

  async function run() {
    setBusy(true);
    try {
      const result = await api<{ raised: number; held: number }>(
        "/api/admin/gamification/signals",
        { method: "POST", body: JSON.stringify({ action: "scan" }) },
      );
      setStatus(`${result.raised} new signals, ${result.held} wallets held.`);
      router.refresh();
    } catch (caught) {
      setStatus(caught instanceof Error ? caught.message : "The scan did not run.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="admin-form-actions">
      <button className="button secondary" disabled={busy} onClick={run} type="button">
        {busy ? "Scanning…" : "Run a scan now"}
      </button>
      {status ? <span className="badge">{status}</span> : null}
    </div>
  );
}
