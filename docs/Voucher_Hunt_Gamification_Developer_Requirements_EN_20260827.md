**PRODUCT & SYSTEM REQUIREMENTS**

**Voucher Hunt Gamification Update**

Leveling · Daily/Urgent Missions · Achievements — Functional and Technical Specification for Development

| Item | Details |
| :---: | ----- |
| Document Version | v1.0 / 2026-08-27 |
| Audience | Mobile app, backend, Admin CMS, QA, data, and marketing teams |
| Purpose | Add repeat-engagement and progression incentives to the existing voucher, booking, QR, and loyalty-point flow |
| Reference Time Zone | Asia/Manila (UTC+8); store server timestamps in UTC and use Manila time for display and resets |

| Recommended Core Structure  Separate Loyalty Points (LP) from Level Experience Points (XP). LP is a spendable reward balance, while XP is a cumulative progression metric with no cash value. When a user commits LP to leveling, the LP is debited and XP is credited within the same transaction. |
| :---- |

# **1\. Update Goals and Core Scope**

This update turns a simple discount app into a service that users visit daily and progress through over time. Levels determine eligibility and benefits, missions drive short-term actions, and achievements recognize long-term cumulative activity.

## **1.1 Included in This Development**

* A level system in which users earn XP by spending LP or through mission and achievement rewards

* Time-windowed daily missions and partner-operated urgent missions

* An achievement system that converts cumulative activity into tiered badges and rewards

* A centralized reward engine, ledgers, event processing, Admin CMS, notifications, anti-abuse controls, and analytics

* Achievement backfill based on historical activity and a safe phased rollout

## **1.2 Existing Policies to Preserve**

* Partner stores receive customer payments directly. Voucher Hunt handles QR verification, purchase-amount records, point calculation, and voucher issuance.

* Retain the existing loyalty policy that calculates purchase rewards as 5% of the verified payment amount.

* LP cannot be purchased, transferred, converted to cash, or withdrawn. The initial release retains partner-specific closed-loop balances; a unified cash-like wallet is out of scope.

* Retain the current ₱500 reward-redemption unit and monthly partner-settlement policy until a separate change is approved.

* Retain three base hunts plus up to two share-bonus hunts (five total per day), and add level-bonus hunts as a separate field.

| Out of Scope  Leaderboards, season passes, user-to-user point gifting, point cash withdrawal, and a cross-partner unified payment balance are excluded from the first release. |
| :---- |

# **2\. Common Terms and System Principles**

| Term | Definition | Development Principle |
| ----- | ----- | ----- |
| LP | Loyalty Point balance | Partner-specific ledger; process debits, credits, and cancellations with reversing entries rather than edits |
| XP | Cumulative experience used to determine level | No cash value, transfer, or withdrawal; does not decrease through normal activity |
| Level | User tier based on cumulative XP ranges | Automatic promotion; benefits are server-determined; recalculation is allowed only after an abuse-related reversal |
| Mission | An action completed within a defined period and set of conditions | Event-driven progress; separate completion from reward issuance |
| Urgent Mission | A short-term campaign targeting a specific partner, area, time, or quantity | Validate inventory, budget, eligibility, and minimum level on the server |
| Achievement | A permanent accomplishment unlocked at a cumulative-activity threshold | One reward per tier; historical backfill is supported |
| Reward Transaction | Record of an LP, XP, hunt ticket, voucher, or badge grant or reversal | idempotency\_key and audit log are required |

## **2.1 Non-Negotiable Rules**

* The client must not make final decisions about balances, XP, or completion. All authoritative decisions are made by the server.

* Process LP debit plus XP credit, and mission reward issuance plus state change, within their respective single database transactions.

* Guarantee idempotency so retransmitted events, ad callbacks, QR uses, and reward requests are applied only once.

* Do not hard-code economy values; manage them through versioned administrator configuration.

* Use Asia/Manila for daily resets, time windows, and push exposure, while storing raw timestamps in UTC.

# **3\. Leveling System**

## **3.1 Recommended Calculation Model**

