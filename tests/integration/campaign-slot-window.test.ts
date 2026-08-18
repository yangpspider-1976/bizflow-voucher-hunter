import { beforeEach, describe, expect, it } from "vitest";
import { ADMIN_SESSION_COOKIE, createAdminSession } from "@/lib/admin-session";
import { PATCH as patchCampaign } from "@/app/api/campaigns/[id]/route";
import { POST as postSlot } from "@/app/api/campaigns/[id]/slots/route";
import { createCampaign, createSlot, listSlots, updateCampaign } from "@/server/admin";
import { getDb, resetDb, run } from "@/server/db";
import { listPublicCampaignCards } from "@/server/voucher-engine";

async function adminRequest(url: string, body: unknown, method: string) {
  const token = await createAdminSession({
    email: "admin@example.com",
    name: "Admin",
    role: "super_admin",
    businessIds: ["*"]
  });
  return new Request(url, {
    method,
    headers: { cookie: `${ADMIN_SESSION_COOKIE}=${token}`, "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

// The clock is frozen at 2026-07-03 (tests/setup.ts).
const TODAY = "2026-07-03";

async function campaignWithWindow(slug: string, startDate: string, endDate: string) {
  return createCampaign({
    businessId: "biz_demo_shop",
    slug,
    title: slug,
    offerMessage: "x",
    heroImage: "#000",
    mode: "online_shop",
    startDate,
    endDate,
    baseAttempts: 3,
    referralDailyLimit: 5,
    candidateTimeoutMinutes: 10,
    terms: "t"
  });
}

const slotInput = (date: string) => ({
  date,
  startTime: "15:00",
  endTime: "17:00",
  totalCapacity: 20
});

describe("campaign window contains its bookable slots", () => {
  beforeEach(async () => {
    process.env.ADMIN_SESSION_SECRET = "test-only-admin-session-secret-with-more-than-32-characters";
    await resetDb();
  });

  describe("through the dashboard API", () => {
    it("rejects an out-of-window slot with 422 and the reason", async () => {
      const campaign = await campaignWithWindow("api-slot", "2026-07-05", "2026-07-06");
      const response = await postSlot(
        await adminRequest(
          `http://localhost/api/campaigns/${campaign.id}/slots`,
          slotInput("2026-07-20"),
          "POST"
        ),
        { params: { id: campaign.id } }
      );
      expect(response.status).toBe(422);
      expect((await response.json()).error.code).toBe("E-SLOT-WINDOW");
      expect(await listSlots(campaign.id)).toHaveLength(0);
    });

    it("saves a widened end date, which is how a stranded campaign is rescued", async () => {
      // Exactly the production shape: campaign closed before its only slot, so
      // the app lists it as finished even though the draw reports it as bookable.
      const campaign = await campaignWithWindow("api-rescue", "2026-07-01", "2026-07-02");
      const db = await getDb();
      await run(
        db,
        `INSERT INTO slots (id, campaign_id, date, start_time, end_time, timezone, branch_id, total_capacity, remaining_capacity, status)
         VALUES ('slot_api_rescue', ?, '2026-07-20', '15:00', '17:00', 'Asia/Manila', NULL, 20, 20, 'active')`,
        [campaign.id]
      );

      const tooNarrow = await patchCampaign(
        await adminRequest(
          `http://localhost/api/campaigns/${campaign.id}`,
          { endDate: "2026-07-10" },
          "PATCH"
        ),
        { params: { id: campaign.id } }
      );
      expect(tooNarrow.status).toBe(422);
      expect((await tooNarrow.json()).error.code).toBe("E-CAMPAIGN-WINDOW-SLOTS");

      const widened = await patchCampaign(
        await adminRequest(
          `http://localhost/api/campaigns/${campaign.id}`,
          { endDate: "2026-07-31" },
          "PATCH"
        ),
        { params: { id: campaign.id } }
      );
      expect(widened.status).toBe(200);
      expect((await widened.json()).data.endDate).toBe("2026-07-31");
      expect(
        (await listPublicCampaignCards()).find((card) => card.campaign.slug === "api-rescue")
      ).toMatchObject({ ended: false });
    });
  });

  describe("createSlot", () => {
    it("accepts a slot inside the window, including on either boundary", async () => {
      const campaign = await campaignWithWindow("inside", "2026-07-05", "2026-07-10");
      await expect(createSlot(campaign.id, slotInput("2026-07-05"))).resolves.toMatchObject({
        date: "2026-07-05"
      });
      await expect(createSlot(campaign.id, slotInput("2026-07-07"))).resolves.toMatchObject({
        date: "2026-07-07"
      });
      await expect(createSlot(campaign.id, slotInput("2026-07-10"))).resolves.toMatchObject({
        date: "2026-07-10"
      });
    });

    it("rejects a slot dated after the campaign ends", async () => {
      // The Dog Mania shape: campaign Aug 15-16, slot Aug 20.
      const campaign = await campaignWithWindow("after", "2026-07-05", "2026-07-06");
      await expect(createSlot(campaign.id, slotInput("2026-07-10"))).rejects.toMatchObject({
        code: "E-SLOT-WINDOW",
        status: 422
      });
      expect(await listSlots(campaign.id)).toHaveLength(0);
    });

    it("rejects a slot dated before the campaign starts", async () => {
      const campaign = await campaignWithWindow("before", "2026-07-05", "2026-07-10");
      await expect(createSlot(campaign.id, slotInput("2026-07-04"))).rejects.toMatchObject({
        code: "E-SLOT-WINDOW",
        status: 422
      });
      expect(await listSlots(campaign.id)).toHaveLength(0);
    });

    it("names the offending date and the window it missed", async () => {
      const campaign = await campaignWithWindow("message", "2026-07-05", "2026-07-06");
      await expect(createSlot(campaign.id, slotInput("2026-07-20"))).rejects.toThrow(
        /2026-07-20 is outside the campaign window \(2026-07-05 to 2026-07-06\)/
      );
    });
  });

  describe("updateCampaign", () => {
    it("refuses a window that would strand an upcoming slot", async () => {
      const campaign = await campaignWithWindow("narrowing", "2026-07-05", "2026-07-20");
      await createSlot(campaign.id, slotInput("2026-07-18"));

      await expect(updateCampaign(campaign.id, { endDate: "2026-07-10" })).rejects.toMatchObject({
        code: "E-CAMPAIGN-WINDOW-SLOTS",
        status: 422,
        details: { strandedSlotDates: ["2026-07-18"] }
      });
      // The rejected patch must not have been half-applied.
      expect((await updateCampaign(campaign.id, {})).endDate).toBe("2026-07-20");
    });

    it("refuses a start date moved past an upcoming slot", async () => {
      const campaign = await campaignWithWindow("start-move", "2026-07-05", "2026-07-20");
      await createSlot(campaign.id, slotInput("2026-07-06"));

      await expect(updateCampaign(campaign.id, { startDate: "2026-07-08" })).rejects.toMatchObject({
        code: "E-CAMPAIGN-WINDOW-SLOTS"
      });
    });

    it("lists every stranded date, de-duplicated and in order", async () => {
      const campaign = await campaignWithWindow("many", "2026-07-05", "2026-07-25");
      await createSlot(campaign.id, slotInput("2026-07-20"));
      await createSlot(campaign.id, { ...slotInput("2026-07-20"), startTime: "18:00", endTime: "20:00" });
      await createSlot(campaign.id, slotInput("2026-07-15"));

      await expect(updateCampaign(campaign.id, { endDate: "2026-07-10" })).rejects.toMatchObject({
        details: { strandedSlotDates: ["2026-07-15", "2026-07-20"] }
      });
    });

    it("allows widening the window to rescue a campaign that already stranded a slot", async () => {
      // Reproduces the production fix path: the bad row predates the guardrail,
      // so the only way out has to be an edit that widens the window.
      const campaign = await campaignWithWindow("rescue", "2026-07-01", "2026-07-02");
      const db = await getDb();
      await run(
        db,
        `INSERT INTO slots (id, campaign_id, date, start_time, end_time, timezone, branch_id, total_capacity, remaining_capacity, status)
         VALUES ('slot_legacy_stranded', ?, '2026-07-20', '15:00', '17:00', 'Asia/Manila', NULL, 20, 20, 'active')`,
        [campaign.id]
      );
      // Its window closed yesterday, so the card is there but closed: no way
      // in for a customer, whatever the stranded slot still holds.
      expect(
        (await listPublicCampaignCards()).find((card) => card.campaign.slug === "rescue")
      ).toMatchObject({ ended: true });

      const fixed = await updateCampaign(campaign.id, { endDate: "2026-07-31" });
      expect(fixed.endDate).toBe("2026-07-31");
      const card = (await listPublicCampaignCards()).find((c) => c.campaign.slug === "rescue");
      expect(card).toMatchObject({ ended: false });
    });

    it("ignores slots already in the past", async () => {
      // The bundled demo campaigns roll their window forward and leave the
      // original fixture slots behind; those must not freeze the campaign.
      const campaign = await campaignWithWindow("history", "2026-06-01", "2026-07-30");
      const db = await getDb();
      await run(
        db,
        `INSERT INTO slots (id, campaign_id, date, start_time, end_time, timezone, branch_id, total_capacity, remaining_capacity, status)
         VALUES ('slot_history', ?, '2026-06-10', '15:00', '17:00', 'Asia/Manila', NULL, 20, 20, 'active')`,
        [campaign.id]
      );

      const updated = await updateCampaign(campaign.id, { startDate: TODAY, endDate: "2026-07-31" });
      expect(updated.startDate).toBe(TODAY);
    });

    it("leaves non-date edits alone on an already-inconsistent campaign", async () => {
      const campaign = await campaignWithWindow("title-edit", "2026-07-01", "2026-07-02");
      const db = await getDb();
      await run(
        db,
        `INSERT INTO slots (id, campaign_id, date, start_time, end_time, timezone, branch_id, total_capacity, remaining_capacity, status)
         VALUES ('slot_orphan', ?, '2026-07-20', '15:00', '17:00', 'Asia/Manila', NULL, 20, 20, 'active')`,
        [campaign.id]
      );

      const updated = await updateCampaign(campaign.id, { title: "Renamed" });
      expect(updated.title).toBe("Renamed");
    });
  });
});
