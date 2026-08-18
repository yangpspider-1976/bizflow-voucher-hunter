import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  addCalendarDays,
  all,
  getDb,
  manilaDateString,
  mapCampaign,
  mapPool,
  one,
  resetDb,
  run,
} from "@/server/db";
import { AppError } from "@/server/errors";
import {
  generateCandidate,
  getHuntSnapshot,
  getPublicCampaign,
  listPublicCampaignCards,
  listSlotsForAttempt,
  redeemVoucher,
  resetHuntForPhone,
  selectFinalVoucher,
  slotNotStartedYet,
  startHunt,
  validateVoucher,
} from "@/server/voucher-engine";
import { huntAndSelect } from "../helpers";

const base = { campaignSlug: "july-dinner", phone: "+639171234567", sessionId: "test-session" };

describe("voucher engine (hunt-first flow)", () => {
  beforeEach(async () => {
    await resetDb();
  });

  // Winning a tier with nothing left to book stranded the customer on an empty
  // date picker, having already spent an attempt and decremented that tier's
  // stock. The draw skips such tiers instead.
  describe("tiers with no bookable slot", () => {
    async function julyDinnerId() {
      const db = await getDb();
      return mapCampaign(
        await one(db, "SELECT * FROM campaigns WHERE slug = ?", ["july-dinner"]),
      ).id;
    }

    it("refuses the draw when every tier is unbookable", async () => {
      const db = await getDb();
      await run(db, "UPDATE slots SET status = 'closed' WHERE campaign_id = ?", [
        await julyDinnerId(),
      ]);

      await startHunt({ ...base, name: "Jane Doe" });
      await expect(generateCandidate(base)).rejects.toThrow(AppError);
    });

    it("draws only the tier that still has one", async () => {
      const db = await getDb();
      const campaignId = await julyDinnerId();
      const pools = (
        await all(db, "SELECT * FROM pools WHERE campaign_id = ?", [campaignId])
      ).map(mapPool);
      // Leave exactly one tier bookable, so the expected result is not a matter
      // of which way a weighted draw happens to fall. The mappings are dropped
      // rather than the slots closed: tiers share slots, so closing "everything
      // but the survivor's" leaves the shared ones open for everyone.
      const survivor = pools[0];
      await run(
        db,
        `DELETE FROM pool_slots
         WHERE pool_id IN (SELECT id FROM pools WHERE campaign_id = ?)
           AND pool_id != ?`,
        [campaignId, survivor.id],
      );

      await startHunt({ ...base, name: "Jane Doe" });
      // Drawn only as many times as the tier has stock; a third would deplete it
      // and raise E-POOL-EMPTY for reasons unrelated to availability.
      const drawn = [
        await generateCandidate(base),
        await generateCandidate(base),
      ];
      expect(drawn.map((attempt) => attempt.displayLabel)).toEqual([
        survivor.displayLabel,
        survivor.displayLabel,
      ]);
      expect(survivor.totalQuantity).toBeGreaterThanOrEqual(drawn.length);
    });
  });

  it("generates exactly three base candidates and blocks the fourth", async () => {
    await startHunt({ ...base, name: "Jane Doe" });
    const first = await generateCandidate(base);
    const second = await generateCandidate(base);
    const third = await generateCandidate(base);

    expect([first, second, third]).toHaveLength(3);
    expect(first.slotId).toBeUndefined(); // no slot chosen at hunt time
    await expect(generateCandidate(base)).rejects.toThrow(AppError);
  });

  it("allows choosing a specific campaign voucher outside production", async () => {
    await startHunt({ ...base, name: "Jane Doe" });
    const candidate = await generateCandidate({
      ...base,
      devPoolId: "pool_dinner_90",
    });

    expect(candidate.poolId).toBe("pool_dinner_90");
    expect(candidate.displayLabel).toBe("90% OFF");
  });

  it("fully resets consumed attempts so the base hunt can start again", async () => {
    await startHunt({ ...base, name: "Jane Doe" });
    await generateCandidate(base);

    const reset = await resetHuntForPhone({ phone: base.phone });
    expect(reset.attemptsCleared).toBe(1);

    const cleared = await getHuntSnapshot({
      campaignSlug: base.campaignSlug,
      phone: base.phone,
    });
    expect(cleared.attempts).toHaveLength(0);
    expect(cleared.voucher).toBeUndefined();
    expect(cleared.remainingBaseAttempts).toBeGreaterThan(0);

    await expect(generateCandidate(base)).resolves.toMatchObject({
      sourceType: "base",
    });
  });

  // A tester who has spun on two campaigns expects one reset to put the whole
  // demo back at the start, not to leave the other campaign mid-hunt.
  it("resets every campaign the number has hunted, not just one", async () => {
    const other = { ...base, campaignSlug: "8pm-drop" };
    await startHunt({ ...base, name: "Jane Doe" });
    await generateCandidate(base);
    await startHunt({ ...other, name: "Jane Doe" });
    await generateCandidate(other);

    const reset = await resetHuntForPhone({ phone: base.phone });
    expect(reset.campaignsReset).toBe(2);
    expect(reset.attemptsCleared).toBe(2);

    for (const campaignSlug of [base.campaignSlug, other.campaignSlug]) {
      const cleared = await getHuntSnapshot({ campaignSlug, phone: base.phone });
      expect(cleared.attempts).toHaveLength(0);
      expect(cleared.voucher).toBeUndefined();
    }
  });

  it("lists rarity-gated slots for the chosen candidate", async () => {
    await startHunt({ ...base, name: "Jane Doe" });
    const candidate = await generateCandidate(base);
    const { slots } = await listSlotsForAttempt({ campaignSlug: "july-dinner", phone: base.phone, attemptId: candidate.id });
    expect(slots.length).toBeGreaterThan(0);
    // A 90% OFF winner is offered at exactly one (off-peak) slot; commons at more.
    if (candidate.displayLabel === "90% OFF") {
      expect(slots).toHaveLength(1);
      expect(slots[0].startTime).toBe("14:00");
    }
  });

  it("rolls demo inventory forward when every fixture slot is in the past", async () => {
    vi.setSystemTime(new Date("2026-07-29T12:00:00+08:00"));
    try {
      await resetDb();
      await startHunt({ ...base, name: "Jane Doe" });
      const candidate = await generateCandidate({
        ...base,
        devPoolId: "pool_dinner_20",
      });
      const { slots } = await listSlotsForAttempt({
        campaignSlug: base.campaignSlug,
        phone: base.phone,
        attemptId: candidate.id,
      });

      expect(slots.length).toBeGreaterThan(0);
      expect(slots.every((slot) => slot.date >= "2026-07-29")).toBe(true);
      expect(slots.some((slot) => slot.id.includes("_roll_20260729"))).toBe(true);
    } finally {
      vi.setSystemTime(new Date("2026-07-03T12:00:00+08:00"));
    }
  });

  it("issues one final voucher and blocks a duplicate for the same phone", async () => {
    const issued = await huntAndSelect({ ...base, name: "Jane Doe", guestCount: 2 });
    expect(issued.voucher.voucherCode).toMatch(/^BIZ-/);
    expect(issued.voucher.status).toBe("Issued");
    expect(issued.voucher.slotId).toBe(issued.slot.id);
    // The holder can still sign in (to view their voucher)...
    const state = await startHunt({ ...base, sessionId: "another-session" });
    expect(state.voucher?.voucherCode).toBe(issued.voucher.voucherCode);
    // ...but cannot hunt for a second voucher.
    await expect(generateCandidate({ ...base, sessionId: "another-session" })).rejects.toThrow(AppError);
  });

  it("rejects a slot that does not offer the chosen tier", async () => {
    await startHunt({ ...base, name: "Jane Doe" });
    const candidate = await generateCandidate(base);
    const { slots } = await listSlotsForAttempt({ campaignSlug: "july-dinner", phone: base.phone, attemptId: candidate.id });
    const allSlotIds = ["slot_dinner_0705_1400", "slot_dinner_0705_1900", "slot_dinner_0705_2000", "slot_dinner_0707_1900"];
    const forbidden = allSlotIds.find((id) => !slots.some((s) => s.id === id));
    if (forbidden) {
      await expect(
        selectFinalVoucher({ ...base, attemptId: candidate.id, slotId: forbidden, name: "Jane Doe" })
      ).rejects.toThrow(AppError);
    }
  });

  it("validates and redeems an issued voucher", async () => {
    const issued = await huntAndSelect({ ...base, name: "Jane Doe", guestCount: 2 });

    const validation = await validateVoucher({ codeOrToken: issued.voucher.voucherCode });
    expect(validation.voucher.status).toBe("Issued");

    const redeemed = await redeemVoucher({ codeOrToken: issued.voucher.voucherCode, staffName: "Front Desk", purchaseAmount: 2200 });
    expect(redeemed.voucher.status).toBe("Redeemed");
    await expect(redeemVoucher({ codeOrToken: issued.voucher.voucherCode, staffName: "Front Desk" })).rejects.toThrow(AppError);
  });
});

