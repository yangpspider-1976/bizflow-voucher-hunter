import type { VoucherAttempt } from "@bizflow/shared";
import { describe, expect, it } from "vitest";

import { recoverSelection } from "../../apps/mobile/src/hunt/recoverSelection";

function attempt(
  id: string,
  status: VoucherAttempt["status"] = "Candidate",
): VoucherAttempt {
  return {
    id,
    campaignId: "campaign-1",
    userId: "user-1",
    attemptNumber: 1,
    sourceType: "base",
    benefitType: "discount_percent",
    benefitValue: "20",
    displayLabel: "20% OFF",
    rarity: "standard",
    poolId: "pool-1",
    status,
    expiresAt: "2099-01-01T00:00:00.000Z",
    createdAt: "2026-08-18T00:00:00.000Z",
  };
}

describe("slot picker selection recovery", () => {
  it("retries rather than expiring when there is no snapshot to judge by", () => {
    // The regression: a client that could not reach an authoritative answer
    // used to report the candidate as lost, stranding the customer on a dead
    // screen for what was only a hydration race.
    expect(
      recoverSelection({ selectedAttemptId: "att_1", snapshot: null }),
    ).toEqual({ kind: "retry" });
  });

  it("routes to the issued voucher instead of the picker", () => {
    expect(
      recoverSelection({
        selectedAttemptId: "att_1",
        snapshot: { attempts: [attempt("att_1")], voucher: { id: "vch_1" } },
      }),
    ).toEqual({ kind: "voucher" });
  });

  it("keeps the current selection when the server still lists it", () => {
    const recovery = recoverSelection({
      selectedAttemptId: "att_2",
      snapshot: { attempts: [attempt("att_1"), attempt("att_2")] },
    });
    expect(recovery).toMatchObject({ kind: "attempt" });
    expect(recovery).toHaveProperty("attempt.id", "att_2");
  });

  it("falls back to the newest selectable attempt after a stale local id", () => {
    const recovery = recoverSelection({
      selectedAttemptId: "att_gone",
      snapshot: {
        attempts: [attempt("att_1", "Released"), attempt("att_2"), attempt("att_3")],
      },
    });
    expect(recovery).toHaveProperty("attempt.id", "att_3");
  });

  it("skips attempts that can no longer be booked", () => {
    const recovery = recoverSelection({
      selectedAttemptId: "att_gone",
      snapshot: {
        attempts: [attempt("att_1"), attempt("att_2", "Expired")],
      },
    });
    expect(recovery).toHaveProperty("attempt.id", "att_1");
  });

  it("expires only when the server holds nothing bookable", () => {
    expect(
      recoverSelection({
        selectedAttemptId: "att_gone",
        snapshot: { attempts: [attempt("att_1", "Expired")] },
      }),
    ).toEqual({ kind: "expired" });

    expect(
      recoverSelection({ selectedAttemptId: "att_gone", snapshot: { attempts: [] } }),
    ).toEqual({ kind: "expired" });
  });
});
