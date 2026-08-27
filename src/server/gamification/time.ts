/**
 * Manila wall-clock arithmetic for resets and time windows.
 *
 * Timestamps are stored in UTC everywhere; only resets, daily windows and push
 * exposure are reckoned in Asia/Manila. The zone has been a flat UTC+8 with no
 * daylight saving since 1978, so the boundary maths here is a fixed offset
 * rather than a timezone database lookup — which is what makes "00:00 Manila,
 * every day of the year" a property that can be tested exhaustively instead of
 * a behaviour that depends on the host's ICU build.
 *
 * Nothing here reads a client clock. A device with its date moved forward is
 * simply a device whose events arrive with a server-assigned `received_at`.
 */

/** Asia/Manila is UTC+8, always. */
const MANILA_OFFSET_MINUTES = 8 * 60;
const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

/** The Manila calendar date, YYYY-MM-DD, of an instant. */
export function manilaDate(at: Date = new Date()): string {
  return shifted(at).toISOString().slice(0, 10);
}

/** Minutes since Manila midnight, 0-1439. */
export function manilaMinuteOfDay(at: Date = new Date()): number {
  const local = shifted(at);
  return local.getUTCHours() * 60 + local.getUTCMinutes();
}

/** The Manila wall clock as "HH:MM". */
export function manilaClock(at: Date = new Date()): string {
  const minutes = manilaMinuteOfDay(at);
  return `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
}

/** The instant Manila midnight starts a given Manila date, as a UTC ISO string. */
export function manilaMidnightUtc(date: string): string {
  const midnight = Date.parse(`${date}T00:00:00.000Z`) - MANILA_OFFSET_MINUTES * MINUTE_MS;
  return new Date(midnight).toISOString();
}

/** The instant the current Manila day ends — i.e. the next daily reset. */
export function manilaDayEndUtc(at: Date = new Date()): string {
  return manilaMidnightUtc(addManilaDays(manilaDate(at), 1));
}

/** Adds whole days to a YYYY-MM-DD Manila date. */
export function addManilaDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00.000Z`) + days * DAY_MS)
    .toISOString()
    .slice(0, 10);
}

/** Whole days from `from` to `to`, both YYYY-MM-DD. Negative if `to` is earlier. */
export function manilaDaysBetween(from: string, to: string): number {
  return Math.round(
    (Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / DAY_MS,
  );
}

/**
 * Whether a Manila wall-clock time falls inside a window.
 *
 * Both ends are inclusive, matching how the windows are written in the
 * requirements ("06:00-10:59" is the whole of the 06:00 hour through the whole
 * of the 10:59 minute). A window whose end is before its start wraps past
 * midnight, so a late-night mission can be expressed without two rows.
 */
export function withinWindow(
  clock: string,
  window: { startTime: string; endTime: string } | null,
): boolean {
  if (!window) return true;
  const now = toMinutes(clock);
  const start = toMinutes(window.startTime);
  const end = toMinutes(window.endTime);
  if (start <= end) return now >= start && now <= end;
  return now >= start || now <= end;
}

/**
 * How an event's own timestamp is judged against a window.
 *
 * Processing can lag — a queue backs up, a retry lands minutes later — and the
 * spec is explicit that an action performed inside the window counts even when
 * its event is handled outside it. So the window is tested against
 * `occurredAt`, never against the clock at processing time, with `graceMinutes`
 * of tolerance for a client whose own timestamp is slightly behind.
 */
export function eventWithinWindow(
  occurredAt: string,
  window: { startTime: string; endTime: string } | null,
  graceMinutes = 0,
): boolean {
  if (!window) return true;
  const at = new Date(occurredAt);
  if (Number.isNaN(at.getTime())) return false;
  if (withinWindow(manilaClock(at), window)) return true;
  if (graceMinutes <= 0) return false;
  // Grace only ever widens the window backwards from its close: an event that
  // arrived early is early, not late.
  const closed = new Date(at.getTime() - graceMinutes * MINUTE_MS);
  return withinWindow(manilaClock(closed), window);
}

function toMinutes(clock: string): number {
  const [hours, minutes] = clock.split(":").map(Number);
  return (hours ?? 0) * 60 + (minutes ?? 0);
}

function pad(value: number) {
  return String(value).padStart(2, "0");
}

function shifted(at: Date) {
  return new Date(at.getTime() + MANILA_OFFSET_MINUTES * MINUTE_MS);
}