// A campaign that cannot be hunted right now is not the same as one that is
// over: slot capacity returns when a booking is cancelled, so a full campaign
// stays listed and its page still serves anyone holding an unbooked voucher.
// A finished one is listed too, for a while — flagged `ended` and sorted last,
// so the app can show it closed instead of silently dropping it — and only
// leaves the directory once it is well past.
describe("public campaign directory", () => {
  const SOLD_OUT_JULY_DINNER = `UPDATE slots SET remaining_capacity = 0, status = 'sold_out'
     WHERE campaign_id = (SELECT id FROM campaigns WHERE slug = 'july-dinner')`;

  beforeEach(async () => {
    await resetDb();
  });

  async function cardFor(slug: string) {
    return (await listPublicCampaignCards()).find(
      (card) => card.campaign.slug === slug,
    );
  }

  it("lists every running campaign as bookable", async () => {
    const cards = await listPublicCampaignCards();
    expect(cards.length).toBeGreaterThan(0);
    expect(cards.every((card) => card.availability.bookable)).toBe(true);
  });

  async function endJulyDinner(daysAgo: number) {
    const db = await getDb();
    await run(db, "UPDATE campaigns SET end_date = ? WHERE slug = ?", [
      addCalendarDays(manilaDateString(), -daysAgo),
      "july-dinner",
    ]);
  }

  it("keeps a campaign whose end date has passed, ended and sorted last", async () => {
    await endJulyDinner(1);

    const cards = await listPublicCampaignCards();
    const card = cards.find((entry) => entry.campaign.slug === "july-dinner");
    expect(card?.ended).toBe(true);
    // Whatever stock and capacity survive the end date, the hunt is over.
    expect(card?.availability).toMatchObject({ bookable: false });
    expect(cards.at(-1)?.campaign.slug).toBe("july-dinner");
    expect(cards.some((entry) => !entry.ended)).toBe(true);
  });

  it("drops a campaign that ended long ago", async () => {
    await endJulyDinner(31);

    expect(await cardFor("july-dinner")).toBeUndefined();
  });

  it("lists a closed campaign as ended even inside its dates", async () => {
    const db = await getDb();
    await run(db, "UPDATE campaigns SET status = 'closed' WHERE slug = ?", [
      "july-dinner",
    ]);

    expect(await cardFor("july-dinner")).toMatchObject({ ended: true });
  });

  // Pausing is a business hiding a campaign it means to bring back, which is
  // not the same claim as telling customers it is over.
  it("keeps a paused campaign out of the directory entirely", async () => {
    const db = await getDb();
    await run(db, "UPDATE campaigns SET status = 'paused' WHERE slug = ?", [
      "july-dinner",
    ]);

    expect(await cardFor("july-dinner")).toBeUndefined();
  });

  it("marks every running campaign as not ended", async () => {
    const cards = await listPublicCampaignCards();
    expect(cards.every((card) => !card.ended)).toBe(true);
  });

  it("keeps a full campaign listed, unbookable, and sorted below the rest", async () => {
    const db = await getDb();
    await run(db, SOLD_OUT_JULY_DINNER);

    const cards = await listPublicCampaignCards();
    const card = cards.find((entry) => entry.campaign.slug === "july-dinner");
    expect(card?.availability).toMatchObject({
      bookable: false,
      remainingCapacity: 0,
    });
    // Full, not given away: the tiers still hold stock.
    expect(card?.availability.remainingPrizes).toBeGreaterThan(0);
    expect(cards.at(-1)?.campaign.slug).toBe("july-dinner");
  });

  it("reports exhausted stock apart from full slots", async () => {
    const db = await getDb();
    await run(
      db,
      `UPDATE pools SET remaining_quantity = 0
       WHERE campaign_id = (SELECT id FROM campaigns WHERE slug = 'july-dinner')`,
    );

    const card = await cardFor("july-dinner");
    expect(card?.availability).toMatchObject({
      bookable: false,
      remainingPrizes: 0,
    });
    expect(card?.availability.remainingCapacity).toBeGreaterThan(0);
  });

  it("gives the campaign page the same availability as its card", async () => {
    const db = await getDb();
    await run(db, SOLD_OUT_JULY_DINNER);

    const { availability } = await getPublicCampaign("july-dinner");
    expect(availability.bookable).toBe(false);
    expect(availability).toEqual((await cardFor("july-dinner"))?.availability);
  });
});

