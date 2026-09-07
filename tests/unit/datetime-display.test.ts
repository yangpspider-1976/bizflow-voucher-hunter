import { describe, expect, it } from "vitest";
import { formatDate, formatDateTime } from "@/lib/datetime-display";

/**
 * The bug these cover: the dashboard rendered stored UTC instants with
 * `toLocaleString("en-PH")` and no `timeZone`, so the deployment host's UTC
 * clock leaked into the page — a voucher redeemed at 4:44 PM Manila was shown
 * to operators as "8:44 AM".
 *
 * The assertions are absolute strings rather than a comparison against a
 * locally-formatted date, because a machine that is itself on UTC+8 (Manila,
 * Taipei, Singapore) renders the broken code correctly and would let a
 * relative assertion pass against the very bug it is meant to catch.
 */
describe("dashboard timestamp display", () => {
  // 4:44 PM Manila, the redemption from the reported screenshot.
  const redeemedAt = "2026-09-04T08:44:00.000Z";

  it("shows a redemption at its Manila wall-clock time, not the host's UTC", () => {
    expect(formatDateTime(redeemedAt)).toBe("Sep 4, 2026, 4:44 PM");
  });

  it("keeps the Manila calendar date for an instant that is still 'yesterday' in UTC", () => {
    // 12:30 AM Manila on Sep 5 is still 4:30 PM UTC on Sep 4. The date column
    // used to report the day before the customer's.
    expect(formatDate("2026-09-04T16:30:00.000Z")).toBe("Sep 5, 2026");
    expect(formatDateTime("2026-09-04T16:30:00.000Z")).toBe("Sep 5, 2026, 12:30 AM");
  });

  it("does not shift a date-only slot value onto the neighbouring day", () => {
    // Slot dates are stored as plain "YYYY-MM-DD" text and parse as UTC
    // midnight; adding +8 must not roll them forward.
    expect(formatDate("2026-09-05")).toBe("Sep 5, 2026");
  });

  it("renders a missing timestamp as an em dash rather than 'Invalid Date'", () => {
    expect(formatDateTime(undefined)).toBe("—");
    expect(formatDateTime(null)).toBe("—");
    expect(formatDate(undefined)).toBe("—");
  });

  it("passes an unparseable value through so it stays debuggable", () => {
    expect(formatDateTime("not-a-timestamp")).toBe("not-a-timestamp");
  });
});
