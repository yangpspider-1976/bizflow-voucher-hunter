# Levels, Missions and Achievements

Implements the *Voucher Hunt Gamification Update* requirements (v1.0, 2026-08-27):
Sprint 0 (foundation) and Phase 1 (MVP), which is the document's own
"Recommended First Release".

Everything here sits **beside** the existing hunt → voucher → booking → QR →
5% accrual flow rather than inside it. No existing balance, ledger or settlement
rule changed; the new systems reference the old ones and extend the event model,
as the migration note in §8 of the requirements asks.

---

## The one rule that shapes everything

**LP and XP are different things.**

| | LP (Loyalty Points) | XP (experience) |
| --- | --- | --- |
| What it is | A spendable balance a partner or the platform owes | A cumulative progression metric |
| Stored in | `reward_wallets` / `reward_business_balances` (centavos) | `user_levels.lifetime_xp` (whole integers) |
| Ledger | `reward_ledger_entries` | `user_xp_ledger` |
| Can be spent? | Yes — storefront items, vouchers, and levels | Never |
| Cash value | Settled with partners monthly | None. No transfer, refund or withdrawal |

Spending LP does not cost you a level, because the level is derived from
`lifetime_xp` and not from what is left in a wallet. Converting LP into XP
debits the LP and credits the XP **in one transaction**.

---

## Where the code lives

| Path | What it does |
| --- | --- |
| `packages/shared/src/gamification.ts` | The shapes every client reads, plus `levelForXp` — the single tested level calculation |
| `src/server/gamification/config.ts` | Versioned economy configuration and the seeded MVP defaults |
| `src/server/gamification/definitions.ts` | The seeded mission and achievement catalogue |
| `src/server/gamification/time.ts` | Manila day boundaries and mission windows |
| `src/server/gamification/rewards.ts` | **The central reward service.** The only thing that grants XP, LP, tickets or badges |
| `src/server/gamification/levels.ts` | Level state and LP → XP conversion |
| `src/server/gamification/missions.ts` | Assignment, progress, completion, payout, expiry |
| `src/server/gamification/achievements.ts` | Counters, tiers, streaks, distinct-thing counters, reversal |
| `src/server/gamification/events.ts` | Event intake, deduplication, retry, dead-letter |
| `src/server/gamification/hooks.ts` | **Where the existing product calls in.** One call per trigger |
| `src/server/gamification/ad-verification.ts` | AdMob server-side verification |
| `src/server/gamification/backfill.ts` | Restartable historical backfill |
| `src/server/gamification/profile.ts` | The single profile response the app renders |

Mobile: `apps/mobile/src/gamification/` and `apps/mobile/src/app/(tabs)/quests/`.
Admin: `src/app/dashboard/gamification/`.

---

## How a reward actually happens

```
verified event  →  gamification_events (deduplicated, recorded)
                →  mission rules engine        →  reward_service
                →  achievement counters        →  reward_service
                                                    ├─ user_xp_ledger + user_levels
                                                    ├─ loyalty_ledger (global or partner pot)
                                                    ├─ hunt_ticket_ledger
                                                    └─ reward_transactions (one row, always)
```

Four properties hold, and each is enforced by a database constraint rather than
by care:

1. **Idempotent.** `reward_transactions.idempotency_key`, `user_xp_ledger.idempotency_key`
   and `gamification_events.idempotency_key` are all unique. A retried event, a
   double tap and a replayed ad callback insert nothing the second time.
2. **Atomic.** `grantReward` takes the caller's open transaction. A mission
   moving to CLAIMED and the reward it pays commit together or not at all.
3. **Versioned.** Every transaction records the `config_version` it ran under,
   so a settled month can be reproduced after operations change the numbers.
4. **Reversible without deletion.** A reversal writes a mirrored transaction and
   a negative ledger entry; nothing is edited or removed.

### Budget rules

- Past the **daily LP cap** a payout is trimmed and the shortfall paid in XP.
  Refusing outright would mean a player did the thing and the mission paid
  nothing, which reads as a bug.
- A single grant above the **review threshold** is written `REVIEW_REQUIRED` and
  waits for an administrator instead of paying itself.