describe("slot start comparison", () => {
  // Manila is UTC+8, so the instants below are chosen to straddle the slot's
  // wall-clock start rather than the UTC one — comparing against UTC is exactly
  // the bug this guards.
  const slot = { date: "2026-08-14", startTime: "19:00", timezone: "Asia/Manila" };

  it("is true before the slot's wall-clock start in its own zone", () => {
    expect(slotNotStartedYet(slot, new Date("2026-08-14T10:00:00Z"))).toBe(true);
  });

  it("is false once the slot has opened", () => {
    expect(slotNotStartedYet(slot, new Date("2026-08-14T11:30:00Z"))).toBe(false);
  });

  it("is true on an earlier date even at a later time of day", () => {
    expect(slotNotStartedYet(slot, new Date("2026-08-13T11:30:00Z"))).toBe(true);
  });

  // `hour12: false` reports midnight as hour 24 on some ICU builds, which sorts
  // a midnight slot after every other time and inverts the comparison.
  it("treats midnight as hour 00, not 24", () => {
    const midnight = { date: "2026-08-14", startTime: "00:30", timezone: "Asia/Manila" };
    expect(slotNotStartedYet(midnight, new Date("2026-08-13T16:05:00Z"))).toBe(true);
    expect(slotNotStartedYet(midnight, new Date("2026-08-13T16:45:00Z"))).toBe(false);
  });
});
