# Prompt — build the three Voucher Hunt user guides as .docx

Paste everything below the line into a fresh agent session opened at the repo
root (`C:\dev\bizflow-voucher-hunter`). It is self-contained: it names the files
to read, the writing rules, the outline of each document, and the checks to run
before handing the files back.

---

You are writing **end-user documentation** for the Voucher Hunt product in this
repo. Produce **three Word documents** — one per audience — that a non-technical
person can follow from first open to confident daily use.

## Deliverables

| File | Audience |
|---|---|
| `docs/Voucher Hunt — Customer Guide.docx` | Customers using the Android app |
| `docs/Voucher Hunt — Staff Guide.docx` | Business owners and their in-store staff, on the dashboard |
| `docs/Voucher Hunt — Admin Guide.docx` | Admins and super admins who set up businesses, campaigns and accounts |

## How to build them

Write **one Python script per guide** under `scripts/`, following the house
pattern already set by `scripts/build-how-it-works-doc.py`:

- `scripts/build-customer-guide.py`
- `scripts/build-staff-guide.py`
- `scripts/build-admin-guide.py`

Read `scripts/build-how-it-works-doc.py` first and reuse its conventions: a
module docstring with the `pip install python-docx` / run line, a `SHOTS` map of
optional screenshots, the `shot()` / `body()` helpers, the `INK` / `MUTED` /
`PURPLE` colours, Calibri 11pt `Normal`, a level-0 title, and a `build()` that
ends by saving to `OUTPUT`.

The script is the source of truth — the .docx is a build product. The docstring
in the existing script says why: the wording stays reviewable in git and cannot
drift silently from the product. Keep that property.

Screenshots: `docs/images/` currently holds only `customer-01-directory.png`,
`customer-02-campaign.png`, `customer-03-roulette.png`, `customer-04-datetime.png`,
`customer-05-voucher.png`, `staff-01-validate.png`, `staff-02-awarded.png`. Use
those where they fit, and for every other screen emit a bracketed placeholder
line naming the filename someone should drop in later — exactly as `shot()`
already does. Do not invent images.

Run each script and confirm all three .docx files are written. Do not hand back
a script you have not run.

## Read these before writing a word

Do not write from memory or from this prompt alone — every screen name, button
label and number below must be checked against the code:

- `README.md` — surfaces, customer flow, routes, the draw-before-booking rule
- `docs/REWARDS.md` — Loyalty Points: earning, conversion, redemption, settlement
- `docs/GAMIFICATION.md` — levels, missions, achievements, XP vs LP
- `apps/mobile/src/i18n/translations.ts` — **the exact words on every app screen.**
  Quote the app's own English strings; never paraphrase a button.
- `apps/mobile/src/app/(tabs)/` — the app's screens and tab order
- `src/app/dashboard/_components/Sidebar.tsx` — the dashboard nav and, in
  `visibleSections()`, exactly which links each role sees
- `src/server/admin-users.ts` — the three roles and the rules on them
- `src/app/dashboard/staff/page.tsx` — the Scan & Redeem screen
- `src/server/change-requests.ts` — what staff may propose and an admin approves
- `docs/I18N.md` — the four supported languages

Where this prompt and the code disagree, **the code wins** — and say so in your
hand-off note so the difference gets looked at.

## Writing rules — all three guides

1. **Plain language.** Short sentences. Second person ("you"). No jargon. If a
   product term must appear (Loyalty Points, LP, XP, campaign, voucher pool,
   slot, tier, rarity), define it once in a short glossary at the end.
2. **Numbered steps for anything procedural.** One action per step, starting
   with the verb, naming the exact button or field label in bold.
3. **No internals.** No endpoints, file paths, env vars, SQL or code in the
   customer and staff guides. The admin guide may name a screen and a setting,
   never an API route.
4. **Say what the screen shows back.** After each procedure, one line on how the
   user knows it worked.
5. **Cover the unhappy paths** where they are common: no code arriving, a sold
   out slot, an invalid voucher, not enough LP. Give the fix, not the cause.
