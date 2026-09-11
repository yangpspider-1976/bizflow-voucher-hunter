import { beforeEach, describe, expect, it, vi } from "vitest";
import { all, getDb, mapPool, one, resetDb } from "@/server/db";
import {
  generateCandidate,
  getHuntSnapshot,
  listSlotsForAttempt,
  selectFinalVoucher,
  startHunt,
} from "@/server/voucher-engine";

const slugs: Record<string, string> = {
  camp_july_dinner: "july-dinner",
  camp_8pm_drop: "8pm-drop",
  camp_glow_facial: "glow-facial",
};

async function seededPools() {
  const db = await getDb();
  return (await all(db, "SELECT * FROM pools ORDER BY campaign_id, id")).map(mapPool);
}

async function remaining(poolId: string) {
  const db = await getDb();
  return Number((await one(db, "SELECT remaining_quantity FROM pools WHERE id = ?", [poolId])).remaining_quantity);
}

/** Draws `poolId` for a fresh phone and returns what the booking needs. */
async function drawTier(poolId: string, campaignSlug: string, index: number) {
  const phone = `+63917${String(5000000 + index).padStart(7, "0")}`;
  const base = { campaignSlug, phone, sessionId: `s-${index}` };
  await startHunt({ ...base, name: "Tier Tester" });
  const attempt = await generateCandidate({ ...base, devPoolId: poolId });
  const { slots } = await listSlotsForAttempt({ campaignSlug, phone, attemptId: attempt.id });
  const slot = slots.find((candidate) => candidate.remainingCapacity > 0 && candidate.status === "active");
  return { base, attempt, slot: slot! };
}

describe("claiming a drawn voucher", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("issues every tier, free items included, inside the hold", async () => {
    const failures: string[] = [];
    for (const [index, pool] of (await seededPools()).entries()) {
      try {
        const { base, attempt, slot } = await drawTier(pool.id, slugs[pool.campaignId]!, index);
        const result = await selectFinalVoucher({ ...base, attemptId: attempt.id, slotId: slot.id, name: "Tier Tester" });
        if (result.voucher.displayLabel !== pool.displayLabel) failures.push(`${pool.id}: issued ${result.voucher.displayLabel}`);
      } catch (error) {
        failures.push(`${pool.id}: ${(error as Error).message}`);
      }
    }
    expect(failures).toEqual([]);
  });

  // A lapsed candidate used to stay `Candidate` in the table, because the claim
  // that noticed the lapse rolled its own record of it back. The app kept
  // offering it, and every claim was refused with "no longer available".
  describe("after the hold lapses", () => {
    async function lapsedFreeDessert() {
      const drawn = await drawTier("pool_dinner_dessert", "july-dinner", 99);
      vi.setSystemTime(new Date(Date.now() + 11 * 60_000));
      return drawn;
    }

    it("stops offering the candidate", async () => {
      const { base, attempt } = await lapsedFreeDessert();
      const snapshot = await getHuntSnapshot(base);
      expect(snapshot.attempts.find((candidate) => candidate.id === attempt.id)?.status).toBe("Expired");
    });

    it("refuses the slot picker with the reason", async () => {
      const { base, attempt } = await lapsedFreeDessert();
      await expect(
        listSlotsForAttempt({ campaignSlug: base.campaignSlug, phone: base.phone, attemptId: attempt.id }),
      ).rejects.toMatchObject({ code: "E-ATTEMPT-EXPIRED", message: expect.stringMatching(/held for 10 minutes/) });
    });

    it("refuses the claim as expired, and keeps it expired", async () => {
      const { base, attempt, slot } = await lapsedFreeDessert();
      const stockWhileHeld = await remaining("pool_dinner_dessert");
      const claim = () => selectFinalVoucher({ ...base, attemptId: attempt.id, slotId: slot.id, name: "Tier Tester" });

      await expect(claim()).rejects.toMatchObject({ code: "E-ATTEMPT-EXPIRED" });
      // The refusal no longer rolls the expiry back: the row says so, and the
      // tier has its unit back.
      const db = await getDb();
      expect((await one(db, "SELECT status FROM attempts WHERE id = ?", [attempt.id])).status).toBe("Expired");
      expect(await remaining("pool_dinner_dessert")).toBe(stockWhileHeld + 1);
      await expect(claim()).rejects.toMatchObject({ code: "E-ATTEMPT-EXPIRED" });
    });
  });
});
