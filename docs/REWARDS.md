# Loyalty Points (LP) — how it works

This document describes the network-wide Loyalty Points system. LP is a
program unit used through participating partner offers. The LP required for a
reward is defined by the applicable offer.

The campaign voucher hunt remains a separate system. A successful referral
still grants an extra roulette spin and now also grants the referrer 10 LP,
at most once per Manila calendar day.

Implementation lives in
[`src/server/rewards-network.ts`](../src/server/rewards-network.ts).

## Customer loop

1. A signed-in customer opens the app and receives a random 1-10 LP once
   that day.
2. A successful distinct referral adds another 10 LP once that day.
3. Partner staff scan the customer wallet QR after a paid purchase.
4. The customer earns 5% of the peso purchase as LP. A ₱500 purchase earns
   25 LP.
5. The customer converts at least 50 LP into an `RWD-XXXXXX` LP voucher.
6. Partner staff redeem the LP voucher under the participating partner's
   applicable offer. Partial use is supported.
7. The partner receives 90% of the spent LP; Voucher Hunt retains a 10%
   service fee.
8. Prior-month partner payouts can be processed during days 1–7 of the next
   month.

If a customer uses the app and completes one eligible referral every day for
30 days, the daily activities can award up to 600 LP - the app-use half of that
ceiling only lands on days the draw comes up 10.

## Exact arithmetic

LP balances are internally stored in integer hundredths (`*_centavos`).
This preserves exact 5% calculations and avoids floating-point rounding:
`100` stored units equals `1 LP`.

| Rule | Value |
|---|---:|
| Purchase earning rate | 5% |
| Daily app-use award | random 1-10 LP, whole points |
| Daily referral award | 10 LP |
| Daily referral limit | 1 network-wide award |
| Minimum LP-voucher conversion | 50 LP |
| Partner service fee | 10% of LP spent |
| Partner payout | 90% of LP spent |
| Settlement processing window | Days 1–7 of the following month |
| LP-voucher expiry | 1 year |

The 10% fee is rounded down to the nearest hundredth of an LP. Partner payout
is always the gross LP spent minus that fee.

## Authentication and credentials

One wallet exists per phone number.

- `walletToken` is presented as a QR and may be shown to partner staff to add
  LP after a purchase.
- `wallet_secret` is held by the customer and is required to convert LP into
  a voucher.
- Customer wallet and conversion endpoints additionally require the signed,
  OTP-backed customer session.
- Staff actions require a signed staff/admin session scoped to the associated
  business.

## Purchase awards and fraud controls

`POST /api/staff/rewards/credit` requires an idempotency key unique within the
business. Retrying the same request returns the original result without adding
LP twice.

Purchases above ₱100,000 or excessive repeated scans are held for admin review.
LP is only added when a held purchase is approved.

## Daily awards

`loyalty_daily_rewards` has a unique key on wallet, reward type, and date.
This makes daily app-use and referral LP idempotent even if clients retry.
The date is evaluated in `Asia/Manila`.

## Spending and settlement

LP is debited with a conditional database update, so concurrent conversions
cannot overdraw the wallet. LP-voucher use similarly updates the remaining
amount conditionally.

Every redemption records:

- gross LP spent;
- 10% service fee;
- 90% partner settlement amount; and
- the business that accepted it.

Only redemptions from completed months can be batched, and processing is
server-enforced to days 1–7 of the following month. Settlement states are:

`Pending` → `Processed` → `Completed`

`Adjusted` is the manual review path.

## Auditability

`reward_ledger_entries` is append-only and records every LP delta with the
resulting balance. `reward_audit_logs` is hash-chained: editing or removing an
old event breaks the hashes after it.

Relevant tables include `reward_wallets`, `loyalty_daily_rewards`,
`reward_purchases`, `reward_ledger_entries`, `reward_vouchers`,
`reward_voucher_redemptions`, `reward_settlements`, and
`reward_audit_logs`.

## Main endpoints

| Endpoint | Purpose |
|---|---|
| `POST /api/public/rewards/wallet` | Create/load wallet and grant daily app-use LP |
| `GET /api/public/rewards/wallet?walletSecret=` | Load authenticated wallet snapshot |
| `POST /api/public/rewards/convert` | Convert LP into an LP voucher |
| `POST /api/staff/rewards/credit` | Add 5% LP from a paid purchase |
| `POST /api/staff/rewards/validate-voucher` | Validate an LP voucher |
| `POST /api/staff/rewards/redeem` | Record LP spending, fee, and payout |
| `POST /api/dashboard/rewards/purchases/review` | Approve/reject held purchases |
| `POST /api/dashboard/rewards/settlements` | Process/complete partner settlements |
| `GET /api/dashboard/rewards/audit/export` | Export the immutable audit trail |
