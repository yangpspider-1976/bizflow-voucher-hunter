/**
 * Authoring, approval and pre-flight simulation for missions.
 *
 * The Admin CMS half of the mission system. Three rules shape all of it:
 *
 *  - A live mission is never edited. Publishing a change writes a new
 *    `definition_version`, and instances already in flight keep pointing at the
 *    version they were assigned under.
 *  - A partner authors, operations approves. A partner-scoped account can write
 *    a campaign against its own business and send it for review; only an
 *    operations account can put it in front of players.
 *  - Nothing goes live unsimulated. `simulateMission` answers the three
 *    questions §10.1 says to ask first — how many people will see it, what it
 *    could cost at worst, and whether the money exists — and the publish path
 *    refuses a partner-funded campaign whose budget the deposit cannot cover.
 */
import crypto from "node:crypto";
import type { MissionAudience, RewardLine } from "@bizflow/shared";
import { all, one, run, withTx, type Exec } from "@/server/db";
import { AppError } from "@/server/errors";
import { centavosToLoyaltyPoints, recordRewardAudit } from "@/server/rewards-network";
import { summarise } from "./rewards";

const isoNow = () => new Date().toISOString();
const id = (prefix: string) => `${prefix}_${crypto.randomBytes(8).toString("hex")}`;
const DAY_MS = 24 * 60 * 60 * 1000;
const RETURN_WINDOW_DAYS = 3;

/** What a caller is allowed to do with missions, derived from their session. */
export type MissionScope = {
  actor: string;
  /** Null for operations: every partner. A list for partner-scoped accounts. */
  partnerIds: string[] | null;
  /** True when this account can put a mission in front of players. */
  canApprove: boolean;
};

export function assertPartnerInScope(scope: MissionScope, partnerId: string | null) {
  if (scope.partnerIds === null) return;
  if (!partnerId || !scope.partnerIds.includes(partnerId)) {
    throw new AppError(
      "E-STAFF-BUSINESS-SCOPE",
      "You can only run missions for your own business",
      403,
    );
  }
}

export type MissionDraft = {
  missionKey: string;
  type: "DAILY" | "URGENT" | "ONBOARDING" | "PARTNER";
  title: string;
  description: string;
  triggerEvent: string;
  targetCount: number;
  window: { startTime: string; endTime: string } | null;
  minLevel: number;
  partnerId: string | null;
  reward: RewardLine[];
  condition: Record<string, unknown>;
  audience: MissionAudience;
  autoClaim: boolean;
  requiresProof: boolean;
  quotaMode: "RESERVE_ON_JOIN" | "ON_COMPLETION";
  userQuota: number;
  globalQuota: number | null;
  rewardBudgetCentavos: number | null;
  status: "Draft" | "Review" | "Scheduled" | "Active" | "Stopped";
  startsAt: string | null;
  endsAt: string | null;
  exposureChannel: "app" | "push" | "both";
  termsUrl: string | null;
  localizationKey: string | null;
  sortOrder: number;
};

/* Simulation ---------------------------------------------------------------- */

export type MissionSimulation = {
  /** Players who would be shown the mission today. */
  audienceSize: number;
  /** The most people who could ever complete it, quota included. */
  maxCompletions: number;
  lpPerCompletionCentavos: number;
  xpPerCompletion: number;
  /** Worst case LP outlay, in centavos. */
  maxLpCostCentavos: number;
  maxLpCost: string;
  budgetCentavos: number | null;
  budget: string;
  /** True when the worst case exceeds the budget the campaign declared. */
  budgetExceeded: boolean;
  funding: "PLATFORM" | "PARTNER";
  /** Partner-funded only: what the partner has on deposit right now. */
  partnerDepositCentavos: number | null;
  partnerDeposit: string;
  /** True when a partner-funded campaign is bigger than the partner's deposit. */
  depositShort: boolean;
  /** Anything an operator should read before approving. */
  warnings: string[];
};

/**
 * What a campaign would cost and reach if it went live now.
 *
 * Every number here is an upper bound rather than a forecast. Nobody can say
 * how many people will actually do a mission, but "this cannot cost more than
 * X and cannot reach more than Y" is a fact an approver can act on, and it is
 * the fact §10.1 asks to be put in front of them.
 */
