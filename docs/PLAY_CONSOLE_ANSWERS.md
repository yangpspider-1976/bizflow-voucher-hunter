# Play Console — answers for the "App content" to-do list

Answers for every item on the Play Console dashboard to-do list, derived from the
code rather than assumed. Paste them in as-is except where marked
**`«FILL IN»`** — those are facts only you have.

App: **Voucher Hunt** · package `com.voucherhunt.mobile` · version `1.0.0`
(`apps/mobile/app.config.js`) · deployed at
**https://voucher-hunt.com**

Companion doc: [PLAY_RELEASE.md](PLAY_RELEASE.md) covers builds, signing, and App
Links. This doc covers only the console questionnaires.

> **Two items need something from you before they are true.** App access (§2)
> needs two env vars set on the production deployment; the deletion page (§6)
> needs a real support address in place of the placeholder. Both are flagged
> inline.

---

## 1. Privacy Policy Settings

| Field | Answer |
|---|---|
| Privacy policy URL | `https://voucher-hunt.com/privacy` |

The page is at [src/app/privacy/page.tsx](../src/app/privacy/page.tsx) —
statically rendered and unauthenticated, so a reviewer reaches it without
installing the app.

The contact address is **yangpspider@gmail.com**, matching `/delete-account` and
the store listing. Still outstanding on this page: it names no operating entity,
and the Philippine Data Privacy Act wording is unreviewed.

---

## 2. Login details  (console: *App access*)

**Answer:** *All or some functionality is restricted.*