Calculate the current level from lifetime\_xp, not the current LP balance. Spending points does not reduce a legitimately earned level; LP used for leveling is converted into separately accumulated XP.

| XP Earning Path | Server Processing | Default / Notes |
| ----- | ----- | ----- |
| Use LP for leveling | Debit LP from the selected partner wallet → credit XP → recalculate level | Default 1 LP \= 1 XP; minimum 50 LP; administrator-configurable |
| Daily/Urgent Missions | Validate condition event → complete → issue reward | XP-first; LP, hunt tickets, and vouchers may be granted in parallel |
| Achievement | Reach cumulative counter threshold → unlock badge → grant reward | Once per tier; XP by default, LP only with budget approval |
| Administrative Adjustment | Adjustment ledger with reason, approver, and reference number | For customer support and abuse recovery only |

| Settlement Note  Converting partner-specific LP to XP extinguishes the corresponding LP liability. Store merchant\_id and conversion\_transaction\_id in the partner ledger and report the transaction separately as a 'Level Conversion' item in the monthly settlement report. |
| :---- |

## **3.2 Recommended Five-Level Structure**

The values below are recommended MVP defaults and must be version-configurable in the Admin CMS. A level must not automatically increase the discount rate; partners configure min\_level and level\_offer instead.

| Level | Cumulative XP | Display Name | Recommended Benefits | Level Bonus Hunts |
| :---: | :---: | :---: | ----- | :---: |
| Lv.1 | 0 | Explorer | Access to public vouchers and daily missions | \+0 |
| Lv.2 | 500 | Hunter | Level-exclusive urgent missions and 10-minute early access to selected offers | \+0 |
| Lv.3 | 1,500 | Pro Hunter | Access to level-exclusive partners and offers | \+1/day |
| Lv.4 | 3,500 | Elite Hunter | Premium offers, 30-minute early access, and level-based booking quotas | \+1/day |
| Lv.5 | 7,000 | Royal Hunter | Invitation-only offers, premium restaurants, and VIP urgent missions | \+2/day |

Do not hide level access restrictions. Locked partners and vouchers must show a lock icon, required level, current XP, and remaining XP to unlock, turning the restriction into a progression goal.

## **3.3 LP → XP Conversion User Flow**

1\.  On the profile's 'Level Up' screen, show the current level, next level, available LP, and required XP.

2\.  The user selects the partner wallet and LP amount (50/100/500 or custom input) to use.

3\.  The confirmation screen shows LP to be debited, XP to be earned, expected level, non-cancellability, and no-cash-value notice.

4\.  The server atomically performs balance locking → LP debit ledger → XP credit ledger → level recalculation → event publication.

5\.  On success, return the result and ledger IDs; if the user was promoted, show the level-up animation and newly unlocked benefits.

| Exception | Required Behavior |
| ----- | ----- |
| Insufficient / Expired Balance | Reject conversion; return the latest balance and spendable amount |
| Duplicate Tap / Network Retry | Return the existing successful result for the same idempotency\_key |
| Concurrent Voucher Use | Prevent excess debit using wallet-row locking or serialization |
| Abuse Reversal | Create reversing LP/XP ledger entries without deleting history, then recalculate the level |
| Configuration Change | Store the economy\_config\_version active when the conversion started |

## **3.4 App Screens and Partner Settings**

| Screen / Feature | Required Display / Input |
| ----- | ----- |
| Home Level Card | Level name, badge, XP progress bar, next key benefit, and mission shortcut |
| Level Details | All levels, required XP, locked/unlocked benefits, and partners by level |
| LP Conversion | Balance by partner wallet, conversion amount, expected XP/level, and double confirmation |
| Locked Offer | Required level, missing XP, and links to related missions/leveling |
| Partner CMS | min\_user\_level, level\_exclusive, early\_access\_minutes, level\_quota, level\_offer\_label |

# **4\. Mission System**

## **4.1 Common Mission Lifecycle**

