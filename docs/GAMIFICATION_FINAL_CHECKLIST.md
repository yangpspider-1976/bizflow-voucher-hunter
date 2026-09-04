# §17 Developer Final Checklist — Gamification Update

Answers to the ten questions in §17 of *Voucher Hunt Gamification Update*
(v1.0, 2026-08-27), each one checked against the code rather than against the
implementation notes in [GAMIFICATION.md](GAMIFICATION.md).

Verified 2026-09-03, re-checked 2026-09-04. The first pass at `8102bb5` found
three questions unanswered; the second found question 10 answered only halfway.
The work that closed each is described under it.

| | Question | Verdict |
| :---: | --- | --- |
| 1 | LP and XP separate, separate ledgers | Pass |
| 2 | Conversions and reward grants atomic and idempotent | Pass |
| 3 | Economy values in versioned administrator configuration | Pass |
| 4 | Evaluations driven only by server events | Pass |
| 5 | Manila reset, windows and delayed events | Pass |
| 6 | Server validates minimum level, exclusive offers, quota, budget | Pass |
| 7 | SSV, one-time QR, multi-account, duplicate, concurrency | Pass — the ad client is a deployment dependency |
| 8 | Settlement separates mission rewards from LP→XP conversions | Pass |
| 9 | Existing hunt→voucher→booking→QR→5% regression | **Needs a CI run** |
| 10 | Everything stoppable and gradually rollable behind flags | Pass — the exposure half was added on the second pass |

Nine of the ten are answered in code. §9 is the exception and cannot be answered
from this machine: the regression suite needs a PostgreSQL instance, there is
none here, and no amount of reading the tests substitutes for running them.
**Run `npm run test:integration` in CI before sign-off.**

---

## 1. Are LP and XP implemented with separate meanings and separate ledgers?

**Pass.**

