import { beforeEach, describe, expect, it } from "vitest";
import { getCampaign, listPools, updateCampaign } from "@/server/admin";
import { resetDb } from "@/server/db";
import { AppError } from "@/server/errors";
import {
  campaignSlotPerformance,
  dashboardMetrics,
  exportCampaignCsv,
} from "@/server/voucher-engine";

/**
 * A paused campaign is still a campaign the console has to show.
 *
 * Pausing is done from the dashboard, and the reason to pause is usually that
 * something in the configuration needs looking at — so the moment it is paused
 * is exactly when its slots, tiers and figures matter most. Every one of these
 * reads used to go through the hunt's `status === "active"` gate and throw
 * E-CAMPAIGN-404, which the pages caught and rendered as an empty table.
 */
describe("dashboard reads for a campaign that is not running", () => {
  const slug = "july-dinner";

  beforeEach(async () => {
    await resetDb();
  });

  async function pause(status: "paused" | "closed") {
    const campaign = await getCampaign(slug);
    await updateCampaign(campaign.id, { status });
    return campaign.id;
  }

  it("still reports the slot table once the campaign is paused", async () => {
    const campaignId = (await getCampaign(slug)).id;
    const whileActive = await campaignSlotPerformance(campaignId);
    expect(whileActive.length).toBeGreaterThan(0);

    await pause("paused");
    const whilePaused = await campaignSlotPerformance(campaignId);
    expect(whilePaused).toEqual(whileActive);
  });

  it("still reports the slot table once the campaign is closed", async () => {
    const campaignId = (await getCampaign(slug)).id;
    const whileActive = await campaignSlotPerformance(campaignId);

    await pause("closed");
    expect(await campaignSlotPerformance(campaignId)).toEqual(whileActive);
  });

  it("still reports the overview metrics once the campaign is paused", async () => {
    const campaignId = (await getCampaign(slug)).id;
    const whileActive = await dashboardMetrics(campaignId);
    expect(whileActive.slotPerformance.length).toBeGreaterThan(0);

    await pause("paused");
    const whilePaused = await dashboardMetrics(campaignId);
    expect(whilePaused.slotPerformance).toEqual(whileActive.slotPerformance);
    expect(whilePaused.summary).toEqual(whileActive.summary);
    expect(whilePaused.campaign.status).toBe("paused");
  });

  it("still exports the campaign CSV once the campaign is paused", async () => {
    const campaignId = await pause("paused");
    const csv = await exportCampaignCsv(campaignId);
    expect(csv).toContain("# LEADS");
  });

  // listPools goes through its own lookup, which was never status-gated — this
  // pins that down so the vouchers page cannot regress to a half-empty table
  // where the tiers load and the slot names beside them do not.
  it("still lists benefit tiers once the campaign is paused", async () => {
    const campaignId = (await getCampaign(slug)).id;
    const whileActive = await listPools(campaignId);
    expect(whileActive.length).toBeGreaterThan(0);

    await pause("paused");
    expect(await listPools(campaignId)).toEqual(whileActive);
  });

  // The gate that is genuinely gone: a campaign that does not exist at all.
  it("still rejects a campaign id that does not exist", async () => {
    await expect(campaignSlotPerformance("camp_does_not_exist")).rejects.toBeInstanceOf(
      AppError,
    );
    await expect(dashboardMetrics("camp_does_not_exist")).rejects.toBeInstanceOf(AppError);
  });
});