States progress in the order LOCKED → AVAILABLE → IN\_PROGRESS → VERIFYING (optional) → CLAIMABLE → CLAIMED. EXPIRED, REJECTED, and CANCELLED are terminal states. Auto-reward missions may skip CLAIMABLE, but the transition must still be recorded.

| Configuration Field | Details |
| ----- | ----- |
| Identity / Version | mission\_id, definition\_version, campaign\_id, partner\_id |
| Classification | DAILY / URGENT / ONBOARDING / PARTNER; category and tags |
| Audience | All users / segment / area / minimum level / new, dormant, and returning users |
| Schedule | start\_at, end\_at, daily\_window, reset\_timezone, grace\_period |
| Condition | trigger\_event, target\_count, unique\_rule, amount\_rule, proof\_rule |
| Quota / Budget | global\_quota, user\_quota, partner\_budget, reward\_budget, reservation\_rule |
| Reward | XP, LP, hunt\_ticket, voucher, badge; funded by PLATFORM/PARTNER |
| Operations | priority, status, exposure\_channel, localization\_key, terms\_url |

## **4.2 Daily Missions — Recommended Default Set**

Finalize reward values after simulating ad revenue and point utilization. During development, seed the values below as initial configuration data and allow administrators to change them immediately.

| Mission | Time / Condition | Verification Event | Sample Reward | Daily Limit |
| ----- | :---: | :---: | :---: | :---: |
| Watch Morning Ad | 06:00–10:59 | ad\_reward\_verified | 5 LP \+ 10 XP | Once |
| Watch Lunch Ad | 11:00–14:59 | ad\_reward\_verified | 5 LP \+ 10 XP | Once |
| Watch Evening Ad | 17:00–21:59 | ad\_reward\_verified | 5 LP \+ 10 XP | Once |
| Complete Voucher Hunt | Hunt result finalized | hunt\_complete | 10 XP | Once |
| Select Voucher | Voucher issued after hunt | voucher\_select | 10 XP | Once |
| Visit and Use QR | Valid booking/voucher QR | qr\_redeem | 5 LP \+ 20 XP | Once |
| Complete Four Missions Today | Four distinct daily missions | mission\_completed | 30 XP | Once |

| Ad Verification  Recognize only AdMob Server-Side Verification (SSV) or another server-verifiable completion callback as a reward event—not ad playback start or a client callback. |
| :---- |

## **4.3 Urgent Missions**

| Type | Example Condition | Verification Method | Operational Rule |
| ----- | ----- | ----- | ----- |
| Partner Promotion | Participate in a designated menu or event | Booking \+ QR \+ payment confirmation | Partner budget, total quota, once per user |
| Off-Peak Visit | Visit weekdays 14:00–17:00 | Booking slot \+ QR | Show only during low-demand hours |
| Explore New Partner | First-time store visit | unique\_partner \+ QR | Exclude prior visit history |
| Visit Review | Submit a review after QR use | review\_verified | Do not require positive reviews or ratings |
| Level-Restricted | Lv.3+ only | user\_level snapshot | Show locked state and required XP |
| Local Flash | Defined radius and short time window | Server time \+ optional location | Location consent, accuracy tolerance, and quota-reservation rules |

### **4.4 Urgent Mission Creation and Participation Flow**

1\.  The partner or operator enters the audience, schedule, conditions, minimum level, total quota, and reward budget.

2\.  After administrator approval, expose the mission only to eligible users at the scheduled time and optionally send a push notification.

3\.  Use mission.quota\_mode to determine whether quota is reserved when a user joins or decremented upon completion.

4\.  Move the mission to CLAIMABLE after automatic event verification or review of receipt, photo, or review evidence.

5\.  Process reward issuance and campaign-budget debit in one transaction and reflect both in the partner report.

## **4.5 Mission App Screens**

