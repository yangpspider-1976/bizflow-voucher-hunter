/**
 * Rewarded ads, and the one thing worth understanding about them.
 *
 * **Finishing the ad does not pay the player.** The reward is granted when
 * Google's server calls our SSV endpoint carrying the signed `customData` this
 * module attaches to the request. `EARNED_REWARD` here only means the view
 * completed on the device; it is a cue to go and re-read the profile, never a
 * reason to credit anything locally. That split is the whole anti-abuse
 * design — a client that lies about watching an ad earns nothing, because the
 * client was never the one being asked.
 *
 * Because of that, the callback usually lands a beat *after* the ad closes.
 * `watchRewardedAd` resolves as soon as the ad is done; the caller re-reads the
 * profile with a short retry, because a mission that has not flipped yet is
 * waiting on Google's callback rather than broken.
 */
import { Platform } from "react-native";

/** How long to wait for an ad to fill before giving up on this tap. */
const LOAD_TIMEOUT_MS = 20_000;

/**
 * The SDK, loaded lazily and defensively.
 *
 * `react-native-google-mobile-ads` is a native module: it exists in a dev or
 * production build and does not exist in Expo Go. A bare import would take the
 * whole app down at startup in an environment where ads simply are not
 * available, so this returns null instead and every caller treats that as "no
 * ads here" rather than as an error.
 */
type AdsModule = typeof import("react-native-google-mobile-ads");

let cached: AdsModule | null | undefined;

function loadSdk(): AdsModule | null {
  if (cached !== undefined) return cached;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    cached = require("react-native-google-mobile-ads") as AdsModule;
  } catch {
    cached = null;
  }
  return cached;
}

/** Whether this build can show a rewarded ad at all. */
export function adsAvailable(): boolean {
  return loadSdk() !== null;
}

/**
 * The rewarded ad unit to request.
 *
 * Falls back to Google's published test unit, which always fills. That keeps a
 * build made without the AdMob account fully walkable — but note the test unit
 * cannot carry an SSV callback URL, so on test ads the server is never called
 * and the mission will not complete. That is a property of Google's test
 * inventory, not a bug here, and it is the reason the real unit id has to be
 * configured before this feature can pay anybody.
 */
function rewardedUnitId(sdk: AdsModule): string {
  const configured = (
    Platform.OS === "ios"
      ? process.env.EXPO_PUBLIC_ADMOB_REWARDED_UNIT_IOS
      : process.env.EXPO_PUBLIC_ADMOB_REWARDED_UNIT_ANDROID
  )?.trim();
  return configured || sdk.TestIds.REWARDED;
}

export type RewardedAdOutcome =
  /** The view completed. The credit is now Google's callback to deliver. */
  | { status: "earned" }
  /** Closed early, or dismissed. Nothing owed and nothing wrong. */
  | { status: "dismissed" }
  /** No ad available, or this build has no ad SDK. */
  | { status: "unavailable"; reason: string };

/**
 * Shows one rewarded ad, tagged with the signed custom data from the server.
 *
 * Resolves rather than rejects on the ordinary unhappy paths — no fill, closed
 * early — because none of those are errors a player should see a red message
 * about. Only a programming mistake throws.
 */
export function watchRewardedAd(customData: string): Promise<RewardedAdOutcome> {
  const sdk = loadSdk();
  if (!sdk) {
    return Promise.resolve({ status: "unavailable", reason: "no-sdk" });
  }

  const { AdEventType, RewardedAd, RewardedAdEventType } = sdk;

  return new Promise<RewardedAdOutcome>((resolve) => {
    const rewarded = RewardedAd.createForAdRequest(rewardedUnitId(sdk), {
      // The signed nonce the server minted. It is what ties Google's callback
      // back to one wallet, and without it a completed view is unattributable.
      serverSideVerificationOptions: { customData },
    });

    let earned = false;
    let settled = false;
    const unsubscribers: Array<() => void> = [];

    // One exit for every path, so no listener outlives the ad and no tap can
    // resolve twice.
    const finish = (outcome: RewardedAdOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const off of unsubscribers) {
        try {
          off();
        } catch {
          // A listener that is already gone is not a problem worth surfacing.
        }
      }
      resolve(outcome);
    };

    const timer = setTimeout(
      () => finish({ status: "unavailable", reason: "timeout" }),
      LOAD_TIMEOUT_MS,
    );

    unsubscribers.push(
      rewarded.addAdEventListener(RewardedAdEventType.LOADED, () => {
        // Cleared here rather than left running: the timeout is on filling the
        // ad, not on how long somebody chooses to watch it.
        clearTimeout(timer);
        try {
          rewarded.show();
        } catch {
          finish({ status: "unavailable", reason: "show-failed" });
        }
      }),
    );

    unsubscribers.push(
      rewarded.addAdEventListener(RewardedAdEventType.EARNED_REWARD, () => {
        // Recorded, not acted on. The payout is the server's to make.
        earned = true;
      }),
    );

    unsubscribers.push(
      rewarded.addAdEventListener(AdEventType.CLOSED, () => {
        finish(earned ? { status: "earned" } : { status: "dismissed" });
      }),
    );

    unsubscribers.push(
      rewarded.addAdEventListener(AdEventType.ERROR, () => {
        finish({ status: "unavailable", reason: "no-fill" });
      }),
    );

    try {
      rewarded.load();
    } catch {
      finish({ status: "unavailable", reason: "load-failed" });
    }
  });
}
