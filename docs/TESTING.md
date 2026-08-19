# Voucher Hunt Testing Guide

Use this document to validate the MVP locally after changes. It covers automated checks, manual browser testing, API and SMS checks, and known limitations.

The current flow is **sign-in first**: the user signs in with a phone number **verified by SMS OTP**, spins a voucher roulette to reveal one candidate, picks a date/time slot that the winning benefit tier is offered at (higher discounts unlock fewer slots), then confirms to issue the final voucher.

### Authentication model (read this before testing)

- **Sign-in is global and OTP-verified.** `/signin` is a two-step form: enter the mobile number → receive a 6-digit SMS code → verify. There is no per-campaign sign-in.
- **Auth lives in httpOnly cookies** (`bizflow_customer_phone`, `bizflow_cust_auth`) that the server sets **only** after a correct code. They cannot be written from the browser, so a phone number can no longer be claimed without receiving its SMS.
- **Every customer page is gated server-side.** `/`, `/vouchers`, `/vouchers/<id>`, `/more`, and `/campaign/<slug>` redirect to `/signin?next=…` when signed out.
- **Public hunt/rewards endpoints take the phone from the session cookie, never the request body.** Passing someone else's number in a body is ignored; no session returns 401.
- **A data reset signs everyone out** (it bumps a server auth epoch), on every device, not just the browser that ran the reset.
- Outside production, OTP responses include a `devCode` so you can complete sign-in without a live SMS. With `SMS_PROVIDER=mock` the code is also printed to the dev-server console.

## 1. Test Environment

### Prerequisites
- Node.js 20+ (the `sms:logs` script uses `node --env-file`, which needs Node 20.6+)
- npm
- Project dependencies installed with `npm install`
- A `.env` file (copy from `.env.example`). Defaults are fine for local testing; SMS defaults to the `mock` provider.

### Start the App
```bash
npm run dev
```

Default local URL:

```text
http://localhost:3000
```

If port 3000 is busy, Next.js picks the next free port (e.g. 3001) — watch the dev server output for the actual URL.

Seeded campaigns:

| Campaign | Slug | Mode | Business |
|---|---|---|---|
| July Dinner | `july-dinner` | Restaurant (reservation) | Mesa Manila Test Kitchen |
| 8PM Shopping | `8pm-drop` | Online shop | SariSari Studio |
| Glow Facial Week | `glow-facial` | Beauty clinic (appointment, uses reservation flow) | Glow Lab Skin Clinic |

Seeded routes:

| Area | URL | Notes |
|---|---|---|
| Sign In (global, OTP) | http://localhost:3000/signin | Entry point when signed out |
| Home / campaign directory | http://localhost:3000 | Requires sign-in |
| Campaign Landing | http://localhost:3000/campaign/july-dinner | |
| Hunt Intro | http://localhost:3000/campaign/july-dinner/hunt | |
| Roulette Spin | http://localhost:3000/campaign/july-dinner/roulette | |
| Voucher Results | http://localhost:3000/campaign/july-dinner/results | |
| Pick Date & Time | http://localhost:3000/campaign/july-dinner/datetime | |
| Confirm Details | http://localhost:3000/campaign/july-dinner/confirm | |
| Confirmation | http://localhost:3000/campaign/july-dinner/confirmation | |
| My Vouchers (global) | http://localhost:3000/vouchers | Device-local wallet |
| Voucher detail (global) | http://localhost:3000/vouchers/&lt;voucherId&gt; | |
| More / Loyalty Points wallet (global) | http://localhost:3000/more | Daily LP status, QR, and LP-voucher conversion |
| Online shop landing | http://localhost:3000/campaign/8pm-drop | |
| Beauty clinic landing | http://localhost:3000/campaign/glow-facial | |
| Admin dashboard | http://localhost:3000/dashboard | |
| Staff validation | http://localhost:3000/staff | |
| Health API | http://localhost:3000/api/health | Public |

The vouchers, voucher-detail, More, and sign-in screens are **global**, not per-campaign. The old
per-campaign paths (`/campaign/<slug>/signin`, `/vouchers`, `/vouchers/<id>`, `/more`) still exist
purely as redirects to their global equivalents, so old links keep working.

## 2. Reset Test Data

The app uses **PostgreSQL**, configured in `.env`:

```text
DATABASE_URL=postgres://user:password@host/dbname?sslmode=require
TEST_DATABASE_URL=postgres://user:password@host/dbname_test?sslmode=require
```

(Every environment needs `DATABASE_URL`. Tests additionally demand
`TEST_DATABASE_URL` and refuse to fall back to `DATABASE_URL`, so a misconfigured
run cannot empty production.)

