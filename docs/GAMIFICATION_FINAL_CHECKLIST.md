# §17 Developer Final Checklist — Gamification Update

Answers to the ten questions in §17 of *Voucher Hunt Gamification Update*
(v1.0, 2026-08-27), each one checked against the code rather than against the
implementation notes in [GAMIFICATION.md](GAMIFICATION.md).

Verified 2026-09-03 on `main` at `8102bb5`.

| | Question | Verdict |
| :---: | --- | --- |
| 1 | LP and XP separate, separate ledgers | Pass |
| 2 | Conversions and reward grants atomic and idempotent | Pass |
| 3 | Economy values in versioned administrator configuration | Pass |
| 4 | Evaluations driven only by server events | Pass |
| 5 | Manila reset, windows and delayed events | Pass |
| 6 | Server validates minimum level, exclusive offers, quota, budget | **Partial** — offer-level gating missing |
| 7 | SSV, one-time QR, multi-account, duplicate, concurrency | Pass — SSV has no producer in the app yet |
| 8 | Settlement separates mission rewards from LP→XP conversions | Pass |
| 9 | Existing hunt→voucher→booking→QR→5% regression | **Unproven here** — needs a Postgres run |
| 10 | Everything stoppable and gradually rollable behind flags | **Gap** — per-mission only |

