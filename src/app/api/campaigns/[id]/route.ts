import { z } from "zod";
import { assertAdminRole, assertBusinessAccess, requireAdmin } from "@/server/auth";
import { getCampaign, updateCampaign } from "@/server/admin";
import { fail, ok } from "@/server/errors";
import {
  MAX_BASE_ATTEMPTS,
  MAX_CANDIDATE_TIMEOUT_MINUTES,
  MAX_REFERRAL_DAILY_LIMIT,
} from "@/lib/limits";
import { isCampaignImageStorageValue } from "@/lib/campaign-image";

export const dynamic = "force-dynamic";

const patchSchema = z
  .object({
    title: z.string().min(1),
    offerMessage: z.string().min(1),
    heroImage: z
      .string()
      .min(1)
      .refine(
        isCampaignImageStorageValue,
        "Upload a valid PNG, JPEG, or WebP campaign image",
      ),
    status: z.enum(["active", "paused", "closed"]),
    startDate: z.string().min(1),
    endDate: z.string().min(1),
    baseAttempts: z.number().int().min(1).max(MAX_BASE_ATTEMPTS),
    referralDailyLimit: z.number().int().min(0).max(MAX_REFERRAL_DAILY_LIMIT),
    candidateTimeoutMinutes: z.number().int().min(1).max(MAX_CANDIDATE_TIMEOUT_MINUTES),
    terms: z.string().min(1),
    shopUrl: z.string().url(),
    allowReschedule: z.boolean()
  })
  .partial();

export async function GET(request: Request, { params }: { params: { id: string } }) {
  try {
    const session = await requireAdmin(request);
    const campaign = await getCampaign(params.id);
    assertBusinessAccess(session, campaign.businessId);
    return ok(campaign);
  } catch (error) {
    return fail(error);
  }
}

export async function PATCH(request: Request, { params }: { params: { id: string } }) {
  try {
    const session = await requireAdmin(request);
    const campaign = await getCampaign(params.id);
    assertAdminRole(session);
    assertBusinessAccess(session, campaign.businessId);
    const patch = patchSchema.parse(await request.json());
    return ok(await updateCampaign(params.id, patch));
  } catch (error) {
    return fail(error);
  }
}