The schema is created and seeded automatically on first DB access. There are four ways to reset:

- **Delete the file** — stop the dev server and remove `data/bizflow.db`. The next load recreates and reseeds it.
- **Admin reset** — Dashboard → Settings → *Reset & Reseed Data* (type `RESET`), or `POST /api/dashboard/reset` (super-admin only). Wipes every table and reseeds.
- **Admin wipe** — Dashboard → Settings → *Wipe Data (No Reseed)* (type `WIPE`), or `POST /api/dashboard/reset` with `{"mode":"wipe"}`. Same wipe with no reseed, for handing over a clean install: it also drops staff/admin logins (super admins are kept) and sets `seed_suppressed` in `meta` so neither the startup self-heal nor a schema bump reloads the fixtures. A later *Reset & Reseed* clears that flag.
- **Schema bump** — bumping `SCHEMA_VERSION` in `src/server/db.ts` (currently `"7"`) forces a full reset + reseed on next start.

**A reset also signs out every customer.** It advances a server-side auth epoch stored in `meta`, which
invalidates all previously issued auth cookies — so any signed-in device lands back on `/signin` on its
next page load, and must complete OTP again. Expect to re-sign-in after every reset.

The seeder is idempotent (`INSERT OR IGNORE`) and self-heals: on startup it verifies every seed row — including pool→slot mappings — and re-inserts anything missing without wiping existing data.

## 3. Automated Validation

Run these before handoff:

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

Expected result:

| Command | Expected |
|---|---|
| `npm run typecheck` | TypeScript exits with code 0 |
| `npm run lint` | No ESLint warnings or errors |
| `npm test` | Unit and integration tests pass (currently 85 tests across 16 files) |
| `npm run build` | Next.js production build succeeds |

Run integration tests only with `npm run test:integration`. Tests use an isolated database and reseed via `resetDb()`, so they never touch `data/bizflow.db`.

Current automated test coverage:

| Test File | Coverage |
|---|---|
| `tests/unit/voucher-engine.test.ts` | attempts, final issue, duplicate prevention, staff redemption |
| `tests/unit/phone.test.ts` | PH phone normalization/validation |
| `tests/unit/sms.test.ts` | SMS provider dispatch (mock/movider/twilio/infobip/clicksend/smpp), single-part vs multipart splitting |
| `tests/unit/rate-limit.test.ts` | IP rate limiting |
| `tests/unit/admin-session.test.ts` | admin session tokens |
| `tests/unit/voucher-presentation.test.ts` | voucher rarity/presentation helpers |
| `tests/unit/customer-auth-epoch.test.ts` | reset advances the auth epoch (revokes sign-ins) |
| `tests/integration/signin-otp.test.ts` | sign-in OTP request/verify, wrong code, replay prevention |
| `tests/integration/voucher-flow.test.ts` | sign-in → hunt → final voucher, dashboard metrics, CSV export |
| `tests/integration/concurrency.test.ts` | concurrent attempts do not over-issue stock |
| `tests/integration/sms-confirmation.test.ts` | confirmation SMS logging + single-part guard |
| `tests/integration/referral-flow.test.ts` | referral open → bonus attempt granting |
| `tests/integration/reservation-lifecycle.test.ts` | reservation, no-show, reschedule |
| `tests/integration/redemption-import.test.ts` | bulk CSV redemption import |
| `tests/integration/admin.test.ts` | campaign create/update, slot/pool config |
| `tests/integration/dashboard-authorization.test.ts` | admin/staff role scoping on dashboard data |

## 4. Public Customer Flow Test

Open:

```text
http://localhost:3000/campaign/july-dinner
```

Signed out, this redirects to `/signin?next=/campaign/july-dinner`.

### Happy Path
1. On **Sign In**, enter a unique mobile number, e.g. `+639170001111` (or `09170001111`), and click `Send Code`.
2. Enter the 6-digit code and click `Verify & Continue`. Outside production the code is shown on-screen
   (`Code sent. Demo code: 123456`) and printed to the dev console by the mock SMS provider.
   `Use a different number` returns to step 1.
3. On the **campaign landing**, click `Let's Hunt!`.
4. On **Ready to Hunt**, click `Start Roulette`.
5. The **roulette** free-spins indefinitely — it only slows down when you tap the reel (or press Enter/Space
   on it). Tap it, watch it coast to a stop on one candidate, then click `Confirm Voucher` to reach **Results**.