They are different columns in different tables and neither is derived from the
other. LP lives in `reward_wallets` / `reward_business_balances` with
`reward_ledger_entries` behind it, in centavos ([db.ts:358](../src/server/db.ts#L358),
[db.ts:406](../src/server/db.ts#L406)). XP lives in `user_levels.lifetime_xp`
with the immutable `user_xp_ledger` behind it, as whole integers
([db.ts:573](../src/server/db.ts#L573), [db.ts:585](../src/server/db.ts#L585)).

The level is computed from `lifetime_xp` and never from a wallet balance, so
spending LP cannot cost a player a level — `levelForXp` in
`packages/shared/src/gamification.ts` is the single calculation and
[gamification-levels.test.ts](../tests/unit/gamification-levels.test.ts) covers
the exact-threshold and multi-level-jump cases §14 names.

`point_xp_conversions` ([db.ts:606](../src/server/db.ts#L606)) is the only row
that joins the two, and it stores `merchant_id` and both ledger ids so the
extinguished LP liability can be traced from the partner side.

## 2. Are point conversions, mission rewards, and achievement rewards atomic and idempotent?

**Pass.**

*Atomic.* `convertPointsToXp` opens one `withTx` and does wallet lock → LP debit
→ XP credit → level recalculation inside it
([levels.ts](../src/server/gamification/levels.ts)). `claimMission` and
`payMission` do the same for a state change and the reward it pays
([missions.ts](../src/server/gamification/missions.ts)). `grantReward` takes the
caller's open transaction rather than opening its own, so nothing can commit a
state change without the grant beside it.

*Idempotent.* Enforced by unique constraints, not by care:
`user_xp_ledger` ([db.ts:600](../src/server/db.ts#L600)),
`point_xp_conversions` ([db.ts:617](../src/server/db.ts#L617)),
`reward_transactions` ([db.ts:773](../src/server/db.ts#L773)),
`hunt_ticket_ledger` ([db.ts:796](../src/server/db.ts#L796)) and
`gamification_events` ([db.ts:818](../src/server/db.ts#L818)) all carry
`idempotency_key TEXT NOT NULL UNIQUE`. A replayed conversion returns the
original result rather than an error, which is what §3.3 asks for on a duplicate
tap — and it still does so after the terms change, because that retry describes
a conversion that already happened under the old ones.

## 3. Are all economy values and exposure conditions managed through administrator configuration and versions?

**Pass.**

`gamification_configs` and `level_definitions` are versioned rows
([db.ts:539](../src/server/db.ts#L539), [db.ts:558](../src/server/db.ts#L558));
`src/server/gamification/config.ts` seeds the §16 defaults as data and reads
them back, and every reward transaction records the `config_version` it ran
under. A live mission is never edited — publishing writes a new
`definition_version` and archives the previous one — so in-flight instances keep
the rules they started under, as §7.3 requires. Risk thresholds and the feature
switches added for §10 are in the same versioned config rather than in code.

*Closed since the first pass.* §9.1's `CONFIG_VERSION_CHANGED` was documented
and raised nowhere. `GET /levels` now returns the `economyVersion` its terms
were quoted under, `POST /levels/convert-points` accepts it back as
`expectedConfigVersion`, and a conversion against terms that have since moved is
refused with `E-CONFIG-VERSION-CHANGED` (409) rather than silently repriced. The
field is optional, so an older client behaves exactly as before, and the replay
path is checked *first* — a retry of a conversion that already succeeded returns
its original result whatever the live version says.

## 4. Are level, mission, and achievement evaluations based only on server events?

**Pass.**

The client cannot assert that it did anything. `POST /api/internal/gamification/events`
is behind `assertCronAuth` and is explicitly not reachable with a customer
session ([route.ts](../src/app/api/internal/gamification/events/route.ts)); the
public surface has no progress-reporting endpoint at all — `join`, `proof`,
`claim` and `seen` are the only writes, and each one is judged against server
state. Ad rewards enter only through Google's SSV callback. Every product
trigger goes through one call to `hooks.ts` after its own transaction commits.

## 5. Are Asia/Manila reset, time-window, and delayed-event rules applied?

**Pass.**

`time.ts` does fixed-offset UTC+8 arithmetic for day boundaries and mission
windows while raw timestamps stay UTC.
[gamification-time.test.ts](../tests/unit/gamification-time.test.ts) asserts the
boundary across all 365 days of a year — 13 tests, passing. Windows are judged
by `occurred_at` with 15 minutes of grace, so an ad watched at 10:58 and
verified at 11:02 still credits the morning mission, which is the §7.3 rule.
There is no midnight job: a daily mission is one row per player per Manila date,
created on first read or first action.

## 6. Does the server validate partner minimum level, exclusive offers, quota, and budget?

**Pass.** The mission half already held; the offer half did not exist and now
does.

**Missions** — unchanged and already correct: `mission_definitions.min_level`
([db.ts:640](../src/server/db.ts#L640)); both quota modes as a conditional
`UPDATE`, never a read-then-write (`joined_count < global_quota` on join,
`completed_count < global_quota` on payout); a partner-funded mission past its
budget refused as `REJECTED / BUDGET_EXHAUSTED`; the daily LP cap trimming a
payout and paying the shortfall in XP; a single grant over the review threshold
written `REVIEW_REQUIRED`; and `WHERE balance_centavos >= ?` on every debit.

**Offers** — new. §3.4's Partner CMS row now exists on `campaigns` as
`min_user_level`, `level_exclusive`, `level_quota`, `level_offer_label` and
`early_access_at`, every default being the unrestricted behaviour that predates
levels, so no campaign already written changed.

| Rule | What the server does |
| --- | --- |
| `min_user_level` | Refuses with `E-LEVEL-REQUIRED` (403) at **both** `startHunt` and `generateCandidate` — the door and the draw, because the draw is what spends an attempt, a tier's stock and a slot's capacity |
| `level_exclusive` | Drops the campaign from the viewer's directory instead of showing it locked; off by default, because §3.2 wants a restriction to read as a goal |
| `early_access_at` | Refuses with `E-OFFER-NOT-OPEN` (409) until the offer opens, less the head start the viewer's level carries — this is the first "opens at" the product has had, and without it `early_access_minutes` had no start to be ahead of |
| `level_quota` | Added to the player's own daily allowance, through the existing `level_bonus` attempt source, so the three hunt sources stay separately counted as §1.2 asks |

The decision is one pure function, `evaluateOfferGate` in `@bizflow/shared`, so
the card the app draws and the refusal the server issues cannot drift apart. A
locked card carries the required level and the XP still to earn, in the app's
four languages, and stays tappable through to the campaign page — §3.2's "do not
hide level access restrictions", answered with a goal rather than a dead end.

Two ordering rules are load-bearing and easy to get backwards: the level is
answered before the clock (a player three levels short does not need the opening
time), and a head start is only granted to somebody the level gate already
admits (early access to an offer you cannot hunt is not a benefit).

Cost was watched: an unrestricted campaign returns from the gate before touching
the database, and the public directory skips the ladder and level reads entirely
unless some campaign in the list actually has rules.

Covered by [gamification-offers.test.ts](../tests/unit/gamification-offers.test.ts)
(17 tests, run locally) and the server half of
[gamification-offer-gates.test.ts](../tests/integration/gamification-offer-gates.test.ts),
which needs Postgres.

## 7. Are AdMob SSV, one-time QR use, and protections against multiple accounts, duplicates, and concurrency implemented?

**Pass on the server. One deployment dependency.**

- **SSV.** ECDSA verification against Google's published keys over the callback's
  own query string, a signed short-lived nonce, and a unique `ad_transaction_id`
  as the replay guard ([ad-verification.ts](../src/server/gamification/ad-verification.ts),
  [db.ts:836](../src/server/db.ts#L836)). No client callback and no playback
  start is ever treated as a completion.
- **One-time QR.** Redemption is a conditional update —
  `UPDATE vouchers SET status='Redeemed' … WHERE id = ? AND status <> 'Redeemed'`
  ([voucher-engine.ts:1345](../src/server/voucher-engine.ts#L1345)) — so a second
  scan changes zero rows.
- **Multiple accounts.** Phone OTP identity, plus the `shared_device` detector
  over `device_id_hash` and a graduated hold that writes rewards
  `REVIEW_REQUIRED` rather than dropping them
  ([anomaly.ts](../src/server/gamification/anomaly.ts)).
- **Duplicates and concurrency.** The unique keys in §2 above, `FOR UPDATE` on
  the XP row, and conditional updates everywhere a counter moves.

*Dependency, unchanged and outside this codebase.* Nothing in the Expo app
requests a rewarded ad yet — no ad SDK is installed and the AdMob app/unit ids do
not exist. The three ad missions are configured and pay correctly, but nothing
can trigger them in production until `react-native-google-mobile-ads` is added,
`customData` from the nonce endpoint is passed into the ad request, and the SSV
callback URL is set in the AdMob console. That needs an AdMob account, not a
code change.

## 8. Does the settlement report separate mission rewards from LP→XP conversions?

**Pass.**

`partnerGamificationStatement` returns six labelled lines — purchase accruals
and voucher use billed, mission rewards, achievement rewards, level conversions
and reversals/adjustments as memo
([settlement.ts:115](../src/server/gamification/settlement.ts#L115)) — with a
billed total and a separate memo total, on the billing page and in the CSV
export. It reports; it does not net, because §1.2 holds the monthly settlement
policy until a separate approval. Whether the memo lines should move into the
net is a finance decision, and this report is what it would be made from.

## 9. Has the existing hunt→voucher→booking→QR→5% accrual flow passed regression testing?

**Not provable on this machine. The one box that stays open.**

The coverage exists: `tests/integration/voucher-flow.test.ts`,
`voucher-hardening.test.ts`, `hunt-resume.test.ts`,
`hunt-snapshot-consistency.test.ts`, `loyalty-points.test.ts` (5% accrual and
its idempotency, both the global pot and the partner bucket),
`lp-lifecycle.test.ts` (the ₱500 redemption unit and the monthly settlement),
`referral-flow.test.ts`, `transactions.test.ts` and `concurrency.test.ts`.

What ran here after the changes above:

```
npm run typecheck            clean
npm run mobile:typecheck     clean
npx vitest run tests/unit    25 files / 248 tests passed
```

The four failing unit files fail for one reason — *"Tests need TEST_DATABASE_URL
set to a PostgreSQL connection string of their own"* — and there is no local
Postgres. The whole integration suite is in the same position, including the new
`gamification-offer-gates.test.ts`, which has therefore never been executed.

This matters more than it did before this round of work, because §6 put a new
check inside `startHunt` and `generateCandidate` — the hunt flow, which is the
part of this system that has been got wrong by reasoning alone before. The check
is designed to be inert on an unconfigured campaign and every seeded campaign is
unconfigured, so the regression suite should be unaffected; **that is a
prediction, and the suite is what turns it into a fact.** Run it.

## 10. Can each feature be stopped immediately and rolled out gradually through feature flags?

**Pass.**

Five switches now live in the versioned economy configuration —
`levels`, `conversion`, `missions`, `achievements`, `notifications` — each with
an `enabled` flag and a `rolloutPercent`, published from
`/dashboard/gamification` like every other economy value, with no deploy and
with the version history as the audit trail
([flags.ts](../src/server/gamification/flags.ts),
[config.ts](../src/server/gamification/config.ts)).

`conversion` is split from `levels` deliberately: it is the one that moves a
partner's liability, and it is the most likely thing to need stopping while
everything else keeps running.

Membership in a partial rollout is a stable hash of the wallet id against the
percentage, so **raising the number only ever adds players**. A cohort that
reshuffled between reads would take the feature away from somebody who had it
yesterday, which is worse than not rolling out at all; the property is asserted
across a ramp of 0 → 5 → 10 → 25 → 50 → 75 → 100 in
[gamification-flags.test.ts](../tests/unit/gamification-flags.test.ts). The
feature name is mixed into the hash so two features at 10% do not pick the same
tenth of the userbase and make one unlucky cohort look like a bad build.
Notifications are a switch rather than a ramp — 0 or 100, refused otherwise —
because a fan-out picks its audience by query and a half-sent announcement is a
silent, unexplainable gap in who heard about a campaign.

Two rules are enforced rather than documented:

- **A flag gates earning and exposure, never a payout already earned.** A
  mission finished this morning still pays when it is claimed this afternoon.
- **Nothing is lost while a switch is off.** An event arriving with the rules
  engine off is written `Deferred` instead of judged, and publishing an economy
  version — the only thing that can turn a feature back on — requeues it.
  Deferred rows are deliberately excluded from the ordinary retry sweep, which
  reads in creation order and would otherwise starve the events that can
  actually be processed.

The one case that is not deferred is a half-off configuration — missions off,
achievements on. That half is skipped for events arriving while it is off and
the row is finished, because replaying later would double-count the half that
already ran. A counter counted twice is a worse outcome than a mission that did
not notice a redemption during an outage the operator declared.

*Closed since the second pass.* The switches stopped **earning** but not
**exposure or entry**, which is half a stop. `gamificationProfile` honoured the
flags from the start — missions and achievements came back empty — but it is not
the only door into either, and the others were left open:

| Surface | Before | Now |
| --- | --- | --- |
| `GET /missions` | Full board, and it assigned today's rows | Empty, and assigns nothing |
| `GET /missions/{key}` | The card, and it assigned today's rows | `MISSION_NOT_ACTIVE` (404) |
| `POST /missions/{key}/join` | Joined: took a quota place, reserved partner budget | `FEATURE_DISABLED` (503) |
| `GET /achievements` | Full board, every bar frozen where it stood | Empty |

The worst of these was the disagreement rather than any one endpoint. The
profile said `missions: false, missions: []` while the board beside it returned
a full set the player could work through and never be credited for, because the
rules engine had already stopped judging the events. Two endpoints disagreeing
about one flag is worse than no flag: the disagreement is invisible until
somebody acts on the half that is still open.

The dividing line, applied deliberately rather than by which file was edited:

- **Exposure and entry are gated.** Joining is entry — it takes a quota place
  and reserves partner budget — so it is refused, and the guard sits inside
  `joinMission` rather than in the route, where no future caller can miss it.
- **Anything already entered runs to completion.** `claim` and `proof` stay
  open. A player who joined while the feature was running, did the work and came
  back to a stopped feature is owed their reward, and proof approval writes
  `CLAIMABLE` and pays directly rather than through the rules engine, so that
  path genuinely finishes while the engine is off.
- **A read comes back empty, not forbidden.** A 503 on the board would turn an
  operator pausing a feature into a broken screen. Empty is what the app already
  knows how to draw.

*And the client half, which did not exist.* `GamificationProfile.features` was
computed, returned, and read by nobody — its own doc comment promised the app
"uses them to decide what to draw", and no screen did. Pausing missions left the
quests tab showing an empty board with no explanation, and the level-up screen
took a player through picking a pot and an amount before the server refused the
conversion. The app now reads `features` and hides what is not running: the
level card, the mission tabs and list (replaced by a plain "paused, nothing you
earned is affected" line), the achievements section, and the conversion entry
point. `level-up` says the same at the door, because it is reachable by deep
link after the entry point is gone. Copy is keyed in all four languages, and a
server too old to send the field falls back to `ALL_FEATURES_ON` — nothing
switched off is nothing to hide.

Covered by the four `stopping a feature` cases in
[gamification-campaign-routes.test.ts](../tests/integration/gamification-campaign-routes.test.ts),
which assert the board empties, the two endpoints agree, a join is refused with
nothing written, the achievement board empties, and the board comes back when
the switch does. They need Postgres.

Per-mission stopping is unchanged and still there: a definition moves to
`Stopped` immediately, and §10.1's choice about in-flight participants is
recorded.

---

## Before sign-off

1. **Run `npm run test:integration` against a real Postgres and attach the
   result.** This is the only outstanding item, and it now covers new code in
   the hunt path (§6) and the feature switches (§10). What ran locally after the
   second pass: `npm run typecheck` clean, `npm run mobile:typecheck` clean,
   `npx vitest run tests/unit` 25 files / 248 tests passed — the same four
   files as before fail only for want of `TEST_DATABASE_URL`.
2. Finish the rewarded-ad client — SDK, AdMob ids, `customData`, SSV callback
   URL. External dependency; nothing in this repository blocks it.
3. Rebuild the native app: `expo-image-picker` and `expo-location` are
   config-plugin dependencies the installed APK does not have, so evidence
   submission and location-gated missions will not work until it is rebuilt.

## Deliberately not done

- **The public marketing page does not draw a lock.** `/` is the business
  landing page — customer traffic goes to the app — so its campaign grid gets
  the anonymous gate: exclusive offers are absent, level-gated ones are listed
  without a lock badge. The server still refuses the hunt. Adding the badge is
  cosmetic and belongs with any future work on that page.
- **Moving the memo settlement lines into the billed net**, which §1.2 holds
  until a separate approval.
