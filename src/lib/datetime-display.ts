/**
 * Manila-fixed formatting for timestamps shown in the dashboard.
 *
 * Every instant we store is UTC (`new Date().toISOString()`), while every
 * operator reading it is on Manila wall-clock time. `toLocaleString("en-PH")`
 * does not bridge that gap: a locale picks the month names and digit order, not
 * the zone. Without an explicit `timeZone` the runtime falls back to the host's,
 * which is UTC on the deployment host — so a voucher redeemed at 4:44 PM
 * rendered as "8:44 AM", and any activity between midnight and 8 AM Manila
 * rendered a day early.
 *
 * Pinning the zone here rather than at each call site keeps that fix from having
 * to be remembered again by the next page that prints a timestamp.
 */

/** The only zone this product displays in. Matches `server/gamification/time.ts`. */
export const DISPLAY_TIME_ZONE = "Asia/Manila";

const DATE_PARTS = {
  year: "numeric",
  month: "short",
  day: "numeric",
} as const;

const TIME_PARTS = {
  hour: "numeric",
  minute: "2-digit",
} as const;

/**
 * A stored instant as a Manila date and time, e.g. "Sep 4, 2026, 4:44 PM".
 *
 * Unparseable input is passed through untouched rather than shown as "Invalid
 * Date": the raw value is at least a clue for whoever has to debug it.
 */
export function formatDateTime(value?: string | null, fallback = "—") {
  if (!value) return fallback;
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleString("en-PH", {
        ...DATE_PARTS,
        ...TIME_PARTS,
        timeZone: DISPLAY_TIME_ZONE,
      });
}

/** The Manila calendar date of a stored instant, e.g. "Sep 4, 2026". */
export function formatDate(value?: string | null, fallback = "—") {
  if (!value) return fallback;
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleDateString("en-PH", { ...DATE_PARTS, timeZone: DISPLAY_TIME_ZONE });
}
