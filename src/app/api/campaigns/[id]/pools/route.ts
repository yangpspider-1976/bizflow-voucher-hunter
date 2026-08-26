import { z } from "zod";
import { benefitValueProblem } from "@bizflow/shared";
import { assertBusinessAccess, requireAdmin } from "@/server/auth";
import { createPool, getCampaign, listPools } from "@/server/admin";
import { requestCampaignChange } from "@/server/change-requests";
import { fail, ok } from "@/server/errors";
import { MAX_MONEY_PESOS, MAX_POOL_QUANTITY } from "@/lib/limits";

export const dynamic = "force-dynamic";

const schema = z.object({
  benefitType: z.enum(["discount_percent", "fixed_amount", "free_item", "free_shipping"]),
  benefitValue: z.string().min(1),
  displayLabel: z.string().min(1),
  totalQuantity: z.number().int().min(1).max(MAX_POOL_QUANTITY),
  rarity: z.enum(["standard", "rare", "epic", "legendary"]),
  minimumSpend: z.number().int().min(0).max(MAX_MONEY_PESOS).optional(),
  restriction: z.string().optional(),
  status: z.enum(["active", "paused", "depleted"]).optional(),
  slotIds: z.array(z.string()).optional()
}).superRefine((input, ctx) => {
  const problem = benefitValueProblem(input.benefitType, input.benefitValue);
  if (problem) ctx.addIssue({ code: z.ZodIssueCode.custom, message: problem, path: ["benefitValue"] });
});

export async function GET(request: Request, { params }: { params: { id: string } }) {
  try {
    const session = await requireAdmin(request);
    assertBusinessAccess(session, (await getCampaign(params.id)).businessId);
    return ok(await listPools(params.id));
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
    if (session.role === "staff") return ok(await requestCampaignChange({ campaignId: campaign.id, requestedBy: session.email, requestType: "pool_create", payload: input }), { status: 202 });
    return ok(await createPool(params.id, input), { status: 201 });
  } catch (error) {
    return fail(error);
  }
}
