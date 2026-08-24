import type { Metadata } from "next";
// The declared deletion mechanism on the Play Data safety form. Shared with
// /privacy and the marketing page from one module so the three cannot drift
// apart.
import { SUPPORT_EMAIL } from "@/lib/contact";
import DeleteAccountForm from "./_components/DeleteAccountForm";

export const metadata: Metadata = {
  title: "Delete your account — Voucher Hunt",
  description:
    "How to request deletion of your Voucher Hunt account and the data held against it.",
};

/**
 * Public account-deletion instructions.
 *
 * Google Play requires this as a URL reachable **without installing the app**,
 * and it must name the app, set out the steps, and state what is deleted, what
 * is retained, and for how long. It is linked from the Play Data safety form and
 * from More → Delete my account in the app.
 *
 * Deliberately unauthenticated and statically rendered so a reviewer and a
 * former user can both reach it.
 *
 * DRAFT — the retention periods below follow from what the schema actually
 * stores (see docs/PLAY_CONSOLE_ANSWERS.md §6), but the statutory figure for
 * financial records has NOT been confirmed with a Philippine accountant or
 * lawyer. Confirm before publishing.
 */
const UPDATED = "30 July 2026";

export default function DeleteAccountPage() {
  return (
    <main className="page-shell legal-page">
      <h1>Delete your Voucher Hunt account</h1>
      <p className="muted">Last updated: {UPDATED}</p>

      <p>
        This page explains how to have your <strong>Voucher Hunt</strong> account
        and the personal data held against it deleted. Voucher Hunt is operated
        by <strong>Voucher Hunt</strong>.
      </p>

      <h2>Delete your account</h2>
      <p>
        Do it here, in two steps and without installing anything. Enter the
        mobile number you sign in with, confirm the 6-digit code we text to it,
        and the account is deleted immediately.
      </p>

      <DeleteAccountForm />

      <h2>If you cannot use the form</h2>
      <p>
        For example, if you no longer have the SIM for the number you signed in
        with:
      </p>
      <ol>
        <li>
          Email <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a> from any
          address, with the subject <strong>“Delete my account”</strong>.
        </li>
        <li>
          Include the <strong>mobile number you sign in with</strong>. It is the
          only way we can find your account.
        </li>
        <li>
          We reply asking for something that shows the number was yours, since
          without the handset the code above cannot prove it.
        </li>
        <li>
          Your account is deleted within <strong>30 days</strong> of that
          confirmation. We email you when it is done.
        </li>
      </ol>

      <p>
        You can also start this from inside the app: <em>More → Delete my
        account</em>, which opens this page.
      </p>

      <h2>What is deleted</h2>
      <p>Deleted permanently, and not recoverable:</p>
      <ul>
        <li>Your name, mobile number, and email address.</li>
        <li>Your sign-in sessions and any notification tokens for your devices.</li>
        <li>
          Your vouchers, reservations, and hunt history, including vouchers that
          have not been used yet.
        </li>
        <li>
          Your Loyalty Points wallet and its balance.{" "}
          <strong>
            Any unspent Loyalty Points are forfeited and cannot be restored.
          </strong>{" "}
          Spend or convert them before you ask us to delete the account.
        </li>
      </ul>

      <h2>What is kept, and for how long</h2>
      <p>
        A small amount of data has to outlive the account. None of it is used to
        contact you or to build a profile of you, and it is{" "}
        <strong>de-identified</strong> — your name, number, and email are removed
        and replaced with an internal reference that cannot be traced back to you
        by us or by a partner business.
      </p>
      <ul>
        <li>
          <strong>Records of Loyalty Points settled with partner businesses</strong>{" "}
          — the amount and the date, kept for up to{" "}
          <strong>10 years</strong> to meet Philippine tax and accounting
          obligations. These are the records a partner business is paid against;
          removing them would unpick payments already made.
        </li>
        <li>
          <strong>Tamper-evident audit entries.</strong> Loyalty Points
          adjustments are written to an append-only log that each entry
          cryptographically chains to the one before it, which is what lets us
          prove a balance was never quietly altered. Entries are de-identified
          rather than removed, because deleting one would break the chain for
          everybody. Kept for up to <strong>10 years</strong>.
        </li>
        <li>
          <strong>SMS delivery logs</strong> — the fact a message was sent and
          whether it arrived, kept for <strong>12 months</strong> to resolve
          delivery disputes with our provider, then deleted.
        </li>
      </ul>

      <h2>Deleting some data without closing your account</h2>
      <p>
        You do not have to delete the whole account to stop most data collection:
      </p>
      <ul>
        <li>
          <strong>Notifications.</strong> Turn any category off under{" "}
          <em>More → Notifications</em>, or switch them off in your device
          settings. Your notification token is removed when you sign out.
        </li>
        <li>
          <strong>Email address.</strong> It is optional. Email us at the address
          above to have it cleared while keeping your account.
        </li>
      </ul>

      <h2>Questions</h2>
      <p>
        Write to <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>. See
        also our <a href="/privacy">Privacy Policy</a>.
      </p>
    </main>
  );
}
