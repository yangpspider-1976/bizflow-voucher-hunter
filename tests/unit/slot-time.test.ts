import { describe, expect, it } from "vitest";
import { slotHasEnded } from "@bizflow/shared";

const morning = { date: "2026-09-11", endTime: "11:00", timezone: "Asia/Manila" };

describe("slot expiry", () => {
  it("hides the reported morning slot at 1:30 PM but keeps later slots", () => {
    const now = new Date("2026-09-11T13:30:00+08:00");
    expect(slotHasEnded(morning, now)).toBe(true);
    expect(slotHasEnded({ ...morning, endTime: "15:00" }, now)).toBe(false);
    expect(slotHasEnded({ ...morning, date: "2026-09-12" }, now)).toBe(false);
  });

  it("allows an ongoing slot, then expires it exactly at the end", () => {
    expect(slotHasEnded(morning, new Date("2026-09-11T10:59:59+08:00"))).toBe(false);
    expect(slotHasEnded(morning, new Date("2026-09-11T11:00:00+08:00"))).toBe(true);
  });

  it("uses the venue's calendar date across UTC midnight", () => {
    expect(slotHasEnded(morning, new Date("2026-09-10T23:30:00Z"))).toBe(false);
    expect(slotHasEnded({ ...morning, date: "2026-09-10" }, new Date("2026-09-10T16:00:00Z"))).toBe(true);
  });

  it("uses the supplied timezone including daylight saving time", () => {
    const slot = { ...morning, timezone: "America/New_York" };
    expect(slotHasEnded(slot, new Date("2026-09-11T14:59:59Z"))).toBe(false);
    expect(slotHasEnded(slot, new Date("2026-09-11T15:00:00Z"))).toBe(true);
  });
});
