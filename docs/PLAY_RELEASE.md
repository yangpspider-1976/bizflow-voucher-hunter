# Phase 6 — Google Play release

What is prepared in the repo, what only you can do, and the exact Data Safety
answers derived from an audit of the code.

Console questionnaires (App access, Ads, Content rating, Target audience,
Financial features, store listing copy) are answered item by item in
[PLAY_CONSOLE_ANSWERS.md](PLAY_CONSOLE_ANSWERS.md).

---

## Blockers, in order

**1. A deployed HTTPS domain.** Everything below waits on this.

`apps/mobile/.env` still points at `http://10.0.2.2:3000` (the emulator's alias
for your laptop). Until the backend is deployed:

- Production builds refuse to run — `getApiBaseUrl()` throws on a non-HTTPS base
  URL outside dev, by design.
- App Links cannot verify (no domain to serve `assetlinks.json`).
- Phase 6's acceptance criterion — "an internal-testing build installs from Play
  and runs the full flow against production" — cannot be met.

Once deployed, replace `REPLACE-WITH-DEPLOYED-DOMAIN` in `apps/mobile/eas.json`
(three places: `preview` and `production` env blocks).

**2. Account deletion.** Play requires apps with accounts to offer a deletion
path, including a **web URL reachable without installing the app**. This does
not exist yet — there is no deletion endpoint, and `/privacy` currently points
at an email address. An email-based process is accepted, but the address must be
real and monitored. A self-serve in-app "delete my account" is stronger and
avoids a review round-trip.

**3. Privacy policy review.** `/privacy` is drafted and accurate to the code and
now carries a real contact address, but it has not been reviewed by a lawyer and
still names no operating entity. Philippine Data Privacy Act obligations need
confirming.

---

## Prepared in the repo

| Item | Where |
|---|---|
| Build profiles (development / preview / production) | `apps/mobile/eas.json` |
| `eas-cli` | devDependency of `apps/mobile` |
| Version strategy | `version` in `app.config.js`; EAS owns `versionCode` |
| Release notes | `apps/mobile/store-assets/google-play/release-notes/<versionCode>-<version>.txt` |
| App Links verification file | `GET /.well-known/assetlinks.json` |
| Privacy policy | `/privacy` (statically rendered, no auth) |
| No SMS permissions | `blockedPermissions` in `app.config.js` |

### Versioning

`eas.json` sets `appVersionSource: "remote"` with `autoIncrement` on the
production profile, so **EAS owns `versionCode`** and bumps it per build. That is
why `android.versionCode` is deliberately absent from `app.config.js` — setting
it there would conflict. Bump the user-visible `version` ("1.0.0") by hand for
meaningful releases.

### Release notes

One file per release in
`apps/mobile/store-assets/google-play/release-notes/`, named
`<versionCode>-<version>.txt` so it can be matched to a build from either
number. The contents are wrapped in the `<en-US>` tags Play accepts, so the file
pastes into the console (or feeds `eas submit`) unedited.

**Play allows 500 characters per language**, counted without the tags. Write for
a customer reading the store listing — what changed for them, not what changed
in the repo.

### Build commands

```bash
cd apps/mobile
npx eas login
npx eas init                       # creates the EAS project + projectId

# Internal APK to sideload and smoke-test against production
npx eas build -p android --profile preview

# Signed AAB for Play
npx eas build -p android --profile production
npx eas submit -p android --latest
```

`eas init` matters beyond the build: **push notifications do not register without
it.** `acquirePushToken` needs `expoConfig.extra.eas.projectId` and returns
`null` when absent, so no device is ever registered.

### App Links

After the first Play upload, take the **Play App Signing** SHA-256 (Play Console
→ Release → Setup → App signing → *App signing key certificate*) — not the
upload key, since Play re-signs the AAB — and set on the web deployment:

```
ANDROID_PACKAGE_NAME=com.voucherhunt.mobile
ANDROID_SHA256_CERT_FINGERPRINTS=AA:BB:...
```

Verify: `https://<domain>/.well-known/assetlinks.json` returns a statement whose
fingerprint matches. Until then the custom `voucherhunt://` scheme still works;
only `https://` links fall back to a chooser dialog.

---

## Data Safety form

Audited from the code, not assumed. Sources: the `SCHEMA` in `src/server/db.ts`,
`analytics_events` writes in `src/server/voucher-engine.ts`, and the mobile
dependency list (no ads or analytics SDKs are present).

