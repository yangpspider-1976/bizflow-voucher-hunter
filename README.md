# Voucher Hunt Engine

Reservation-based voucher hunting for SMEs. A customer picks a campaign, spins to reveal voucher candidates, selects one, then books a date/time slot **from the windows that voucher's benefit tier is offered at**, and redeems it in store. A network-wide Loyalty Points wallet runs alongside it.

**The customer experience is an Android app.** It lives in `apps/mobile`
(Expo / React Native). The admin dashboard and the staff redemption screen stay
web. Both clients talk to the same Next.js API in this repo.

## Surfaces

| Surface | Where | Audience |
|---|---|---|
| Customer app | `apps/mobile` (Expo / Android) | Customers — hunt, book, vouchers, wallet, shop |
| Business landing page | `/` | SME owners evaluating the product |
| Customer landing page | `/client` | Customers — what the app does, install link |
| Admin dashboard | `/dashboard` | Business owners and admins |
| Staff validation | `/staff` | In-store staff redeeming vouchers and wallet QRs |
| Link fallback | `/campaign/[slug]`, `/vouchers/[voucherId]` | Redirect to `/client` — see below |

**There is no customer web app.** The hunt, wallet, vouchers and LP screens exist
only in `apps/mobile`; the web tree is the dashboard, the marketing pages and the
API. Anything customer-facing goes to the app.

`/campaign/[slug]` and `/vouchers/[voucherId]` survive as two-line redirects
because they are verified Android App Links and the address on printed QR codes.
With the app installed Android opens the app and never reaches the server; every
other visitor is sent to `/client` to install it. Do not rebuild pages there.

## Current Scope

- Customer voucher hunt shipped as an Expo/React Native **Android app** — the only customer client
- **Loyalty Points (LP)**: daily app-use and referral awards, 5% earn on scanned in-store purchases, conversion to `RWD-` LP vouchers, partner redemption with partial use, and monthly partner settlement (see `docs/REWARDS.md`)
- In-app **shop** for spending LP with participating partners
- Desktop-optimized admin dashboard
- Desktop-optimized staff validation and redemption page (vouchers, LP vouchers, wallet QR credit)
- Push notifications to the app (`docs/NOTIFICATIONS.md`) and app localization (`docs/I18N.md`)
- libSQL/Turso persistence (`@libsql/client`) with transactional, race-safe stock control — serverless-ready for Vercel
- Admin CRUD API for campaigns, slots, and voucher pools (session + token guarded)
- Real SMS delivery layer (Movider/Twilio/Infobip/ClickSend) with mock fallback
- Server-enforced referral extra attempts
- Phone **OTP sign-in** for every customer, so a voucher can only be issued to a verified number — codes expire, count attempts, burn after five wrong guesses, and are capped per number
- **Rate limiting** on public hunt/OTP/referral, admin login, and value-moving endpoints, keyed on the address a trusted proxy reported and budgeted by both address and subject (hashed)
- Cryptographically random prize draws and 80-bit voucher/loyalty codes, so neither can be predicted or enumerated
- Dev-only tooling (loyalty grants, forced roulette outcomes, resets, OTP echo) behind a fail-closed gate that never opens in production
- Staff **no-show** tagging and **reservation rescheduling** (per-campaign `allowReschedule`)
- **CSV redemption import** (e.g. Shopify used-codes report) from the dashboard
- Sold-out recovery UI that suggests alternate available slots
- Dashboard metrics and multi-section CSV export
- Unit and integration tests, including concurrency, OTP, rate-limit, and lifecycle guarantees

## Customer Flow

**The draw comes before the booking.** The prize is drawn campaign-wide first,
and the slot picker then offers only the windows that prize's tier is bound to
(`pool_slots`). A tier's odds come from its chosen `rarity` alone — which sets
`probability_weight` via `RARITY_WEIGHTS` — never from how many slots it is
offered at.

**Vouchers are always slot-bound.** A voucher stays redeemable until the slot the
customer booked ends. There is no issuance-relative expiry window.

| Step | App screen (`apps/mobile/src/app`) |
|---|---|
| 1 | Campaign directory — `(tabs)/index` |
| 2 | Campaign landing — `(tabs)/campaign/[slug]/index` |
| 3 | Voucher roulette — `…/roulette` |
| 4 | Voucher results — `…/results` |
| 5 | Date & time, tier-gated — `…/datetime` |
| 6 | Confirm & details — `…/confirm` |
| 7 | Confirmation SMS/QR — `…/confirmation` |

The roulette opens straight from the campaign landing CTA.

Outside the hunt the app carries three more tabs: **Vouchers** (issued vouchers
and their redemption QR), **Shop** (spend LP with participating partners), and
**More** (account, Loyalty Points wallet, language, sign out).

Sign-in is a single global phone-OTP step (`/api/public/signin/request-otp`), not
a per-campaign gate. The app authenticates with a **bearer token** in secure
storage. The dashboard uses httpOnly cookies; both resolve server-side to the
same verified identity, and a data reset invalidates both.

