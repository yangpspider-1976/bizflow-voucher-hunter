# Levels, Missions and Achievements

Implements the *Voucher Hunt Gamification Update* requirements (v1.0, 2026-08-27)
in full: Sprint 0 (foundation), Phase 1 (MVP), Phase 2 (urgent missions, the
Partner CMS, quota and budget, evidence review, push) and Phase 3 (backfill,
anomaly detection, settlement reporting, the KPI dashboard, economy
optimisation).

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
| `src/server/gamification/offers.ts` | The level gate on a partner's campaign |
| `src/server/gamification/flags.ts` | Feature switches and the gradual rollout |
| `src/server/gamification/missions.ts` | Assignment, progress, completion, payout, expiry |
| `src/server/gamification/achievements.ts` | Counters, tiers, streaks, distinct-thing counters, reversal |
| `src/server/gamification/events.ts` | Event intake, deduplication, retry, dead-letter |
| `src/server/gamification/hooks.ts` | **Where the existing product calls in.** One call per trigger |
| `src/server/gamification/ad-verification.ts` | AdMob server-side verification |
| `src/server/gamification/backfill.ts` | Restartable historical backfill |
| `src/server/gamification/profile.ts` | The single profile response the app renders |
| `src/server/gamification/mission-admin.ts` | Authoring, the approval workflow, and the pre-flight simulation |
| `src/server/gamification/proofs.ts` | Evidence submission, the review queue, and the decision |
| `src/server/gamification/notify.ts` | Mission, level and badge notifications, with quiet hours and consent |
| `src/server/gamification/anomaly.ts` | The seven detectors and the graduated hold |
| `src/server/gamification/analytics.ts` | The KPI queries behind the dashboard |
| `src/server/gamification/settlement.ts` | The five settlement lines on a partner statement |

Mobile: `apps/mobile/src/gamification/` and `apps/mobile/src/app/(tabs)/quests/`.
Admin: `src/app/dashboard/gamification/` — five screens behind one sidebar row
(Economy, Missions, Evidence, Analytics, Abuse), of which a partner account sees
Missions and Evidence, scoped to its own businesses.

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
| Purchase scanned at a partner's checkout | `POST /api/staff/rewards/credit` | `purchase_verified` |
| A held purchase scan cleared by review | `POST /api/dashboard/rewards/purchases/review` | `purchase_verified` |
| Referral visit verified | `POST /api/public/referral/claim` | `referral_verified` |
| Rewarded ad verified by Google | `GET /api/public/gamification/ads/ssv` | `ad_reward_verified` |

A purchase scan is the one trigger with two call sites, because a fraud-flagged
scan credits nothing until a person clears it: raising `purchase_verified` at
the till would pay a mission for a sale the platform has not yet honoured, and
never raising it after a review would lose the sale entirely. Both key the event
on the purchase id, so a sale can only ever be counted once.