Everything past the campaign browse screen requires a signed-in account, and
sign-in is a 6-digit OTP sent by SMS to a Philippine mobile number
([src/server/otp.ts:28-52](../src/server/otp.ts#L28-L52)).

A reviewer cannot receive that SMS — no Philippine handset — and `devCode` is
suppressed in production by design. So one number is allowed to sign in with a
fixed code instead, implemented in
[src/server/otp.ts](../src/server/otp.ts) and covered by
[tests/integration/signin-otp.test.ts](../tests/integration/signin-otp.test.ts).

> **Set both env vars on the production deployment before you submit**, or the
> credentials below will not work and the build will be rejected:
>
> ```
> REVIEW_ACCOUNT_PHONE=«the number you entered in the console»
> REVIEW_ACCOUNT_OTP=«the 6-digit code you entered in the console»
> ```
>
> The bypass is inert unless both are set and the code is exactly 6 digits.
> **Use a random code, not `000000`.** It does not expire and is not consumed,
> so only the per-IP rate limit (10 verify attempts per 5 minutes) stands
> between it and someone guessing. The blast radius is one ordinary customer
> account with no elevated rights — but there is no reason to make it free.
> **Unset both once the app is live**, and re-set them for the next review.

The App access form reads:

```
Name:        Reviewer demo account
Username:    +63«FILL IN: review phone, e.g. +639171234567»
Password:    «FILL IN: the random 6-digit code, NOT 000000»
```

Enter the username in **+63 international format** — the field's own help text
asks for the country code. `normalizePhone` accepts `+639171234567`,
`09171234567`, and `639171234567` interchangeably, so the env var may use any of
them and still match.

"Other information required to access the app" (500 char limit; this is 439):

```
Instructions:
1. Open the app and tap Sign in.
2. Enter the mobile number above and tap Send code.
3. The SMS will not arrive on your device. Enter the code above instead - this number is configured as a review account and accepts a fixed code.
4. Tap any campaign > pick a date and time > Hunt > pick a voucher > Confirm. A voucher with a QR code is issued to the Vouchers tab.
No other credentials are needed. There are no paid features.
```

**Tick the checkbox** at the foot of the dialog — "these login details provide
full access to all features and content, including premium or paid content".
The review account is an ordinary customer account, and the app has no paid or
gated tier, so it does reach everything a user can reach.

---

## 3. advertisement  (console: *Ads*)

**Answer:** *No, my app does not contain ads.*

Verified against `apps/mobile/package.json` — the dependency list holds no ad,
attribution, or analytics SDK (Expo modules, React Native, and
`react-native-qrcode-svg` only). Nothing in the app renders third-party content.

### Advertising ID — a separate declaration

App content → **Advertising ID** → *Does the app use an ad ID?* → **Yes**
(since 1.7.0).

Purposes to tick: **Advertising or marketing**, and **Fraud prevention,
security, and compliance**. Nothing else. Advertising is why the SDK is there;
the fraud purpose is Google's own invalid-traffic detection, not ours — our
anomaly detection keys off `device_id_hash` and never sees the ad ID. Do **not**
tick Analytics: there is still no analytics SDK, and the KPI dashboard is
computed server-side from our own tables.

This is not the same question as "contains ads", and it **blocks submission**
until answered — the console reports it as "Incomplete ad ID declaration" and
refuses to send the version for review.

Answer from the merged manifest, not from the dependency list: an SDK merges
`com.google.android.gms.permission.AD_ID` in without the app declaring it, and
Play blocks releases where the declaration and the manifest disagree. Confirm on
a built artifact:

```bash
aapt2 dump permissions <build>.aab
# or, from a local prebuild:
grep AD_ID apps/mobile/android/app/build/intermediates/merged_manifest/release/*/AndroidManifest.xml
```

Up to 1.6.0 the answer was **No** and that was correct — nothing pulled the
permission in. `react-native-google-mobile-ads` (1.7.0) does, via the
`play-services-ads` AAR, and it was verified present in the merged manifest of
build 24 before this declaration was changed. The permission cannot simply be
suppressed: it can be added to `blockedPermissions`, but that forces
non-personalised ads only and cuts the revenue the feature exists for.

The same dump confirms `READ_SMS` and `RECEIVE_SMS` are absent, which is the
evidence for the §6 claim that the app never reads SMS — `blockedPermissions` in
`app.config.js` strips them from the merged manifest.

---

## 4. Content rating

The questionnaire is IARC's; you complete it per store, and the ratings are
issued automatically. Category to select: **Reference, News, or Educational** —
or **Utility, Productivity, Communication, or Other**. Voucher Hunt is not a
game, and picking a game category pulls in a much harsher question set.

| Question | Answer |
|---|---|
| Violence, realistic or fantasy | No |
| Sexuality or nudity | No |
| Profanity or crude humour | No |
| Controlled substances (drugs, alcohol, tobacco) | No |
| **Gambling** — real or simulated | **No** — see the note below |
| Horror or fear-inducing content | No |
| User-generated content shared with other users | No |
| Users can interact or communicate with each other | No |
| Shares the user's location with other users | No |
| Allows purchase of digital goods | No |
| Contains links to external websites or social networks | Yes — a referral link opened via the OS share sheet |

**On the gambling question.** The voucher reveal is a weighted random draw
([voucher-engine.ts:511-521](../src/server/voucher-engine.ts#L511-L521)), which
is a "spin to win" shape and does invite scrutiny. It is nevertheless not
gambling under IARC's definition, and here is the reasoning to give if asked:
the user stakes nothing, no purchase or currency is required to draw, every
outcome is a winning voucher (the pools differ in value, none is a loss), and
nothing won can be cashed out or wagered again.

Expected outcome: **Everyone / PEGI 3 / ESRB Everyone**.

---

## 5. Target audience

| Field | Answer |
|---|---|
| Target age groups | **18 and over**, only |
| Does your store listing appeal to children? | No |
| Ads suitable for children? | N/A — the audience is 18+, so the question does not arise |

Rationale: the app books restaurant and retail reservations and carries a
loyalty balance, both of which assume an adult holder. Selecting any bracket
under 18 pulls the app into Families policy — Designed for Families
declarations, a stricter data-safety bar, and the Families ads programme, which
restricts rewarded ads to certified networks and forbids personalised ads to
children. Since 1.7.0 the app serves rewarded ads, so staying 18+ is now
load-bearing rather than merely tidy.

### Ads declaration (App content → Ads)

**Does your app contain ads?** → **Yes** (since 1.7.0).

This is separate from the Advertising ID declaration in §3 and from the Data
Safety form; all three have to agree. Answering Yes puts a "Contains ads" badge
on the store listing, which is correct and unavoidable — a rewarded ad is still
an ad, even though the player opts into each one.

Also re-answer the **content rating** questionnaire: it asks whether the app
contains ads, and the previous submission answered No. The rating itself is
unlikely to move for an 18+ app with opt-in rewarded video, but an unamended
answer is a false declaration.

The privacy policy already states the app is not directed to children
([privacy/page.tsx:139-143](../src/app/privacy/page.tsx#L139-L143)), which is
consistent with this answer. Keep the two aligned.

---

## 6. Data security  (console: *Data safety*)

Audited from `SCHEMA` in `src/server/db.ts`, the `analytics_events` writes in
`src/server/voucher-engine.ts`, and the mobile dependency list.

| Top-level question | Answer |
|---|---|
| Does your app collect or share required user data types? | **Yes** |
| Is all user data encrypted in transit? | **Yes** — HTTPS only; the client refuses plain HTTP outside dev |
| Account creation methods supported | **Username and other authentication** — only this one |
| Delete account URL | `https://voucher-hunt.com/delete-account` — **not deployed yet** |
| Deletion of some data without deleting the account? (optional) | **Yes** — notifications can be turned off per category, and the optional email address can be cleared on request |

On account creation: Play counts a phone number as a "username" and a one-time
password as "other authentication", which is precisely the sign-in flow
([sign-in.tsx](../apps/mobile/src/app/sign-in.tsx),
[otp.ts](../src/server/otp.ts)). Accounts are created in-app on first use, so
"do not allow users to create accounts" is wrong. Do **not** tick "username and
password" — the customer app has no password; `STAFF_PASSWORD` and
`ADMIN_SESSION_SECRET` belong to the web dashboards, which are outside the
Android app's scope.

### Data types — the six boxes to tick

In the order the form presents them. Everything not listed stays unticked.

| Section | Tick |
|---|---|
| location | — |
| **Personal Information** | **name**, **Email address**, **User ID**, **phone number** |
| Financial Information | — (see the note on purchase history below) |
| Health and Fitness | — |
| message | — **nothing**, see the warning below |
| Photos and videos | — |
| audio file | — |
| Files and docs | — |
| calendar | — |
| contact | — |
| **App activity** | **App interactions** |
| Web browsing | — |
| App info and performance | — |
| **Device or other IDs** | **Device or other IDs** |

> **Never tick "SMS or MMS" under message.** It declares that the app reads the
> device's messages. This app cannot: `READ_SMS` and `RECEIVE_SMS` are in
> `blockedPermissions` and the customer types the code by hand. Ticking it
> triggers a permissions review that the app's own manifest would fail.

**Purchase history — a judgment call.** Recommended: leave it unticked. Play
scopes the declaration to data collected *through the app*, and purchase amounts
are entered by staff on the web dashboard; the app only displays the resulting
points ledger. The counter-argument is that Google defines purchase history
broadly ("information about purchases or transactions a user has made") and a
reviewer sees exactly that in the app. Ticking it (collected / required / app
functionality) is the conservative option and costs little.

### Data handling — per-type answers

Step 4 asks five questions per data type. All seven answered:

| Data type | Collected / Shared | Ephemeral? | Required? | Collection purposes | Sharing purposes |
|---|---|---|---|---|---|
| name | Collected **and** Shared | No | Required | App functionality, Account management | App functionality |
| Email address | Collected only | No | **Users can choose** | App functionality, Account management | — |
| User ID | Collected only | No | Required | App functionality, Account management, Fraud prevention & security | — |
| phone number | Collected **and** Shared | No | Required | App functionality, Account management, Fraud prevention & security | App functionality |
| App interactions | Collected only | No | Required | App functionality, Analytics, Fraud prevention & security | — |
| Device or other IDs | Collected **and** Shared | No | **Users can choose** | App functionality, Advertising or marketing, Fraud prevention & security | Advertising or marketing |
| Photos and videos | Collected only | No | **Users can choose** | App functionality | — |

**What counts as "shared".** Google excludes transfers to a *service provider
processing on the developer's behalf*. The SMS provider, Expo's push service, and
the hosting and database providers are all service providers, so none of them
makes a field "shared". Partner businesses are **not** service providers — they
are independent entities using the data for their own purposes — so the two
fields their staff actually see are the only shared ones: the **name** on a
reservation, and a **masked phone number** at a loyalty scan. The mask makes the
phone borderline; declaring it is the safer side.

**Ephemeral is No for everything** — each field is written to the database and
outlives the request.

**Optional fields.** Email is allowed empty by the schema and is only stored if
entered. Device IDs are optional because no push token exists unless the user
grants notification permission.

**Analytics on App interactions** is deliberate: `analytics_events` feeds the
partner dashboard metrics, which is analytics in Google's sense. This is
unrelated to the "no analytics SDKs" point in §3, which is about third-party
SDKs and still holds.

**Advertising or marketing applies to exactly one type: Device or other IDs.**
Since 1.7.0 the app shows optional rewarded ads, so the advertising ID is
collected and shared with Google for advertising, and Google also uses it for
invalid-traffic detection. No other type reaches an advertiser — Google never
receives a name, number, or email. **Never tick Developer communications** on
any type: nothing in the code messages users for marketing, only transactional
SMS, which is App functionality.

**Photos and videos** is new to this table and was missed when evidence
submission shipped in 1.6.0, not when ads shipped. A mission may ask for a
receipt or photo, and `mission_proof_files` stores the image itself — base64,
against a wallet id, with an `expires_at`. Optional because only some urgent
missions ask for evidence and the player chooses whether to enter one; not
shared, because only our own reviewers see it.

On **User ID**: the app assigns an internal user id, and `buildReferralLink()`
embeds it in the referral URL shared out of the app, so it does leave the device.
Declared collected but **not** shared — user-initiated sharing is an explicit
exception in Google's rules, and the link only travels when the user taps share.

**Declare as NOT collected** (verified absent): contacts, SMS or call logs,
files, calendar, health, and financial account details.

Three entries left this list, and each for its own reason:

- **Advertising identifier** — collected and shared since 1.7.0. Covered by
  Device or other IDs above.
- **Photos or videos** — collected since 1.6.0, stored in
  `mission_proof_files`. Its own row above.
- **Location** — stays declared *not collected*, but the reasoning changed and
  is worth writing down. Coarse and fine location are requested, but only at the
  moment somebody taps Join on a mission with a radius, and only to run that one
  check. Nothing persists: the only `latitude`/`longitude` columns in the schema
  belong to `businesses`, which are partner store coordinates, not people. If a
  reported position is ever written to a row, this answer changes.

The deletion page is [src/app/delete-account/page.tsx](../src/app/delete-account/page.tsx)
— unauthenticated and statically rendered, so a reviewer reaches it without the
app. It names the app and operator, gives the steps, and states what is deleted,
what is retained, and for how long, which are Play's three stated requirements
for this link. It is reachable in-app from *More → Delete my account*, which
Play also expects of an app that creates accounts in-app.

The declared contact is **yangpspider@gmail.com**. Because the process is
email-based, that mailbox **is** the deletion mechanism — it has to be monitored,
and a reviewer may well test it.

> **⚠ One thing on that page still needs you.** The **10-year** retention figure
> for settlement and audit records follows Philippine tax practice but has not
> been confirmed by an accountant or lawyer. Confirm it, or change it.
>
> The process is a *request* process, not self-serve deletion. Play accepts
> that. If you would rather ship self-serve deletion in-app, that is a larger
> change — the wallet's ledger and audit rows carry foreign keys and a hash
> chain, so it means de-identifying rows rather than deleting them.

Two points a reviewer may probe:

- **The app never reads SMS.** Codes are typed manually. `READ_SMS` and
  `RECEIVE_SMS` are in `blockedPermissions`
  ([app.config.js:86-89](../apps/mobile/app.config.js#L86-L89)) and are stripped
  from the merged manifest. Confirm on the release build with
  `aapt dump permissions`.
- **Loyalty Points are not money** — see §8.

---

## 7. Government App

**Answer:** *No.* Voucher Hunt is a private commercial product for SME partner
businesses. It is not developed by, on behalf of, or in partnership with any
government entity.

---

## 8. financial functions  (console: *Financial features*)

**Answer:** *My app does not provide any financial features.*

Do **not** tick lending, insurance, investment, crypto, e-money, or payment
processing. The reasoning, since the peso amounts in the codebase can look like
a financial feature at a glance:

- **Loyalty Points are a promotional program unit, not e-money.** They accrue at
  5% of a partner purchase, are spendable only on vouchers at partner
  businesses, and cannot be withdrawn, transferred between users, or redeemed
  for cash ([rewards-network.ts:20-27](../src/server/rewards-network.ts#L20-L27)).
- **The app stores no payment instrument** and processes no payment. There is no
  card, wallet, or bank linkage anywhere in the schema.
- **The peso amounts are staff input on the web dashboard**, not a transaction in
  the app — a staff member types the amount a customer already paid at checkout
  so the 5% accrual can be computed
  ([RewardsStaffTools.tsx:180](../src/app/dashboard/_components/RewardsStaffTools.tsx#L180)).
  That surface is not part of the Android app at all.

Keep the LP-to-peso disclaimer copy conservative in-app for the same reason —
wording that implies LP is redeemable for cash would contradict this
declaration.

---

## 9. health

**Answer:** *No* to every question in this section — the app has no health
features, is not a health app, conducts no health research, and provides no
COVID-19 or medical functionality.

Note the trap: one partner campaign in the seed data is a facial/spa promotion
(`glow-facial-week`). That is a retail beauty voucher, not a health service, and
does not change this answer. Avoid the words "treatment", "therapy", or
"clinic" in store listing copy so the two stay consistent.

---

## 10. Select app category and provide contact details

| Field | Answer |
|---|---|
| App or game | **App** |
| Category | **Shopping** (alternative: *Lifestyle*) |
| Tags | Deals & coupons; Loyalty & rewards; Food & drink |
| Email address | `yangpspider@gmail.com` — same as `/privacy` and `/delete-account` |
| Phone | `«FILL IN»` — optional, but expected for a commerce app in PH |
| Website | `https://voucher-hunt.com` |

**Shopping over Lifestyle:** the core loop is discovering and redeeming
merchant offers, which is what the Shopping category ranks for. Lifestyle is the
fallback if you position the reservation flow as the primary feature.

The support email must be real and monitored — it is displayed publicly on the
store listing and is the address users write to for the deletion requests in §6.
Use the same address in the privacy policy so the two match.

---

## 11. Store listing settings

| Field | Limit | Draft |
|---|---|---|
| App name | 30 | `Voucher Hunt` |
| Short description | 80 | `Reveal vouchers from local partners, book a slot, and earn Loyalty Points.` (74) |

**Full description** (4000 max; the draft below is ~1,050):

```
Voucher Hunt turns everyday spending at your favourite local businesses into
real rewards.

REVEAL A VOUCHER
Pick a campaign from a partner near you, choose the date and time you want to
visit, then reveal your voucher. Every hunt ends in a win — the only question
is how good it is.

BOOK YOUR SLOT
Your voucher is tied to a reservation, so the table or appointment is held for
you. Partner staff see your booking when you arrive; just show the QR code in
the app.

EARN LOYALTY POINTS
Earn Loyalty Points on qualifying purchases at participating partners, plus
bonus points for opening the app and sharing a referral link with a friend.
Convert your points into vouchers you can spend across the partner network.

KEEP EVERYTHING IN ONE PLACE
Your vouchers, reservations, and points balance live in the app. Optional
notifications remind you before a booking and when points land — turn any
category off at any time under More > Notifications.

LEVEL UP AS YOU GO
Every hunt, visit and mission earns XP. Levels unlock partners, earlier access
to offers and extra hunts a day, and a badge wall records what you have done.

ADS ARE OPTIONAL, TRACKING IS NOT A THING
You can watch a short ad to earn points if you want to — nothing plays on its
own, and skipping it costs you only those points. There is no third-party
analytics in the app. We ask for your mobile number to sign you in and your name
to hold your reservation. Nothing more.

Sign in with your mobile number to get started.
```

Copy notes, so the listing stays consistent with §4, §8, and §9: "Every hunt
ends in a win" is deliberate — it forecloses the gambling reading. Do not
describe Loyalty Points as cash, cashback, or a balance that can be withdrawn.
Do not use clinical language for the beauty campaigns.

### Graphic assets

All in `apps/mobile/store-assets/google-play/`.

| Asset | Spec | Status |
|---|---|---|
| App icon | 512×512 PNG, no alpha | ✅ `app-icon-512x512.png` |
| Feature graphic | 1024×500 PNG or JPG, no alpha | ✅ `feature-graphic-1024x500.png` |
| Phone screenshots | 2–8, 9:16, ≥1080 px per side for promo | ✅ 4 in `screenshots/` |
| Tablet screenshots | — | Not supplied; costs ranking on tablets, not eligibility |

The screenshots were captured from a Pixel 7 Pro emulator, which is 1440×3120 —
a 2.17:1 ratio that Play rejects. Each was scaled to 1080 wide and cropped to
1080×1920 from the top, which costs only the status bar. **Do not pad to width
instead**: side padding leaves full-bleed elements (the bottom tab bar, the
roulette band) visibly short of the edge. Keeping both the screen title and the
tab bar would need 2097px of the 2340 available, so the tab bar is dropped in
favour of the title and primary CTA.

The launcher icon can be regenerated at any size with
`node apps/mobile/scripts/generate-brand-assets.js`.

---

## Order to work in

1. ~~Deploy the backend to HTTPS~~ — done; `eas.json` points at the live host.
2. **Redeploy.** `/delete-account` and the privacy-policy link to it exist only
   in the repo; the live site still serves the old pages. The Data safety form
   rejects a 404, so this must land before §6 is submitted.
3. ~~Real support address~~ — done; `yangpspider@gmail.com` on `/privacy` and
   `/delete-account`. Use the same address in the store listing contact details
   (§10) so the three agree.
4. `REVIEW_ACCOUNT_PHONE` and `REVIEW_ACCOUNT_OTP` set on production — §2.
5. Feature graphic and screenshots — §11.
6. Then fill in the questionnaires, which are quick once 1–5 are done.
7. After the first upload, set `ANDROID_SHA256_CERT_FINGERPRINTS` from Play App
   Signing so `/.well-known/assetlinks.json` stops serving an empty statement
   list — see PLAY_RELEASE.md. Not a submission blocker; until then `https://`
   links show a chooser dialog instead of opening the app.
