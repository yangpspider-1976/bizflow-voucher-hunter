/**
 * The KPI queries behind the gamification dashboard.
 *
 * §13 of the requirements lists eight areas and the dimensions each has to be
 * sliceable by. This module answers them from the tables the engine already
 * writes — no separate analytics store, no event pipeline to keep in sync, and
 * so no possibility of the dashboard and the ledger disagreeing about what
 * happened.
 *
 * Every figure is bounded by a date range in Manila days, converted to UTC
 * instants once at the top. Rows are stored in UTC and read in Manila, and
 * doing that conversion in one place is what keeps "yesterday" the same
 * yesterday on every panel.
 */
import { all, getDb, one, type Exec } from "@/server/db";
import { centavosToLoyaltyPoints } from "@/server/rewards-network";
import { loadLevels } from "./config";
import { addManilaDays, manilaDate, manilaMidnightUtc } from "./time";

export type AnalyticsRange = {
  /** Manila dates, inclusive. */
  from: string;
  to: string;
  /** Optional partner filter, applied wherever a row names one. */
  partnerId?: string | null;
};

/** The half-open UTC interval a Manila date range covers. */
function boundsFor(range: AnalyticsRange) {
  return {
    from: manilaMidnightUtc(range.from),
    to: manilaMidnightUtc(addManilaDays(range.to, 1)),
  };
}

/** A sensible default window: the last 30 Manila days, ending today. */
export function defaultRange(): AnalyticsRange {
  const to = manilaDate();
  return { from: addManilaDays(to, -29), to };
}

export type EngagementKpis = {
  activePlayers: number;
  missionParticipants: number;
  missionHomeVisitRate: number;
  newPlayers: number;
};

/**
 * Who was here and how many of them played.
 *
 * "Active" is a player with any verified event in the window, which is the same
 * definition the dormancy segment uses — one idea of activity across the whole
 * system rather than one per screen.
 */
export async function engagementKpis(db: Exec, range: AnalyticsRange): Promise<EngagementKpis> {
  const { from, to } = boundsFor(range);
  const [active, participants, players, joined] = await Promise.all([
    one(
      db,
      `SELECT COUNT(DISTINCT wallet_id) AS total FROM gamification_events
       WHERE occurred_at_utc >= ? AND occurred_at_utc < ?`,
      [from, to],
    ),
    one(
      db,
      `SELECT COUNT(DISTINCT wallet_id) AS total FROM user_missions
       WHERE updated_at >= ? AND updated_at < ?
         AND state IN ('IN_PROGRESS', 'VERIFYING', 'CLAIMABLE', 'CLAIMED')`,
      [from, to],
    ),
    one(
      db,
      "SELECT COUNT(*) AS total FROM reward_wallets WHERE created_at >= ? AND created_at < ?",
      [from, to],
    ),
    one(
      db,
      `SELECT COUNT(DISTINCT wallet_id) AS total FROM user_missions
       WHERE assigned_at >= ? AND assigned_at < ?`,
      [from, to],
    ),
  ]);

  const activePlayers = Number(active?.total ?? 0);
  const assigned = Number(joined?.total ?? 0);
  return {
    activePlayers,
    missionParticipants: Number(participants?.total ?? 0),
    // Assignment happens on the first look of the day, so "was assigned a
    // mission" is the closest honest proxy for "opened the mission screen"
    // without adding a client-side analytics event nobody would trust.
    missionHomeVisitRate: activePlayers === 0 ? 0 : assigned / activePlayers,
    newPlayers: Number(players?.total ?? 0),
  };
}

export type MissionFunnelRow = {
  missionKey: string;
  title: string;
  type: string;
  partnerName: string;
  assigned: number;
  started: number;
  completed: number;
  claimed: number;
  expired: number;
  rejected: number;
  /** claimed / assigned, 0-1. */
  conversion: number;
  /** Median-ish: mean minutes from assignment to completion. */
  averageMinutesToComplete: number;
};

/**
 * Exposure → join → completion → reward, per mission.
 *
 * One row per mission key rather than per definition version: an operator
 * republishing a mission mid-month wants to see the campaign, not two halves of
 * it. The version is still on every instance for anyone who needs to split it.
 */
