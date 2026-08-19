# Voucher Hunt — Mobile App Migration (Phase 1 → 7) Handoff

**Audience:** an AI agent picking this up fresh, with no prior conversation context.
**Goal:** ship the **customer-facing** experience as a **React Native (Expo) Android app**, publishable to Google Play. The **admin/staff dashboard stays a web app**. The Next.js backend/API is shared by both.

Read this whole file before writing code. It encodes decisions already made — **do not relitigate them.**

---

## 0. Project snapshot

- **Repo:** `bizflow-voucher-hunter` — a Next.js 14 (App Router) + TypeScript full-stack app.
- **DB:** PostgreSQL (`pg`), async. Every environment uses `DATABASE_URL`; tests use their own `TEST_DATABASE_URL`.
- **What the product does:** a customer signs in by phone (SMS OTP), spins a "voucher roulette" to reveal one candidate voucher, picks a date/time slot the winning tier is offered at, and confirms to issue a final voucher (with QR). There is a Loyalty Points wallet, a referral bonus-spin system, an admin dashboard, and a staff QR-validation screen.
- **This is NOT a static SPA.** It uses server components, server-side redirect auth-gates, API routes, cookie auth, and server-side SMS. The server must keep running (Vercel/Node host). The mobile app is a **client that talks to this backend over HTTP** — it does not bundle the server.

### Commands (run from repo root)
```bash
npm install
npm run dev         # next dev
npm run typecheck   # tsc --noEmit
npm run lint        # next lint
npm test            # vitest run  (85 tests, 16 files at time of writing)
npm run build       # next build
```
**Definition of "green" for the web app: typecheck + lint + `vitest run` + `next build` all pass.** Keep them green after every backend change. The build occasionally exits non-zero due to a stale `.next` race when a dev server is running concurrently — a clean re-run resolves it; only treat a *reproducible* failure as real.

---

## 1. Phase 0 — DONE (context, don't redo)

A monorepo foundation is already in place:

- Root `package.json` has `"workspaces": ["packages/*", "apps/*"]`. **The web app currently lives at the repo root** (root = web app AND workspace root). The `apps/` folder is empty and reserved for the mobile app.
- **`packages/shared` (`@bizflow/shared`)** holds isomorphic code reused by both web and (future) mobile:
  - `src/types.ts` — all domain types (source of truth)
  - `src/phone.ts` — `normalizePhone`, `isValidPhilippinePhone`, `maskPhone`
  - `src/phone-display.ts` — `toDisplayPhone` (renders `+639…` as `09…`)
  - `src/voucher-presentation.ts` — `getVoucherPresentation` (rarity tiers)
  - Exposed via `exports` subpaths: `@bizflow/shared/types`, `/phone`, `/phone-display`, `/voucher-presentation`, and root `@bizflow/shared`.
  - It ships **TypeScript source** (no build step). Next transpiles it via `transpilePackages: ["@bizflow/shared"]` in `next.config.mjs`. The mobile app's Metro bundler will transpile it too.
- The old web paths (`@/types/voucher`, `@/server/phone`, `@/lib/phone-display`, `@/lib/voucher-presentation`) are now **thin re-exports** of the shared package, so existing web imports were untouched.

**Rule for `packages/shared`:** isomorphic only — no Node built-ins, no `next/*`, no DOM, no DB, no `window`. Server logic stays in the web app and is reached over the API. When the mobile app needs a pure helper or type that currently lives in the web app, move it into `@bizflow/shared` and re-export from the old path.

### Deferred / not done in Phase 0
- **The web app was NOT physically moved to `apps/web`.** Doing so would break the live Vercel deploy until its "Root Directory" setting is changed (an ops action). Optionally move it in Phase 2 alongside adding `apps/mobile`, coordinated with a Vercel root-dir change. It is not required.
- **Deploying to a custom HTTPS domain is an ops task for the human owner** (domain registrar + Vercel). The app needs a stable base URL by Phase 2.