export async function simulateMission(
  db: Exec,
  draft: Pick<
    MissionDraft,
    | "audience"
    | "minLevel"
    | "partnerId"
    | "reward"
    | "globalQuota"
    | "userQuota"
    | "rewardBudgetCentavos"
  >,
): Promise<MissionSimulation> {
  const audienceSize = await estimateAudience(db, draft);
  const payout = summarise(draft.reward);
  const funding: "PLATFORM" | "PARTNER" =
    draft.reward.find((line) => line.fundingSource)?.fundingSource ?? "PLATFORM";

  // A player may do a repeatable mission `userQuota` times, so the reachable
  // completions are that many per person — bounded, as everything is, by the
  // campaign-wide quota when there is one.
  const perPersonCap = Math.max(1, draft.userQuota);
  const uncapped = audienceSize * perPersonCap;
  const maxCompletions =
    draft.globalQuota === null ? uncapped : Math.min(uncapped, draft.globalQuota);
  const maxLpCostCentavos = maxCompletions * payout.lpCentavos;

  const warnings: string[] = [];
  const budget = draft.rewardBudgetCentavos;
  const budgetExceeded = budget !== null && maxLpCostCentavos > budget;
  if (budgetExceeded) {
    warnings.push(
      `At full take-up this pays ${centavosToLoyaltyPoints(maxLpCostCentavos)} against a ${centavosToLoyaltyPoints(budget ?? 0)} budget. Later players are refused once the budget runs out.`,
    );
  }
  if (audienceSize === 0) {
    warnings.push("No player matches this audience today. Nobody would see the mission.");
  }
  if (draft.globalQuota === null && payout.lpCentavos > 0 && budget === null) {
    warnings.push("No quota and no budget: this campaign has no upper bound on what it can pay.");
  }

  let partnerDepositCentavos: number | null = null;
  let depositShort = false;
  if (funding === "PARTNER" && draft.partnerId) {
    const partner = await one(
      db,
      "SELECT deposit_balance_centavos FROM businesses WHERE id = ?",
      [draft.partnerId],
    );
    partnerDepositCentavos = Number(partner?.deposit_balance_centavos ?? 0);
    const committed = budget ?? maxLpCostCentavos;
    depositShort = committed > partnerDepositCentavos;
    if (depositShort) {
      warnings.push(
        `The partner has ${centavosToLoyaltyPoints(partnerDepositCentavos)} on deposit and this commits ${centavosToLoyaltyPoints(committed)}.`,
      );
    }
  }

  return {
    audienceSize,
    maxCompletions,
    lpPerCompletionCentavos: payout.lpCentavos,
    xpPerCompletion: payout.xp,
    maxLpCostCentavos,
    maxLpCost: centavosToLoyaltyPoints(maxLpCostCentavos),
    budgetCentavos: budget,
    budget: budget === null ? "—" : centavosToLoyaltyPoints(budget),
    budgetExceeded,
    funding,
    partnerDepositCentavos,
    partnerDeposit:
      partnerDepositCentavos === null ? "—" : centavosToLoyaltyPoints(partnerDepositCentavos),
    depositShort,
    warnings,
  };
}

/**
 * How many players match a campaign's audience right now.
 *
 * The area is deliberately not part of this count. We do not store where our
 * players are — only where they were when they last tapped Join on a flash
 * mission — and inventing a location to filter on would make the estimate look
 * more precise than it is. A radius always narrows the real audience, so the
 * count is an upper bound either way, which is what an approver needs.
 */