6. Confirm one candidate is revealed. Optionally `Spin again` if you have bonus spins, or `Share to unlock another spin`.
7. With a candidate selected, click `Pick date & time`.
8. On **Date & Time**, choose a date/time slot offered for that benefit tier, then continue. (Higher-value tiers show fewer slots; rarer tiers may show none at busy windows.)
9. On **Confirm Details**, enter `Full Name` (mobile number is pre-filled and read-only). There is **no OTP step
   here** — the phone was verified at sign-in. `Confirm & Reserve` stays enabled: tapping it with a missing
   field reports exactly what's missing (e.g. "Missing full name.").
10. Click `Confirm & Reserve`.
11. Confirm the **Confirmation** page shows the voucher benefit, voucher code, QR block, selected date/time, and confirmed status, then `View My Vouchers`.

Expected result:

```text
One final voucher is issued, a reservation is created (restaurant/beauty modes),
unselected candidates are released, and a confirmation SMS is dispatched (see §10).
```

### Cross-Campaign Sign-In
1. Sign in once (OTP) from any entry point.
2. Open a different campaign (e.g. switch from `july-dinner` to `8pm-drop`).

Expected result:

```text
One sign-in covers every campaign — the second campaign signs in automatically with no
re-entry and no second OTP. "Sign out" from the More tab clears the server session
(httpOnly cookies) and local state, and returns to /signin.
```

### Auth Enforcement
1. While signed out, open `/`, `/vouchers`, `/vouchers/<id>`, `/more`, and `/campaign/july-dinner`.
2. While signed in, run the reset (Dashboard → Settings), then refresh any customer page.
3. In devtools, try setting a `bizflow_customer_phone` cookie by hand and reload a customer page.

Expected result:

```text
1. Each page redirects to /signin?next=<that path>, and returns there after verifying.
2. The reset revokes the session — the page redirects to /signin and OTP is required again.
3. Nothing happens: the auth cookies are httpOnly and only the server sets them after a
   correct code, so a hand-written cookie does not sign you in.
```

### Duplicate Prevention
1. Complete the happy path with a phone number.
2. Return to the same campaign and try to hunt/issue again with the same number.

Expected result:

```text
The app blocks another final voucher for the same phone number in the same campaign
(E-DUPLICATE-FINAL). Auto sign-in fails silently in this case rather than erroring.
```

### Expired Voucher Indicator
1. Open **My Vouchers** and view a voucher whose validity window has passed (e.g. an older `july-dinner` 50% OFF voucher).

Expected result:

```text
The voucher detail shows an "expired on <date>" banner and a Status of "Expired";
the wallet list marks the entry with "· Expired".
```

### Sold-Out Slot Behavior
1. Open the restaurant campaign and reach the Date & Time step.
2. Look for a slot marked sold out (e.g. seeded `2026-07-06 19:00`).

Expected result:

```text
Sold-out slots are disabled and cannot be selected.
```

## 5. Online Shop and Beauty Clinic Flow Test

Repeat the customer happy path on:

```text
http://localhost:3000/campaign/8pm-drop      (online shop)
http://localhost:3000/campaign/glow-facial   (beauty clinic)
```

Use a different phone number per campaign.

Expected differences:

| Area | Online shop (`8pm-drop`) | Beauty clinic (`glow-facial`) |
|---|---|---|
| Category label | Online Shop | Restaurant (appointment reuses reservation flow) |
| Guest count | Not required | Not required |
| Confirmation SMS | "Use:" window + shop URL | "Visit:" window + show on arrival |
| Reservation | Not created | Created (appointment) |

## 6. Staff Validation and Redemption Test

First issue a voucher from the customer flow and copy the voucher code.

Open:

```text
http://localhost:3000/staff
```

### Validate
1. Enter the voucher code and validate.

Expected result:

```text
Reservation/voucher details and validation result appear. Status is Issued/valid,
or clearly Expired/Redeemed/Cancelled when applicable.
```

### Redeem
1. Enter staff name, optionally purchase amount and note, then mark as used.

Expected result:

```text
Voucher status changes to Redeemed.
```

### Redeem Twice / Expired
1. Try to redeem the same code again, or an expired code.

Expected result:

```text
The app blocks the action with an already-used or expired message.
```

## 7. Admin Dashboard Test

Open:

```text
http://localhost:3000/dashboard
```

Log in with the admin credentials from `.env` (`ADMIN_EMAIL` / `ADMIN_PASSWORD`).

Validate:

| Area | Expected |
|---|---|
| Sidebar | Voucher Hunt admin navigation is visible (no campaign switcher — it moved to the pages) |
| Campaign selector | Top-left of Dashboard, Slots, and Vouchers; switching re-scopes the page via `?campaign=` |
| Metrics | Visit, hunt, attempt, voucher, redemption, and referral cards render |
| Campaign table | Seeded restaurant, online shop, and beauty clinic rows render, each with an **Allow reschedule** toggle |
| Slot table | Slot inventory rows render with status chips |
| Staff requests | Approve / Reject sit side by side in one row |
| Loyalty Points | LP wallet, staff tools, fees, and partner settlement controls render |
| Export button | CSV export link is available |

