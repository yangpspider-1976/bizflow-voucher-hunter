import { beforeEach, describe, expect, it } from "vitest";
import { resetDb } from "@/server/db";
import { generateCandidate, getHuntSnapshot, startHunt } from "@/server/voucher-engine";
import { huntAndSelect } from "../helpers";

/**
 * What a client needs to pick a campaign back up after it was interrupted. The
 * app cannot ask the customer where they were, so everything it resumes from
 * has to be readable in one snapshot.
 */
describe("resuming an interrupted campaign", () => {
  const campaignSlug = "july-dinner";
  const phone = "+639181234567";

  beforeEach(async () => {
    await resetDb();
  });

  it("carries the booked slot alongside a confirmed voucher", async () => {
    const selected = await huntAndSelect({ campaignSlug, phone, name: "Resuming User" });

    const snapshot = await getHuntSnapshot({ campaignSlug, phone });

    expect(snapshot.voucher?.id).toBe(selected.voucher.id);
    // The regression: the booking's date and time were re-derived from the
    // campaign's slot list, and a client that could not find the row there
    // showed a customer holding a reservation that it had no voucher at all.
    expect(snapshot.voucherSlot?.id).toBe(selected.slot.id);
    expect(snapshot.voucherSlot?.date).toBe(selected.slot.date);
    expect(snapshot.voucherSlot?.startTime).toBe(selected.slot.startTime);
  });

  it("reports a drawn but unbooked candidate with no slot", async () => {
    const sessionId = "resume-session";
    await startHunt({ campaignSlug, phone, sessionId });
    const candidate = await generateCandidate({ campaignSlug, phone, sessionId });

    const snapshot = await getHuntSnapshot({ campaignSlug, phone });

    // The interrupted-reel case: the draw is already spent server-side, which is
    // what lets the app land on it again rather than paying for another.
    expect(snapshot.attempts.map((attempt) => attempt.id)).toContain(candidate.id);
    expect(snapshot.attempts[0].status).toBe("Candidate");
    expect(snapshot.voucher).toBeUndefined();
    expect(snapshot.voucherSlot).toBeUndefined();
  });
});
