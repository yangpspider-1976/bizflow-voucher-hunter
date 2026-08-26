import { z } from "zod";
import { assertBusinessAccess, requireAdmin } from "@/server/auth";
import { createSlot, getCampaign, listSlots } from "@/server/admin";
import { requestCampaignChange } from "@/server/change-requests";
import { fail, ok } from "@/server/errors";
import { MAX_SLOT_CAPACITY } from "@/lib/limits";

export const dynamic = "force-dynamic";

const timePattern = /^\d{2}:\d{2}$/;

const schema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD"),
  startTime: z.string().regex(timePattern, "startTime must be HH:MM"),
  endTime: z.string().regex(timePattern, "endTime must be HH:MM"),
  timezone: z.string().optional(),
  branchId: z.string().optional(),
  totalCapacity: z.number().int().min(1).max(MAX_SLOT_CAPACITY),
  status: z.enum(["active", "sold_out", "closed", "paused"]).optional()
});

export async function GET(request: Request, { params }: { params: { id: string } }) {
  try {
    const session = await requireAdmin(request);
    assertBusinessAccess(session, (await getCampaign(params.id)).businessId);
    return ok(await listSlots(params.id));
  } catch (error) {
    return fail(error);
  }
}

export async function POST(request: Request, { params }: { params: { id: string } }) {
  try {
    const session = await requireAdmin(request);
    const campaign = await getCampaign(params.id);
    assertBusinessAccess(session, campaign.businessId);
    const input = schema.parse(await request.json());
    if (session.role === "staff") {
      return ok(await requestCampaignChange({ campaignId: campaign.id, requestedBy: session.email, requestType: "slot_create", payload: input }), { status: 202 });
    }
    return ok(await createSlot(params.id, input), { status: 201 });
  } catch (error) {
    return fail(error);
  }
}