The dev tools' simulated checkout (`POST /api/public/rewards/dev-purchase`)
calls the earning path directly rather than through the staff route, so it
books a real `reward_purchase` and bills the partner but raises no event.
Drive `purchase_verified` missions through the internal event intake instead.

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
| POST | `/api/public/gamification/missions/{key}/join` | Join an urgent mission, reserving quota. Optional `location` |
| POST | `/api/public/gamification/missions/{key}/proof` | Submit evidence (photo, receipt or note) |
| POST | `/api/public/gamification/missions/{key}/claim` | Claim a finished mission |
| GET | `/api/public/gamification/achievements` | Every badge group and tier |
| POST | `/api/public/gamification/achievements/seen` | Acknowledge celebration screens (badge unlocks and the level-up screen) |
| POST | `/api/public/gamification/ads/nonce` | Mint the signed `custom_data` for a rewarded ad |
| GET | `/api/public/gamification/ads/ssv` | AdMob SSV callback (called by Google, not the app) |
| POST | `/api/internal/gamification/events` | Service-to-service verified events (`CRON_SECRET`) |
| GET/POST | `/api/admin/gamification/economy` | Read / publish an economy version |
| GET/POST | `/api/admin/gamification/levels` | Read / publish a level ladder |
| GET/POST/PATCH | `/api/admin/gamification/missions` | List / publish / approve / stop mission definitions. `?simulate=1` runs the pre-flight without writing |
| GET/POST | `/api/admin/gamification/proofs` | The evidence review queue and the decision |
| GET | `/api/admin/gamification/proofs/{id}/file` | The image behind one submission |
| GET/POST | `/api/admin/gamification/signals` | The abuse queue; `{"action":"scan"}` runs the detectors |
| GET/POST | `/api/admin/gamification/held` | Rewards parked for approval, and the decision on one |
| GET | `/api/admin/gamification/analytics` | KPIs, or `?format=csv` for the mission funnel |
| GET | `/api/dashboard/rewards/settlements/gamification` | A partner's five settlement lines, `?format=csv` to export |
| GET/POST | `/api/admin/gamification/backfill` | Historical achievement backfill |
| POST | `/api/admin/gamification/rewards/{id}/reverse` | Reverse a grant (super admin + named second approver) |
| POST | `/api/admin/gamification/counters` | Correct an achievement counter, and optionally revoke a badge with a reason |

### Error codes

`INSUFFICIENT_POINTS` · `MISSION_NOT_ACTIVE` · `NOT_ELIGIBLE` · `LEVEL_REQUIRED` ·
`QUOTA_EXHAUSTED` · `ALREADY_COMPLETED` · `REWARD_ALREADY_GRANTED` ·
`BUDGET_EXHAUSTED` · `PROOF_REQUIRED` · `REVIEW_PENDING` · `CONFIG_VERSION_CHANGED`,
carried on this codebase's
`E-`-prefixed codes (`E-INSUFFICIENT-POINTS`, `E-MISSION-NOT-ACTIVE`, …), plus
`E-OFFER-NOT-OPEN` for a campaign whose opening time has not arrived and
`E-FEATURE-DISABLED` (503) for one that is switched off — not a refusal of the
player, which is why it is not a 403.

---

## Urgent missions

A daily mission is a row the system creates for you. An urgent mission is a
campaign somebody runs, and you are not in it until you join. That difference
shapes everything about them.

**A card exists before a row does.** `listMissionCards` returns the player's own
instances *and* every live campaign they have no instance of, built from the
definition and a fresh eligibility check. Without that second half the Urgent
tab would be permanently empty: there is nothing to read until somebody joins,
and nobody joins something they cannot see.

**A campaign they cannot join is still shown, with the reason.** The
requirements are explicit that a restriction should read as a goal, so an
ineligible card carries `ineligibleReason` — `LEVEL_REQUIRED` (with the XP still
to go), `QUOTA_EXHAUSTED`, `NOT_STARTED`, `OUT_OF_AREA`, `NOT_ELIGIBLE` — and
the first one that applies wins, so the message does not flip between two true
answers.

### Audience

`audience_json` on the definition, evaluated server-side against facts read once
per player per request:

| Rule | Meaning |
| --- | --- |
| `segment: new` | Wallet created inside `segmentDays` (7 by default) |
| `segment: dormant` | Has done something, but nothing for `segmentDays` (30) |
| `segment: returning` | Active in the last 3 days *and* silent for the whole dormancy window before it |
| `firstVisitOnly` | The player has never redeemed at this partner |
| `area` | A circle: latitude, longitude, radius in metres |
| `minLevel` | The level gate, which is a column rather than an audience rule |

`returning` deliberately needs both halves. "Came back" is a shape over time, not
a timestamp, and a player who never left matches the first half on its own.

### Location

Only `area` missions ever ask for a location, and only at the moment somebody
taps Join. A permission prompt with no visible reason is the one people deny.