---

## 2. Decisions already made — treat as fixed

| Decision | Choice |
|---|---|
| App framework | **React Native via Expo** (managed workflow) |
| Android first | Yes; iOS later (not now) |
| Repo layout | **Monorepo** — mobile app goes in `apps/mobile`, shares `@bizflow/shared` |
| Dashboard | **Stays web.** Do NOT port it to RN |
| Customer vouchers wallet | **Server-backed** (new API). Today the web wallet is device-local `localStorage`; the app must read vouchers from the server |
| Web customer UI | **Keep it running** through the build. Whether to retire it is a **post-launch decision** (Phase 7). The API + dashboard stay regardless |
| App auth | **Bearer token** in secure storage (see Phase 1). Cookies don't work in RN |
| QR | The customer app only **displays** QR (no scanning). Scanning is staff-only and stays on web → **no camera work in the app** |
| SMS | OTP is sent **server-side**. Do NOT add Android SMS-read/autofill permissions — that's a Play "restricted permission" and triggers heavy review. Manual code entry only |

---

## 3. Backend you're integrating against

### 3.1 Response envelope (all API routes)
Success: `{ "success": true, "data": <T> }`
Error: `{ "success": false, "error": { "code": "E-...", "message": "...", "details"?: ... } }`
Helpers: `ok(data)` / `fail(error)` in `src/server/errors.ts`. `AppError(code, message, status)` sets the HTTP status.

### 3.2 Auth model TODAY (web)
- Sign-in is **global** (not per-campaign) and **OTP-verified**.
- On `POST /api/public/signin/verify-otp`, the server sets two **httpOnly cookies**: `bizflow_customer_phone` and `bizflow_cust_auth` (holds a server "auth epoch"). See `src/server/customer-auth.ts`.
- Server gates read them via `getSignedInCustomerPhone()` / `requireSignedInCustomerPhone()` (throws `E-CUSTOMER-AUTH` 401). Every customer page and the hunt/rewards endpoints are gated.
- A **data reset bumps the auth epoch** (stored in `meta`), invalidating all cookies → everyone must re-sign-in. Keep this property for tokens too.
- **Public endpoints already take the phone from the session, never the request body** — so a caller can only ever act as their verified number.

### 3.3 Existing public API (all under `/api/public`)
| Method + path | Auth | Purpose |
|---|---|---|
| `POST /signin/request-otp` `{phone}` | none | Send SMS code. Returns `{sent, expiresAt, devCode?}`. `devCode` present outside production |
| `POST /signin/verify-otp` `{phone, code}` | none | Verify; sets auth cookies; returns `{phone}` |
| `POST /signin/signout` | cookie | Clears auth cookies |
| `GET /campaigns/[slug]` | none | One campaign + business + slots |
| `GET /campaigns/[slug]/slots` | none | Slots for a campaign |
| `GET /campaigns/[slug]/pools` | none | Benefit-tier pools (used by dev tools) |
| `POST /hunt/start` `{campaignSlug, sessionId, name?, email?}` | **session** | Sign-in-to-campaign / current hunt state |
| `POST /hunt/attempt` `{campaignSlug, sessionId, sourceType?, devPoolId?}` | **session** | Draw one candidate |
| `GET /hunt/state?campaignSlug=` | **session** | Hunt snapshot |
| `GET /hunt/slots?campaignSlug=&attemptId=` | **session** | Slots offered for a candidate's tier |
| `POST /hunt/select` `{campaignSlug, attemptId, slotId, sessionId, name, email?, guestCount?}` | **session** | Issue final voucher; sends confirmation SMS |
| `POST /hunt/reset` `{campaignSlug}` | **session** | Dev-only: clear this phone's hunt |
| `POST /rewards/wallet` `{name?, email?}` | **session** | Get/create the Loyalty Points wallet and award daily app-use LP once. Returns `{wallet, walletSecret, balance, ledger, vouchers, dailyStatus}` |
| `GET /rewards/wallet?walletSecret=` | **session** | Wallet snapshot |
| `POST /rewards/convert` `{walletSecret, amount}` | **session** | Convert Loyalty Points → LP voucher |
| `POST /referral/visit?campaign=&ref=` etc. | varies | Referral open/claim/state — grants bonus spins |
| `POST /voucher/resend` | — | Resend confirmation SMS |