export async function missionFunnel(
  db: Exec,
  range: AnalyticsRange,
): Promise<MissionFunnelRow[]> {
  const { from, to } = boundsFor(range);
  const args: Array<string> = [from, to];
  const partnerFilter = range.partnerId ? "AND d.partner_id = ?" : "";
  if (range.partnerId) args.push(range.partnerId);

  const rows = await all(
    db,
    `SELECT um.mission_key,
            MAX(d.title) AS title,
            MAX(d.type) AS type,
            MAX(b.name) AS partner_name,
            COUNT(*) AS assigned,
            SUM(CASE WHEN um.progress > 0 THEN 1 ELSE 0 END) AS started,
            SUM(CASE WHEN um.completed_at IS NOT NULL THEN 1 ELSE 0 END) AS completed,
            SUM(CASE WHEN um.state = 'CLAIMED' THEN 1 ELSE 0 END) AS claimed,
            SUM(CASE WHEN um.state = 'EXPIRED' THEN 1 ELSE 0 END) AS expired,
            SUM(CASE WHEN um.state = 'REJECTED' THEN 1 ELSE 0 END) AS rejected,
            AVG(
              CASE WHEN um.completed_at IS NOT NULL
                THEN EXTRACT(EPOCH FROM (um.completed_at::timestamptz - um.assigned_at::timestamptz)) / 60
              END
            ) AS avg_minutes
     FROM user_missions um
     JOIN mission_definitions d
       ON d.mission_key = um.mission_key AND d.definition_version = um.definition_version
     LEFT JOIN businesses b ON b.id = d.partner_id
     WHERE um.assigned_at >= ? AND um.assigned_at < ?
       ${partnerFilter}
     GROUP BY um.mission_key
     ORDER BY COUNT(*) DESC`,
    args,
  );

  return rows.map((row) => {
    const assigned = Number(row.assigned ?? 0);
    const claimed = Number(row.claimed ?? 0);
    return {
      missionKey: String(row.mission_key),
      title: String(row.title ?? row.mission_key),
      type: String(row.type ?? ""),
      partnerName: String(row.partner_name ?? ""),
      assigned,
      started: Number(row.started ?? 0),
      completed: Number(row.completed ?? 0),
      claimed,
      expired: Number(row.expired ?? 0),
      rejected: Number(row.rejected ?? 0),
      conversion: assigned === 0 ? 0 : claimed / assigned,
      averageMinutesToComplete: Math.round(Number(row.avg_minutes ?? 0)),
    };
  });
}

export type LevelKpis = {
  distribution: { level: number; name: string; players: number }[];
  promotions: number;
  conversionCount: number;
  conversionLpCentavos: number;
  conversionLp: string;
  xpBySource: { source: string; xp: number }[];
};

/** Where players stand, how many moved, and what fuelled it. */
export async function levelKpis(db: Exec, range: AnalyticsRange): Promise<LevelKpis> {
  const { from, to } = boundsFor(range);
  const { levels } = await loadLevels(db);

  const [distribution, promotions, conversions, sources] = await Promise.all([
    all(
      db,
      "SELECT current_level, COUNT(*) AS players FROM user_levels GROUP BY current_level ORDER BY current_level ASC",
    ),
    one(
      db,
      `SELECT COUNT(*) AS total FROM gamification_events
       WHERE event_name = 'level_up' AND occurred_at_utc >= ? AND occurred_at_utc < ?`,
      [from, to],
    ),
    one(
      db,
      `SELECT COUNT(*) AS total, COALESCE(SUM(lp_centavos), 0) AS lp
       FROM point_xp_conversions
       WHERE status = 'Completed' AND created_at >= ? AND created_at < ?`,
      [from, to],
    ),
    all(
      db,
      `SELECT source_type, COALESCE(SUM(delta), 0) AS xp
       FROM user_xp_ledger
       WHERE created_at >= ? AND created_at < ?
       GROUP BY source_type
       ORDER BY 2 DESC`,
      [from, to],
    ),
  ]);

  const lp = Number(conversions?.lp ?? 0);
  return {
    distribution: distribution.map((row) => ({
      level: Number(row.current_level),
      name: levels.find((entry) => entry.level === Number(row.current_level))?.name ?? "—",
      players: Number(row.players),
    })),
    promotions: Number(promotions?.total ?? 0),
    conversionCount: Number(conversions?.total ?? 0),
    conversionLpCentavos: lp,
    conversionLp: centavosToLoyaltyPoints(lp),
    xpBySource: sources.map((row) => ({
      source: String(row.source_type),
      xp: Number(row.xp),
    })),
  };
}