The phone measures; the server decides. It refuses a fix the device itself flags
as `mocked`, refuses one whose reported accuracy is worse than 200 m — a
five-kilometre error radius is not a location — and adds the accuracy to the
radius rather than subtracting it, so a 40 m-uncertain fix 30 m outside the
boundary is admitted. Refusing somebody standing inside the shop is the worse of
the two mistakes.

A location never grants a reward on its own. It gates joining; finishing still
needs the partner's own QR scan.

### Quota

`quota_mode` decides when a place is taken:

- **`RESERVE_ON_JOIN`** — the seat is taken by the join, with a conditional
  `UPDATE ... WHERE joined_count < global_quota`. That single statement *is* the
  reservation, which is the only way a limited campaign survives everybody
  tapping at once when the push lands. Seats are handed back by the nightly
  sweep when an instance expires or is cancelled, once each, stamped
  `quota_released` in the same transaction as the decrement.
- **`ON_COMPLETION`** — the seat is taken at the finish line, by the same shape
  of conditional update inside `payMission`. A player who does not make the cut
  is marked `REJECTED` with `QUOTA_EXHAUSTED` rather than paid.

`user_quota` above 1 lets one player do a campaign repeatedly. The unique key is
`(wallet, mission, mission_date)`, so repeats live in numbered occurrence slots
— `''`, `'#2'`, `'#3'` — rather than in extra rows the key would reject.

---

## Evidence review

Some missions cannot be verified by an event. A QR scan proves somebody was
there, not that they ordered the set menu. Those carry `requires_proof`.

```
target met  →  VERIFYING  →  player submits  →  operator decides
                                                 ├─ Approved → CLAIMABLE → paid
                                                 └─ Rejected → VERIFYING, with the reason
```

A finished mission that needs evidence lands in `VERIFYING`, **not**
`CLAIMABLE` — the requirements separate completion from issuance, and a mission
whose evidence is later rejected must never have paid first.

A rejection deliberately leaves the mission in `VERIFYING` rather than resetting
it. The player did the thing; what failed was the photo. The reviewer's reason is
required, is stored, and is shown to them verbatim, because a second attempt only
helps if they know what to fix. Resubmitting marks the previous submission
`Superseded` rather than deleting it.

**Two tables, deliberately.** `mission_proofs` is the decision — who submitted
what, who reviewed it, why they said no — and is read by the queue, the support
screens and the mission engine. `mission_proof_files` is the picture, read by
one endpoint and emptied 90 days later by the retention sweep. A reward paid on a
receipt can still be explained after the receipt is gone.

Uploads are base64 JSON, capped at 2 MB decoded, and limited to JPEG, PNG and
WebP by allowlist rather than by sniffing. The app downscales to JPEG at quality
0.6 before sending — learning about the cap after a slow upload on mobile data is
the worst possible way to learn about it.

---

## The Partner CMS

`/dashboard/gamification/missions`. A partner writes a campaign against its own
business and sends it for review; operations approves it and only then do players
see it. The split is enforced in `publishMissionDefinition` and
`listMissionDefinitions`, not in the page: a partner account that labels its own
draft "Active" gets it queued for review anyway, which is safer than refusing the
request and losing what they typed.

Nothing is edited. Publishing always writes a new `definition_version` and
archives the previous live one, so instances already in flight keep being judged
by the rules they started under.

### The pre-flight

§10.1 asks three questions before publication, and `simulateMission` answers all
three:

| Question | Answer |
| --- | --- |
| How many people would see it? | A count over wallets matching the segment and the level gate |
| What could it cost at worst? | `min(audience × user_quota, global_quota) × LP per completion` |
| Is the money there? | The partner's deposit against the budget the campaign commits |

Every number is an upper bound rather than a forecast. Nobody can say how many
people will actually do a mission, but "this cannot cost more than X" is a fact
an approver can act on. The Publish button stays disabled until the simulation
has run, and a partner-funded campaign whose deposit does not cover it is refused
— at publication *and* again at approval, because both the audience and the
deposit move in between.

