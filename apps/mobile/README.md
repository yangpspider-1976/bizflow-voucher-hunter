# Voucher Hunt Mobile

Expo SDK 57 Android client for the customer-facing Voucher Hunt experience.
The Next.js app at the repository root remains the API server and web
admin/staff dashboard.

## Configure the API

Copy `.env.example` to `.env.local`, then set:

```env
EXPO_PUBLIC_API_BASE_URL=http://10.0.2.2:3000
```

- Android emulator: use `http://10.0.2.2:3000`.
- Physical Android device: use the development computer's LAN address, such
  as `http://192.168.1.10:3000`. The phone and computer must share a network.
- Production: use the stable HTTPS deployment. Non-HTTPS production URLs are
  rejected so bearer tokens are never sent over plaintext HTTP.

Do not put secrets in `EXPO_PUBLIC_*` variables. The API base URL is public
configuration.

## Configure Google Maps

The embedded business map uses the native Google Maps SDK. Expo Go carries
Expo's own Android Maps credential and cannot use this project's key, so test
the map in a development build:

1. In Google Cloud, enable **Maps SDK for Android**.
2. Create an Android-restricted API key for package
   `com.voucherhunt.mobile` and the signing certificate SHA-1.
3. Add the key to `apps/mobile/.env`:

   ```env
   GOOGLE_MAPS_API_KEY=your_restricted_android_maps_key
   ```

4. Rebuild the native development app once:

   ```bash
   cd apps/mobile
   npx expo run:android
   ```

After that build, keep Metro running with `npx expo start --dev-client`.
JavaScript and UI edits continue to update through Fast Refresh; rebuild only
when native dependencies or native configuration change.

For EAS builds, configure the same variable in the relevant EAS environment.
Use the SHA-1 of that environment's signing certificate in the Google Cloud key
restriction.

## Run

From the repository root, pick the backend the emulator should talk to:

```bash
npm run emulator:dev    # against the local Next server (run `npm run dev` first)
npm run emulator:prod   # against https://voucher-hunt.com
```

Both start Metro, open the Android emulator, and pin `EXPO_PUBLIC_API_BASE_URL`
for that session, so switching targets does not mean editing `.env.local`. They
clear the Metro cache on every start, because `EXPO_PUBLIC_*` values are inlined
into the bundle and a warm cache serves the previous target's URL.

They open the development build, which must be installed on the emulator once
(and again whenever native configuration changes):

```bash
npm run mobile:android
```

To start Metro without choosing a target — taking whatever `.env.local` holds —
use `npm run mobile` and press `a` in the Expo terminal.

## Phase 2 behavior

- Phone number and manual six-digit OTP sign-in.
- The OTP verify request opts into a mobile bearer token.
- The opaque bearer token and normalized phone are persisted with
  `expo-secure-store`.
- Expo Router protected routes prevent access to Home, Vouchers, and More
  until authentication is restored.
- Sign out revokes the server token and always clears the local secure
  session.
- Home and Vouchers are intentionally shell screens. Their data journeys are
  Phase 3 and Phase 4.

## Validation

```bash
npm run mobile:typecheck
npm run lint --workspace @voucher-hunt/mobile
cd apps/mobile
npx expo export --platform android --output-dir dist
```

`npx expo-doctor` currently reports 19/20 checks. Its remaining duplicate-React
warning is caused by the two applications intentionally requiring different
majors: the root Next.js 14 web app uses React 18, while Expo SDK 57 uses its
app-local React 19. Metro's Android export resolves the mobile-local copy and
passes. Do not add a root React override, because that would break the web
app's supported dependency range; revisit this when the web framework is
upgraded.