async function estimateAudience(
  db: Exec,
  draft: Pick<MissionDraft, "audience" | "minLevel" | "partnerId">,
): Promise<number> {
  const clauses = ["w.status = 'Active'"];
  const args: Array<string | number> = [];

  if (draft.minLevel > 1) {
    clauses.push("COALESCE(ul.current_level, 1) >= ?");
    args.push(draft.minLevel);
  }

  const audience = draft.audience;
  const days = audience.segmentDays ?? (audience.segment === "new" ? 7 : 30);
  const cutoff = new Date(Date.now() - days * DAY_MS).toISOString();
  const returnCutoff = new Date(Date.now() - RETURN_WINDOW_DAYS * DAY_MS).toISOString();

  if (audience.segment === "new") {
    clauses.push("w.created_at >= ?");
    args.push(cutoff);
  } else if (audience.segment === "dormant") {
    clauses.push(
      "EXISTS (SELECT 1 FROM gamification_events e WHERE e.wallet_id = w.id)",
    );
    clauses.push(
      "NOT EXISTS (SELECT 1 FROM gamification_events e WHERE e.wallet_id = w.id AND e.occurred_at_utc >= ?)",
    );
    args.push(cutoff);
  } else if (audience.segment === "returning") {
    clauses.push(
      "EXISTS (SELECT 1 FROM gamification_events e WHERE e.wallet_id = w.id AND e.occurred_at_utc >= ?)",
    );
    clauses.push(
      "NOT EXISTS (SELECT 1 FROM gamification_events e WHERE e.wallet_id = w.id AND e.occurred_at_utc >= ? AND e.occurred_at_utc < ?)",
    );
    args.push(returnCutoff, cutoff, returnCutoff);
  }

  if (audience.firstVisitOnly && draft.partnerId) {
    clauses.push(
      `NOT EXISTS (SELECT 1 FROM user_counter_members m
        WHERE m.wallet_id = w.id AND m.counter_key = 'distinct_partners' AND m.member_key = ?)`,
    );
    args.push(draft.partnerId);
  }

  const row = await one(
    db,
    `SELECT COUNT(*) AS total
     FROM reward_wallets w
     LEFT JOIN user_levels ul ON ul.wallet_id = w.id
     WHERE ${clauses.join(" AND ")}`,
    args,
  );
  return Number(row?.total ?? 0);
}

/* Publishing ---------------------------------------------------------------- */

/**
 * Writes a new version of a mission definition.
 *
 * Always an insert. The previous live version is archived in the same
 * transaction so "the live set" stays a single row per key, and the archived
 * row stays readable so an instance assigned under it can still be explained.
 */
