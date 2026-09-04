/**
 * Dynamic Expo config. This replaces the previous static `app.json` so the
 * App Link domain can come from the environment rather than being baked in —
 * the deployed host is an ops decision (see docs/MOBILE_APP_MIGRATION.md §0).
 *
 * Env:
 *   EXPO_PUBLIC_API_BASE_URL  – the backend the app talks to (required at runtime)
 *   EXPO_PUBLIC_APP_LINK_HOST – bare hostname (no scheme) that should open the app,
 *                               e.g. "vouchers.example.com". Optional; when unset
 *                               only the custom scheme is registered.
 *   EXPO_PUBLIC_ADMOB_ANDROID_APP_ID / EXPO_PUBLIC_ADMOB_IOS_APP_ID
 *                             – AdMob application ids (the "~" kind). Optional;
 *                               the published Google test ids are used when unset,
 *                               so a build without an AdMob account still runs.
 */

/**
 * AdMob application ids, baked into the manifest at build time.
 *
 * These are not the ad unit ids — they identify the app to the Google Mobile
 * Ads SDK, and the SDK **crashes at launch** if the value is missing or
 * malformed. That is why the fallback is Google's own published test
 * application id rather than an empty string: a build made without the AdMob
 * account configured still starts, still shows test ads, and still exercises
 * the whole rewarded flow. Only the money is missing.
 *
 * Real ids come from the environment at build time, so the value that ships is
 * an ops decision like the API host above it, not something baked into git.
 *
 * Note these carry a `~` between the two halves. The ad *unit* ids used at
 * runtime carry a `/`, and mixing the two up is the most common way to get an
 * SDK that initialises and then never fills.
 */
const TEST_ANDROID_APP_ID = "ca-app-pub-3940256099942544~3347511713";
const TEST_IOS_APP_ID = "ca-app-pub-3940256099942544~1458002511";

const androidAppId = process.env.EXPO_PUBLIC_ADMOB_ANDROID_APP_ID?.trim() || TEST_ANDROID_APP_ID;
const iosAppId = process.env.EXPO_PUBLIC_ADMOB_IOS_APP_ID?.trim() || TEST_IOS_APP_ID;

/** Brand purple — `--purple` in the web's globals.css. */
const BRAND_PURPLE = "#5c3dff";

const appLinkHost = process.env.EXPO_PUBLIC_APP_LINK_HOST?.trim();
/**
 * Android intent filters.
 *
 * The custom scheme always works and needs no domain verification, so it is the
 * dependable path for dev and for links we generate ourselves. The https filter is
 * only added when a host is configured, because `autoVerify` against a host that
 * does not serve `/.well-known/assetlinks.json` silently fails verification and
 * leaves Android showing a disambiguation dialog.
 */
function intentFilters() {
  const filters = [
    {
      action: "VIEW",
      category: ["BROWSABLE", "DEFAULT"],
      data: [{ scheme: "voucherhunt" }],
    },
  ];

  if (appLinkHost) {
    filters.push({
      action: "VIEW",
      autoVerify: true,
      category: ["BROWSABLE", "DEFAULT"],
      // Scoped to the customer paths. Leaving it open would also capture the
      // admin dashboard and the referral handoff, which must stay in the browser.
      data: [
        { scheme: "https", host: appLinkHost, pathPrefix: "/campaign" },
        { scheme: "https", host: appLinkHost, pathPrefix: "/vouchers" },
      ],
    });
  }

  return filters;
}