Online shop campaigns work the same way — e.g. `8pm-drop`.

Migration background and the remaining phase decisions are in
`docs/MOBILE_APP_MIGRATION.md`.

## Admin and Staff Routes

| Area | Route |
|---|---|
| Admin dashboard | `/dashboard` |
| Staff validation / redemption | `/staff` |
| CSV export | `/api/export/campaigns/camp_july_dinner` |
| Health check | `/api/health` |

## Admin Configuration API

These endpoints create and manage campaign configuration. They are guarded by a
shared admin token — send it as `Authorization: Bearer <token>` or `x-admin-token: <token>`,
where the token matches `ADMIN_ACCESS_TOKEN` from the environment.

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/campaigns` | POST | Create a campaign |
| `/api/campaigns/{id}` | GET / PATCH | Read or update a campaign |
| `/api/campaigns/{id}/slots` | GET / POST | List or create date/time slots |
| `/api/slots/{slotId}/pools` | GET / POST | List or create voucher pools for a slot |
| `/api/campaigns/{id}/redemptions/import` | POST | Bulk-redeem codes from a CSV export (Shopify used-codes) |
| `/api/staff/vouchers/no-show` | POST | Flag a reserved booking + voucher as no-show |
| `/api/staff/reservations/reschedule` | POST | Move an issued reservation to another slot (if `allowReschedule`) |

Public anti-abuse / verification endpoints (rate-limited, no admin token):

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/public/signin/request-otp` | POST | Send a 6-digit sign-in OTP via SMS |
| `/api/public/signin/verify-otp` | POST | Verify the code and establish the customer session. Also returns a bearer token when the caller opts in with `{issueToken:true}` or `X-Client: mobile` |
| `/api/public/signin/session` | GET | Current customer session, if any |
| `/api/public/signin/signout` | POST | Clear the customer session, or delete the presented bearer token |