6. Every guide opens with a one-paragraph "What this app is" and a "What you
   need before you start" list, and closes with a short troubleshooting table
   and the glossary.
7. Keep each guide to a length a person will actually read: roughly 6–10 pages
   for the customer guide, 8–14 for staff, 10–16 for admin.
8. Use tables for reference material (statuses, roles, limits) and prose for
   procedures. Do not build a table where two sentences do.
9. British/neutral English, consistent with the existing docs. Philippine peso
   amounts as ₱.

## Guide 1 — Customer Guide

Audience: someone who just installed the Android app. They have a phone number
and nothing else. There is **no customer website** — everything happens in the app.

Cover, in this order:

1. **Installing and signing in.** Phone OTP: enter a Philippine mobile number
   (`09XX XXX XXXX`), receive a 6-digit code by SMS, verify. SMS can take up to
   a minute. Resend has a countdown. Five wrong guesses burn the code. One
   sign-in covers the whole app, not one per campaign.
2. **The five tabs** — Home, Quests, Vouchers, LP Shop, More — one short
   paragraph each, so the reader has a map before the procedures start.
3. **Hunting a voucher**, step by step, matching the app's real screens:
   Home (search and filter campaigns) → campaign page → **Let's Hunt!** →
   the roulette (tap to stop the reel) → the voucher result → **pick a date and
   time** → confirm with name, optional email and number of guests →
   the confirmation screen with the voucher code and QR, plus a confirmation SMS.
   Make these rules explicit, because they surprise people:
   - The prize is drawn **first**; the time slots you are then offered are only
     the ones that prize's tier is available at. Higher-value vouchers are
     offered at fewer times.
   - A hunt is **resumed, never restarted** — reopening a campaign returns you
     to the furthest step you reached, and an interrupted spin shows the draw
     you already paid for rather than charging another.
   - One final voucher per phone per campaign.
4. **Using a voucher in store.** Open the Vouchers tab, open the voucher, show
   the QR to staff. The voucher stays valid until the booked slot ends. Explain
   Active / Redeemed / Expired.
5. **Loyalty Points.** The daily 1–10 LP for opening the app; 10 LP for a
   successful referral, once a day; 5% of a paid purchase when staff scan your
   wallet QR (₱500 → 25 LP). Converting 50 LP or more into an `RWD-` voucher.
   Spending LP in the LP Shop with partner businesses, including partial use of
   a voucher. LP vouchers expire after a year.
6. **Quests.** Daily and urgent missions, the daily reset, XP and the five
   levels, achievements and badges. State plainly that **XP is not LP**: XP
   measures progress and can never be spent, LP is the balance you spend, and
   spending LP never costs you a level.
7. **Referrals** — how to invite someone and what the referrer gets (a bonus
   spin, plus the daily 10 LP).
8. **Account and settings** (More tab): the signed-in number, language (English,
   Korean, Chinese, Japanese), sign out, delete my account.
9. **Troubleshooting**: no SMS; wrong number entered; "sold out" on a slot;
   voucher rejected in store; LP not showing after a purchase; the app says a
   hunt is already in progress.

## Guide 2 — Staff Guide

Audience: a business owner or their counter staff, on a desktop browser at
`/dashboard`. Assume no training and a queue of customers waiting.

Start from the fact that a **staff** account signs in with an email and password
created for them by an admin, and sees a deliberately narrow dashboard. Per
`visibleSections()`, a staff account sees exactly: Dashboard, Slots, Vouchers,
Users, Loyalty Points, Transactions, LP Billing, Levels & Missions, and
Scan & Redeem — all scoped to their own business. Say clearly what they cannot
do: create businesses or campaigns, manage team accounts, or touch Settings.

Cover:

1. **Signing in** and what the sidebar sections mean.
2. **Scan & Redeem — the main daily job.** Give this the most space. Scanning a
   QR with the camera, uploading an image, or typing the code by hand. Explain
   that staff do not need to know which kind of code they are holding: a
   campaign voucher and an LP voucher both validate from the same box. Walk
   through the validation result, what a valid result shows (the customer, the
   benefit, the booked slot), and pressing redeem. Then the other counter jobs:
   crediting a customer's wallet after a purchase (scan the wallet QR, enter the
   purchase amount, the 5% is awarded and shown back), redeeming an LP voucher
   against a bill including partial use, and marking a **no-show**.
   Rescheduling a booking, where the campaign allows it.
