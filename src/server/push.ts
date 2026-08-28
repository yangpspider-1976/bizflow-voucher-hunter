import crypto from "node:crypto";
import { all, getDb, one, run, type Exec } from "@/server/db";
import { manilaClock, manilaDate, withinWindow } from "@/server/gamification/time";

/**
 * Push notifications via Expo's push service.
 *
 * Expo relays to FCM on our behalf, so the server needs no Firebase credentials
 * for the default (non-standalone-FCM) setup — only the device's Expo push token.
 * Sending is deliberately best-effort: a failed notification must never fail the
 * business operation that triggered it, exactly as `sendVoucherConfirmationSms`
 * behaves for SMS.
 */

const EXPO_PUSH_ENDPOINT = "https://exp.host/--/api/v2/push/send";

/** How long to wait on Expo before giving up and logging the attempt as failed. */
const SEND_TIMEOUT_MS = Number(process.env.PUSH_TIMEOUT_MS ?? 8000);

export type PushCategory = "daily" | "reservation" | "rewards" | "missions";

/** Column on `push_devices` that opts a device out of each category. */
const CATEGORY_COLUMN: Record<PushCategory, string> = {
  daily: "daily_enabled",
  reservation: "reservation_enabled",
  rewards: "rewards_enabled",
  missions: "missions_enabled",
};

export type PushDevice = {
  id: string;
  phone: string;
  expoPushToken: string;
  platform: string;
  dailyEnabled: boolean;
  reservationEnabled: boolean;
  rewardsEnabled: boolean;
  missionsEnabled: boolean;
  /**
   * Marketing consent, separate from the mission category.
   *
   * A player can want to know their evidence was approved (transactional) and
   * not want to be told about a partner promotion two streets away (marketing).
   * The requirements treat urgent-mission pushes as the second kind, so they
   * need both switches on.
   */
  marketingEnabled: boolean;
  /** False when the player has chosen to be notified at any hour. */
  quietHoursEnabled: boolean;
};

type Row = any;

function mapDevice(row: Row): PushDevice {
  return {
    id: String(row.id),
    phone: String(row.phone),
    expoPushToken: String(row.expo_push_token),
    platform: String(row.platform),
    dailyEnabled: Number(row.daily_enabled) === 1,
    reservationEnabled: Number(row.reservation_enabled) === 1,
    rewardsEnabled: Number(row.rewards_enabled) === 1,
    missionsEnabled: Number(row.missions_enabled ?? 1) === 1,
    marketingEnabled: Number(row.marketing_enabled ?? 1) === 1,
    quietHoursEnabled: Number(row.quiet_hours_enabled ?? 1) === 1,
  };
}

const isoNow = () => new Date().toISOString();
const id = (prefix: string) => `${prefix}_${crypto.randomBytes(8).toString("hex")}`;

/** Expo tokens look like `ExponentPushToken[xxx]` or `ExpoPushToken[xxx]`. */
export function isExpoPushToken(value: string) {
  return /^Expo(nent)?PushToken\[[^\]]+\]$/.test(value.trim());
}

/**
 * Registers (or refreshes) a device for a phone.
 *
 * Keyed on the token, not the phone: a token is unique per app install, and the
 * same handset can be handed to another customer. Re-registering an existing
 * token moves it to the current phone so the previous owner stops receiving that
 * device's notifications.
 */