The campaign selector only appears when more than one campaign exists, and it is scoped **per page** —
switching campaigns on Slots does not carry the choice over to Vouchers.

After issuing a voucher, refresh the dashboard.

Expected result:

```text
Issued voucher and attempt metrics increase.
```

## 8. CSV Export Test

Open (authenticated as admin):

```text
http://localhost:3000/api/export/campaigns/camp_july_dinner
```

Other campaign IDs: `camp_8pm_drop`, `camp_glow_facial`.

Expected result:

```text
A CSV downloads with LEADS, VOUCHERS, ATTEMPTS, and REDEMPTIONS sections
(voucher_code, phone, name, benefit, status, issued/expiry time, slot details).
```

## 9. API Smoke Tests

### Health
```bash
curl http://localhost:3000/api/health
```

Expected:

```json
{
  "success": true,
  "data": { "status": "ok", "version": "0.1.0", "timestamp": "..." }
}
```

### Public Campaign Data
```bash
curl http://localhost:3000/api/public/campaigns/july-dinner
```

Expected: response includes campaign, business, and slots.

### Sign-in OTP Request (triggers an SMS via the configured provider)
```bash
curl -X POST http://localhost:3000/api/public/signin/request-otp \
  -H "Content-Type: application/json" \
  -d "{\"phone\":\"09170001111\"}"
```

Expected: `{ "success": true, "data": { "sent": true, "expiresAt": "...", "devCode": "123456" } }`.
`devCode` is returned outside production so the flow can be completed without a live SMS.

Verify it (this is what sets the auth cookies — `-c` saves them to a jar you can reuse):

```bash
curl -X POST http://localhost:3000/api/public/signin/verify-otp \
  -H "Content-Type: application/json" -c cookies.txt \
  -d "{\"phone\":\"09170001111\",\"code\":\"123456\"}"
```

The old campaign-scoped `/api/public/otp/*` endpoints have been **removed** — sign-in OTP replaced them.

### Authenticated Endpoints Require the Session
Hunt and rewards endpoints take the phone from the session cookie, never the body:

```bash
# No session -> 401
curl -X POST http://localhost:3000/api/public/hunt/start \
  -H "Content-Type: application/json" \
  -d "{\"campaignSlug\":\"july-dinner\",\"sessionId\":\"smoke-test\"}"

# With the cookie jar from verify-otp -> succeeds, acting as the verified number
curl -X POST http://localhost:3000/api/public/hunt/start \
  -H "Content-Type: application/json" -b cookies.txt \
  -d "{\"campaignSlug\":\"july-dinner\",\"sessionId\":\"smoke-test\"}"
```

Expected: the first returns `E-CUSTOMER-AUTH` (401); the second succeeds. Adding a `phone` field to
either body changes nothing — it is ignored in favour of the session.

### Staff Validation Error
```bash
curl -X POST http://localhost:3000/api/staff/vouchers/validate \
  -H "Content-Type: application/json" \
  -d "{\"codeOrToken\":\"NOT-A-CODE\"}"
```

Expected: 404-style error response with code `E-VOUCHER-404`.

## 10. SMS Testing

SMS is a provider-agnostic layer (`src/server/sms.ts`) selected by `SMS_PROVIDER`:
`mock | smpp | movider | twilio | infobip | clicksend`.

### Mock (default)
With `SMS_PROVIDER=mock` (or unset), messages are printed to the dev-server console as `[SMS MOCK] To: ...` and always "succeed". Sign-in OTP codes and voucher confirmations both flow through this. Use it for local/manual testing without spending credits — the sign-in code appears in the console and in the form's `devCode` hint.

### SMPP (direct SMSC / PH aggregator)
Set the SMPP block in `.env` (see `.env.example`): `SMS_PROVIDER=smpp`, `SMPP_HOST`, `SMPP_PORT`, `SMPP_SYSTEM_ID`, `SMPP_PASSWORD`, `SMPP_BIND_TYPE`, and the `SMPP_SOURCE_ADDR*` sender IDs. Notes:
- Long messages are split into UDH-concatenated parts (GSM 153/part, UCS-2 67/part); short ones (OTP) send inline. The confirmation body is trimmed to fit one part.
- `SMPP_REGISTERED_DELIVERY=1` requests delivery receipts, which update the `sms_logs` row (`delivery_status`, `delivered_at`).
- The account allows **one bind per `system_id`** — do not run two apps against the same credentials at once (second bind fails with `ESME_ALREADYBOUND`).