| Screen | Requirements |
| ----- | ----- |
| Mission Home | Daily/Urgent tabs, today's progress, next reset time, and total claimable rewards |
| Mission Card | Title, reward, progress, time remaining, minimum level, partner, and join/completion status |
| Mission Details | Instructions, verification criteria, terms, location, inventory, and failure/rejection reason |
| Evidence Submission | Photo/receipt/text, upload progress, privacy notice, and resubmission availability |
| Completion / Reward | Automatic issuance or Claim button, ledger details, and streak/achievement progress |

# **5\. Achievement System**

Achievements accumulate without a daily reset. Within each achievement group, Bronze → Silver → Gold → Royal tiers unlock independently. Badges are permanent, and each tier reward is granted only once.

## **5.1 Recommended Achievement Groups and Thresholds**

| Achievement Group | Counter Basis | Bronze | Silver | Gold | Royal |
| ----- | ----- | :---: | :---: | :---: | :---: |
| Hunt Master | hunt\_complete | 1 | 10 | 50 | 200 |
| Voucher User | Valid qr\_redeem events | 1 | 5 | 20 | 50 |
| Mission Specialist | mission\_completed | 7 | 30 | 100 | 300 |
| Daily Streak | Consecutive days completing daily missions | 3 days | 7 days | 14 days | 30 days |
| Reviewer | Verified reviews submitted after QR use | 1 | 5 | 20 | 50 |
| Connector | referral\_verified | 1 | 5 | 20 | 50 |
| City Explorer | QR uses at distinct partners | 3 | 10 | 25 | 50 |
| Level Investor | Cumulative LP→XP conversion amount | 100 | 500 | 2,000 | 5,000 |

The default reward consists of a badge \+ XP. Allow LP, hunt tickets, and special vouchers to be selected in the reward\_type array, and prevent reward-generated events from incrementing the same achievement counter recursively.

## **5.2 Evaluation, Backfill, and Reversal Rules**

* Accumulate achievement counters in user\_achievement\_progress instead of recounting raw events on every request, while retaining source events for recalculation.

* At release, backfill from historical hunt\_complete, voucher\_select, booking\_complete, qr\_redeem, referral\_verified, credit\_earned, and credit\_redeemed events.

* Make backfill jobs user-batched, restartable, and idempotent, and store backfill\_job\_id.

* Unlock achievements and grant rewards automatically. The app must show a celebration screen and completed issuance details so unclaimed rewards do not create support requests.

* Adjust counters with reversing events for cancelled payments, fraudulent reviews, and abusive referrals. Previously unlocked badges may be retained or revoked according to policy, but revocation requires an administrator reason.

## **5.3 Achievement Screens**

| Element | Displayed Information |
| ----- | ----- |
| Achievement Summary | Unlocked badge count, recent unlocks, and next achievable milestones |
| Category Filter | Hunt / Visit / Mission / Streak / Review / Referral / Explore / Points |
| Achievement Card | Badge, tier, current/target, reward, unlock date, and lock condition |
| Achievement Details | Thresholds by tier, historical completion dates, and progress to the next tier |
| Profile Badges | Select 1–3 featured badges; sharing is a later-phase feature |

# **6\. Unified Reward and Point-Economy System**

## **6.1 Central Reward Engine**

Process all rewards through a single reward\_service so levels, missions, and achievements never modify LP directly. A reward request includes source\_type/source\_id, user\_id, reward\_type, amount, funding\_source, idempotency\_key, and config\_version.

| Reward Type | Storage / Issuance | Key Constraint |
| ----- | ----- | ----- |
| XP | user\_xp\_ledger \+ user\_level | No cash value; does not decrease through normal activity |
| LP | partner loyalty\_wallet \+ loyalty\_ledger | Separate partner-specific balances, expirations, budgets, and settlement |
| Hunt Ticket | hunt\_ticket\_ledger | Distinguish base, share, level, and mission acquisition sources |
| Voucher | voucher issuance service | Validate quota, validity period, minimum level, and per-user limit |
| Badge | user\_achievement\_badge | Prevent duplicate unlocks of the same tier |

## **6.2 Budget and Funding Responsibility**

* Classify funding\_source as PLATFORM or PARTNER and store partner\_id and campaign\_budget\_id.