export type AchievementKpis = {
  unlocks: { groupKey: string; tier: string; unlocks: number }[];
  backfillUnlocks: number;
  totalUnlocks: number;
};

/** Badge unlocks in the window, and how many of them came from the backfill. */
export async function achievementKpis(
  db: Exec,
  range: AnalyticsRange,
): Promise<AchievementKpis> {
  const { from, to } = boundsFor(range);
  const [rows, backfilled] = await Promise.all([
    all(
      db,
      `SELECT group_key, tier, COUNT(*) AS unlocks
       FROM user_achievements
       WHERE unlocked_at >= ? AND unlocked_at < ? AND revoked_at IS NULL
       GROUP BY group_key, tier
       ORDER BY COUNT(*) DESC`,
      [from, to],
    ),
    one(
      db,
      `SELECT COUNT(*) AS total FROM user_achievements
       WHERE unlocked_at >= ? AND unlocked_at < ? AND backfill_job_id IS NOT NULL`,
      [from, to],
    ),
  ]);
  return {
    unlocks: rows.map((row) => ({
      groupKey: String(row.group_key),
      tier: String(row.tier),
      unlocks: Number(row.unlocks),
    })),
    backfillUnlocks: Number(backfilled?.total ?? 0),
    totalUnlocks: rows.reduce((total, row) => total + Number(row.unlocks), 0),
  };
}

export type EconomyKpis = {
  issuedLpCentavos: number;
  issuedLp: string;
  platformLpCentavos: number;
  partnerLpCentavos: number;
  xpGranted: number;
  huntTickets: number;
  heldCount: number;
  heldLpCentavos: number;
  reversedCount: number;
  reversedLpCentavos: number;
  bySource: { sourceType: string; lpCentavos: number; lp: string; xp: number }[];
};

/**
 * What the economy paid out, and what it held back.
 *
 * Read from `reward_transactions` rather than from the loyalty ledger, because
 * this is the gamification system's own cost — the ledger also carries purchase
 * accruals and daily awards, which belong to a different question.
 */
export async function economyKpis(db: Exec, range: AnalyticsRange): Promise<EconomyKpis> {
  const { from, to } = boundsFor(range);
  const args: Array<string> = [from, to];
  const partnerFilter = range.partnerId ? "AND partner_id = ?" : "";
  if (range.partnerId) args.push(range.partnerId);

  const [totals, bySource] = await Promise.all([
    one(
      db,
      `SELECT
         COALESCE(SUM(CASE WHEN status = 'GRANTED' THEN lp_centavos END), 0) AS issued,
         COALESCE(SUM(CASE WHEN status = 'GRANTED' AND funding_source = 'PLATFORM' THEN lp_centavos END), 0) AS platform_lp,
         COALESCE(SUM(CASE WHEN status = 'GRANTED' AND funding_source = 'PARTNER' THEN lp_centavos END), 0) AS partner_lp,
         COALESCE(SUM(CASE WHEN status = 'GRANTED' THEN xp_amount END), 0) AS xp,
         COALESCE(SUM(CASE WHEN status = 'GRANTED' THEN hunt_tickets END), 0) AS tickets,
         COUNT(*) FILTER (WHERE status = 'REVIEW_REQUIRED') AS held_count,
         COALESCE(SUM(CASE WHEN status = 'REVIEW_REQUIRED' THEN lp_centavos END), 0) AS held_lp,
         COUNT(*) FILTER (WHERE status = 'REVERSED') AS reversed_count,
         COALESCE(SUM(CASE WHEN status = 'REVERSED' THEN lp_centavos END), 0) AS reversed_lp
       FROM reward_transactions
       WHERE created_at >= ? AND created_at < ?
       ${partnerFilter}`,
      args,
    ),
    all(
      db,
      `SELECT source_type,
              COALESCE(SUM(lp_centavos), 0) AS lp,
              COALESCE(SUM(xp_amount), 0) AS xp
       FROM reward_transactions
       WHERE status = 'GRANTED' AND created_at >= ? AND created_at < ?
       ${partnerFilter}
       GROUP BY source_type
       ORDER BY 2 DESC`,
      args,
    ),
  ]);

  const issued = Number(totals?.issued ?? 0);
  return {
    issuedLpCentavos: issued,
    issuedLp: centavosToLoyaltyPoints(issued),
    platformLpCentavos: Number(totals?.platform_lp ?? 0),
    partnerLpCentavos: Number(totals?.partner_lp ?? 0),
    xpGranted: Number(totals?.xp ?? 0),
    huntTickets: Number(totals?.tickets ?? 0),
    heldCount: Number(totals?.held_count ?? 0),
    heldLpCentavos: Number(totals?.held_lp ?? 0),
    reversedCount: Number(totals?.reversed_count ?? 0),
    reversedLpCentavos: Number(totals?.reversed_lp ?? 0),
    bySource: bySource.map((row) => ({
      sourceType: String(row.source_type),
      lpCentavos: Number(row.lp),
      lp: centavosToLoyaltyPoints(Number(row.lp)),
      xp: Number(row.xp),
    })),
  };
}