### Inspecting sms_logs
Voucher confirmations and resends are written to the `sms_logs` table. Inspect recent rows (submit status + delivery receipt):

```bash
npm run sms:logs          # last 10 rows
npm run sms:logs -- 25    # last 25 rows
```

(Sign-in OTP codes send via the same provider but are not written to `sms_logs`; their challenges live in `otp_challenges`.)

## 11. Visual QA Checklist

Use desktop and mobile viewport sizes.

| Screen | Checks |
|---|---|
| `/signin` | centred sign-in block, phone field, Send Code; then code field, Verify & Continue, "Use a different number" |
| `/` | campaign directory, search, category filter pills (visible on short screens), category-coloured card icons |
| `/campaign/july-dinner` | campaign landing (header shows the campaign name), rule card, primary CTA |
| `/campaign/july-dinner/hunt` | hunt intro summary, Start Roulette CTA |
| `/campaign/july-dinner/roulette` | reel centred and stable, free-spins until tapped, "Tap to stop" hint, coast to a stop, Confirm Voucher |
| `/campaign/july-dinner/results` | candidate card, spin-again / share actions + share hint, Pick date & time CTA |
| `/campaign/july-dinner/datetime` | day labels, slot rows with time + availability + selected check, tinted "Want more choices?" panel, sold-out rows |
| `/campaign/july-dinner/confirm` | full name field, read-only phone, **no OTP block**, Confirm & Reserve (enabled; reports missing fields) |
| `/campaign/july-dinner/confirmation` | confirmation status, voucher code, QR block, evenly padded summary rows |
| `/vouchers` | wallet list, expired markers, no back arrow |
| `/vouchers/<id>` | voucher detail, QR, summary rows |
| `/more` | account card, Loyalty Points wallet + QR, daily LP status, dev tools (local only), Sign Out |
| `/campaign/8pm-drop` | online shop copy, no guest-count dependency |
| `/campaign/glow-facial` | beauty clinic copy, appointment slots |
| `/dashboard` | per-page campaign selector (top-left, category-coloured icon), admin tables, metric cards, status chips |
| `/dashboard/campaigns` | campaign rows with an **Allow reschedule** toggle only (no Require OTP) |
| `/staff` | validation form, result card, redeem button states, reschedule dropdown styling |

Responsive checks:

- No text overlaps cards or buttons.
- Tables and wide content scroll horizontally on small screens.
- Primary actions remain visible and tappable.
- Disabled states are visually distinct.
- Status chips use correct colors: active/confirmed green, low stock orange, sold out/error/expired red.

## 12. Known Testing Notes

- `npm run test:e2e` (Playwright) is available but has been flaky in this environment; unit/integration/typecheck/lint/build are the primary gates.
- SMPP delivery depends on the SMSC account: sends can be rejected with `ESME_RTHROTTLED` (throttled/quota) or `ESME_RINVSRCADR` (unregistered sender). These are account-side, not code issues — verify limits with the provider.
- GSM multipart concatenation relies on the SMSC packing UDH+GSM correctly; UCS-2 multipart is the more portable fallback. Verify a deliberately long message arrives intact on a handset before relying on it.
- The datastore is PostgreSQL in every environment, so concurrency and stock-control tests exercise the same engine production runs.
- **Staff QR scanning is hidden when the device has no camera** (typical on desktop) — only *Upload QR Image* shows. To exercise the scanner, test on a phone or a laptop with a webcam.
- **My Vouchers is device-local.** The wallet is stored in this browser's `localStorage`, so vouchers issued on one device do not appear on another, and a database reset does not clear an already-cached list.
- **Rate limits apply to sign-in OTP**: 5 requests / 5 min for `request-otp`, 10 / 5 min for `verify-otp`. Repeated smoke testing from one IP can trip these; wait out the window or restart the dev server.

## 13. Release Readiness Gate

Before a demo or handoff, confirm:

| Gate | Required Result |
|---|---|
| Typecheck | Passed |
| Lint | Passed |
| Unit/integration tests | Passed |
| Production build | Passed |
| Manual public flow (OTP sign-in → roulette → confirm) | Passed |
| Auth enforcement (signed-out redirects, reset revokes sessions) | Passed |
| Manual staff redemption | Passed |
| Manual dashboard/export | Passed |
| SMS (mock, and SMPP if configured) | Verified |
| Security audit | Reviewed or explicitly deferred |
| E2E | Passed or explicitly deferred with reason |
