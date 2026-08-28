import { z } from "zod";
import { requireAdmin } from "@/server/auth";
import { getDb } from "@/server/db";
import { fail, ok } from "@/server/errors";
import {
  decideMissionReview,
  listMissionDefinitions,
  publishMissionDefinition,
  simulateMission,
  stopMission,
  type MissionScope,
} from "@/server/gamification/mission-admin";
import { announceUrgentMission } from "@/server/gamification/notify";

const rewardLineSchema = z.object({
  type: z.enum(["XP", "LP", "HUNT_TICKET", "BADGE"]),
  amount: z.number().int().nonnegative(),
  fundingSource: z.enum(["PLATFORM", "PARTNER"]).optional(),
  badge: z.string().min(1).max(64).optional(),
});

const audienceSchema = z
  .object({
    segment: z.enum(["all", "new", "returning", "dormant"]).default("all"),
    segmentDays: z.number().int().min(1).max(365).optional(),
    area: z
      .object({
        latitude: z.number().min(-90).max(90),
        longitude: z.number().min(-180).max(180),
        radiusMeters: z.number().int().min(50).max(50_000),
      })
      .optional(),
    firstVisitOnly: z.boolean().optional(),
  })
  .default({ segment: "all" });

const schema = z.object({
  missionKey: z
    .string()
    .min(3)
    .max(64)
    .regex(/^[a-z0-9_]+$/, "Use lower case letters, digits and underscores"),
  type: z.enum(["DAILY", "URGENT", "ONBOARDING", "PARTNER"]),
  title: z.string().min(3).max(120),
  description: z.string().max(400).default(""),
  triggerEvent: z.enum([
    "ad_reward_verified",
    "hunt_complete",
    "voucher_select",
    "qr_redeem",
    "booking_complete",
    "purchase_verified",
    "review_verified",
    "referral_verified",
    "mission_completed",
  ]),
  targetCount: z.number().int().min(1).max(1000),
  window: z
    .object({
      startTime: z.string().regex(/^\d{2}:\d{2}$/),
      endTime: z.string().regex(/^\d{2}:\d{2}$/),
    })
    .nullable()
    .optional(),
  minLevel: z.number().int().min(1).max(50).default(1),
  partnerId: z.string().min(1).nullable().optional(),
  reward: z.array(rewardLineSchema).min(1).max(6),
  condition: z.record(z.unknown()).default({}),
  audience: audienceSchema,
  autoClaim: z.boolean().default(true),
  requiresProof: z.boolean().default(false),
  quotaMode: z.enum(["RESERVE_ON_JOIN", "ON_COMPLETION"]).default("ON_COMPLETION"),
  userQuota: z.number().int().min(1).max(100).default(1),
  globalQuota: z.number().int().min(1).nullable().optional(),
  rewardBudgetCentavos: z.number().int().min(0).nullable().optional(),
  status: z.enum(["Draft", "Review", "Scheduled", "Active", "Stopped"]).default("Draft"),
  startsAt: z.string().datetime().nullable().optional(),
  endsAt: z.string().datetime().nullable().optional(),
  exposureChannel: z.enum(["app", "push", "both"]).default("app"),
  termsUrl: z.string().url().max(400).nullable().optional(),
  localizationKey: z.string().max(80).nullable().optional(),
  sortOrder: z.number().int().min(0).max(10_000).default(100),
});

export const dynamic = "force-dynamic";
/** Publishing a campaign can fan a push out to every eligible player. */
export const maxDuration = 60;

/**
 * The caller's authority over missions.
 *
 * Operations (admin and super-admin) see and approve everything. A partner
 * account is scoped to its own businesses: it can write and submit a campaign
 * against them, and sees nothing else. `businessIds` containing "*" is how the
 * account model spells "all of them".
 */
function scopeFor(session: Awaited<ReturnType<typeof requireAdmin>>): MissionScope {
  const operations =
    session.role === "super_admin" ||
    (session.role === "admin" && session.businessIds.includes("*"));
  return {
    actor: session.email,
    partnerIds: operations ? null : session.businessIds.filter((value) => value !== "*"),
    canApprove: session.role === "super_admin" || session.role === "admin",
  };
}

export async function GET(request: Request) {
  try {
    const session = await requireAdmin(request);
    const db = await getDb();
    return ok(await listMissionDefinitions(db, scopeFor(session)));
  } catch (error) {
    return fail(error);
  }
}

/**
 * Publishes a mission definition, or simulates one without publishing.
 *
 * Always a new `definition_version`, never an edit: the requirements forbid
 * changing an active mission's conditions or rewards in place, because
 * instances already in flight point at the version they were assigned under and
 * must keep being judged by it. Republishing under the same key supersedes the
 * old version for anyone starting fresh, and leaves everyone mid-mission alone.
 *
 * `?simulate=1` runs the pre-flight and writes nothing, which is what the
 * builder calls while an operator is still typing.
 */
export async function POST(request: Request) {
  try {
    const session = await requireAdmin(request);
    const scope = scopeFor(session);
    const input = schema.parse(await request.json());
    const draft = {
      ...input,
      partnerId: input.partnerId ?? null,
      window: input.window ?? null,
      globalQuota: input.globalQuota ?? null,
      rewardBudgetCentavos: input.rewardBudgetCentavos ?? null,
      startsAt: input.startsAt ?? null,
      endsAt: input.endsAt ?? null,
      termsUrl: input.termsUrl ?? null,
      localizationKey: input.localizationKey ?? null,
    };

    if (new URL(request.url).searchParams.get("simulate")) {
      const db = await getDb();
      return ok(await simulateMission(db, draft));
    }

    const published = await publishMissionDefinition(scope, draft);
    // After the commit, never inside it: a fan-out is a few hundred network
    // calls, and a campaign that is live but silent is a far better failure
    // than a transaction held open across them.
    if (published.status === "Active") {
      await announceUrgentMission({
        missionKey: published.missionKey,
        definitionVersion: published.definitionVersion,
      });
    }
    return ok(published);
  } catch (error) {
    return fail(error);
  }
}

const stopSchema = z.object({
  action: z.literal("stop").default("stop"),
  missionKey: z.string().min(3).max(64),
  definitionVersion: z.number().int().min(1),
  /**
   * Whether players already inside the mission are cancelled as well. Recorded
   * either way, because "we stopped it but let the people mid-way finish" is a
   * policy decision somebody has to be able to point at later.
   */
  cancelInProgress: z.boolean().default(false),
  reason: z.string().min(4).max(280),
});

const reviewSchema = z.object({
  action: z.literal("review"),
  missionKey: z.string().min(3).max(64),
  definitionVersion: z.number().int().min(1),
  decision: z.enum(["Approved", "Rejected"]),
  /** False stages an approved mission instead of starting it immediately. */
  activate: z.boolean().default(true),
  note: z.string().min(4).max(280),
});

/** Stops a running mission, or records operations' decision on one in review. */
export async function PATCH(request: Request) {
  try {
    const session = await requireAdmin(request);
    const scope = scopeFor(session);
    const body = await request.json();

    if (body?.action === "review") {
      const input = reviewSchema.parse(body);
      const decided = await decideMissionReview({ scope, ...input });
      if (decided.status === "Active") {
        await announceUrgentMission({
          missionKey: decided.missionKey,
          definitionVersion: decided.definitionVersion,
        });
      }
      return ok(decided);
    }

    const input = stopSchema.parse(body);
    return ok(await stopMission({ scope, ...input }));
  } catch (error) {
    return fail(error);
  }
}