The area is not part of the audience count. We do not know where players are
between sessions, and inventing a location to filter on would make the estimate
look more precise than it is. A radius only ever narrows the real audience, so
the count stays an upper bound either way.

---

## Notifications

| Trigger | Category | Marketing? | Notes |
| --- | --- | :---: | --- |
| Urgent mission published | `missions` | yes | Eligibility re-checked per player at send time |
| A daily window opens | `missions` | no | Hourly job, deduped per mission per Manila day |
| Closing soon / one step left | `missions` | no | No pressure language — says what is left, not what is lost |
| Evidence approved or declined | `missions` | no | Transactional; carries the reason verbatim |
| Level up | `rewards` | no | Once per level, ever |
| Badge unlocked | `rewards` | no | Once per tier, ever |

Three rules apply to all of them, and are enforced in `sendPush` rather than at
each call site:

- **Quiet hours.** 22:00–08:00 Manila, published as economy configuration, and
  overridable per device — the check is per device because the setting is.
- **Marketing consent.** An urgent-mission announcement needs `marketing_enabled`
  on top of the mission category. "Your evidence was approved" does not. They are
  separate questions and the app asks them separately.
- **A frequency cap.** Three mission pushes per player per Manila day, counted on
  delivered messages, however many campaigns happen to launch.

Level-up and badge notifications are sent from the hook layer *after* the event
has committed, because those are exactly the grants that happen with the app
closed. Neither touches `announced_level` or `seen_at`, so the push tells the
player and the in-app celebration still runs when they next open it — once each.

---

## Anomaly detection

Seven detectors run nightly over yesterday and today.

| Detector | Looks for | Score |
| --- | --- | :---: |
| `ad_replay` | More verified rewarded ads in a day than a person watches | 4 |
| `lp_velocity` | More LP granted than the daily cap allows | 4 |
| `shared_device` | One device hash behind several wallets | 3 |
| `referral_ring` | A burst of referrals from one account | 3 |
| `qr_velocity` | An implausible number of redemptions | 2 |
| `review_velocity` | An implausible number of reviews | 2 |
| `proof_rejections` | Evidence turned down repeatedly in a week | 2 |

Every threshold is in the economy config and changeable without a deploy.

**A signal is a question, not a verdict.** Most have a dull answer — a family
sharing a phone, a genuinely busy weekend — so the observation that triggered one
is shown in full and every operator action takes a reason.

**A hold is not a punishment.** Past the configured score a wallet moves to
`Held` and its rewards are written `REVIEW_REQUIRED` instead of paid — the same
path an over-threshold single grant already takes. Nothing is taken and nothing
is lost. Silently dropping rewards a legitimate player earned is the failure
that produces support tickets nobody can answer.

The queue those land in is on the same screen. A held row carries zeroes in
`xp_amount` and `lp_centavos` precisely because nothing was paid, and
`reward_json` is the record of what is owed; approving pays *that*, applying the
daily LP cap as of the day the money actually moves rather than the day it was
earned. An approval takes a finance reference number, a refusal takes a reason,
and both write an audit row.

Signals are keyed `(detector, wallet, day)`, so a sweep that runs twice raises one
row and an operator's decision is not undone by the next pass. Tightening is
automatic; loosening is not — a detector going quiet is evidence that nothing
happened today, not that anything was resolved.

---

## Analytics

`/dashboard/gamification/analytics` answers §13's eight areas from the engine's
own tables. There is no separate analytics store, which is the point: the
dashboard and the ledger cannot disagree about what happened. Date ranges are
Manila days converted to UTC instants once, so "yesterday" is the same yesterday
on every panel. The mission funnel exports as CSV.

---

## Settlement

§6.2 asks the partner statement to separate five things, and
`partnerGamificationStatement` reports all five:

| Line | Billed? |
| --- | --- |
| Purchase accruals | yes — the existing net |
| Voucher use | yes — the existing net |
| Mission rewards (partner-funded) | memo |
| Achievement rewards (partner-funded) | memo |
| Level conversions | memo |
| Reversals and adjustments | memo |

