import { describe, expect, it } from "vitest";
import {
  addManilaDays,
  eventWithinWindow,
  manilaClock,
  manilaDate,
  manilaDayEndUtc,
  manilaDaysBetween,
  manilaMidnightUtc,
  manilaMinuteOfDay,
  withinWindow,
} from "@/server/gamification/time";

describe("Manila day boundaries", () => {
  it("rolls the date over at 16:00 UTC, not at midnight UTC", () => {
    // 15:59 UTC is 23:59 in Manila, still the same day.
    expect(manilaDate(new Date("2026-08-27T15:59:00.000Z"))).toBe("2026-08-27");
    expect(manilaDate(new Date("2026-08-27T16:00:00.000Z"))).toBe("2026-08-28");
  });

  it("reports the Manila wall clock, not the server's", () => {
    expect(manilaClock(new Date("2026-08-27T02:30:00.000Z"))).toBe("10:30");
    expect(manilaMinuteOfDay(new Date("2026-08-27T02:30:00.000Z"))).toBe(10 * 60 + 30);
  });

  it("turns a Manila date back into the UTC instant it started", () => {
    expect(manilaMidnightUtc("2026-08-28")).toBe("2026-08-27T16:00:00.000Z");
  });

  it("puts the daily reset at the next Manila midnight", () => {
    expect(manilaDayEndUtc(new Date("2026-08-27T02:00:00.000Z"))).toBe(
      "2026-08-27T16:00:00.000Z",
    );
    // Just before the reset, the next one is still tonight's.
    expect(manilaDayEndUtc(new Date("2026-08-27T15:59:59.000Z"))).toBe(
      "2026-08-27T16:00:00.000Z",
    );
    // Just after, it has moved on by a day.
    expect(manilaDayEndUtc(new Date("2026-08-27T16:00:01.000Z"))).toBe(
      "2026-08-28T16:00:00.000Z",
    );
  });

  it("holds a constant offset across a whole year, since Manila has no DST", () => {
    // The property the QA criteria ask for: every day of the year, one reset,
    // always sixteen hours into the UTC day.
    for (let day = 0; day < 365; day += 1) {
      const date = addManilaDays("2026-01-01", day);
      expect(manilaMidnightUtc(date).endsWith("T16:00:00.000Z")).toBe(true);
      expect(manilaDate(new Date(manilaMidnightUtc(date)))).toBe(date);
    }
  });

  it("counts calendar days between Manila dates", () => {
    expect(manilaDaysBetween("2026-08-27", "2026-08-28")).toBe(1);
    expect(manilaDaysBetween("2026-02-28", "2026-03-01")).toBe(1);
    expect(manilaDaysBetween("2026-08-28", "2026-08-27")).toBe(-1);
    expect(manilaDaysBetween("2026-08-27", "2026-08-27")).toBe(0);
  });
});

describe("mission windows", () => {
  const morning = { startTime: "06:00", endTime: "10:59" };

  it("includes both ends of the window", () => {
    expect(withinWindow("06:00", morning)).toBe(true);
    expect(withinWindow("10:59", morning)).toBe(true);
    expect(withinWindow("05:59", morning)).toBe(false);
    expect(withinWindow("11:00", morning)).toBe(false);
  });

  it("treats no window as always open", () => {
    expect(withinWindow("03:00", null)).toBe(true);
  });

  it("wraps a window that crosses midnight", () => {
    const overnight = { startTime: "22:00", endTime: "02:00" };
    expect(withinWindow("23:30", overnight)).toBe(true);
    expect(withinWindow("01:00", overnight)).toBe(true);
    expect(withinWindow("12:00", overnight)).toBe(false);
  });

  it("judges an event by when it happened, not by when it is processed", () => {
    // 02:58 UTC is 10:58 Manila: inside the morning window.
    expect(eventWithinWindow("2026-08-27T02:58:00.000Z", morning)).toBe(true);
    // 03:05 UTC is 11:05 Manila: outside it.
    expect(eventWithinWindow("2026-08-27T03:05:00.000Z", morning)).toBe(false);
  });

  it("allows grace for an event whose own timestamp lags", () => {
    // 11:05 Manila with fifteen minutes of grace still counts as the morning.
    expect(eventWithinWindow("2026-08-27T03:05:00.000Z", morning, 15)).toBe(true);
    // An hour late does not.
    expect(eventWithinWindow("2026-08-27T04:05:00.000Z", morning, 15)).toBe(false);
  });

  it("does not let grace make an early event count", () => {
    // 05:50 Manila is before the window opens; grace widens the close, not the
    // open, so this stays out.
    expect(eventWithinWindow("2026-08-26T21:50:00.000Z", morning, 15)).toBe(false);
  });

  it("rejects an unparseable timestamp rather than counting it", () => {
    expect(eventWithinWindow("not-a-date", morning)).toBe(false);
  });
});