module.exports = {
  expo: {
    name: "Voucher Hunt",
    slug: "voucher-hunt",
    // Customer-visible version. `android.versionCode` is deliberately absent:
    // eas.json sets `appVersionSource: "remote"`, so EAS owns the version code
    // and bumps it per production build. Declaring it here would conflict.
    version: "1.6.0",
    orientation: "portrait",
    icon: "./assets/images/icon.png",
    scheme: "voucherhunt",
    userInterfaceStyle: "light",
    ios: {
      // No `icon` override: the template pointed at `./assets/expo.icon`, which is
      // Expo's own artwork. Falling through to the brand `icon` above keeps iOS
      // consistent when it is eventually built (Android ships first).
      supportsTablet: false,
      associatedDomains: appLinkHost ? [`applinks:${appLinkHost}`] : undefined,
    },
    android: {
      adaptiveIcon: {
        backgroundColor: BRAND_PURPLE,
        foregroundImage: "./assets/images/android-icon-foreground.png",
        backgroundImage: "./assets/images/android-icon-background.png",
        monochromeImage: "./assets/images/android-icon-monochrome.png",
      },
      predictiveBackGestureEnabled: false,
      package: "com.voucherhunt.mobile",
      intentFilters: intentFilters(),
      // The customer app only displays QR codes; scanning is staff-only and stays
      // on the web. Nothing here may request SMS permissions — that is a Play
      // restricted permission and the OTP is sent server-side anyway.
      //
      // Location is here for one feature only: an urgent mission confined to a
      // radius around a partner. It is requested at the moment somebody taps
      // Join on one of those, never at launch, and the app works without it —
      // every other mission ignores it. Evidence is picked from the gallery,
      // never the camera, so CAMERA and RECORD_AUDIO are blocked below.
      permissions: [
        "android.permission.ACCESS_COARSE_LOCATION",
        "android.permission.ACCESS_FINE_LOCATION",
      ],
      // Stripped from the merged manifest whatever adds them. SMS is a Play
      // restricted permission and the OTP is sent server-side; camera and
      // microphone are unused and come in only as a side effect of the image
      // picker's defaults, which are also turned off at the plugin. Two locks
      // on the same door, because the manifest is what ships.
      blockedPermissions: [
        "android.permission.READ_SMS",
        "android.permission.RECEIVE_SMS",
        "android.permission.CAMERA",
        "android.permission.RECORD_AUDIO",
      ],
    },
    web: {
      output: "static",
      favicon: "./assets/images/favicon.png",
    },
    plugins: [
      "expo-router",
      [
        "expo-splash-screen",
        {
          // White, not the brand purple: the splash artwork carries its own
          // purple tile, so a purple field made the launch screen one flat block
          // of colour with the mark barely readable inside it.
          backgroundColor: "#ffffff",
          image: "./assets/images/splash-icon.png",
          imageWidth: 140,
        },
      ],
      "expo-secure-store",
      "expo-localization",
      [
        "expo-image-picker",
        {
          photosPermission:
            "Voucher Hunt needs access to your photos so you can send a receipt or photo as mission evidence.",
          // Gallery only: nothing in the app calls launchCameraAsync. Left at
          // their defaults the plugin adds CAMERA and RECORD_AUDIO anyway,
          // because it also ships a camera path we do not use — and a voucher
          // app asking for a microphone is both untrue and the kind of thing a
          // Play reviewer stops on. Verified against the built .aab, not
          // assumed: see the permission diff in docs/PLAY_RELEASE.md.
          cameraPermission: false,
          microphonePermission: false,
        },
      ],
      [
        "expo-location",
        {
          locationAlwaysAndWhenInUsePermission:
            "Voucher Hunt uses your location only to check you are near a partner when you join a nearby mission.",
        },
      ],
      [
        "react-native-google-mobile-ads",
        {
          androidAppId,
          iosAppId,
          // The SDK starts itself on the first ad request rather than at
          // launch. Nothing asks for an ad until a player taps an ad mission,
          // so initialising eagerly would be a cold-start cost for a feature
          // most sessions never touch.
          optimizeInitialization: true,
          optimizeAdLoading: true,
        },
      ],
      [
        "expo-notifications",
        {
          // Android renders the notification icon as a white silhouette from the
          // alpha channel, so the monochrome launcher layer is the right source.
          icon: "./assets/images/android-icon-monochrome.png",
          color: BRAND_PURPLE,
        },
      ],
    ],
    extra: {
      eas: {
        projectId: "fdf07bda-f818-426f-84a7-9f6083101b77",
      },
    },
    experiments: {
      typedRoutes: true,
      reactCompiler: true,
    },
  },
};
