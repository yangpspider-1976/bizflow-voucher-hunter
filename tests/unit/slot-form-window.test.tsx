// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

const { SlotForm } = await import("@/app/dashboard/_components/SlotForm");

/**
 * The date a slot can be given is bounded twice: by the campaign window, which
 * the save enforces, and by today, because a slot in the past can never be
 * booked. A business hits both through a picker it cannot argue with, so what
 * the picker offers has to be exactly what would be accepted — and when that is
 * nothing, it has to say so rather than grey out the calendar in silence.
 */
describe("slot date picker bounds", () => {
  afterEach(cleanup);

  const renderForm = (window: { startDate: string; endDate: string }, today: string) => {
    render(
      <SlotForm
        campaignId="camp_1"
        campaignWindow={window}
        requestMode
        returnHref="/dashboard/slots"
        today={today}
      />,
    );
    return document.querySelector('input[type="date"]') as HTMLInputElement;
  };

  it("offers the rest of a running campaign, starting today", () => {
    const input = renderForm({ startDate: "2026-08-18", endDate: "2026-09-17" }, "2026-08-25");
    expect(input.min).toBe("2026-08-25");
    expect(input.max).toBe("2026-09-17");
    expect(input.disabled).toBe(false);
  });

  it("does not offer days the campaign has already spent", () => {
    const input = renderForm({ startDate: "2026-08-18", endDate: "2026-09-17" }, "2026-08-25");
    // The window opened on the 18th, but a slot dated then is unbookable.
    expect(input.min > "2026-08-18").toBe(true);
  });

  it("opens at the start date for a campaign that has not begun", () => {
    const input = renderForm({ startDate: "2026-09-01", endDate: "2026-09-30" }, "2026-08-25");
    expect(input.min).toBe("2026-09-01");
    expect(input.max).toBe("2026-09-30");
    expect(input.disabled).toBe(false);
  });

  it("says the campaign ended instead of greying the whole calendar", () => {
    const input = renderForm({ startDate: "2026-07-01", endDate: "2026-07-31" }, "2026-08-25");
    expect(input.disabled).toBe(true);
    // Spelled out, not ISO: the exact order is the runtime's to choose, but
    // both ends of the dead window have to be in the sentence.
    expect(
      screen.getByText(/campaign ran .*Jul.*2026 to .*Jul.*2026, so there is no date left to request/),
    ).toBeTruthy();
    expect(screen.getByText(/Ask an admin to extend the campaign dates/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Submit Request" })).toHaveProperty("disabled", true);
  });

  it("tells an admin to extend the dates themselves", () => {
    render(
      <SlotForm
        campaignId="camp_1"
        campaignWindow={{ startDate: "2026-07-01", endDate: "2026-07-31" }}
        returnHref="/dashboard/slots"
        today="2026-08-25"
      />,
    );
    expect(screen.getByText(/Extend the campaign dates first/)).toBeTruthy();
  });
});