* Set daily, campaign, and per-user LP issuance caps; when exceeded, rewards must be holdable or replaceable with XP.

* Hold high-value or high-frequency rewards as REVIEW\_REQUIRED and record administrator approval/rejection plus a reference number.

* The partner settlement report must separate purchase accruals, voucher use, mission rewards, level conversions, and reversals/adjustments.

* When point-economy settings change, record effective\_at and config\_version so historical transactions can be reproduced.

# **7\. Event-Driven Architecture**

| Processing Flow  Verified core event → mission/achievement rules engine → reward service → LP/XP/hunt-ticket/voucher ledgers → level recalculation → notification and analytics events |
| :---- |

## **7.1 Events to Retain and Add**

| Category | Event |
| ----- | ----- |
| Retain Existing | hunt\_complete, voucher\_select, booking\_complete, qr\_redeem, referral\_verified, credit\_earned, credit\_redeemed |
| Verification | ad\_reward\_verified, purchase\_verified, review\_verified, proof\_approved, proof\_rejected |
| Mission | mission\_assigned, mission\_progressed, mission\_completed, mission\_reward\_granted, mission\_expired |
| Level | points\_converted\_to\_xp, xp\_granted, level\_up, level\_recalculated |
| Achievement | achievement\_progressed, achievement\_unlocked, achievement\_reward\_granted |
| Security / Reversal | fraud\_flagged, reward\_held, reward\_reversed, account\_suspended |

## **7.2 Common Event Schema**

Every event includes event\_id (UUID), event\_name, schema\_version, user\_id, occurred\_at\_utc, received\_at\_utc, source, partner\_id, object\_type/object\_id, idempotency\_key, amount/currency (when applicable), device\_id\_hash, and metadata. Do not place sensitive personal data, raw receipts, or precise locations directly in metadata; include only a reference key to separate secure storage.

## **7.3 Delivery Guarantees**

* Use the transactional outbox pattern to prevent business-data commits from becoming inconsistent with event publication.

* Consumers deduplicate by event\_id or idempotency\_key and send failed messages to a dead-letter queue after retries.

* The rules engine stores a definition\_version snapshot so configuration changes do not alter evaluation of in-progress missions.

* Use occurred\_at\_utc and grace\_period to recognize actions performed within the valid window even when event processing is delayed.

# **8\. Data Model — New and Extended Entities**

| Entity | Key Fields | Notes |
| ----- | ----- | ----- |
| level\_definitions | level, name, min\_xp, benefits\_json, version, effective\_at | Level policy version |
| user\_levels | user\_id, lifetime\_xp, current\_level, next\_level\_xp, updated\_at | One-row-per-user cache |
| user\_xp\_ledger | tx\_id, user\_id, delta, source\_type/id, idempotency\_key, config\_version | Immutable XP ledger |
| point\_xp\_conversions | tx\_id, user\_id, partner\_id, lp\_amount, xp\_amount, status | Linked to LP debit |
| mission\_definitions | type, segment, schedule, condition\_json, reward\_json, quota, version | Administrator template |
| user\_missions | user\_id, mission\_id/version, state, progress, assigned/expires\_at | Per-user instance |
| mission\_proofs | proof\_id, user\_mission\_id, file\_ref, review\_status, reviewer | Evidence and personal data separated |
| achievement\_definitions | group, tier, threshold, counter\_key, reward\_json, version | Tier definition |
| user\_achievements | user\_id, achievement\_id, progress, unlocked\_at, reward\_tx\_id | Prevents duplicate unlocks |
| reward\_transactions | reward\_tx\_id, type, amount, funding\_source, status, source | Unified reward state |
| event\_log/outbox | event\_id, schema\_version, payload\_ref, published\_at, retry\_count | Delivery and reprocessing |
| admin\_audit\_logs | actor, action, target, before/after, reason, ip\_hash, created\_at | Audit trail for sensitive actions |

| Migration  Reference identifiers from the existing loyalty\_wallet/ledger, voucher, booking, and qr\_redemption tables without duplicating balances. Integrate the new systems by extending the ledgers and event model. |
| :---- |