- A **partner-funded** mission stops paying when its campaign budget is gone —
  a partner's money is not ours to substitute XP for, so that is a refusal, and
  the instance is marked `REJECTED` with `BUDGET_EXHAUSTED`.

---

## Time

Timestamps are stored in UTC. Only resets, daily windows and push exposure are
reckoned in Asia/Manila, which has been a flat UTC+8 with no daylight saving
since 1978 — so `time.ts` does fixed-offset arithmetic rather than a timezone
lookup, and `tests/unit/gamification-time.test.ts` asserts the property across
all 365 days of a year.

Celebrations follow the same principle: `user_levels.announced_level` is the
watermark for a promotion and `user_achievements.seen_at` for a badge, so a
level won while the app was closed is celebrated on whichever device opens next
and never again after that.

**There is no midnight job.** A daily mission is one row per player per Manila
date; tomorrow simply has no row yet and gets one the first time anybody looks
or acts. The maintenance cron only marks yesterday's *unfinished* instances
`EXPIRED` — a mission that reached `CLAIMABLE` before midnight keeps its reward,
because the player earned it.

Events are judged by `occurred_at`, never by the clock at processing time, with
15 minutes of grace: an ad watched at 10:58 and verified at 11:02 still
completes the morning mission.

---

## Wiring points

Each of these is one call to `src/server/gamification/hooks.ts`:

| Trigger | Where | Event |
| --- | --- | --- |
| Hunt spin resolved | `POST /api/public/hunt/attempt` | `hunt_complete` |
| Voucher chosen and booked | `POST /api/public/hunt/select` | `voucher_select` |
| Campaign voucher redeemed at the till | `redeemVoucher` in `voucher-engine.ts` | `qr_redeem` |
| LP voucher spent at a partner | `POST /api/staff/rewards/redeem` | `qr_redeem` |
| Referral visit verified | `POST /api/public/referral/claim` | `referral_verified` |
| Rewarded ad verified by Google | `GET /api/public/gamification/ads/ssv` | `ad_reward_verified` |

All are called **after** their own transaction commits, and all use
`ingestEventQuietly`: a rules-engine fault must never roll back a redemption.
The event row survives and `processPendingEvents` retries it on the next cron.

---

## API