export type RiskKpis = {
  openSignals: number;
  bySignal: { signalKey: string; total: number; severity: string }[];
  heldWallets: number;
  suspendedWallets: number;
  deadLetteredEvents: number;
  duplicateEventRate: number;
  proofRejectionRate: number;
};

/** Hold, rejection and duplicate rates — §13's risk row. */
export async function riskKpis(db: Exec, range: AnalyticsRange): Promise<RiskKpis> {
  const { from, to } = boundsFor(range);
  const [signals, bySignal, wallets, deadLetters, events, proofs] = await Promise.all([
    one(db, "SELECT COUNT(*) AS total FROM fraud_signals WHERE status = 'Open'"),
    all(
      db,
      // Ranked rather than MAX(severity): alphabetically "warn" sorts above
      // "critical", which would report the milder of the two.
      `SELECT signal_key, COUNT(*) AS total,
              MAX(CASE severity WHEN 'critical' THEN 3 WHEN 'warn' THEN 2 ELSE 1 END) AS rank
       FROM fraud_signals
       WHERE created_at >= ? AND created_at < ?
       GROUP BY signal_key
       ORDER BY COUNT(*) DESC`,
      [from, to],
    ),
    one(
      db,
      `SELECT
         COUNT(*) FILTER (WHERE risk_state = 'Held') AS held,
         COUNT(*) FILTER (WHERE risk_state = 'Suspended') AS suspended
       FROM reward_wallets`,
    ),
    one(db, "SELECT COUNT(*) AS total FROM gamification_events WHERE status = 'Failed'"),
    one(
      db,
      `SELECT COUNT(*) AS total,
              COUNT(*) FILTER (WHERE status = 'Ignored') AS ignored
       FROM gamification_events
       WHERE created_at >= ? AND created_at < ?`,
      [from, to],
    ),
    one(
      db,
      `SELECT COUNT(*) AS total,
              COUNT(*) FILTER (WHERE review_status = 'Rejected') AS rejected
       FROM mission_proofs
       WHERE submitted_at >= ? AND submitted_at < ?`,
      [from, to],
    ),
  ]);

  const eventTotal = Number(events?.total ?? 0);
  const proofTotal = Number(proofs?.total ?? 0);
  return {
    openSignals: Number(signals?.total ?? 0),
    bySignal: bySignal.map((row) => ({
      signalKey: String(row.signal_key),
      severity: ["info", "info", "warn", "critical"][Number(row.rank ?? 1)] ?? "info",
      total: Number(row.total),
    })),
    heldWallets: Number(wallets?.held ?? 0),
    suspendedWallets: Number(wallets?.suspended ?? 0),
    deadLetteredEvents: Number(deadLetters?.total ?? 0),
    duplicateEventRate: eventTotal === 0 ? 0 : Number(events?.ignored ?? 0) / eventTotal,
    proofRejectionRate: proofTotal === 0 ? 0 : Number(proofs?.rejected ?? 0) / proofTotal,
  };
}

export type RetentionKpis = {
  /** Players who acted on N consecutive Manila days, by streak length. */
  streaks: { days: number; players: number }[];
  playingRetention: number;
  nonPlayingRetention: number;
};

/**
 * Whether playing keeps people coming back.
 *
 * The comparison the requirements ask for: retention among players who
 * completed a mission in the window against those who did not, both measured as
 * "still active in the last seven days". A single number is not a cohort study,
 * but it is the number that says whether the whole feature is earning its keep.
 */