# **9\. API Specification — Recommended Endpoints**

| Method | Endpoint | Purpose | Key Validation |
| :---: | ----- | ----- | ----- |
| GET | /v1/gamification/profile | Level, XP, today's missions, and achievement summary | User authentication |
| GET | /v1/levels | Level ranges, benefits, and locked partners | active config version |
| POST | /v1/levels/convert-points | Convert LP to XP | Balance, minimum unit, idempotency key, and wallet lock |
| GET | /v1/missions?type= | List of missions available to the user | Segment, level, time, and quota |
| GET | /v1/missions/{id} | Mission details and progress | Assignment and exposure eligibility |
| POST | /v1/missions/{id}/join | Join urgent mission / reserve quota | Inventory, duplicate, and expiration |
| POST | /v1/missions/{id}/proof | Evidence Submission | Format, size, malicious file, and owner |
| POST | /v1/missions/{id}/claim | Claim reward | CLAIMABLE state, idempotency key, and budget |
| GET | /v1/achievements | All badges, tiers, and progress | Definition version |
| POST | /v1/internal/events | Receive verified domain events | Service authentication, schema, and signature |
| POST | /v1/admin/rewards/{id}/reverse | Administrator reward reversal | RBAC, dual approval, and reason |

## **9.1 Common Error Codes**

Standardize server error codes into the groups below and map them to user-facing messages in the app.

* Access / State: INSUFFICIENT\_POINTS · MISSION\_NOT\_ACTIVE · NOT\_ELIGIBLE · LEVEL\_REQUIRED · QUOTA\_EXHAUSTED

* Duplicate / Issuance: ALREADY\_COMPLETED · REWARD\_ALREADY\_GRANTED · PROOF\_REQUIRED · REVIEW\_PENDING

* Budget / Configuration: BUDGET\_EXHAUSTED · CONFIG\_VERSION\_CHANGED

# **10\. Admin CMS**

| Menu | Required Functions | Permissions / Audit |
| ----- | ----- | ----- |
| Level Settings | Names, thresholds, benefits, conversion ratio, minimum conversion, effective time, and preview | Operations authors / administrator approves |
| Mission Builder | Type, audience, conditions, schedule, quota, reward, language, and test users | Draft → Review → Schedule → Stop |
| Urgent Mission | Partner, store, map, level, booking slots, budget, and evidence method | Partner authors / operations approves |
| Achievement Settings | Group, tier, threshold, badge, reward, and backfill option | Version and duplicate-threshold validation |
| Rewards / Settlement | PLATFORM/PARTNER budgets; issuance, conversion, reversal, and monthly export | Finance permission and reference number |
| User Support | View level, mission, achievement, ledger, hold, and evidence data | Sensitive-data masking |
| Abuse Prevention | Anomalous ads, QR, referrals, and reviews; hold/release/reverse rewards | Reason, approval, and audit log |
| Analytics | Participation, completion, conversion, promotion, LP burn, and partner ROI | Date-range, segment, and partner filters |

## **10.1 Operational Safeguards**

* Do not directly edit the conditions or rewards of an active mission; create a new definition\_version.

* Before publication, simulate the expected audience size, maximum LP cost, and whether the partner budget will be exceeded.

* When stopping an urgent mission, choose whether to block only new participants or also cancel in-progress users, and record the reward policy.

* Treat reward reversals, XP adjustments, level demotions, and bulk pushes as privileged operations and support dual approval.

# **11\. Notifications, Exposure, and Personalization**

| Trigger | Channel / Message Purpose | Constraint |
| ----- | ----- | ----- |
| Daily Mission Start | App home / push: announce the current time-window mission | Once per mission; honor user notification settings |
| Urgent Mission Published | Push / in-app: nearby, preferred category, and level-eligible | Send only after checking segment, distance, and quota |
| Near Completion | In-app: one action remaining / deadline approaching | Do not use excessive pressure messaging |
| Reward Issued | Toast / notification center: LP, XP, and hunt-ticket details | Link to ledger details |
| Level Up | Celebration screen / push: new benefits and level offers | Once per transaction |
| Achievement Unlocked | Celebration screen / profile badge | Once per tier |
| Expiring Soon | Mission/voucher deadline reminder | Per-user frequency cap |