export async function publishMissionDefinition(scope: MissionScope, draft: MissionDraft) {
  assertDraftIsSane(draft);
  assertPartnerInScope(scope, draft.partnerId);

  // Only operations can put a mission in front of players. A partner writing
  // one gets it queued for review however they labelled it, which is safer than
  // refusing the request and losing what they typed.
  const status =
    scope.canApprove || draft.status === "Draft" ? draft.status : ("Review" as const);

  return withTx(async (tx) => {
    if (status === "Active" || status === "Scheduled") {
      const simulation = await simulateMission(tx, draft);
      if (simulation.depositShort) {
        throw new AppError(
          "E-BUDGET-EXHAUSTED",
          `This campaign commits more Loyalty Points than the partner has on deposit (${simulation.partnerDeposit}).`,
          409,
        );
      }
    }

    const previous = await one(
      tx,
      "SELECT COALESCE(MAX(definition_version), 0) + 1 AS next FROM mission_definitions WHERE mission_key = ?",
      [draft.missionKey],
    );
    const definitionVersion = Number(previous?.next ?? 1);
    const now = isoNow();
    const approved = status === "Active" || status === "Scheduled";

    await run(
      tx,
      `INSERT INTO mission_definitions
       (id, mission_key, definition_version, type, title, description, trigger_event,
        target_count, window_start, window_end, min_level, partner_id, reward_json,
        condition_json, audience_json, auto_claim, requires_proof, quota_mode, user_quota,
        global_quota, reward_budget_centavos, status, starts_at, ends_at, exposure_channel,
        terms_url, localization_key, sort_order, created_by, submitted_by, submitted_at,
        approved_by, approved_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id("mdef"),
        draft.missionKey,
        definitionVersion,
        draft.type,
        draft.title,
        draft.description,
        draft.triggerEvent,
        draft.targetCount,
        draft.window?.startTime ?? null,
        draft.window?.endTime ?? null,
        draft.minLevel,
        draft.partnerId,
        JSON.stringify(draft.reward),
        JSON.stringify(draft.condition),
        JSON.stringify(draft.audience),
        draft.autoClaim ? 1 : 0,
        draft.requiresProof ? 1 : 0,
        draft.quotaMode,
        draft.userQuota,
        draft.globalQuota,
        draft.rewardBudgetCentavos,
        status,
        draft.startsAt,
        draft.endsAt,
        draft.exposureChannel,
        draft.termsUrl,
        draft.localizationKey,
        draft.sortOrder,
        scope.actor,
        status === "Review" ? scope.actor : null,
        status === "Review" ? now : null,
        approved ? scope.actor : null,
        approved ? now : null,
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
      [now, draft.missionKey, definitionVersion],
    );

    await recordRewardAudit(tx, {
      actorType: "admin",
      actorId: scope.actor,
      action: "gamification_mission_published",
      entityType: "mission_definition",
      entityId: `${draft.missionKey}:${definitionVersion}`,
      metadata: {
        type: draft.type,
        triggerEvent: draft.triggerEvent,
        reward: draft.reward,
        status,
        partnerId: draft.partnerId,
        quotaMode: draft.quotaMode,
        requiresProof: draft.requiresProof,
      },
    });

    return { missionKey: draft.missionKey, definitionVersion, status };
  });
}

/**
 * Operations' decision on a mission a partner sent for review.
 *
 * Approving is the moment a campaign becomes real, so it is also the moment the
 * simulation is re-run: the audience and the partner's deposit both move
 * between drafting and approval, and approving into a shortfall is exactly the
 * mistake the pre-flight exists to catch.
 */
export async function decideMissionReview(input: {
  scope: MissionScope;
  missionKey: string;
  definitionVersion: number;
  decision: "Approved" | "Rejected";
  /** Approved missions can be staged rather than started immediately. */
  activate?: boolean;
  note: string;
}) {
  if (!input.scope.canApprove) {
    throw new AppError(
      "E-REWARDS-ADMIN-SCOPE",
      "Approving a mission requires an operations account",
      403,
    );
  }
  if (!input.note.trim()) {
    throw new AppError("E-VALIDATION-400", "Record why this was approved or rejected", 400);
  }

  return withTx(async (tx) => {
    const row = await one(
      tx,
      "SELECT * FROM mission_definitions WHERE mission_key = ? AND definition_version = ? FOR UPDATE",
      [input.missionKey, input.definitionVersion],
    );
    if (!row) {
      throw new AppError("E-MISSION-NOT-ACTIVE", "That mission version does not exist", 404);
    }
    if (String(row.status) !== "Review") {
      throw new AppError(
        "E-MISSION-NOT-ACTIVE",
        `That mission is ${String(row.status)}, not waiting for review`,
        409,
      );
    }

    const now = isoNow();
    const status =
      input.decision === "Rejected" ? "Draft" : input.activate === false ? "Scheduled" : "Active";

    if (input.decision === "Approved") {
      const simulation = await simulateMission(tx, {
        audience: JSON.parse(String(row.audience_json ?? "{}")),
        minLevel: Number(row.min_level ?? 1),
        partnerId: row.partner_id ? String(row.partner_id) : null,
        reward: JSON.parse(String(row.reward_json ?? "[]")),
        globalQuota: row.global_quota === null ? null : Number(row.global_quota),
        userQuota: Number(row.user_quota ?? 1),
        rewardBudgetCentavos:
          row.reward_budget_centavos === null ? null : Number(row.reward_budget_centavos),
      });
      if (simulation.depositShort) {
        throw new AppError(
          "E-BUDGET-EXHAUSTED",
          `The partner's deposit (${simulation.partnerDeposit}) no longer covers this campaign.`,
          409,
        );
      }
    }

    await run(
      tx,
      `UPDATE mission_definitions
       SET status = ?, approved_by = ?, approved_at = ?, review_note = ?, updated_at = ?
       WHERE mission_key = ? AND definition_version = ?`,
      [
        status,
        input.decision === "Approved" ? input.scope.actor : null,
        input.decision === "Approved" ? now : null,
        input.note.trim(),
        now,
        input.missionKey,
        input.definitionVersion,
      ],
    );

    if (input.decision === "Approved") {
      await run(
        tx,
        `UPDATE mission_definitions SET status = 'Archived', updated_at = ?
         WHERE mission_key = ? AND definition_version < ? AND status IN ('Active', 'Scheduled')`,
        [now, input.missionKey, input.definitionVersion],
      );
    }

    await recordRewardAudit(tx, {
      actorType: "admin",
      actorId: input.scope.actor,
      action: `gamification_mission_${input.decision.toLowerCase()}`,
      entityType: "mission_definition",
      entityId: `${input.missionKey}:${input.definitionVersion}`,
      metadata: { note: input.note.trim(), status },
    });

    return { missionKey: input.missionKey, definitionVersion: input.definitionVersion, status };
  });
}