export async function registerPushDevice(input: {
  phone: string;
  expoPushToken: string;
  platform: string;
}) {
  const db = await getDb();
  const token = input.expoPushToken.trim();
  const now = isoNow();
  const existing = await one(
    db,
    "SELECT * FROM push_devices WHERE expo_push_token = ?",
    [token],
  );

  if (existing) {
    await run(
      db,
      "UPDATE push_devices SET phone = ?, platform = ?, last_seen_at = ? WHERE expo_push_token = ?",
      [input.phone, input.platform, now, token],
    );
  } else {
    await run(
      db,
      `INSERT INTO push_devices
       (id, phone, expo_push_token, platform, created_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [id("pdev"), input.phone, token, input.platform, now, now],
    );
  }

  return mapDevice(
    await one(db, "SELECT * FROM push_devices WHERE expo_push_token = ?", [token]),
  );
}

/** Removes a device, e.g. on sign-out. */
export async function unregisterPushDevice(expoPushToken: string) {
  const db = await getDb();
  await run(db, "DELETE FROM push_devices WHERE expo_push_token = ?", [
    expoPushToken.trim(),
  ]);
}

export async function listPushDevices(phone: string): Promise<PushDevice[]> {
  const db = await getDb();
  return (
    await all(db, "SELECT * FROM push_devices WHERE phone = ?", [phone])
  ).map(mapDevice);
}

export async function setPushPreferences(input: {
  phone: string;
  daily?: boolean;
  reservation?: boolean;
  rewards?: boolean;
  missions?: boolean;
  marketing?: boolean;
  quietHours?: boolean;
}) {
  const db = await getDb();
  const sets: string[] = [];
  const args: (string | number)[] = [];
  if (input.daily !== undefined) {
    sets.push("daily_enabled = ?");
    args.push(input.daily ? 1 : 0);
  }
  if (input.reservation !== undefined) {
    sets.push("reservation_enabled = ?");
    args.push(input.reservation ? 1 : 0);
  }
  if (input.rewards !== undefined) {
    sets.push("rewards_enabled = ?");
    args.push(input.rewards ? 1 : 0);
  }
  if (input.missions !== undefined) {
    sets.push("missions_enabled = ?");
    args.push(input.missions ? 1 : 0);
  }
  if (input.marketing !== undefined) {
    sets.push("marketing_enabled = ?");
    args.push(input.marketing ? 1 : 0);
  }
  if (input.quietHours !== undefined) {
    sets.push("quiet_hours_enabled = ?");
    args.push(input.quietHours ? 1 : 0);
  }
  if (sets.length === 0) return listPushDevices(input.phone);

  args.push(input.phone);
  await run(db, `UPDATE push_devices SET ${sets.join(", ")} WHERE phone = ?`, args);
  return listPushDevices(input.phone);
}

export type PushMessage = {
  phone: string;
  category: PushCategory;
  title: string;
  body: string;
  /** Deep-link target etc., delivered to the app as the notification payload. */
  data?: Record<string, unknown>;
  /**
   * When set, the send is skipped if a log row already carries this key. Use it
   * for anything a scheduler might replay — `daily:<phone>:<manila-date>`.
   */
  dedupeKey?: string;
  /**
   * Marketing rather than transactional. Delivered only to devices that also
   * left marketing consent on, and counted against the daily cap below.
   */
  marketing?: boolean;
  /**
   * Manila blackout hours. A device whose owner turned quiet hours off is sent
   * to anyway; everyone else waits. Supplied by the caller rather than read
   * here, because the window is an economy setting an operator publishes and
   * this file is transport.
   */
  quietHours?: { start: string; end: string } | null;
  /**
   * The most messages of this category one phone may receive in a Manila day.
   * Null is uncapped, which is right for anything transactional.
   */
  dailyCap?: number | null;
};

export type PushResult = {
  sent: number;
  skipped: number;
  failed: number;
};

/**
 * Sends one notification to every eligible device for a phone.
 *
 * Never throws: callers are business flows (approving a purchase, issuing a
 * voucher) whose success must not depend on the notification going out.
 */
export async function sendPush(message: PushMessage): Promise<PushResult> {
  const result: PushResult = { sent: 0, skipped: 0, failed: 0 };
  try {
    const db = await getDb();

    if (message.dedupeKey) {
      const seen = await one(db, "SELECT 1 FROM push_logs WHERE dedupe_key = ?", [
        message.dedupeKey,
      ]);
      if (seen) {
        result.skipped += 1;
        return result;
      }
    }

    // A per-person ceiling on how often one category may interrupt somebody.
    // Counted on delivered messages rather than attempts, so a run that was
    // itself skipped does not use up somebody else’s quiet evening.
    if (message.dailyCap !== null && message.dailyCap !== undefined) {
      const today = manilaDate();
      const sentToday = await one(
        db,
        `SELECT COUNT(*) AS total FROM push_logs
         WHERE phone = ? AND category = ? AND status = 'sent' AND created_at >= ?`,
        [message.phone, message.category, `${today}T00:00:00.000Z`],
      );
      if (Number(sentToday?.total ?? 0) >= message.dailyCap) {
        result.skipped += 1;
        return result;
      }
    }

    const column = CATEGORY_COLUMN[message.category];
    const clauses = [`${column} = 1`];
    if (message.marketing) clauses.push("marketing_enabled = 1");
    const devices = (
      await all(
        db,
        `SELECT * FROM push_devices WHERE phone = ? AND ${clauses.join(" AND ")}`,
        [message.phone],
      )
    ).map(mapDevice);

    if (devices.length === 0) {
      result.skipped += 1;
      return result;
    }

    // Quiet hours are per device, because the setting is. A household phone
    // that opted out of them still rings; the one that did not, does not.
    const quiet = message.quietHours ?? null;
    const inBlackout = quiet
      ? withinWindow(manilaClock(), { startTime: quiet.start, endTime: quiet.end })
      : false;
    const wakeable = inBlackout
      ? devices.filter((device) => !device.quietHoursEnabled)
      : devices;
    if (wakeable.length === 0) {
      result.skipped += 1;
      return result;
    }

    const tickets = await deliver(
      wakeable.map((device) => ({
        to: device.expoPushToken,
        title: message.title,
        body: message.body,
        data: message.data ?? {},
        sound: "default",
        channelId: "default",
      })),
    );

    for (const [index, device] of wakeable.entries()) {
      const ticket = tickets[index];
      const ok = ticket?.status === "ok";
      if (ok) result.sent += 1;
      else result.failed += 1;

      await logPush(db, {
        message,
        device,
        status: ok ? "sent" : "failed",
        ticketId: ticket?.id,
        failureReason: ok ? undefined : (ticket?.message ?? "no ticket returned"),
        // Only the first device carries the dedupe key — the unique index would
        // reject the rest, and one delivery per person is what dedupe means.
        dedupeKey: index === 0 ? message.dedupeKey : undefined,
      });

      // Expo reports a token that the OS has invalidated (app uninstalled,
      // notifications revoked). Keeping it would fail forever, so drop it.
      if (ticket?.details?.error === "DeviceNotRegistered") {
        await run(db, "DELETE FROM push_devices WHERE expo_push_token = ?", [
          device.expoPushToken,
        ]);
      }
    }
  } catch {
    // Swallowed by design — see the doc comment above.
    result.failed += 1;
  }
  return result;
}

type ExpoTicket = {
  status?: string;
  id?: string;
  message?: string;
  details?: { error?: string };
};

async function deliver(messages: unknown[]): Promise<ExpoTicket[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
  try {
    const response = await fetch(EXPO_PUSH_ENDPOINT, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        ...(process.env.EXPO_ACCESS_TOKEN
          ? { Authorization: `Bearer ${process.env.EXPO_ACCESS_TOKEN}` }
          : {}),
      },
      body: JSON.stringify(messages),
      signal: controller.signal,
    });
    const payload = (await response.json()) as { data?: ExpoTicket[] };
    return payload.data ?? [];
  } finally {
    clearTimeout(timer);
  }
}

async function logPush(
  db: Exec,
  input: {
    message: PushMessage;
    device: PushDevice;
    status: string;
    ticketId?: string;
    failureReason?: string;
    dedupeKey?: string;
  },
) {
  try {
    await run(
      db,
      `INSERT INTO push_logs
       (id, phone, expo_push_token, category, title, body, data, status, ticket_id, failure_reason, dedupe_key, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id("plog"),
        input.message.phone,
        input.device.expoPushToken,
        input.message.category,
        input.message.title,
        input.message.body,
        input.message.data ? JSON.stringify(input.message.data) : null,
        input.status,
        input.ticketId ?? null,
        input.failureReason ?? null,
        input.dedupeKey ?? null,
        isoNow(),
      ],
    );
  } catch {
    // A logging failure must not break delivery accounting.
  }
}