Set the default quiet hours to 22:00–08:00 (Asia/Manila), while allowing users to change the setting. Urgent missions must honor marketing-push consent; in-app exposure is governed by a separate policy.

# **12\. Abuse Prevention, Security, and Policy**

| Risk | Control |
| ----- | ----- |
| Repeated Ads / Fake Completion | AdMob SSV, ad\_unit/session nonce, duplicate-reward blocking for the same ad, and daily caps |
| QR Reuse | Server-issued one-time token, validity window, and partner/device/user cross-validation |
| Multiple Accounts | Phone OTP, device hash, payment/QR/referral graph anomaly detection, and graduated holds |
| Time Manipulation | Use server UTC and Manila conversion rather than client time |
| Location Spoofing | Apply only to location missions; accuracy, speed, and mock signals; location consent and minimal retention |
| Fraudulent Reviews | Accept only reviews after QR use; detect duplicates, prohibited terms, and copied content; administrator review |
| Reward Race Condition | Database locks, unique constraints, idempotency\_key, and atomic budget debit |
| Administrator Misuse | RBAC, dual approval, before/after logs, and hash-linked audit exports |

| Review Policy  Mission conditions may require only review submission/verification after an actual visit. Do not make a five-star rating, positive sentiment, or prescribed wording a reward condition. |
| :---- |

# **13\. Analytics Events and Core KPIs**

| Area | KPI | Required Dimensions |
| ----- | ----- | ----- |
| Engagement | DAU/WAU, mission-home visit rate, and mission participants | New/existing, level, area, and channel |
| Mission | Exposure → join → completion → reward conversion rate; average completion time | Mission type, time window, and partner |
| Level | Level distribution, promotion rate, time to promotion, and LP→XP conversion volume | XP source, cohort, and level |
| Achievement | Achievement unlock rate, next-tier progress, and backfill unlocks | Achievement group and tier |
| Voucher | hunt→select→booking→QR funnel and level-offer utilization | Level, discount band, and partner |
| Economy | LP issuance/use/conversion/expiration, reward cost, and budget utilization | PLATFORM/PARTNER and source |
| Retention | D1/D7/D30, mission-streak retention, and dormant-user return | Participating/non-participating comparison cohorts |
| Risk | Hold, rejection, and reversal rates; duplicate-event rate; SSV failure rate | Reason, device, and campaign |

# **14\. QA Acceptance Criteria**

| Area | Required Test | Pass Criteria |
| ----- | ----- | ----- |
| LP→XP | Normal, insufficient balance, duplicate tap, concurrent use, and configuration change | LP and XP ledger totals reconcile; zero double debits or grants |
| Level | Just below threshold, exact threshold, multi-level jump, and reversing ledger | Benefits, level, and notifications match the server result |
| Daily Reset | UTC boundary, 00:00 Manila, and year-round dates without DST | Previous mission expires and one new instance is created |
| Ads | SSV success, failure, delay, retransmission, and forgery | Issue once only for successfully verified events |
| Urgent Mission | Audience, level, time, distance, quota, and budget race conditions | Zero excess joins or excess rewards |
| QR / Review | Duplicate QR, expired QR, review prerequisite, and evidence rejection | Only valid linked events advance progress |
| Achievement | Historical backfill, crossing multiple thresholds, and reversal events | One unlock and one reward per tier |
| Offline / Retry | App restart, network timeout, and request retransmission | UI converges to the final server state |
| Administrator | Version publication, stop, permissions, dual approval, and audit | Block unauthorized operations and log 100% of attempts |
| Performance | Concurrent load on mission list, profile, and rewards | Recommended p95 ≤ 500 ms (excluding external ads and file uploads) |
| Localization | Long copy, currency, date, time zone, and English/Korean keys | No clipping or hard-coded strings |

