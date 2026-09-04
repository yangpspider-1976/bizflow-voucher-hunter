# AdMob setup — the two steps that need your account

Everything in the repository is done. The rewarded-ad flow is wired end to end:
the app asks the server for a signed nonce, hands it to the ad, and Google's
server-side verification callback is what credits the mission. What is left are
the two things only the account owner can do — creating the AdMob app and ad
units, and pointing their SSV callback at this backend.

Until those are done the app still builds and still plays an ad, because it
falls back to Google's published **test** ids. But a test ad unit has no SSV
callback setting, so nothing reaches the server and **the three daily ad
missions cannot be completed**. That is the gap these steps close.

---

## Step 2 — Create the AdMob app and rewarded ad units

1. Sign in at [apps.admob.com](https://apps.admob.com) with the Google account
   that should own the ad revenue. This is a monetisation account and is
   separate from the Play Console login, though the same Google account can hold
   both.

2. **Apps → Add app.** Answer "Yes" to *Is your app listed on a supported app
   store?* if `com.voucherhunt.mobile` is already published, and search for it;
   otherwise answer "No" and name it *Voucher Hunt*. Choose **Android**.
   - Create a second app for **iOS** only when the iOS build actually ships.
     The repo already reads a separate iOS id, so nothing changes when you do.

3. Copy the **App ID**. It looks like `ca-app-pub-1234567890123456~1234567890`
   — the separator is a **tilde**. This is the value the native SDK needs at
   launch, and the SDK crashes on startup if it is wrong, so paste it rather
   than typing it.

4. **Ad units → Add ad unit → Rewarded.**
   - Name it something you will recognise in reports, e.g. `voucher-hunt-daily-rewarded`.
   - **Reward amount: 1. Reward item: `mission`.** The server does not read
     either value — the mission's own reward table decides what a player gets —
     but AdMob requires them, and keeping them boring avoids implying the number
     means something it does not.
   - Leave the rest at defaults.

5. Copy the **Ad unit ID**. It looks like
   `ca-app-pub-1234567890123456/1234567890` — the separator here is a **slash**.
   Mixing the tilde and slash ids up is the single most common setup mistake:
   the SDK initialises happily and then never fills.

6. Put all of it in the environment the app is built with:

   ```
   EXPO_PUBLIC_ADMOB_ANDROID_APP_ID=ca-app-pub-…~…
   EXPO_PUBLIC_ADMOB_REWARDED_UNIT_ANDROID=ca-app-pub-…/…
   ```

   The **app id is read at build time** and baked into the native manifest, so
   it needs a rebuild, not a restart. For EAS builds set both as EAS environment
   variables (or in `eas.json` `env`), not just in a local `.env`.

> **New AdMob accounts are not approved instantly.** Google reviews the account,
> and until it is approved ad units return no-fill. The app handles that
> correctly — the button says no ad is available — but do not read an empty
> response in the first day or two as a wiring fault.

---

## Step 4 — Point server-side verification at this backend

This is what actually makes an ad pay.

1. In AdMob, open the rewarded ad unit → **Server-side verification**.

2. Set the callback URL to:

   ```
   https://<your-domain>/api/public/gamification/ads/ssv
   ```

   Use the real deployed host. It must be **HTTPS and publicly reachable** —
   Google calls it from its own servers, so `localhost` and any private network
   address will silently never work.

3. Leave **"Send SSV callbacks"** enabled. Do not add extra query parameters;
   the endpoint verifies Google's signature over the exact query string it
   receives, and anything appended by hand invalidates that signature.

4. Set `ADMOB_SSV_NONCE_SECRET` in the **server's** production environment to at
   least 32 random characters. A local value has already been generated in
   `.env` for development. Production should have its own — it falls back to
   `ADMIN_SESSION_SECRET` when unset, which works but ties two unrelated secrets
   to the same rotation.

   ```bash
   node -e "console.log(require('crypto').randomBytes(36).toString('base64url'))"
   ```

---

## Verifying it works

Do these in order; each one isolates a different half.

1. **Ad plays at all.** Install a dev or production build (not Expo Go — the ad
   SDK is native and the app deliberately hides the Watch button where it is
   absent). Open Quests inside one of the ad windows — 06:00–10:59, 11:00–14:59
   or 17:00–21:59 Manila — and tap **Watch**. A test ad should play.

2. **The callback arrives.** Watch the server logs while finishing a real ad.
   The endpoint answers JSON with a `status`:
   - `accepted` — verified and credited. The mission flips within a second or two.
   - `duplicate` — the same `transaction_id` already banked. Correct behaviour on
     a retry, not an error.
   - `rejected` with `E-ADMOB-SIGNATURE` — the signature did not verify. Almost
     always a modified callback URL or an appended parameter.
   - `rejected` with `E-ADMOB-NONCE` — the `custom_data` did not resolve to a
     wallet. Usually the server's nonce secret differs from the one that minted
     it, i.e. the app talked to a different environment than the one being
     watched.
   - `rejected` with `E-ADMOB-STALE` — the callback is outside its 15-minute
     window. Check the server clock.

   The endpoint always answers **200**, deliberately: a non-200 makes AdMob
   retry a callback that has already been banked. Read `status`, not the code.

3. **The mission completes.** The card moves out of AVAILABLE and the reward
   lands as 5 LP + 10 XP. If the ad plays but the mission never flips, the ad
   half is fine and the SSV half is not — step 4 is where to look, and step 2 is
   where to check you are not still on the test unit.

---

## Notes worth keeping

- **The app can never grant an ad reward.** Finishing the video only tells the
  app to go and re-read the profile; the credit exists solely because Google
  called the server. Nothing in the client can shortcut that, which is the
  point of §12's ad-fraud control.
- **The nonce is short-lived and signed**, carrying a wallet id and an expiry —
  never a phone number. Nothing personal travels through Google.
- **Replays are banked once.** `ad_verifications.transaction_id` is unique, so a
  repeated callback records nothing and pays nothing.
- **The cap is structural, not a counter.** Each ad mission is one per window
  per Manila day, so a second ad in the same evening credits nothing because
  that evening's mission is already claimed. The `viewsToday` the nonce
  endpoint returns is informational — it is reported, not enforced — so do not
  read it as a limit that will stop anything on its own.
- **iOS needs App Tracking Transparency** before it ships with personalised ads.
  The plugin accepts a `userTrackingUsageDescription`; add it when iOS is
  actually on the roadmap rather than now.