export async function retentionKpis(db: Exec, range: AnalyticsRange): Promise<RetentionKpis> {
  const { from, to } = boundsFor(range);
  const recent = manilaMidnightUtc(addManilaDays(manilaDate(), -6));

  const [streaks, cohorts] = await Promise.all([
    all(
      db,
      `SELECT counter_value AS days, COUNT(*) AS players
       FROM user_achievement_progress
       WHERE counter_key = 'daily_streak' AND counter_value > 0
       GROUP BY counter_value
       ORDER BY counter_value ASC`,
    ),
    one(
      db,
      `SELECT
         COUNT(*) FILTER (WHERE played) AS played_total,
         COUNT(*) FILTER (WHERE played AND active_recently) AS played_active,
         COUNT(*) FILTER (WHERE NOT played) AS idle_total,
         COUNT(*) FILTER (WHERE NOT played AND active_recently) AS idle_active
       FROM (
         SELECT w.id,
                EXISTS (
                  SELECT 1 FROM user_missions um
                  WHERE um.wallet_id = w.id AND um.state = 'CLAIMED'
                    AND um.claimed_at >= ? AND um.claimed_at < ?
                ) AS played,
                EXISTS (
                  SELECT 1 FROM gamification_events e
                  WHERE e.wallet_id = w.id AND e.occurred_at_utc >= ?
                ) AS active_recently
         FROM reward_wallets w
         WHERE w.created_at < ?
       ) cohort`,
      [from, to, recent, to],
    ),
  ]);

  const playedTotal = Number(cohorts?.played_total ?? 0);
  const idleTotal = Number(cohorts?.idle_total ?? 0);
  return {
    streaks: streaks.map((row) => ({
      days: Number(row.days),
      players: Number(row.players),
    })),
    playingRetention: playedTotal === 0 ? 0 : Number(cohorts?.played_active ?? 0) / playedTotal,
    nonPlayingRetention: idleTotal === 0 ? 0 : Number(cohorts?.idle_active ?? 0) / idleTotal,
  };
}

export type VoucherFunnel = {
  hunted: number;
  selected: number;
  booked: number;
  redeemed: number;
};

export type VoucherKpis = {
  funnel: VoucherFunnel;
  /**
   * The same funnel split by the hunter's level, the discount they won, and the
   * partner who honoured it — the three dimensions §13 names.
   */
  byLevel: { level: number; name: string; selected: number; redeemed: number }[];
  byDiscountBand: { band: string; selected: number; redeemed: number }[];
  byPartner: { partnerId: string; partnerName: string; selected: number; redeemed: number }[];
  /** How much of the level-gated stock is actually being taken up. */
  levelOffers: {
    gatedCampaigns: number;
    exclusiveCampaigns: number;
    selectedOnGated: number;
    redeemedOnGated: number;
    /** Gated vouchers as a share of every voucher issued in the window. */
    shareOfSelected: number;
  };
};

/**
 * §13's Voucher row: the hunt→select→booking→QR funnel, and whether the
 * level-gated offers §3.4 lets partners write are actually being taken up.
 *
 * Each stage is counted on its own timestamp inside the window rather than by
 * following one cohort forward. A voucher won on the 30th and redeemed on the
 * 2nd belongs to the redemption count of the month it was redeemed in, which is
 * how the partner settlement reads it — and two numbers for one fact is how a
 * dashboard loses an argument with finance.
 *
 * One honest limitation, worth a line on the panel. The level dimension is the
 * hunter's level *now*, not their level at the moment of the hunt: nothing
 * snapshots a level onto an attempt, and inventing one here would mean writing
 * to the hunt path to satisfy a report. A player who promoted mid-window counts
 * entirely at their new level.
 */