3. **Watching the day**: the Dashboard metrics, the Slots list and capacity, the
   Vouchers list and its statuses, looking a customer up under Users.
4. **Loyalty Points and LP Billing** — reading the partner balance, what the
   business is owed (90% of LP spent, after the 10% service fee), and the
   settlement window of days 1–7 of the following month.
5. **Levels & Missions** for a partner: what a mission is, submitting one for
   approval, and reviewing customer evidence in the proofs queue.
6. **Asking for a change.** Staff cannot create slots or voucher pools directly —
   they submit a request that an admin approves or rejects, and it takes effect
   only once approved. Explain how to submit one and how to tell its state
   (Pending / Approved / Rejected).
7. **Troubleshooting**: code not recognised; camera unavailable on a desktop;
   voucher already redeemed; customer at the wrong time slot; wallet credit
   held for review.

## Guide 3 — Admin & Super Admin Guide

Audience: the operator setting the platform up and running it. Technically
comfortable, but still entitled to plain instructions.

Open with the **role model**, as a table, taken from `src/server/admin-users.ts`
and `Sidebar.tsx`:

- **super_admin** — everything, including **Team** and **Settings**.
- **admin** — everything except Team and Settings. Spell out why: an admin who
  could create accounts could make itself a super admin, so that boundary is
  enforced in the nav, the page and the API behind it.
- **staff** — scoped to one business, the narrow list above.

Also state the guardrails the software enforces, so nobody fights them by
accident: you cannot change your own role or status, and the last active super
admin cannot be demoted, deactivated or deleted.

Then cover, in the order a new operator actually needs them:

1. **Signing in** at `/login` and the dashboard layout.
2. **Creating a business** — the fields, the location picker, what customers see.
3. **Creating a campaign** — slug, title, offer message, hero image, start and
   end dates, mode (in-store vs online shop), base attempts, referral daily
   limit, candidate timeout, terms, and whether rescheduling is allowed.
4. **Time slots** — date, start and end time, capacity, status
   (active / sold out / closed / paused).
5. **Voucher pools and tiers** — benefit type (percent discount, fixed amount,
   free item, free shipping), benefit value, display label, quantity, minimum
   spend, restriction, and **rarity**. Make the odds rule explicit: a tier's
   chance of being drawn comes from its rarity alone, never from how many slots
   it is offered at. Then bind each pool to the slots its tier is offered at —
   that binding is what the customer's date picker obeys.
6. **Approving change requests** from staff — the queue, what a request contains,
   approving and rejecting.
7. **Creating accounts** (super admin) — `/dashboard/team`: add a member, choose
   a role, scope a staff member to a business, deactivate someone who leaves.
8. **Running the network**: Users and a single customer's history, Vouchers,
   Transactions, Loyalty Points, LP Billing and the monthly partner statement,
   and the CSV exports.
9. **Levels & Missions operations**: the mission builder and its pre-flight cost
   simulation, the approval workflow, the evidence/proofs queue, the anomaly
   dashboard and held rewards, the KPI analytics, and the versioned economy
   settings that change without a deploy.
10. **Settings and the Danger Zone** (super admin) — including that resetting
    data wipes the database and signs every customer and admin out. Put a clear
    warning on it.
11. **Troubleshooting**: a customer says a voucher will not validate; a campaign
    is not showing in the app; a slot shows sold out with stock remaining; a
    staff member cannot see a page; SMS is not arriving.

## Before you hand back

- Run all three scripts; confirm the three .docx files exist and open.
- Re-check every button label, screen name, role capability and number against
  the files listed above — grep the call site rather than trusting a summary.
- Do not commit unless asked. If you do commit, stage the six named paths
  explicitly — three scripts, three documents — never `-A`.
- Hand back: the three file paths, one line on what each covers, and a list of
  anything you could not verify in code or deliberately left out.