Customer endpoints are under `/api/public/gamification/` (the project's existing
convention; the requirements' `/v1/...` paths map one-to-one).

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/public/gamification/profile` | Level, today's missions, achievements — one call |
| GET | `/api/public/gamification/levels` | The whole ladder plus where the caller stands |
| POST | `/api/public/gamification/levels/convert-points` | LP → XP. Requires `idempotencyKey` |
| GET | `/api/public/gamification/missions?type=` | Mission board |
| GET | `/api/public/gamification/missions/{key}` | One mission's details |
| POST | `/api/public/gamification/missions/{key}/join` | Join an urgent mission, reserving quota |
| POST | `/api/public/gamification/missions/{key}/claim` | Claim a finished mission |
| GET | `/api/public/gamification/achievements` | Every badge group and tier |
| POST | `/api/public/gamification/achievements/seen` | Acknowledge celebration screens (badge unlocks and the level-up screen) |
| POST | `/api/public/gamification/ads/nonce` | Mint the signed `custom_data` for a rewarded ad |
| GET | `/api/public/gamification/ads/ssv` | AdMob SSV callback (called by Google, not the app) |
| POST | `/api/internal/gamification/events` | Service-to-service verified events (`CRON_SECRET`) |
| GET/POST | `/api/admin/gamification/economy` | Read / publish an economy version |
| GET/POST | `/api/admin/gamification/levels` | Read / publish a level ladder |
| GET/POST/PATCH | `/api/admin/gamification/missions` | List / publish / stop mission definitions |
| GET/POST | `/api/admin/gamification/backfill` | Historical achievement backfill |
| POST | `/api/admin/gamification/rewards/{id}/reverse` | Reverse a grant (super admin + named second approver) |
| POST | `/api/admin/gamification/counters` | Correct an achievement counter, and optionally revoke a badge with a reason |

### Error codes

`INSUFFICIENT_POINTS` · `MISSION_NOT_ACTIVE` · `NOT_ELIGIBLE` · `LEVEL_REQUIRED` ·
`QUOTA_EXHAUSTED` · `ALREADY_COMPLETED` · `REWARD_ALREADY_GRANTED` ·
`BUDGET_EXHAUSTED` · `CONFIG_VERSION_CHANGED`, carried on this codebase's
`E-`-prefixed codes (`E-INSUFFICIENT-POINTS`, `E-MISSION-NOT-ACTIVE`, …).

---

## Anti-abuse

| Risk | Control |
| --- | --- |
| Fake ad completion | AdMob SSV only: ECDSA signature over Google's own query string, a signed short-lived nonce, a unique `ad_transaction_id`, and three windowed missions a day as the ceiling |
| Replayed events | Unique `idempotency_key` on events, reward transactions and the XP ledger |
| Reward race conditions | Conditional `UPDATE`s (never read-then-write), `FOR UPDATE` on the XP row, unique indexes |
| Time manipulation | Server UTC and Manila conversion; a client clock is never read |
| Over-spending a pot | `WHERE balance_centavos >= ?` on every debit — a zero row count is an insufficient balance |
| Administrator misuse | RBAC, hash-linked `reward_audit_logs`, and a named second approver on reversals |
| Fraudulent activity already rewarded | Counters are corrected by `/api/admin/gamification/counters`; a badge is only revoked when an administrator says so, with a reason on the audit row |

---

## Configuration

Nothing is hard-coded. `/dashboard/gamification` publishes new versions of the
economy and the level ladder; a live mission is never edited, only superseded by
a new `definition_version` that in-flight instances do not see.

Seeded MVP defaults (all changeable without a deploy):

- 1 LP = 1 XP, minimum 50 LP
- Levels at 0 / 500 / 1,500 / 3,500 / 7,000 XP
- Ad windows 06:00–10:59, 11:00–14:59, 17:00–21:59 (Manila)
- Ad 5 LP + 10 XP; hunt 10 XP; voucher select 10 XP; QR 5 LP + 20 XP; four missions 30 XP
- Achievement tiers pay badge + XP (25 / 75 / 200 / 500); LP is opt-in per tier
- Daily LP grant cap 200 LP per player; single grants above 500 LP are held

---

## Testing

```bash
npm run typecheck          # web + shared
npm run mobile:typecheck   # Expo app
npx vitest run tests/unit/gamification-levels.test.ts tests/unit/gamification-time.test.ts
npm run test:integration   # needs TEST_DATABASE_URL
```

The unit tests cover the pure logic and run anywhere: level thresholds
(including the exact-threshold and multi-level-jump cases the QA criteria name),
ladder validation, Manila boundaries across a full year, and window/grace rules.

The integration tests need Postgres and cover LP↔XP reconciliation, duplicate
taps, concurrent conversions, the daily reset, window crediting, the capstone
mission, one-unlock-per-tier, streaks, distinct-partner counting and backfill
idempotency.

---

## Not in this change

- **The rewarded-ad SDK in the app.** The whole server side is done and tested —
  nonce minting, signature verification, replay protection, mission crediting —
  but the Expo app does not yet show a rewarded ad, because no ad SDK is
  installed and none of the AdMob app/unit IDs exist yet. Adding
  `react-native-google-mobile-ads`, its config plugin and the AdMob account, then
  passing `customData` from `POST /api/public/gamification/ads/nonce` into the
  ad request and pointing the SSV callback at
  `/api/public/gamification/ads/ssv`, completes it. Until then the three ad
  missions exist, are configurable and pay correctly — nothing can trigger them
  from the app.
- **Evidence submission and review** (`POST /v1/missions/{id}/proof`,
  `mission_proofs`). Phase 2 in the requirements' own sequence: the table and the
  `VERIFYING` state exist, the review UI does not.
- **Location-gated flash missions.** The mission model carries the fields; no
  location capture or radius check is wired.
- Everything the requirements list as out of scope: leaderboards, season passes,
  point gifting, cash withdrawal, a cross-partner unified balance.
