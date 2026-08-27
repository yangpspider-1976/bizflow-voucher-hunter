import crypto from "node:crypto";
import { z } from "zod";
import { assertBusinessAccess, assertRewardsAdmin, requireAdmin } from "@/server/auth";
import { all, getDb, one, run, withTx } from "@/server/db";
import { AppError, fail, ok } from "@/server/errors";
import { recordRewardAudit } from "@/server/rewards-network";

const isoNow = () => new Date().toISOString();
const id = (prefix: string) => `${prefix}_${crypto.randomBytes(8).toString("hex")}`;

const rewardLineSchema = z.object({
  type: z.enum(["XP", "LP", "HUNT_TICKET", "BADGE"]),
  amount: z.number().int().nonnegative(),
  fundingSource: z.enum(["PLATFORM", "PARTNER"]).optional(),
  badge: z.string().min(1).max(64).optional(),
});

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
  autoClaim: z.boolean().default(true),
  userQuota: z.number().int().min(1).max(100).default(1),
  globalQuota: z.number().int().min(1).nullable().optional(),
  rewardBudgetCentavos: z.number().int().min(0).nullable().optional(),
  status: z.enum(["Draft", "Review", "Scheduled", "Active", "Stopped"]).default("Draft"),
  startsAt: z.string().datetime().nullable().optional(),
  endsAt: z.string().datetime().nullable().optional(),
  sortOrder: z.number().int().min(0).max(10_000).default(100),
});

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const session = await requireAdmin(request);
    assertRewardsAdmin(session);
    const db = await getDb();
    const rows = await all(
      db,
      `SELECT d.*, b.name AS partner_name
       FROM mission_definitions d
       LEFT JOIN businesses b ON b.id = d.partner_id
       ORDER BY d.mission_key ASC, d.definition_version DESC`,
    );
    return ok(rows);
  } catch (error) {
    return fail(error);
  }
}

/**
 * Publishes a mission definition.
 *
 * Always a new `definition_version`, never an edit: the requirements forbid
 * changing an active mission's conditions or rewards in place, because
 * instances already in flight point at the version they were assigned under and
 * must keep being judged by it. Republishing under the same key supersedes the
 * old version for anyone starting fresh, and leaves everyone mid-mission alone.
 */
export async function POST(request: Request) {
  try {
    const session = await requireAdmin(request);
    assertRewardsAdmin(session);
    const input = schema.parse(await request.json());

    if (input.partnerId) assertBusinessAccess(session, input.partnerId);

    const paysPartnerLp = input.reward.some(
      (line) => line.type === "LP" && line.fundingSource === "PARTNER",
    );
    if (paysPartnerLp && !input.partnerId) {
      throw new AppError(
        "E-CONFIG-INVALID",
        "A partner-funded reward needs the partner it is funded by",
        400,
      );
    }
    if (paysPartnerLp && (input.rewardBudgetCentavos ?? 0) <= 0) {
      throw new AppError(
        "E-CONFIG-INVALID",
        "A partner-funded reward needs a budget to draw against",
        400,
      );
    }

    const result = await withTx(async (tx) => {
      const previous = await one(
        tx,
        "SELECT COALESCE(MAX(definition_version), 0) + 1 AS next FROM mission_definitions WHERE mission_key = ?",
        [input.missionKey],
      );
      const definitionVersion = Number(previous?.next ?? 1);
      const now = isoNow();

      await run(
        tx,
        `INSERT INTO mission_definitions
         (id, mission_key, definition_version, type, title, description, trigger_event,
          target_count, window_start, window_end, min_level, partner_id, reward_json,
          condition_json, auto_claim, user_quota, global_quota, reward_budget_centavos,
          status, starts_at, ends_at, sort_order, created_by, approved_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id("mdef"),
          input.missionKey,
          definitionVersion,
          input.type,
          input.title,
          input.description,
          input.triggerEvent,
          input.targetCount,
          input.window?.startTime ?? null,
          input.window?.endTime ?? null,
          input.minLevel,
          input.partnerId ?? null,
          JSON.stringify(input.reward),
          JSON.stringify(input.condition),
          input.autoClaim ? 1 : 0,
          input.userQuota,
          input.globalQuota ?? null,
          input.rewardBudgetCentavos ?? null,
          input.status,
          input.startsAt ?? null,
          input.endsAt ?? null,
          input.sortOrder,
          session.email,
          input.status === "Active" ? session.email : null,
          now,
          now,
        ],
      );

      // Superseding, not deleting: older versions stay readable so an instance
      // assigned under one can still be explained.
      await run(
        tx,
        `UPDATE mission_definitions SET status = 'Archived', updated_at = ?
         WHERE mission_key = ? AND definition_version < ? AND status IN ('Active', 'Scheduled')`,
        [now, input.missionKey, definitionVersion],
      );

      await recordRewardAudit(tx, {
        actorType: "admin",
        actorId: session.email,
        action: "gamification_mission_published",
        entityType: "mission_definition",
        entityId: `${input.missionKey}:${definitionVersion}`,
        metadata: {
          type: input.type,
          triggerEvent: input.triggerEvent,
          reward: input.reward,
          status: input.status,
          partnerId: input.partnerId ?? null,
        },
      });

      return { missionKey: input.missionKey, definitionVersion };
    });

    return ok(result);
  } catch (error) {
    return fail(error);
  }
}

const stopSchema = z.object({
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

/** Stops a running mission. */
export async function PATCH(request: Request) {
  try {
    const session = await requireAdmin(request);
    assertRewardsAdmin(session);
    const input = stopSchema.parse(await request.json());

    const stopped = await withTx(async (tx) => {
      const now = isoNow();
      await run(
        tx,
        "UPDATE mission_definitions SET status = 'Stopped', updated_at = ? WHERE mission_key = ? AND definition_version = ?",
        [now, input.missionKey, input.definitionVersion],
      );
      const cancelled = input.cancelInProgress
        ? await run(
            tx,
            `UPDATE user_missions
             SET state = 'CANCELLED', reject_reason = ?, updated_at = ?
             WHERE mission_key = ? AND definition_version = ?
               AND state IN ('LOCKED', 'AVAILABLE', 'IN_PROGRESS', 'VERIFYING')`,
            [input.reason, now, input.missionKey, input.definitionVersion],
          )
        : 0;

      await recordRewardAudit(tx, {
        actorType: "admin",
        actorId: session.email,
        action: "gamification_mission_stopped",
        entityType: "mission_definition",
        entityId: `${input.missionKey}:${input.definitionVersion}`,
        metadata: {
          reason: input.reason,
          cancelInProgress: input.cancelInProgress,
          cancelled,
        },
      });
      return { cancelled };
    });

    return ok(stopped);
  } catch (error) {
    return fail(error);
  }
}
