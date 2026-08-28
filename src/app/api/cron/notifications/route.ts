import { assertCronAuth } from "@/server/cron-auth";
import { fail, ok } from "@/server/errors";
import {
  notifyDailyLoyaltyAvailable,
  notifyReservationReminder,
  phonesAwaitingDailyLoyalty,
  reservationsDueOn,
} from "@/server/notifications";
import {
  announceDailyWindow,
  remindMissionsClosingSoon,
} from "@/server/gamification/notify";
import { liveMissionDefinitions } from "@/server/gamification/missions";
import { getDb } from "@/server/db";
import { manilaClock, withinWindow } from "@/server/gamification/time";
import { manilaDateParts } from "@/server/rewards-network";

export const dynamic = "force-dynamic";
export const revalidate = 0;
/** Fan-out over many customers; well beyond the default serverless budget. */
export const maxDuration = 60;

/** `YYYY-MM-DD` for the Manila day `offsetDays` from now. */
function manilaDateOffset(offsetDays: number) {
  const target = new Date(Date.now() + offsetDays * 24 * 60 * 60 * 1000);
  return manilaDateParts(target).date;
}

/**
 * Scheduled notification fan-out.
 *
 * Invoked by an external scheduler (Vercel Cron, GitHub Actions, cron-job.org).
 * Suggested cadence — both jobs are safe to run more often than needed, because
 * every send is deduped:
 *   - `daily`       once a day, mid-morning Manila
 *   - `reservation` once a day, so bookings get a day-ahead reminder
 *   - `missions`    hourly: whichever time-boxed mission is open right now,
 *                   plus a reminder on anything closing within a few hours
 *
 * Auth: `assertCronAuth` — the shared `CRON_SECRET`, sent as `Authorization:
 * Bearer` (what Vercel Cron sends) or `?secret=`. It refuses to run when the
 * variable is unset, so a misconfigured deploy is never publicly invocable.
 */
export async function POST(request: Request) {
  try {
    assertCronAuth(request);
    const job = new URL(request.url).searchParams.get("job") ?? "all";

    const summary = {
      daily: { attempted: 0, sent: 0, skipped: 0, failed: 0 },
      reservation: { attempted: 0, sent: 0, skipped: 0, failed: 0 },
      missions: { windowsOpen: 0, windowNudges: 0, closingReminders: 0 },
    };

    if (job === "all" || job === "daily") {
      const date = manilaDateParts().date;
      const phones = await phonesAwaitingDailyLoyalty();
      summary.daily.attempted = phones.length;
      for (const phone of phones) {
        const result = await notifyDailyLoyaltyAvailable({ phone, date });
        summary.daily.sent += result.sent;
        summary.daily.skipped += result.skipped;
        summary.daily.failed += result.failed;
      }
    }

    if (job === "all" || job === "reservation") {
      // Tomorrow in Manila: a day-ahead reminder is early enough to act on and
      // late enough to be relevant.
      const date = manilaDateOffset(1);
      const due = await reservationsDueOn(date);
      summary.reservation.attempted = due.length;
      for (const reservation of due) {
        const result = await notifyReservationReminder({
          phone: reservation.phone,
          campaignSlug: reservation.campaignSlug,
          businessName: reservation.businessName,
          time: formatTime(reservation.startTime),
          date: reservation.date,
          voucherId: reservation.voucherId,
        });
        summary.reservation.sent += result.sent;
        summary.reservation.skipped += result.skipped;
        summary.reservation.failed += result.failed;
      }
    }

    if (job === "all" || job === "missions") {
      // Only the windows that are open at this minute. A mission announced at
      // 06:00 and again at 07:00 would be the same message twice, which is what
      // the per-mission-per-day dedupe key prevents; running hourly is what
      // makes the announcement land near the start of whichever window it is.
      const db = await getDb();
      const clock = manilaClock();
      const windowed = (await liveMissionDefinitions(db, { type: "DAILY" })).filter(
        (definition) => definition.window && withinWindow(clock, definition.window),
      );
      summary.missions.windowsOpen = windowed.length;
      for (const definition of windowed) {
        const result = await announceDailyWindow({ missionKey: definition.missionKey });
        summary.missions.windowNudges += result.notified;
      }
      const closing = await remindMissionsClosingSoon({ withinHours: 4 });
      summary.missions.closingReminders = closing.notified;
    }

    return ok(summary);
  } catch (error) {
    return fail(error);
  }
}

/** Mirrors the customer-facing 12-hour format used across both clients. */
function formatTime(time: string) {
  const [hours, minutes] = time.split(":").map(Number);
  const period = hours >= 12 ? "PM" : "AM";
  const twelveHour = hours % 12 === 0 ? 12 : hours % 12;
  return `${twelveHour}:${String(minutes).padStart(2, "0")} ${period}`;
}

/** Vercel Cron issues GET; delegate so either verb works. */
export async function GET(request: Request) {
  return POST(request);
}
