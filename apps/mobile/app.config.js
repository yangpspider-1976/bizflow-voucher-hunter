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
 */

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
      // every other mission ignores it. There is deliberately no CAMERA
      // permission: evidence is picked from the gallery, which on modern
      // Android needs no permission at all.
      permissions: [
        "android.permission.ACCESS_COARSE_LOCATION",
        "android.permission.ACCESS_FINE_LOCATION",
      ],
      blockedPermissions: [
        "android.permission.READ_SMS",
        "android.permission.RECEIVE_SMS",
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
          // Gallery only. A receipt is photographed with the camera app and
          // picked from the roll, which keeps CAMERA off the manifest.
          photosPermission:
            "Voucher Hunt needs access to your photos so you can send a receipt or photo as mission evidence.",
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