**Does your app collect or share any of the required user data types?** → Yes
**Is all user data encrypted in transit?** → Yes (HTTPS only; the client refuses
plain HTTP in production)
**Do you provide a way for users to request deletion?** → Yes, *once the address
in item 2 above is real*

| Data type | Collected | Shared | Optional? | Purpose |
|---|---|---|---|---|
| Phone number | Yes | Yes — SMS provider | Required | Account management, app functionality |
| Name | Yes | Yes — partner staff at redemption | Required to confirm a voucher | App functionality |
| Email address | Yes | No | Optional | App functionality |
| Device or other IDs | Yes — Expo push token | Yes — Expo push service | Optional (only if notifications allowed) | App functionality |
| App interactions | Yes — vouchers, reservations, points, missions, referral opens | No | Required | App functionality, fraud prevention |
| Photos | Yes — only a photo the customer attaches as mission evidence | Yes — reviewed by the partner the mission belongs to, and by operations | Optional | App functionality |
| Approximate and precise location | Yes — only when a customer joins a mission with a radius | No | Optional | App functionality, fraud prevention |

**Declare as NOT collected** (verified absent): contacts, SMS or call logs,
files, calendar, health, financial account details, purchase history tied to a
payment instrument, and any advertising identifier.

### Location and photos — new in 1.6.0

Both were declared as not collected up to 1.5.1 and both are collected now.
**The Data Safety form has to be updated before 1.6.0 is submitted**, or the
declaration no longer matches the binary. So does the table in
[PLAY_CONSOLE_ANSWERS.md](PLAY_CONSOLE_ANSWERS.md).

Neither is ambient or background collection, and the form has a place to say so:

- **Location** is read once, in the foreground, at the moment a customer taps
  Join on a mission confined to a radius. No other screen asks for it, nothing
  is kept beyond the eligibility decision, and every other mission works with
  the permission denied. `ACCESS_COARSE_LOCATION` and `ACCESS_FINE_LOCATION`
  are in the manifest; there is no background location permission.
- **Photos** are picked from the gallery through the system photo picker, which
  needs no permission of its own — there is deliberately no `CAMERA` permission
  and no media-library permission. An uploaded image is held only while the
  review needs it and is deleted after 90 days (`mission_proof_files`).

Location is collected and not shared. Photos are collected and shared, because
staff at the partner the mission belongs to review what a customer sends. Both
are optional: the app is fully usable with both permissions refused.

Two points a reviewer may probe:

- **The app never reads SMS.** OTP codes are typed manually.
  `READ_SMS`/`RECEIVE_SMS` are explicitly listed under `blockedPermissions`, so
  they are stripped from the merged manifest. Confirm on the release build with
  `aapt dump permissions`.
- **Loyalty Points are not money.** They are a program unit; no payment
  instrument is stored. Declaring "financial info" would be wrong.

---

## Store listing

- **Content rating questionnaire.** No user-generated content, no ads, no
  gambling. The roulette is a promotional reveal with no stake and no purchase
  required — answer the gambling questions accordingly, but read them carefully,
  since a "spin to win" mechanic invites scrutiny.
- **Target audience.** Not children.
- **Ads declaration.** Contains no ads.
- **Assets needed:** 512×512 icon, 1024×500 feature graphic, at least two
  phone screenshots, a short description (≤80 chars), and a full description.
  The launcher icon can be regenerated at any size with
  `node apps/mobile/scripts/generate-brand-assets.js`.

---

## Release flow

1. `internal testing` — up to 100 testers by email, available in minutes. This
   is where the Phase 6 acceptance criterion is met.
2. `closed testing` — a wider group; required before production if the account is
   new.
3. `production` — staged rollout.

## Pre-submission checklist

- [ ] Backend deployed to HTTPS; `EXPO_PUBLIC_API_BASE_URL` points at it
- [ ] `REPLACE-WITH-DEPLOYED-DOMAIN` cleared from `eas.json`
- [ ] `eas init` run (needed for both builds and push)
- [ ] `CRON_SECRET` set and the notification schedule live
- [ ] Privacy policy reviewed; contact address real and monitored
- [ ] Account deletion path available and documented
- [ ] Data Safety form submitted per the table above
- [ ] Release build confirmed to request no SMS permission
- [ ] Data Safety form updated for location and photos (new in 1.6.0)
- [ ] Full journey verified against production from a Play internal-testing build
