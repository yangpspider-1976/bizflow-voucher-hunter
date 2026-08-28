import * as Location from "expo-location";

import type { MissionLocation } from "@/api/client";

/**
 * The phone's position, for missions that have a radius.
 *
 * Asked for at the moment somebody taps Join on a nearby mission, never at
 * launch. A permission prompt that arrives with no visible reason is the one
 * people deny, and every other mission in the app works without it.
 *
 * Nothing here decides eligibility. The server does the radius test, applies
 * the accuracy floor and refuses a mocked fix — this only measures and reports,
 * `mocked` flag included, because hiding a signal the OS is offering would make
 * the server's job impossible.
 */
export async function readMissionLocation(): Promise<
  { ok: true; location: MissionLocation } | { ok: false; reason: "denied" | "unavailable" }
> {
  try {
    const permission = await Location.requestForegroundPermissionsAsync();
    if (!permission.granted) return { ok: false, reason: "denied" };

    const position = await Location.getCurrentPositionAsync({
      // Balanced rather than highest: the server's floor is 200 metres, and
      // asking for GPS-grade precision indoors means a long wait for a fix that
      // is no more useful.
      accuracy: Location.Accuracy.Balanced,
    });
    return {
      ok: true,
      location: {
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
        ...(typeof position.coords.accuracy === "number"
          ? { accuracyMeters: position.coords.accuracy }
          : {}),
        ...(position.mocked ? { mocked: true } : {}),
      },
    };
  } catch {
    // A device with location services switched off, or an emulator with no
    // provider. Not an error worth a stack trace — the mission simply cannot be
    // joined from here.
    return { ok: false, reason: "unavailable" };
  }
}
