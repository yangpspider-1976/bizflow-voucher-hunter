import { describe, expect, it } from "vitest";
import { slotDateProblem } from "@/server/admin";

/**
 * The rule both write paths share, checked without a database behind it.
 *
 * Which of the two problems a date has decides what the caller is told to do —
 * extend the campaign, or pick a later date — so the reason matters as much as
 * the refusal.
 */
describe("slotDateProblem", () => {
  const campaign = { startDate: "2026-07-01", endDate: "2026-07-31" };
  const today = "2026-07-15";

  it("passes a date ahead and inside the window", () => {
    expect(slotDateProblem("2026-07-20", campaign, today)).toBeNull();
  });

  it("passes today itself", () => {
    expect(slotDateProblem(today, campaign, today)).toBeNull();
  });

  it("refuses yesterday, inside the window though it is", () => {
    expect(slotDateProblem("2026-07-14", campaign, today)).toMatchObject({
      reason: "past",
      message: "Slot date 2026-07-14 has already passed.",
    });
  });

  it("refuses a date past the campaign end", () => {
    expect(slotDateProblem("2026-08-01", campaign, today)).toMatchObject({
      reason: "window",
      message:
        "Slot date 2026-08-01 is outside the campaign window (2026-07-01 to 2026-07-31).",
    });
  });

  it("reports a date that is both past and outside as past", () => {
    // The campaign start is behind us: telling someone to widen the window
    // backwards would not make the date bookable.
    expect(slotDateProblem("2026-06-20", campaign, today)).toMatchObject({ reason: "past" });
  });

  it("still refuses a future date before a campaign that has not started", () => {
    expect(
      slotDateProblem("2026-08-05", { startDate: "2026-09-01", endDate: "2026-09-30" }, today),
    ).toMatchObject({ reason: "window" });
  });
});