export async function voucherKpis(db: Exec, range: AnalyticsRange): Promise<VoucherKpis> {
  const { from, to } = boundsFor(range);
  const { levels } = await loadLevels(db);

  // Every stage reaches its partner through campaigns, so the filter is one
  // clause used four times rather than four spellings of the same idea.
  const partnerFilter = range.partnerId ? "AND c.business_id = ?" : "";
  const withPartner = (...leading: string[]) =>
    range.partnerId ? [...leading, range.partnerId] : leading;

  const [hunted, selected, booked, redeemed, byLevel, byBand, byPartner, gated, gatedCounts] =
    await Promise.all([
      one(
        db,
        `SELECT COUNT(*) AS total FROM attempts a
         JOIN campaigns c ON c.id = a.campaign_id
         WHERE a.created_at >= ? AND a.created_at < ? ${partnerFilter}`,
        withPartner(from, to),
      ),
      one(
        db,
        `SELECT COUNT(*) AS total FROM vouchers v
         JOIN campaigns c ON c.id = v.campaign_id
         WHERE v.issued_at >= ? AND v.issued_at < ? ${partnerFilter}`,
        withPartner(from, to),
      ),
      one(
        db,
        `SELECT COUNT(*) AS total FROM reservations r
         JOIN campaigns c ON c.id = r.campaign_id
         WHERE r.created_at >= ? AND r.created_at < ? ${partnerFilter}`,
        withPartner(from, to),
      ),
      one(
        db,
        `SELECT COUNT(*) AS total FROM vouchers v
         JOIN campaigns c ON c.id = v.campaign_id
         WHERE v.redeemed_at IS NOT NULL AND v.redeemed_at >= ? AND v.redeemed_at < ?
           ${partnerFilter}`,
        withPartner(from, to),
      ),
      all(
        db,
        `SELECT COALESCE(ul.current_level, 1) AS level,
                COUNT(*) AS selected,
                SUM(CASE WHEN v.redeemed_at IS NOT NULL THEN 1 ELSE 0 END) AS redeemed
         FROM vouchers v
         JOIN campaigns c ON c.id = v.campaign_id
         JOIN users u ON u.id = v.user_id
         LEFT JOIN reward_wallets w ON w.phone = u.phone
         LEFT JOIN user_levels ul ON ul.wallet_id = w.id
         WHERE v.issued_at >= ? AND v.issued_at < ? ${partnerFilter}
         GROUP BY COALESCE(ul.current_level, 1)
         ORDER BY 1 ASC`,
        withPartner(from, to),
      ),
      all(
        db,
        `SELECT v.benefit_type AS benefit_type,
                CASE
                  WHEN v.benefit_type <> 'discount_percent' THEN NULL
                  WHEN NULLIF(v.benefit_value, '') IS NULL THEN NULL
                  WHEN v.benefit_value ~ '^[0-9]+([.][0-9]+)?$'
                    THEN WIDTH_BUCKET(v.benefit_value::numeric, 0, 100, 5)
                  ELSE NULL
                END AS bucket,
                COUNT(*) AS selected,
                SUM(CASE WHEN v.redeemed_at IS NOT NULL THEN 1 ELSE 0 END) AS redeemed
         FROM vouchers v
         JOIN campaigns c ON c.id = v.campaign_id
         WHERE v.issued_at >= ? AND v.issued_at < ? ${partnerFilter}
         GROUP BY 1, 2
         ORDER BY 1, 2`,
        withPartner(from, to),
      ),
      all(
        db,
        `SELECT c.business_id AS partner_id,
                MAX(b.name) AS partner_name,
                COUNT(*) AS selected,
                SUM(CASE WHEN v.redeemed_at IS NOT NULL THEN 1 ELSE 0 END) AS redeemed
         FROM vouchers v
         JOIN campaigns c ON c.id = v.campaign_id
         LEFT JOIN businesses b ON b.id = c.business_id
         WHERE v.issued_at >= ? AND v.issued_at < ? ${partnerFilter}
         GROUP BY c.business_id
         ORDER BY 3 DESC`,
        withPartner(from, to),
      ),
      one(
        db,
        `SELECT COUNT(*) AS selected,
                SUM(CASE WHEN v.redeemed_at IS NOT NULL THEN 1 ELSE 0 END) AS redeemed
         FROM vouchers v
         JOIN campaigns c ON c.id = v.campaign_id
         WHERE v.issued_at >= ? AND v.issued_at < ?
           AND (c.min_user_level > 1 OR c.level_exclusive = 1 OR c.level_quota > 0)
           ${partnerFilter}`,
        withPartner(from, to),
      ),
      one(
        db,
        `SELECT
           SUM(CASE WHEN c.min_user_level > 1 OR c.level_exclusive = 1 OR c.level_quota > 0
                    THEN 1 ELSE 0 END) AS gated,
           SUM(CASE WHEN c.level_exclusive = 1 THEN 1 ELSE 0 END) AS exclusive
         FROM campaigns c
         WHERE 1 = 1 ${partnerFilter}`,
        range.partnerId ? [range.partnerId] : [],
      ),
    ]);

  const selectedTotal = Number(selected?.total ?? 0);
  const gatedSelected = Number(gated?.selected ?? 0);

  return {
    funnel: {
      hunted: Number(hunted?.total ?? 0),
      selected: selectedTotal,
      booked: Number(booked?.total ?? 0),
      redeemed: Number(redeemed?.total ?? 0),
    },
    byLevel: byLevel.map((row) => {
      const level = Number(row.level ?? 1);
      return {
        level,
        name: levels.find((entry) => entry.level === level)?.name ?? "—",
        selected: Number(row.selected ?? 0),
        redeemed: Number(row.redeemed ?? 0),
      };
    }),
    byDiscountBand: byBand.map((row) => ({
      band: discountBandLabel(String(row.benefit_type ?? ""), row.bucket),
      selected: Number(row.selected ?? 0),
      redeemed: Number(row.redeemed ?? 0),
    })),
    byPartner: byPartner.map((row) => ({
      partnerId: String(row.partner_id ?? ""),
      partnerName: String(row.partner_name ?? row.partner_id ?? ""),
      selected: Number(row.selected ?? 0),
      redeemed: Number(row.redeemed ?? 0),
    })),
    levelOffers: {
      gatedCampaigns: Number(gatedCounts?.gated ?? 0),
      exclusiveCampaigns: Number(gatedCounts?.exclusive ?? 0),
      selectedOnGated: gatedSelected,
      redeemedOnGated: Number(gated?.redeemed ?? 0),
      shareOfSelected: selectedTotal === 0 ? 0 : gatedSelected / selectedTotal,
    },
  };
}

