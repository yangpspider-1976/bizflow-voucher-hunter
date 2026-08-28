import Constants from "expo-constants";
import * as Device from "expo-device";
import { Platform } from "react-native";

import { apiRequest } from "@/api/client";

type NotificationsModule = typeof import("expo-notifications");

/**
 * Push registration.
 *
 * Remote push is unavailable in Expo Go on Android from SDK 53 onward, so this
 * only does anything in a development or production build. Emulators have no
 * push transport at all, hence the `Device.isDevice` guard — without it the
 * token request throws on every simulator run.
 */

export type PushPreferences = {
  daily: boolean;
  reservation: boolean;
  rewards: boolean;
  missions: boolean;
  /**
   * Marketing consent, which partner-promotion announcements need on top of the
   * mission category. Two separate questions: "tell me about my missions" and
   * "tell me about promotions near me".
   */
  marketing: boolean;
  /** On by default: no notifications between 10 PM and 8 AM Manila. */
  quietHours: boolean;
};

type PushDevice = {
  id: string;
  expoPushToken: string;
  dailyEnabled: boolean;
  reservationEnabled: boolean;
  rewardsEnabled: boolean;
  missionsEnabled: boolean;
  marketingEnabled: boolean;
  quietHoursEnabled: boolean;
};

let notificationsPromise: Promise<NotificationsModule | null> | null = null;
let handlerConfigured = false;

function isExpoGo() {
  return Constants.appOwnership === "expo";
}

async function getNotifications(): Promise<NotificationsModule | null> {
  if (isExpoGo()) return null;

  notificationsPromise ??= (async () => {
    try {
      return await import("expo-notifications");
    } catch {
      return null;
    }
  })();
  const notifications = await notificationsPromise;
  if (!notifications || handlerConfigured) return notifications;

  /** Foreground presentation: without this a notification arriving while the app
   *  is open is delivered silently and the customer never sees it. */
  notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
    }),
  });
  handlerConfigured = true;
  return notifications;
}

function projectId(): string | undefined {
  return (
    Constants.expoConfig?.extra?.eas?.projectId ??
    Constants.easConfig?.projectId
  );
}

/**
 * Asks for permission and returns the Expo push token, or null when push is
 * unavailable (simulator, permission denied, Expo Go, missing EAS project).
 * Never throws — a customer refusing notifications must not break sign-in.
 */
export async function acquirePushToken(): Promise<string | null> {
  try {
    const Notifications = await getNotifications();
    if (!Notifications) return null;
    if (!Device.isDevice) return null;

    if (Platform.OS === "android") {
      // Android 13+ will not show the permission prompt without a channel.
      await Notifications.setNotificationChannelAsync("default", {
        name: "Voucher Hunt",
        importance: Notifications.AndroidImportance.DEFAULT,
        lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
      });
    }

    const existing = await Notifications.getPermissionsAsync();
    let status = existing.status;
    if (status !== "granted") {
      // Only prompt if the OS still allows it; re-asking after a hard denial is
      // a no-op and just burns the one prompt Android grants.
      if (!existing.canAskAgain) return null;
      status = (await Notifications.requestPermissionsAsync()).status;
    }
    if (status !== "granted") return null;

    const id = projectId();
    if (!id) return null;

    const token = await Notifications.getExpoPushTokenAsync({ projectId: id });
    return token.data ?? null;
  } catch {
    return null;
  }
}

/** Registers the token against the signed-in phone. Best-effort. */
export async function registerPushToken(token: string, authToken: string) {
  try {
    await apiRequest<PushDevice>("/api/public/notifications/devices", {
      method: "POST",
      body: { expoPushToken: token, platform: Platform.OS },
      token: authToken,
    });
  } catch {
    // A registration failure only costs notifications, never the session.
  }
}

/** Drops the device server-side so a signed-out phone stops receiving pushes. */
export async function unregisterPushToken(token: string, authToken: string) {
  try {
    await apiRequest("/api/public/notifications/devices", {
      method: "DELETE",
      body: { expoPushToken: token },
      token: authToken,
    });
  } catch {
    // Ignored: sign-out must complete regardless.
  }
}

export async function fetchPushPreferences(
  authToken: string,
): Promise<PushPreferences | null> {
  try {
    const devices = await apiRequest<PushDevice[]>(
      "/api/public/notifications/devices",
      { token: authToken },
    );
    const device = devices[0];
    if (!device) return null;
    return {
      daily: device.dailyEnabled,
      reservation: device.reservationEnabled,
      rewards: device.rewardsEnabled,
      // Defaulted rather than assumed absent: a device registered before these
      // columns existed is opted in, which is what its row already meant.
      missions: device.missionsEnabled ?? true,
      marketing: device.marketingEnabled ?? true,
      quietHours: device.quietHoursEnabled ?? true,
    };
  } catch {
    return null;
  }
}

export async function updatePushPreferences(
  next: Partial<PushPreferences>,
  authToken: string,
) {
  return apiRequest<PushDevice[]>("/api/public/notifications/devices", {
    method: "PATCH",
    body: next,
    token: authToken,
  });
}
