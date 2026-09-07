import type { Metadata } from "next";
// Declared to Google Play as the account-deletion contact. Shared with
// /delete-account and the marketing page from one module so the three cannot
// drift apart — Play reviewers do test it.
import { SUPPORT_EMAIL } from "@/lib/contact";

export const metadata: Metadata = {
  title: "Privacy Policy — Voucher Hunt",
  description:
    "How Voucher Hunt collects, uses, and shares personal information.",
};

/**
 * Public privacy policy.
 *
 * Google Play requires a publicly reachable policy URL for any app that handles
 * personal data, and this app handles phone numbers. Deliberately unauthenticated
 * and statically rendered so the Play Console reviewer and the store listing can
 * both reach it.
 *
 * DRAFT — the contents mirror what the code actually does (see docs/PLAY_RELEASE.md
 * for the audit), but this has NOT been reviewed by a lawyer. Philippine Data
 * Privacy Act obligations and the operating entity's legal name still need to be
 * confirmed before publishing.
 *
 * This page and the Play Data Safety form are one statement made twice, and a
 * reviewer reads them against the manifest. If an SDK is added or removed, both
 * change together or the app is in violation of whichever is now false — which
 * is exactly what happened when rewarded ads shipped while this page still said
 * there were none.
 */
const UPDATED = "7 September 2026";

export default function PrivacyPolicyPage() {
  return (
    <main className="page-shell legal-page">
      <h1>Privacy Policy</h1>
      <p className="muted">Last updated: {UPDATED}</p>

      <p>
        Voucher Hunt lets you sign in with your mobile number, reveal a voucher,
        reserve a time to use it, and earn Loyalty Points at participating
        partner businesses. This policy explains what we collect, why, and who we
        share it with.
      </p>

      <h2>Information we collect</h2>
      <ul>
        <li>
          <strong>Mobile number (required).</strong> Sign-in is by one-time SMS
          code, so we cannot identify your vouchers or points without it.
        </li>
        <li>
          <strong>Name (required to confirm a voucher).</strong> Shown to partner
          staff so they can match a reservation to you.
        </li>
        <li>
          <strong>Email address (optional).</strong> Only stored if you enter it.
        </li>
        <li>
          <strong>Notification token.</strong> If you allow notifications, we
          store the push token your device issues. It identifies the device, not
          you personally.
        </li>
        <li>
          <strong>Activity in the service.</strong> Vouchers drawn and issued,
          reservations, Loyalty Points earned and spent, and referral link opens.
        </li>
        <li>
          <strong>Advertising identifier.</strong> The app offers optional
          rewarded ads: you may choose to watch a short video to earn points. If
          you do, Google&apos;s Mobile Ads SDK reads the advertising ID your
          device provides, to select and measure the ad and to detect invalid
          traffic. It is a resettable device identifier, not your name or
          number, and you can reset or limit it in your Android settings.
        </li>
      </ul>

      <p>
        We do <strong>not</strong> collect your location, contacts, photos, or
        the contents of your SMS inbox. The app never reads SMS messages — you
        type the verification code yourself. There are no third-party analytics
        SDKs in the app; the only third-party SDK that receives anything about
        you is Google&apos;s Mobile Ads SDK, and only when you choose to watch a
        rewarded ad.
      </p>

      <h2>How we use it</h2>
      <ul>
        <li>To sign you in and keep you signed in.</li>
        <li>
          To issue vouchers, hold reservations, and let partner staff validate a
          voucher you present.
        </li>
        <li>To calculate and settle Loyalty Points.</li>
        <li>
          To send you service messages: your voucher confirmation by SMS, and —
          only if you allow it — notifications about your points and bookings.
        </li>
        <li>
          To detect abuse, such as repeated scans intended to inflate Loyalty
          Points.
        </li>
      </ul>

      <h2>Who we share it with</h2>
      <ul>
        <li>
          <strong>Partner businesses.</strong> When you present a voucher, staff
          see the voucher and the name on the reservation. For Loyalty Points
          they see a masked mobile number, not the full one.
        </li>
        <li>
          <strong>Our SMS provider,</strong> to deliver your verification code
          and voucher confirmation. They receive your mobile number and the
          message.
        </li>
        <li>
          <strong>Expo&apos;s push notification service,</strong> to deliver
          notifications to your device. It receives the push token and the
          notification text.
        </li>
        <li>
          <strong>Google,</strong> when you choose to watch a rewarded ad. Google
          receives your device&apos;s advertising ID and standard ad-request
          information so it can serve and measure the ad. It does not receive
          your name, mobile number, or email address.
        </li>
        <li>
          <strong>Our hosting and database providers,</strong> who store the data
          on our behalf.
        </li>
      </ul>

      <p>
        We do not sell your personal information. The only information shared for
        advertising is the advertising ID described above, shared with Google when
        you choose to watch a rewarded ad. We never share your mobile number,
        name, or email address with advertisers.
      </p>

      <h2>How long we keep it</h2>
      <p>
        Account and voucher records are kept while your account is active, and
        afterwards only as long as needed for settlement with partner businesses
        and for our legal and accounting obligations. Sign-in sessions expire
        automatically.
      </p>

      <h2>Your choices</h2>
      <ul>
        <li>
          <strong>Rewarded ads.</strong> They are never shown unless you tap to
          watch one; nothing in the app plays an ad on its own. Skipping them
          costs you only the points that ad would have paid. You can also reset
          or limit your advertising ID in <em>Android Settings → Privacy → Ads</em>.
        </li>
        <li>
          <strong>Notifications.</strong> Turn any category off under
          <em> More → Notifications</em> in the app, or switch them off entirely
          in your device settings.
        </li>
        <li>
          <strong>Signing out</strong> removes the session from your device and
          stops notifications to it.
        </li>
        <li>
          <strong>Access or deletion.</strong> Contact us using the details below
          to request a copy of your data. To close your account, see{" "}
          <a href="/delete-account">Delete your account</a>, which sets out the
          steps and what we keep afterwards.
        </li>
      </ul>

      <h2>Children</h2>
      <p>
        Voucher Hunt is not directed to children and we do not knowingly collect
        information from them.
      </p>

      <h2>Changes</h2>
      <p>
        If this policy changes materially, we will update the date above and, if
        the change is significant, tell you in the app.
      </p>

      <h2>Contact</h2>
      <p>
        Questions, data access requests, and deletion requests:{" "}
        <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>.
      </p>
    </main>
  );
}