"session" = currently the httpOnly cookie. **Phase 1 makes these also accept a bearer token.**

### 3.4 The customer flow (screens to rebuild in RN)
Web routes (for reference — the app rebuilds these as RN screens):
1. **Sign in** (`/signin`) — 2 steps: enter phone → `request-otp`; enter code → `verify-otp`. (`SignInForm.tsx`)
2. **Home / campaign directory** (`/`) — grid of active campaigns. Server component calls `listPublicCampaignCards()`. **No list API yet — Phase 1 adds one.** (`CampaignDirectory.tsx`)
3. **Campaign landing** (`/campaign/[slug]`) — "Ready to hunt". (`PublicStepClient.tsx`, step `landing`)
4. **Roulette** (`/campaign/[slug]/roulette`) — starts directly from the campaign landing CTA. See §6 gotcha.
5. **Results** (`/campaign/[slug]/results`) — the revealed candidate; share for bonus spin.
6. **Date & Time** (`/campaign/[slug]/datetime`) — tier-gated slot picker (`hunt/slots`).
7. **Confirm** (`/campaign/[slug]/confirm`) — name + read-only phone; `hunt/select`.
8. **Confirmation** (`/campaign/[slug]/confirmation`) — voucher code + QR.
9. **My Vouchers** (`/vouchers`, `/vouchers/[id]`) — currently device-local; **Phase 1 makes it server-backed.**
10. **More** (`/more`) — account, Loyalty Points wallet (+QR, daily status, LP-voucher conversion), sign out.

Almost all of steps 3–9 live in one big client component: `src/app/campaign/[slug]/_components/PublicStepClient.tsx` (~2500 lines). Read it to understand exact API calls, state, and the roulette. The mobile app reimplements this as separate RN screens.

---

## 4. PHASE 1 — Backend API readiness (do this first; web-only, no RN yet)

Goal: expose a complete JSON+token API the mobile app can drive, **without breaking the web app**. All additive.

### 4.1 Bearer-token auth alongside cookies
1. Add a token store. Simplest: a new table `customer_tokens (id, token_hash, phone, created_at, expires_at)` in the `SCHEMA` in `src/server/db.ts`. Add it to `DATA_TABLES` (so a reset wipes it — keeps the "reset signs everyone out" guarantee). Store a **hash** of the token, never the raw token.
2. Issue a token on OTP verify **for mobile clients**. Recommended: extend `POST /api/public/signin/verify-otp` to return `{ phone, token }` when the request opts in (e.g. header `X-Client: mobile` or body `{ issueToken: true }`), so the web response is unchanged when it doesn't ask. The token is a random opaque string (e.g. `crypto.randomBytes(32).toString("base64url")`), stored hashed with an expiry (mirror the cookie lifetime).
3. Add a request-aware resolver. Today `getSignedInCustomerPhone()` (in `src/server/customer-auth.ts`) reads only cookies via `next/headers`. Add a variant that also accepts a `Request` and checks `Authorization: Bearer <token>` → look up the hashed token → return phone. Then update `requireSignedInCustomerPhone()` (and its call sites in the hunt/rewards routes) to pass `request` and accept **either** cookie **or** bearer.
   - Route handlers already have `request`. Thread it through.
   - Order: try bearer (if `Authorization` present), else cookie.
4. Add `POST /api/public/signin/signout` handling for tokens too: if a bearer token is presented, delete that token row.
5. Tests: add an integration test proving (a) a valid token authorizes a hunt endpoint, (b) an invalid/absent token 401s, (c) a reset invalidates issued tokens. Mirror `tests/integration/signin-otp.test.ts`.