**It reports them; it does not net them.** §1.2 says the monthly
partner-settlement policy stays as it is until a separate change is approved, so
what a partner pays is exactly what it was before this feature existed. Whether
the memo lines should move into the net is a finance decision, and this report is
what that decision needs to be made from. Both the billing page and a CSV export
label each line accordingly.
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

## Level-gated offers

§3.4 lets a partner put four restrictions on a campaign, and §3.2 is explicit
about how they must read: **a restriction is a goal, not a locked door.** So a
locked card carries the level it wants, the XP still to earn, and stays tappable
through to the campaign page.

| Column on `campaigns` | Meaning | Default |
| --- | --- | --- |
| `min_user_level` | Nobody below this may hunt it | 1 — open |
| `level_exclusive` | Hide it from those below, rather than showing it locked | off |
| `level_quota` | Extra hunts a day it grants a qualifying player, on top of their level's own allowance | 0 |
| `level_offer_label` | The partner's name for the offer | none |
| `early_access_at` | When it opens to everybody; a level's `early_access_minutes` is measured back from this | null — open now |

Every default is the behaviour that predates levels, so the columns changed no
campaign already written, and `early_access_at` is the first "opens at" this
product has had: without one there was no start for a head start to be ahead of.

The decision is `evaluateOfferGate` in `@bizflow/shared` — pure, and shared, so
the card the app draws and the refusal the server issues are the same function
rather than two that agree by inspection. It is enforced at `startHunt` *and* at
`generateCandidate`: the door and the draw, because the draw is what spends an
attempt, a tier's stock and a slot's capacity.

Three rules that are easy to get backwards:

- **The level is answered before the clock.** A player three levels short does
  not need to know the offer opens at six.
- **A head start is only for somebody the level already admits.** Early access
  to an offer you cannot hunt is not a benefit.
- **Only the level gate hides a campaign.** One that has not opened yet shows
  its opening time, because that is a countdown rather than a restriction.

Unrestricted campaigns cost nothing to evaluate: the gate returns early before
touching the database, and the public directory skips the ladder and level reads
entirely unless some campaign in it actually has rules. The directory is the
hottest public page in the product and it was not going to pay for a feature
almost no campaign uses.

---

## Feature switches and rollout

Every part of this can be stopped immediately and ramped gradually, from the
same versioned economy configuration as everything else — so switching missions
off at nine on a Friday is an operator publishing a version, with the audit
trail that comes with it, rather than a deploy.

| Switch | Covers |
| --- | --- |
| `levels` | The ladder, its benefits and the offer gates |
| `conversion` | LP → XP, on its own, because it is the one that moves a partner's liability |
| `missions` | Assignment, progress and payout |
| `achievements` | Counters and unlocks |
| `notifications` | Every push this feature sends |

Each carries a `rolloutPercent`. Membership is a stable hash of the wallet id
against the number, so **raising it only ever adds players** — a cohort that
reshuffled would take the feature away from somebody who had it yesterday, which
is worse than not rolling out at all. The feature name is mixed into the hash so
two features at 10% do not pick the same tenth of the userbase and make one
unlucky cohort look like a bad build. Notifications are a switch rather than a
ramp — 0 or 100, refused otherwise — because a push fan-out picks its audience
by query and a half-sent announcement is an unexplainable gap.

Two rules hold everywhere:

- **A flag gates earning and exposure, never a payout already earned.** A
  mission finished this morning still pays when claimed this afternoon.
  Concretely: the profile, the mission board, one mission's card and the
  achievement list all come back empty while their feature is off, and
  `join` — which takes a quota place and reserves partner budget — is refused
  with `E-FEATURE-DISABLED`. `claim` and `proof` stay open, because both
  finish something the player entered while the feature was running; proof
  approval writes `CLAIMABLE` and pays directly rather than through the rules
  engine, so that path completes even with the engine stopped. A read is
  answered empty rather than 503: pausing a feature should not read as a broken
  screen. The app reads the same flags off the profile and hides what is not
  running, so a paused feature is an absent section rather than a dead end.