Customer endpoints the app drives (session = cookie **or** bearer token):

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/public/campaigns` | GET | Campaign directory cards |
| `/api/public/campaigns/{slug}` | GET | One campaign + business + slots |
| `/api/public/hunt/start` | POST | Sign in to a campaign / current hunt state |
| `/api/public/hunt/attempt` | POST | Draw one candidate |
| `/api/public/hunt/slots` | GET | Slots offered for a candidate's tier |
| `/api/public/hunt/select` | POST | Issue the final voucher; sends confirmation SMS |
| `/api/public/vouchers` | GET | The signed-in phone's issued vouchers |
| `/api/public/rewards/wallet` | GET / POST | Loyalty Points wallet, ledger, and daily award |
| `/api/public/rewards/convert` | POST | Convert LP into an `RWD-` LP voucher |
| `/api/public/referral/*` | varies | Referral open/claim/state — grants bonus spins |

Staff redemption endpoints live under `/api/staff` (voucher validate/redeem,
LP-voucher validate/redeem, wallet credit, no-show, reschedule).

Example:

```bash
curl -X POST http://127.0.0.1:3000/api/campaigns \
  -H "Authorization: Bearer local-admin-token" \
  -H "Content-Type: application/json" \
  -d '{"businessId":"biz_demo_shop","slug":"aug-drop","title":"August Drop","offerMessage":"...","heroImage":"#000","mode":"online_shop","startDate":"2026-08-01","endDate":"2026-08-31","baseAttempts":3,"referralDailyLimit":5,"candidateTimeoutMinutes":10,"terms":"..."}'
```

## Tech Stack

- Next.js App Router (API, dashboard, staff, marketing, web fallback flow)
- Expo / React Native with expo-router (`apps/mobile`, Android)
- npm workspaces: root = web app, `apps/mobile`, `packages/shared` (`@bizflow/shared` — isomorphic types and helpers used by both clients)
- React
- TypeScript
- Zod
- React Icons
- Inter (UI) and Outfit (product wordmark) via `next/font/local`
- Vitest
- Playwright test scaffold
- libSQL datastore (`@libsql/client`): a local SQLite file for dev/tests (`DATABASE_PATH`), Turso (`DATABASE_URL`) in production

## Setup

Web (API, dashboard, staff):

```bash
npm install
npm run dev
```

Open:

```text
http://127.0.0.1:3000
```

Customer app:

```bash
npm run mobile           # expo start
npm run mobile:android   # expo run:android
npm run mobile:typecheck
```

Point the app's `API_BASE_URL` at the deployed domain or at the dev machine's LAN
address (`http://192.168.x.x:3000`). `localhost` does not resolve from a phone,
and the Android emulator reaches the host as `10.0.2.2`.

## Validation

Run before handoff:

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

Those four gates cover the web app and the shared package. The mobile app is
checked separately:

```bash
npm run mobile:typecheck
```

Additional scripts:

```bash
npm run test:integration
npm run test:e2e
```

Detailed manual and automated test instructions are in:

```text
docs/TESTING.md
```

## Database (libSQL / Turso)

The data layer uses `@libsql/client`, which speaks the SQLite dialect over a
local file **or** a hosted Turso database:

- **Local dev & tests**: a SQLite file (`DATABASE_PATH`, default `data/bizflow.db`).
  The schema is created and seeded automatically on first use.
- **Production (Vercel)**: set `DATABASE_URL=libsql://<db>.turso.io` and
  `DATABASE_AUTH_TOKEN=<token>`. When `DATABASE_URL` is set it takes precedence.

To deploy on Vercel: create a free Turso DB (`turso db create` + `turso db tokens create`),
add `DATABASE_URL` / `DATABASE_AUTH_TOKEN` (and `ADMIN_SESSION_SECRET`, admin creds,
SMS keys) as project env vars, and deploy. The schema/seed runs on the first request.

To regenerate seeded demo data locally, stop the dev server and delete
`data/bizflow.db*`; the next load recreates and reseeds it. Tests use a separate
`data/test-bizflow.db`.

## Stock Control & Concurrency

Slot capacity and voucher-pool quantity are protected against race conditions:

- Every mutation runs inside a libSQL write transaction (`withTx`).
- Stock and capacity are reduced with conditional updates (`... WHERE remaining > 0`) and the affected-row count is verified, so a depleted pool/slot can never be over-issued.
- A `UNIQUE(campaign_id, user_id)` constraint on `vouchers` is the authoritative guard for the "one final voucher per phone per campaign" rule under concurrent selects.

Covered by `tests/integration/concurrency.test.ts`. On Turso these guarantees hold across serverless instances (single primary with transactional writes).

## Security

Sign-in, voucher redemption, and the loyalty ledger are the surfaces that move
value. `docs/SECURITY.md` records the trust boundaries, the invariants enforced in
code, the accepted risks, and a deployment checklist.

Two environment variables have to be right or protections weaken silently:

- `TRUSTED_PROXY_HOPS` — how many proxies sit in front of the app. Rate limits key
  on the address the outermost trusted hop reported; everything to its left in
  `X-Forwarded-For` was supplied by the caller. `1` suits Vercel or a single
  nginx/Cloudflare. Set it too high and callers can pick their own bucket again,
  which makes every limit in the app decorative.
- `ENABLE_DEV_TOOLS` — gates every tool that mints value or bypasses a rule:
  loyalty grants, simulated checkout scans, forced roulette outcomes, hunt resets,
  statement backdating, the OTP echo, and the bootstrap login fallback. It fails
  closed — on automatically in `development` and `test`, off for anything
  unrecognised (unset, `preview`, `staging`), and ignored when `NODE_ENV=production`.
- `DEV_ACCOUNT_PHONE` (and `DEV_ACCOUNT_PHONE_2`) — customer numbers that keep the
  self-scoped hunt tools (reset my hunt, refresh my vouchers, force my own next
  draw) in production, where the flag above never opens. The money-moving tools
  stay refused for them, and they grant no console access. Read per request, so
  unsetting one revokes it immediately. Pair with `DEV_ACCOUNT_OTP` /
  `DEV_ACCOUNT_OTP_2` only if the number is not a handset you hold — that is a
  password that never expires.

Staff and admin access runs through `admin_users` accounts managed at
`/dashboard/team`; there is no per-business PIN.

## Important Notes

- `npm install` has reported dependency vulnerabilities, including a Next.js security warning. Perform a dependency security review before production use.
- `npm audit --json` needs explicit approval because it sends dependency inventory to the external npm audit service.
- Playwright E2E is scaffolded, but a previous run hung without producing a useful report. Unit tests, integration tests, lint, typecheck, and build have passed.

## Production Path

Before production:

- Provision a Turso database and set `DATABASE_URL` / `DATABASE_AUTH_TOKEN` (the data layer is already serverless-ready via `@libsql/client`).
- Set `ADMIN_SESSION_SECRET`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`, and `ADMIN_ACCESS_TOKEN`. Production has no bootstrap fallback — the login route returns `E-ADMIN-CONFIG` without them.
- Set `TRUSTED_PROXY_HOPS` to the real proxy depth and leave `ENABLE_DEV_TOOLS` unset.
- Configure a real SMS provider. Use `SMS_PROVIDER=smpp_worker` for the hosted SMPP path, since binding directly from Vercel never works (see `.env.example`).
- Work through the deployment checklist in `docs/SECURITY.md`.
- Set the app's `API_BASE_URL` to the production HTTPS domain, then build and ship the AAB — see `docs/PLAY_RELEASE.md` and `docs/PLAY_CONSOLE_ANSWERS.md`.
- Unset `REVIEW_ACCOUNT_PHONE` / `REVIEW_ACCOUNT_OTP` once the app is live; they are a long-lived fixed-code sign-in for Play reviewers.
- Perform a dependency security review and re-run E2E.