/**
 * Stops a running mission.
 *
 * The choice the requirements ask for is `cancelInProgress`: block new joiners
 * only, or also end the runs already under way. Either way it is recorded,
 * because "we stopped it but let the people mid-way finish" is a policy
 * decision somebody has to be able to point at later. Cancelled instances hand
 * their reserved quota places back on the next sweep.
 */
export async function stopMission(input: {
  scope: MissionScope;
  missionKey: string;
  definitionVersion: number;
  cancelInProgress: boolean;
  reason: string;
}) {
  return withTx(async (tx) => {
    const row = await one(
      tx,
      "SELECT partner_id FROM mission_definitions WHERE mission_key = ? AND definition_version = ?",
      [input.missionKey, input.definitionVersion],
    );
    if (!row) {
      throw new AppError("E-MISSION-NOT-ACTIVE", "That mission version does not exist", 404);
    }
    assertPartnerInScope(input.scope, row.partner_id ? String(row.partner_id) : null);

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
      actorId: input.scope.actor,
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
}

/** Everything an operator or partner may see, newest version of each key first. */
export async function listMissionDefinitions(db: Exec, scope: MissionScope) {
  const scoped = scope.partnerIds !== null;
  if (scoped && scope.partnerIds!.length === 0) return [];
  const where = scoped
    ? `WHERE d.partner_id IN (${scope.partnerIds!.map(() => "?").join(", ")})`
    : "";
  return all(
    db,
    `SELECT d.*, b.name AS partner_name
     FROM mission_definitions d
     LEFT JOIN businesses b ON b.id = d.partner_id
     ${where}
     ORDER BY d.mission_key ASC, d.definition_version DESC`,
    scoped ? scope.partnerIds! : [],
  );
}

/**
 * The rules a definition has to satisfy before it can exist at all.
 *
 * Deliberately strict about the combinations that would produce a mission
 * nobody can finish or that pays money nobody agreed to: a partner-funded
 * reward with no partner, evidence with an automatic payout, a reservation with
 * nothing to reserve.
 */
function assertDraftIsSane(draft: MissionDraft) {
  const paysPartnerLp = draft.reward.some(
    (line) => line.type === "LP" && line.fundingSource === "PARTNER",
  );
  if (paysPartnerLp && !draft.partnerId) {
    throw new AppError(
      "E-CONFIG-INVALID",
      "A partner-funded reward needs the partner it is funded by",
      400,
    );
  }
  if (paysPartnerLp && (draft.rewardBudgetCentavos ?? 0) <= 0) {
    throw new AppError(
      "E-CONFIG-INVALID",
      "A partner-funded reward needs a budget to draw against",
      400,
    );
  }
  if (draft.quotaMode === "RESERVE_ON_JOIN" && draft.globalQuota === null) {
    throw new AppError(
      "E-CONFIG-INVALID",
      "Reserving on join needs a total quota to reserve out of",
      400,
    );
  }
  if (draft.startsAt && draft.endsAt && Date.parse(draft.endsAt) <= Date.parse(draft.startsAt)) {
    throw new AppError("E-CONFIG-INVALID", "The mission ends before it starts", 400);
  }
  if (draft.audience.area && draft.type === "DAILY") {
    throw new AppError(
      "E-CONFIG-INVALID",
      "A daily mission cannot be confined to an area — everybody gets it every day",
      400,
    );
  }
  if (draft.requiresProof && draft.type === "DAILY") {
    throw new AppError(
      "E-CONFIG-INVALID",
      "Daily missions pay themselves; evidence review belongs on urgent missions",
      400,
    );
  }
}
