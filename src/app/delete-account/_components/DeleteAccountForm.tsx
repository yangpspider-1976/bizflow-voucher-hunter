"use client";

import { useState } from "react";

/**
 * Self-serve account deletion, on the page Google Play links to.
 *
 * It lives here rather than only in the app on purpose: Play requires the
 * deletion route to be reachable **without installing anything**, and a former
 * user who has already uninstalled is exactly the person most likely to want it.
 *
 * The page around this component stays statically rendered — only this island is
 * interactive — so a reviewer or a search crawler still gets the full text with
 * no JavaScript at all.
 */

type Stage = "phone" | "code" | "done";

type ApiError = { error?: { message?: string } };

async function post(path: string, body: Record<string, unknown>) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = (await response.json().catch(() => null)) as
    | (ApiError & { success?: boolean; data?: unknown })
    | null;
  if (!response.ok || !payload?.success) {
    throw new Error(payload?.error?.message ?? "Something went wrong. Try again.");
  }
  return payload.data as Record<string, unknown>;
}

export default function DeleteAccountForm() {
  const [stage, setStage] = useState<Stage>("phone");
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [understood, setUnderstood] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reference, setReference] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (stage === "phone") {
        await post("/api/public/account/deletion/request-otp", { phone });
        setStage("code");
      } else {
        const data = await post("/api/public/account/deletion/confirm", { phone, code });
        setReference(typeof data.ref === "string" ? data.ref : null);
        setStage("done");
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Something went wrong. Try again.");
    } finally {
      setBusy(false);
    }
  }

  if (stage === "done") {
    return (
      <div className="panel delete-account-form">
        <h3>Your account is deleted</h3>
        <p>
          It is gone now, not queued — there is nothing further for you to do and
          no waiting period to sit through.
        </p>
        {reference ? (
          <p>
            Your deletion reference is <strong>{reference}</strong>. Keep it if you
            want a record; it is the only identifier left, and quoting it is the
            only way we can look this deletion up afterwards.
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <form className="panel delete-account-form" onSubmit={submit}>
      {stage === "phone" ? (
        <>
          <h3>Delete your account now</h3>
          <p>
            Enter the mobile number you sign in with. We will text you a 6-digit
            code to confirm the request is really yours.
          </p>
          <label className="field">
            <span>Mobile number</span>
            <input
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              placeholder="09XX XXX XXXX"
              value={phone}
              onChange={(event) => setPhone(event.target.value)}
              required
            />
          </label>
          <label className="delete-account-confirm">
            <input
              type="checkbox"
              checked={understood}
              onChange={(event) => setUnderstood(event.target.checked)}
            />
            <span>
              I understand this permanently deletes my vouchers and reservations,
              and that any unspent Loyalty Points are forfeited.
            </span>
          </label>
          <button className="button full" type="submit" disabled={busy || !understood}>
            {busy ? "Sending code…" : "Send confirmation code"}
          </button>
        </>
      ) : (
        <>
          <h3>Enter the code</h3>
          <p>
            If <strong>{phone}</strong> has an account, a 6-digit code is on its
            way. It expires in 5 minutes.
          </p>
          <label className="field">
            <span>6-digit code</span>
            <input
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="\d{6}"
              maxLength={6}
              value={code}
              onChange={(event) => setCode(event.target.value.replace(/\D/g, ""))}
              required
            />
          </label>
          <button className="button full" type="submit" disabled={busy || code.length !== 6}>
            {busy ? "Deleting…" : "Delete my account permanently"}
          </button>
          <button
            className="button secondary full"
            type="button"
            disabled={busy}
            onClick={() => {
              setStage("phone");
              setCode("");
              setError(null);
            }}
          >
            Use a different number
          </button>
        </>
      )}
      {error ? (
        <p className="alert" role="alert">
          {error}
        </p>
      ) : null}
    </form>
  );
}