/**
 * A readable name for one discount bucket.
 *
 * `WIDTH_BUCKET(value, 0, 100, 5)` gives five twenty-point bands, so bucket 1
 * is 1-20% and bucket 5 is 81-100%; a value at or above 100 lands in the
 * overflow bucket 6 and is folded back into the top band. A benefit that is not
 * a percentage has no band and is labelled by its kind instead, because "free
 * item" is a category a partner reasons about, not a discount of zero.
 */
function discountBandLabel(benefitType: string, bucket: unknown): string {
  if (benefitType !== "discount_percent") return benefitType || "unknown";
  const index = Number(bucket ?? 0);
  if (!Number.isFinite(index) || index <= 0) return "discount_percent";
  const top = Math.min(5, index);
  return `${(top - 1) * 20 + 1}-${top * 20}%`;
}

export type GamificationKpis = {
  range: AnalyticsRange;
  engagement: EngagementKpis;
  missions: MissionFunnelRow[];
  levels: LevelKpis;
  achievements: AchievementKpis;
  economy: EconomyKpis;
  vouchers: VoucherKpis;
  risk: RiskKpis;
  retention: RetentionKpis;
};

/** Everything the dashboard renders, in one pass. */
export async function gamificationKpis(range: AnalyticsRange): Promise<GamificationKpis> {
  const db = await getDb();
  const [engagement, missions, levels, achievements, economy, vouchers, risk, retention] =
    await Promise.all([
      engagementKpis(db, range),
      missionFunnel(db, range),
      levelKpis(db, range),
      achievementKpis(db, range),
      economyKpis(db, range),
      voucherKpis(db, range),
      riskKpis(db, range),
      retentionKpis(db, range),
    ]);
  return {
    range, engagement, missions, levels, achievements, economy, vouchers, risk, retention,
  };
}

/**
 * The mission funnel as a CSV.
 *
 * Values are quoted and internal quotes doubled — a partner name with a comma
 * in it is ordinary, and a CSV that breaks on one is worse than no export.
 */
export function missionFunnelToCsv(rows: MissionFunnelRow[]) {
  const header = [
    "mission_key",
    "title",
    "type",
    "partner",
    "assigned",
    "started",
    "completed",
    "claimed",
    "expired",
    "rejected",
    "conversion",
    "avg_minutes_to_complete",
  ];
  const body = rows.map((row) => [
    row.missionKey,
    row.title,
    row.type,
    row.partnerName,
    row.assigned,
    row.started,
    row.completed,
    row.claimed,
    row.expired,
    row.rejected,
    row.conversion.toFixed(4),
    row.averageMinutesToComplete,
  ]);
  return [header, ...body]
    .map((line) => line.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(","))
    .join("\n");
}
