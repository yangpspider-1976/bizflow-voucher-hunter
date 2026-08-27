# Security model

What this system trusts, what it enforces, and what it knowingly does not. Written
after the hardening pass of 2026-08-07; keep it current when a trust boundary moves.

The short version: this app moves real value. Loyalty Points are a liability a
partner is billed for, vouchers are goods handed over at a checkout, and every SMS is
metered SMPP credit. Treat "a caller can cause value to move" as the definition of
a bug, not "a caller can cause a 500".

## Trust boundaries

| Boundary | What proves identity | Where it is enforced |
| --- | --- | --- |
| Customer (web) | `httpOnly` phone + epoch cookies, set only after OTP | `getSignedInCustomerPhone` |
| Customer (mobile) | Opaque bearer token; only its SHA-256 is stored | `customer_tokens`, same function |
| Console (admin/staff) | HMAC-SHA256 signed session cookie, 8h | `verifyAdminSession` + `requireAdmin` |
| Integrations | `ADMIN_ACCESS_TOKEN`, constant-time compared | `requireAdmin` |
| SMPP worker → app | `SMPP_WORKER_CALLBACK_SECRET` | `/api/sms/delivery-receipt` |
| Scheduler → app | `CRON_SECRET` | `/api/cron/notifications` |

A customer's phone **always** comes from the verified session, never from the
request body. Every privileged route calls `requireAdmin` in its own handler;
`middleware.ts` is defence in depth, not the gate, so a middleware bypass in
Next.js does not become an authorization bypass here.

## Invariants the system enforces

**Value cannot be created without a billed counterparty.** LP is issued only by
`creditRewardFromPurchase`, which books a `reward_purchase` against a partner
whose deposit is not exhausted. The daily app-use and referral bonuses are capped
by `UNIQUE (wallet_id, reward_type, reward_date)` — the database, not a code path,
is what makes them once-a-day.

**Value cannot be spent twice.** Every debit is a conditional update
(`WHERE balance_centavos >= ? AND status = 'Active'`) whose affected-row count is
checked, backed by `CHECK (balance_centavos >= 0)`. Voucher redemption is
`WHERE id = ? AND status <> 'Redeemed'`, likewise checked. Purchase scans are
idempotent on `UNIQUE (business_id, idempotency_key)`.

**Money is integer centavos end to end.** No floats. `moneyToCentavos` rejects
non-finite input and anything that is not a bounded decimal string.

**Draws are unpredictable.** `weightedPool` uses `crypto.randomInt` over integer
weights. It previously used `Math.random()`, whose xorshift128+ state is
recoverable from a few outputs — and every draw publishes its own result.

**Codes are not guessable.** Voucher and LP codes are 80 bits
(`generateVoucherCode`), QR tokens 192. They were 24 bits, which made every
endpoint that resolves a code an enumeration oracle.

**Rate limits key on an address we observed.** `clientIp` reads the hop appended
by our own proxy, counting from the right per `TRUSTED_PROXY_HOPS`. Reading the
*first* `X-Forwarded-For` entry — as this did — let any caller choose and rotate
their own bucket, which silently voided every limit in the app.

**Credential and money endpoints are limited twice**, by address and by subject
(phone, wallet, login email). Neither alone works: an address is cheap to rotate,
and a subject is shared by everyone behind one NAT.

**A six-digit OTP is protected by attempt count, not by code space.** Five wrong
guesses burn the challenge; a new code supersedes any outstanding one; a number
can be sent at most five codes per 15 minutes however many addresses ask. The
per-number budgets key on the *normalised* number: keyed on the raw input,
`09171234567`, `+639171234567` and every punctuated spelling of them were
separate buckets, so an attacker could mint unlimited budget against one victim
by re-punctuating. That mattered most to the fixed-code accounts below, whose
codes are neither expired nor consumed.

**Fixed-code sign-in has no per-challenge attempt limit.** `REVIEW_ACCOUNT_OTP`
and the `DEV_ACCOUNT_OTP` slots are matched in constant time but never burn a
challenge, so the only thing bounding a brute force is the verify route's 10
tries per 15 minutes per number. Use random codes, and unset each one as soon as
it is no longer needed. Every configured slot is an independent standing target,
so the cheapest hardening available here is to keep the count at what is actually
in use.