Two of the ten are not sign-off ready: the level gate does not reach partner
offers (§6) and there is no feature-flag layer above the individual mission
(§10). §9 is a matter of running the suite somewhere it can run. The rest hold.

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
([levels.ts:70](../src/server/gamification/levels.ts#L70)). `claimMission`
([missions.ts:864](../src/server/gamification/missions.ts#L864)) and `payMission`
([missions.ts:698](../src/server/gamification/missions.ts#L698)) do the same for
a state change and the reward it pays. `grantReward` takes the caller's open
transaction rather than opening its own, so nothing can commit a state change
without the grant beside it.

*Idempotent.* Enforced by unique constraints, not by care:
`user_xp_ledger` ([db.ts:600](../src/server/db.ts#L600)),
`point_xp_conversions` ([db.ts:617](../src/server/db.ts#L617)),
`reward_transactions` ([db.ts:773](../src/server/db.ts#L773)),
`hunt_ticket_ledger` ([db.ts:796](../src/server/db.ts#L796)) and
`gamification_events` ([db.ts:818](../src/server/db.ts#L818)) all carry
`idempotency_key TEXT NOT NULL UNIQUE`. A replayed conversion returns the
original result rather than an error
([levels.ts:76](../src/server/gamification/levels.ts#L76)), which is what §3.3
asks for on a duplicate tap.

## 3. Are all economy values and exposure conditions managed through administrator configuration and versions?

**Pass.**

`gamification_configs` and `level_definitions` are versioned rows
([db.ts:539](../src/server/db.ts#L539), [db.ts:558](../src/server/db.ts#L558));
`src/server/gamification/config.ts` seeds the §16 defaults as data and reads
them back, and every reward transaction records the `config_version` it ran
under. A live mission is never edited — publishing writes a new
`definition_version` and archives the previous one
([mission-admin.ts](../src/server/gamification/mission-admin.ts)) — so
in-flight instances keep the rules they started under, as §7.3 requires.
Risk thresholds are in the same versioned config rather than in code, so raising
one after a real campaign trips a detector is an operator action.

*One item outstanding.* §9.1 lists `CONFIG_VERSION_CHANGED`, and no code path
raises it. Nothing is wrong today — no client endpoint accepts a `configVersion`
from the caller, so there is no stale version to reject — but the code is
documented as supported and is not. Either implement the optimistic check on
`POST /levels/convert-points` or drop the code from the error list.

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

**Partial — the mission half is complete, the offer half does not exist.**

What holds:

- **Minimum level on missions.** `mission_definitions.min_level`
  ([db.ts:640](../src/server/db.ts#L640)), checked server-side, with the
  ineligible card carrying `LEVEL_REQUIRED` and the XP still to go.
- **Quota.** Both modes are a conditional `UPDATE`, never a read-then-write:
  `joined_count < global_quota` on join
  ([missions.ts:1011](../src/server/gamification/missions.ts#L1011)) and
  `completed_count < global_quota` on payout
  ([missions.ts:719](../src/server/gamification/missions.ts#L719)).
- **Budget.** A partner-funded mission past its campaign budget is refused and
  marked `REJECTED / BUDGET_EXHAUSTED`
  ([missions.ts:749](../src/server/gamification/missions.ts#L749)); the daily LP
  cap trims a payout and pays the shortfall in XP
  ([rewards.ts:357](../src/server/gamification/rewards.ts#L357)); a single grant
  over the review threshold is written `REVIEW_REQUIRED`
  ([rewards.ts:172](../src/server/gamification/rewards.ts#L172)); every debit
  carries `WHERE balance_centavos >= ?`.

What is missing: **§3.4's Partner CMS row is not implemented on offers.** The
`campaigns` table has no `min_user_level`, `level_exclusive`, `level_quota` or
`level_offer_label` column, and nothing in the hunt or voucher path consults a
player's level except the bonus-hunt allowance
([voucher-engine.ts:249](../src/server/voucher-engine.ts#L249)).
`level_definitions.early_access_minutes` is stored, seeded at 10/30 minutes and
editable in the Admin CMS ([db.ts:566](../src/server/db.ts#L566)) but is read by
nothing — it is a number on a screen. So today:

- a partner cannot restrict a campaign to Lv.3+, which is the §3.2 benefit for
  levels 3 through 5;
- early access is advertised to players in the level ladder and not honoured;
- the §3.4 "Locked Offer" screen — lock icon, required level, missing XP — has
  no data to render, because no offer is ever locked.

This does not affect any ledger, and levels remain correct. It is a scope hole
in the *benefits* of levelling, and it is the one thing on this list a player
would notice: the ladder promises access it does not currently grant. Closing it
is a column on `campaigns`, a check in the campaign read path and the eligibility
already written for missions, plus the locked-card state in the app.

## 7. Are AdMob SSV, one-time QR use, and protections against multiple accounts, duplicates, and concurrency implemented?

**Pass on the server. One deployment dependency.**

- **SSV.** ECDSA verification against Google's published keys over the callback's
  own query string, a signed short-lived nonce minted by
  `POST /ads/nonce`, and a unique `ad_transaction_id` as the replay guard
  ([ad-verification.ts](../src/server/gamification/ad-verification.ts),
  [db.ts:836](../src/server/db.ts#L836)). No client callback and no playback
  start is ever treated as a completion.
- **One-time QR.** Redemption is a conditional update —
  `UPDATE vouchers SET status='Redeemed' … WHERE id = ? AND status <> 'Redeemed'`
  ([voucher-engine.ts:1345](../src/server/voucher-engine.ts#L1345)) — so a second
  scan changes zero rows.
- **Multiple accounts.** Phone OTP identity, plus the `shared_device` detector
  over `device_id_hash` and a graduated hold that writes rewards
  `REVIEW_REQUIRED` rather than dropping them
  ([anomaly.ts:240](../src/server/gamification/anomaly.ts#L240)).
- **Duplicates and concurrency.** The unique keys in §2 above, `FOR UPDATE` on
  the XP row, and conditional updates everywhere a counter moves.

*Dependency.* Nothing in the Expo app requests a rewarded ad yet — no ad SDK is
installed and the AdMob app/unit ids do not exist. The three ad missions are
configured and pay correctly, but nothing can trigger them in production until
`react-native-google-mobile-ads` is added, `customData` from the nonce endpoint
is passed into the ad request and the SSV callback URL is set in AdMob.

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

**Not provable on this machine. Must be run before sign-off.**

The coverage exists: `tests/integration/voucher-flow.test.ts`,
`voucher-hardening.test.ts`, `hunt-resume.test.ts`,
`hunt-snapshot-consistency.test.ts`, `loyalty-points.test.ts` (5% accrual and
its idempotency, both the global pot and the partner bucket),
`lp-lifecycle.test.ts` (the ₱500 redemption unit and the monthly settlement),
`referral-flow.test.ts`, `transactions.test.ts` and `concurrency.test.ts`.

What ran here on 2026-09-03:

```
npm run typecheck                    clean
npx vitest run tests/unit            23 files / 220 tests passed
npx vitest run tests/unit/gamification-*   54 passed
```

The four failing unit files fail for one reason — *"Tests need TEST_DATABASE_URL
set to a PostgreSQL connection string of their own"* — and there is no local
Postgres. The whole integration suite is in the same position. **Run
`npm run test:integration` against a throwaway Postgres in CI or staging and
attach the output before this box is ticked.** Until then §9 is untested rather
than passing.

## 10. Can each feature be stopped immediately and rolled out gradually through feature flags?

**Gap. Stopping works at the mission level only, and there is no gradual rollout.**

What exists:

- A mission definition can be moved to `Stopped` immediately, without a deploy
  ([mission-admin.ts:512](../src/server/gamification/mission-admin.ts#L512)),
  and §10.1's choice about in-flight participants is recorded.
- Economy and level configuration are republished as new versions, so a value
  can be corrected in seconds.
- Mission audience segments target who sees one campaign.

What does not exist:

- No switch turns off the level system, LP→XP conversion, achievements, the
  anomaly sweep or gamification push as a whole. If conversion had to be halted
  tonight, the only levers are a code deploy or publishing an economy version
  with a hostile minimum — which is a workaround, not a control.
- No percentage or cohort rollout anywhere. A published mission is live for its
  whole audience at once. There is no way to give levels to 5% of wallets first,
  which is what §15's "safe phased rollout" describes.

Cheapest honest fix, and it needs no new infrastructure: the economy config is
already versioned, admin-publishable and read on every path, so add a `features`
block to it — `{ levels, conversion, missions, achievements, notifications }` —
plus a `rolloutPercent` keyed on a stable hash of the wallet id, and check both
in `profile.ts` and at the top of each hook in `hooks.ts`. That gives an instant
stop and a graduated ramp through the screen operations already use, with the
version history as the audit trail.

Two rules matter in the implementation: a flag must gate *earning and exposure*,
never a payout that was already earned — a disabled feature must not swallow a
grant a player is owed — and a wallet inside the rollout must stay inside it
when the percentage moves, which is what hashing the wallet id rather than
sampling gives you.

---

## Before sign-off

1. Run `npm run test:integration` against a real Postgres and attach the result (§9).
2. Decide on offer-level gating: implement `min_user_level` / `level_exclusive` /
   early access on `campaigns`, or remove the promise from the level ladder copy
   so the app stops advertising a benefit it does not deliver (§6).
3. Add the config-driven feature block and rollout percentage (§10).
4. Either implement `CONFIG_VERSION_CHANGED` or drop it from the documented
   error list (§3).
5. Finish the rewarded-ad client: SDK, AdMob ids, `customData`, SSV callback URL (§7).
6. Rebuild the native app — `expo-image-picker` and `expo-location` are new
   config-plugin dependencies, so evidence submission and location-gated
   missions do not work on the currently installed APK.