**Keep it backward compatible:** the web app must keep working via cookies with zero changes.

### 4.2 New endpoints
1. `GET /api/public/campaigns` → list for the directory. Reuse `listPublicCampaignCards()` from `src/server/voucher-engine.ts`. Returns `CampaignCard[]` = `{ campaign, businessName, businessLogo, businessIndustry }[]`.
2. `GET /api/public/vouchers` (**session**) → the signed-in phone's issued vouchers, shaped for display like the web `ClaimedVoucher` (`{ voucher, slot, campaignSlug, campaignTitle, businessName }`). Query `vouchers` joined to `slots`/`campaigns`/`businesses`, filtered by the user's phone (a phone maps to per-campaign `users` rows; join through them). Add a matching detail lookup or return enough for the detail screen. This replaces the localStorage wallet **for the app** (leave the web's localStorage path alone for now).

### 4.3 Phase 1 acceptance
- Web app still green (typecheck/lint/test/build).
- With a bearer token obtained from `verify-otp`, you can curl the entire journey: list campaigns → start → attempt → slots → select → vouchers → wallet.
- New integration tests pass.

---

## 5. PHASE 2 → 7 (mobile app)

Each phase is independently shippable and must leave the web app + dashboard working.

### PHASE 2 — Expo app shell + auth
- Scaffold `apps/mobile` (Expo, TypeScript). Add it to the workspace (`apps/*` glob already set). Configure Metro to transpile `@bizflow/shared` (workspace symlink; Expo monorepo config — `metro.config.js` with `watchFolders` + `nodeModulesPaths`).
- Navigation: **expo-router** (file-based, mirrors Next's structure — eases mental mapping) or React Navigation.
- API client: a small fetch wrapper pointing at `API_BASE_URL` (env/config); unwraps the `{success,data}` envelope; attaches `Authorization: Bearer <token>`.
- Token storage: **expo-secure-store**. Store the token from `verify-otp`; clear on sign out.
- Screens: **Sign in** (phone → code, using `request-otp`/`verify-otp` with `X-Client: mobile`), and an empty **bottom-tab shell** (Home / Vouchers / More).
- Theme to match the web look (mobile-first purple UI). Reuse `@bizflow/shared` types + `toDisplayPhone` + `getVoucherPresentation`.
- **Acceptance:** installable dev build (Expo Go or dev client) you can sign into; token persists across restarts; sign out works.

### PHASE 3 — Core hunt flow
- Screens: directory (from `GET /campaigns`) → campaign landing (`GET /campaigns/[slug]`) → hunt intro → **roulette** → results → date & time (`hunt/slots`) → confirm (`hunt/select`) → confirmation (voucher + QR).
- QR display: `react-native-qrcode-svg` (or similar).
- **The roulette is the hardest port** — see §6.
- **Acceptance:** full sign-in → hunt → issued-voucher journey works in the app against the real API.

### PHASE 4 — Wallet, More, referral
- **My Vouchers** list + detail from `GET /api/public/vouchers`.
- **More**: account (show `toDisplayPhone(phone)`), Loyalty Points wallet (balance, daily LP status, wallet QR, convert LP via `rewards/convert`), sign out (`signin/signout` + clear secure store). Omit the web's "dev tools" block.
- **Referral**: use the native share sheet (`expo-sharing`/RN `Share`) to share the referral link.
- **Acceptance:** feature-complete customer app.

### PHASE 5 — Native polish
- App icon, splash, status bar, safe-area handling.
- **Deep links / universal links** so referral links (and campaign links) open the app; configure the scheme + Android intent filters. Handle a cold-start deep link into a campaign.
- Loading / empty / error states; offline handling (the app needs connectivity — fail gracefully).
- **Optional:** push notifications via FCM (`expo-notifications`). Requires an FCM project + server-side send. Skip if not needed for v1.
- **Do NOT request SMS permissions.**

### PHASE 6 — Google Play release
- Google Play Developer account ($25 one-time). Play App Signing.
- **Privacy policy** (mandatory) + **Data Safety** form — you collect **phone numbers** and send OTP; declare it accurately.
- Content rating questionnaire.
- Build a signed **AAB** with **EAS Build** (`eas build -p android`) — no Mac needed for Android. Configure `eas.json`, app version/versionCode, and the `API_BASE_URL` for production (the deployed HTTPS domain).
- Release track flow: internal testing → closed → production.
- **Acceptance:** an internal-testing build installs from Play and runs the full flow against production.

### PHASE 7 — Decide the web customer UI's fate
- Post-launch decision (owner's call). Options: keep the web customer UI as a no-install fallback, or delete the customer route files (`src/app/campaign/…`, `/`, `/vouchers`, `/more`, `/signin`) leaving dashboard + API. **The API and dashboard stay regardless.** Reversible either way.

---

## 6. Gotchas & conventions

- **The roulette animation** (`PublicStepClient.tsx`, search `roulette`): the reel **free-spins at constant speed until the user taps it**, then **coasts to a stop** on the pre-drawn winner with a velocity-matched ease-out (the coast's opening speed equals the spin speed so there's no visual "lurch"), then the user confirms. Web implements it with `requestAnimationFrame` + CSS `translateX` and a doubled item list for seamless looping. Constants to mirror: card width/gap → `rouletteUnit`, `rouletteSpinSpeed` (px/ms), `rouletteStopCards`, `rouletteStopEaseExp`. In RN, reimplement with **react-native-reanimated** (shared values + `withDecay`/custom timing). Preserve the UX: indefinite spin, tap-to-stop, land exactly on the winner. The winner is decided server-side by `hunt/attempt`; the animation just has to *land on it*.
- **Vouchers are device-local on web** (`src/lib/voucher-display.ts`, `readClaimedVouchers` from `localStorage`). The app must use the new server endpoint (§4.2) instead — don't copy the localStorage approach.
- **Phone format:** stored normalized as `+639XXXXXXXXX`. Display as `09XXXXXXXXX` via `toDisplayPhone` (in `@bizflow/shared`). Accept `+639…`, `09…`, `639…` on input (`isValidPhilippinePhone`).
- **Reset revocation:** a data reset must sign out the app too. Achieved by wiping `customer_tokens` in the reset (add to `DATA_TABLES`). Don't rely on the cookie epoch for the app.
- **Don't break the web app.** Every Phase-1 change is additive. Run the four gates after each change.
- **CORS:** native `fetch` isn't CORS-restricted like a browser, so hitting the API from the device is fine. If you ever run the app on Expo *web*, you'd need CORS — out of scope (Android only).
- **Local dev against the API:** point `API_BASE_URL` at the deployed domain, or at the dev machine's LAN IP (`http://192.168.x.x:3000`) with `next dev` — `localhost` won't resolve from a phone/emulator (Android emulator uses `10.0.2.2`).
- **Env/secrets:** never commit `.env`. The mobile app's only needed config is `API_BASE_URL` (+ optional FCM keys later) — keep it in Expo config/`app.config.js` env, not hardcoded.

---

## 7. Suggested order of work
1. **Phase 1** entirely (backend, in this repo) — token auth + `GET /campaigns` + `GET /vouchers` + tests. Ship it; web stays green.
2. **Phase 2** — `apps/mobile` scaffold + auth. Get sign-in working end to end.
3. **Phase 3** — hunt flow incl. roulette.
4. **Phase 4** — wallet/more/referral.
5. **Phase 5** — polish + deep links.
6. **Phase 6** — Play release.
7. **Phase 7** — web-UI decision.

Do one phase at a time. Confirm the phase's acceptance criteria before moving on.