**Dev tooling fails closed.** `devToolsEnabled()` opens only for `development`,
`test`, or an explicit `ENABLE_DEV_TOOLS=true`, and never in production. The
previous `NODE_ENV !== "production"` test opened free LP, forced roulette
outcomes, and a published-password super-admin login on any deploy whose NODE_ENV
was unset, `preview`, or `staging`.

**The production developer accounts are a second, narrower gate.** The
`DEV_ACCOUNT_PHONE` slots (`DEV_ACCOUNT_ENV_PAIRS` in `src/server/dev-tools.ts`)
name customer numbers that keep the hunt tools in production: reset my hunt,
refresh my vouchers, force my own next draw. Each is scoped to rows keyed by the
caller's own session phone and is reversible, and the numbers are compared
normalised so no spelling of one slips past. The tools that move money — LP
grants, simulated checkout scans, simulated collection — stay on
`devToolsEnabled()` and refuse in production for these accounts too, because those
write rows a real partner is billed for. They confer no console rights. Membership of a
slot is also what shows a client its dev panel — `isDevAccountPhone` via
`GET /api/public/signin/session`, on every deployment rather than a build-time
`NODE_ENV`/`__DEV__` test, which showed the panel to every ordinary account
signed in against a development backend. That response is advisory and every
tool re-checks the gate server-side.

**Console rights are re-read per request.** `requireAdmin` reloads the account, so
disabling, demoting or re-scoping takes effect immediately rather than at the end
of an 8-hour session.

## Accepted risks

- **No Content-Security-Policy.** The dashboard renders `data:` campaign artwork
  and Next.js injects inline bootstrap script, so a policy worth having needs
  nonce plumbing. The other baseline headers are set in `next.config.mjs`.
- **`walletSecret` is not a security boundary.** It is handed to the client by an
  endpoint the bearer token already guards, then passed back. It gates nothing the
  token does not. Left in place because removing it is an API change across both
  clients; do not mistake it for a second factor.
- **Self-referral is bounded, not prevented.** The check keys on a client-held
  cookie, so a private window defeats it. Damage is capped by
  `referralDailyLimit` and by the once-daily LP referral award.
- **A dishonest staff member can inflate a purchase amount** and credit LP to a
  friend's wallet. Their own employer is billed; amounts over ₱100,000 are held
  for review. This is a business control, not a technical one.
- **`ADMIN_ACCESS_TOKEN` is a single static super-admin credential** with no
  rotation story and no per-route scoping. `RATE_LIMIT_SALT` and `OTP_SALT` fall
  back to it, so rotating it rebuckets rate limits and invalidates outstanding
  OTP hashes. Set all three explicitly.
- **Next.js 14.2.30 carries open advisories** (`npm audit --omit=dev`). None are
  reachable as an authorization bypass here because every privileged route guards
  itself, but the upgrade is outstanding.

## Deployment checklist

These cannot be verified from the code — confirm them per environment:

1. `NODE_ENV=production` on every internet-reachable deploy, **including previews**.
   Verify with `/api/public/rewards/dev-credit`: it must return 403.
2. `ADMIN_SESSION_SECRET` (≥32 chars), `ADMIN_ACCESS_TOKEN`, `OTP_SALT`,
   `RATE_LIMIT_SALT`, `CRON_SECRET`, `SMPP_WORKER_CALLBACK_SECRET` all set to
   distinct random values. Nothing may be left at its `.env.example` placeholder.
3. `TRUSTED_PROXY_HOPS` matches the real topology. One hop for Vercel.
4. `REVIEW_ACCOUNT_PHONE` / `REVIEW_ACCOUNT_OTP` unset once Play review passes —
   they are a permanent fixed-code login while set.
5. The bootstrap `ADMIN_EMAIL` / `ADMIN_PASSWORD` pair retired once a real
   super-admin exists in `admin_users`.

## Not covered by code changes

Three things worth doing that no edit in this repo can accomplish:

1. **Rotate every secret** that has ever been in a shell history, a CI log, or a
   `.env` shared over chat — starting with `ADMIN_ACCESS_TOKEN`, since three
   subsystems derive from it.
2. **Alert on anomalous LP movement**: a wallet's balance rising faster than any
   purchase history explains, a partner's issuance spiking, redemptions clustering
   at one checkout. The audit log is hash-chained (`reward_audit_logs.event_hash`) but
   nothing reads it.
3. **Reconcile LP issued against LP settled** on a schedule, and alarm on drift.
   Double-entry invariants catch classes of bug that no amount of endpoint review
   will.