- **Nothing is lost while a switch is off.** An event that arrives with the
  whole rules engine off is written `Deferred` rather than judged, and
  publishing an economy version — the only thing that can turn a feature back
  on — requeues it. Deferred rows are deliberately not swept by the ordinary
  retry pass: in creation order they would starve the events that can actually
  be processed.

The one case that is not deferred is a *half*-off configuration — missions off,
achievements on. That half is skipped for events arriving while it is off and
the row is finished, because retrying later would double-count the half that
already ran, and a counter counted twice is worse than a mission that did not
notice a redemption during a declared outage.

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
- Every feature on, at 100%

---

## Testing

```bash
npm run typecheck          # web + shared
npm run mobile:typecheck   # Expo app
npx vitest run tests/unit   # every gamification unit test runs without a database
npm run test:integration   # needs TEST_DATABASE_URL
```

The unit tests cover the pure logic and run anywhere: level thresholds
(including the exact-threshold and multi-level-jump cases the QA criteria name),
ladder validation, Manila boundaries across a full year, window/grace rules,
audience segments, quota arithmetic and the whole location-gate decision —
including the mocked-fix refusal and the accuracy tolerance at the boundary —
plus the offer gate (the level lock, the missing-XP figure, exclusivity, and
early access at both edges of the window) and the rollout hash, where the
property worth asserting is that raising a percentage never removes anybody.

`gamification-schema.test.ts` is a different kind of test and worth calling out.
The DDL in `db.ts` is executed on the first request a cold process serves, so a
statement that does not parse fails boot for the whole app, and nothing between
writing it and shipping it looks at it — the integration suite needs a Postgres
that is not available locally. So it reads the source as text and checks the
shape: balanced parentheses, no trailing comma before a bracket, no table or
index declared twice, every foreign key pointing at a table that exists, and
every new table present in `DATA_TABLES` and ordered before what it references.

The integration tests need Postgres and cover LP↔XP reconciliation, duplicate
taps, concurrent conversions, the daily reset, window crediting, the capstone
mission, one-unlock-per-tier, streaks, distinct-partner counting and backfill
idempotency; and for Phase 2 and 3, joinable-card exposure, level-gated cards,
both quota modes, quota release on expiry (exactly once), partner-scoped event
matching, the whole evidence lifecycle including supersession and cross-partner
refusal, the pre-flight bounds, the deposit refusal, and the separated partner
statement. `gamification-offer-gates.test.ts` covers the rest of the checklist's
§6 and §10: a level-gated campaign refused at both the door and the draw, an
exclusive one absent from the directory, a head start admitted before the
opening, the gate standing down when levels are switched off, a conversion
refused while the switch is off, an event deferred and requeued, and the
economy-version guard — including that a *successful* conversion still replays
after the terms move, because that retry describes something that already
happened.

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
- **Moving the memo settlement lines into the billed net.** Partner-funded
  mission rewards and level conversions are reported separately, as §6.2 asks,
  but what a partner pays is unchanged — §1.2 holds the settlement policy until
  a separate approval. The report exists so that decision can be made on
  numbers.
- **A dedicated review-submission flow for the Reviewer achievement.** The
  `review_verified` event, the counter and the mission trigger all work; nothing
  in the app yet writes a review, so the event has no producer.
- Everything the requirements list as out of scope: leaderboards, season passes,
  point gifting, cash withdrawal, a cross-partner unified balance.

### Needs a native build

`expo-image-picker` and `expo-location` are new dependencies with config
plugins. The Android project is generated (`android/` is gitignored), so a
prebuild picks them up — but the currently installed APK does not have them, and
evidence submission and location-gated missions will not work until the app is
rebuilt and reinstalled.