## **14.1 Automated-Test Priorities**

* Unit tests: level thresholds, mission-condition DSL, achievement counters, reward caps, and time-window calculations

* Integration tests: loyalty-ledger \+ XP-ledger atomicity, outbox publication, duplicate consumption, and budget contention

* Contract tests: AdMob SSV, QR service, booking/payment events, and push provider

* Regression tests: existing hunt, voucher issuance, booking, QR, 5% accrual, and ₱500 redemption flow

# **15\. Development and Release Sequence**

| Phase | Scope | Completion Criteria |
| ----- | ----- | ----- |
| Sprint 0 / Foundation | Event schema, ledgers, reward\_service, configuration versioning, feature flags, and migration | Pass integration tests for idempotency, atomicity, and audit logging |
| Phase 1 / MVP | Five levels, LP→XP, daily missions, eight core achievement groups, user screens, and basic CMS | Pass end-to-end and existing-feature regression tests with internal users |
| Phase 2 | Urgent missions, Partner CMS, quota and budget, evidence review, and push notifications | Limited pilot with 3–5 selected partners |
| Phase 3 | Backfill, anomaly detection, settlement reports, KPI dashboard, and economy optimization | Meet reward-cost, error-rate, and retention thresholds |
| Later Phase | Seasonal achievements, featured-badge sharing, personalized recommendations, and leaderboard evaluation | Separate approval for legal, economic, and operational impact |

| Recommended First Release  Launch the five-level structure, LP→XP, three daily ad windows, hunt/QR daily missions, automatic achievements, and administrator settings first. Move review-based urgent missions requiring manual photo/receipt verification to Phase 2\. |
| :---- |

# **16\. Values to Confirm Before Development Starts**

To avoid blocking development, implement the values below as configuration and start with the recommended defaults. Operations and Finance can change the values before deployment after review.

| Decision Item | Recommended Initial Value | Configuration Location |
| ----- | ----- | ----- |
| LP→XP Ratio | 1 LP \= 1 XP / minimum 50 LP | Economy Config |
| Level Thresholds | 0 / 500 / 1,500 / 3,500 / 7,000 XP | Level Config v1 |
| Daily Ad Windows | 06–10:59 / 11–14:59 / 17–21:59 | Mission Schedule |
| Daily Rewards | Ad 5 LP \+ 10 XP; hunt 10 XP; QR 5 LP \+ 20 XP | Reward Matrix |
| Urgent-Mission Approval | Partner authors → operations approves → scheduled publication | Mission Workflow |
| Achievement Rewards | Automatic badge \+ XP; LP/voucher optional | Achievement Config |
| Level Demotion | None during normal use; recalculate only for abuse/reversing entries | Risk Policy |
| Backfill Scope | All available verified events | Backfill Job Config |
| Default Language | English app copy; support Korean administrator copy; key all strings | Localization |

# **17\. Developer Final Checklist**

* □ Are LP and XP implemented with separate meanings and separate ledgers?

* □ Are point conversions, mission rewards, and achievement rewards atomic and idempotent?

* □ Are all economy values and exposure conditions managed through administrator configuration and versions?

* □ Are level, mission, and achievement evaluations based only on server events?

* □ Are Asia/Manila reset, time-window, and delayed-event rules applied?

* □ Does the server validate partner minimum level, exclusive offers, quota, and budget?

* □ Are AdMob SSV, one-time QR use, and protections against multiple accounts, duplicates, and concurrency implemented?

* □ Does the settlement report separate mission rewards from LP→XP conversions?

* □ Has the existing hunt→voucher→booking→QR→5% accrual flow passed regression testing?

* □ Can each feature be stopped immediately and rolled out gradually through feature flags?

| Final Success Criteria  Users can understand today's actions, distance to the next level, and achievement progress on one screen. Operations can adjust conditions, rewards, and budgets without a code deployment, while Finance and QA can trace every LP and XP cause through ledgers and events. |
| :---- |

