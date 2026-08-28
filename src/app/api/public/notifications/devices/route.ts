import { z } from "zod";
import { requireSignedInCustomerPhone } from "@/server/customer-auth";
import { AppError, fail, ok } from "@/server/errors";
import { enforceRateLimit } from "@/server/rate-limit";
import {
  isExpoPushToken,
  listPushDevices,
  registerPushDevice,
  setPushPreferences,
  unregisterPushDevice,
} from "@/server/push";

export const dynamic = "force-dynamic";

const registerSchema = z.object({
  expoPushToken: z.string().trim().min(10),
  platform: z.enum(["android", "ios"]).default("android"),
});

const preferencesSchema = z.object({
  daily: z.boolean().optional(),
  reservation: z.boolean().optional(),
  rewards: z.boolean().optional(),
  missions: z.boolean().optional(),
  /**
   * Marketing consent, which urgent-mission announcements need on top of the
   * mission category. Kept separate because they are separate questions: "tell
   * me about my missions" and "tell me about partner promotions near me".
   */
  marketing: z.boolean().optional(),
  /** False opts out of the 22:00-08:00 Manila blackout. */
  quietHours: z.boolean().optional(),
});

/** Register this install's Expo push token against the signed-in phone. */
export async function POST(request: Request) {
  try {
    await enforceRateLimit(request, "notifications/devices", {
      limit: 20,
      windowMs: 60_000,
    });
    const phone = await requireSignedInCustomerPhone(request);
    const input = registerSchema.parse(await request.json());
    if (!isExpoPushToken(input.expoPushToken)) {
      throw new AppError(
        "E-PUSH-TOKEN",
        "A valid Expo push token is required",
        400,
      );
    }
    return ok(await registerPushDevice({ phone, ...input }));
  } catch (error) {
    return fail(error);
  }
}

/** Current devices and their per-category opt-in state. */
export async function GET(request: Request) {
  try {
    const phone = await requireSignedInCustomerPhone(request);
    return ok(await listPushDevices(phone));
  } catch (error) {
    return fail(error);
  }
}

/** Toggle notification categories for every device on this phone. */
export async function PATCH(request: Request) {
  try {
    const phone = await requireSignedInCustomerPhone(request);
    const input = preferencesSchema.parse(await request.json());
    return ok(await setPushPreferences({ phone, ...input }));
  } catch (error) {
    return fail(error);
  }
}

/**
 * Drop a device, used on sign-out. Scoped to the signed-in phone so one customer
 * cannot unregister another's device by guessing a token.
 */
export async function DELETE(request: Request) {
  try {
    const phone = await requireSignedInCustomerPhone(request);
    const input = registerSchema.pick({ expoPushToken: true }).parse(
      await request.json(),
    );
    const owned = (await listPushDevices(phone)).some(
      (device) => device.expoPushToken === input.expoPushToken.trim(),
    );
    if (owned) await unregisterPushDevice(input.expoPushToken);
    return ok({ unregistered: owned });
  } catch (error) {
    return fail(error);
  }
}
