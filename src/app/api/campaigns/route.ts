import { z } from "zod";
import { assertAdminRole, assertBusinessAccess, requireAdmin } from "@/server/auth";
import { createCampaign } from "@/server/admin";
import { fail, ok } from "@/server/errors";
import {
  MAX_BASE_ATTEMPTS,
  MAX_CANDIDATE_TIMEOUT_MINUTES,
  MAX_REFERRAL_DAILY_LIMIT,
} from "@/lib/limits";
import { isCampaignImageStorageValue } from "@/lib/campaign-image";

export const dynamic = "force-dynamic";

const schema = z.object({
  businessId: z.string().min(1),
  slug: z
    .string()
    .min(1)
    .regex(/^[a-z0-9-]+$/, "slug must be lowercase letters, numbers, and hyphens"),
  title: z.string().min(1),
  offerMessage: z.string().min(1),
  heroImage: z
    .string()
    .min(1)
    .refine(
      isCampaignImageStorageValue,
      "Upload a valid PNG, JPEG, or WebP campaign image",
    ),
  mode: z.enum(["restaurant", "online_shop", "beauty", "pet", "retail", "other"]),
  location: z.string().optional(),
  startDate: z.string().min(1),
  endDate: z.string().min(1),
  baseAttempts: z.number().int().min(1).max(MAX_BASE_ATTEMPTS),
  referralDailyLimit: z.number().int().min(0).max(MAX_REFERRAL_DAILY_LIMIT),
  candidateTimeoutMinutes: z.number().int().min(1).max(MAX_CANDIDATE_TIMEOUT_MINUTES),
  terms: z.string().min(1),
  shopUrl: z.string().url().optional(),
  status: z.enum(["active", "paused", "closed"]).optional(),
  allowReschedule: z.boolean().optional()
});

export async function POST(request: Request) {
  try {
    const session = await requireAdmin(request);
    const input = schema.parse(await request.json());
    assertAdminRole(session);
    assertBusinessAccess(session, input.businessId);
    return ok(await createCampaign(input), { status: 201 });
  } catch (error) {
    return fail(error);
  }
}
