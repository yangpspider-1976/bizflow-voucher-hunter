/**
 * The one screen the requirements ask for: where you are, what today wants from
 * you, and how far the next badge is — assembled in a single call so the app
 * does not stitch four requests together and show three different truths while
 * they land.
 */
import type {
  AchievementCard,
  AchievementCategory,
  AchievementTier,
  AchievementTierState,
  ConvertibleWallet,
  GamificationFeatures,
  GamificationProfile,
} from "@bizflow/shared";
import { ACHIEVEMENT_TIERS, levelForXp } from "@bizflow/shared";
import { all, getDb, one, withReadTx, withTx, type Exec } from "@/server/db";
import { normalizePhone } from "@/server/phone";
import { centavosToLoyaltyPoints, ensureRewardWallet } from "@/server/rewards-network";
import { unseenUnlocks } from "./achievements";
import { loadEconomy, loadLevels, parseRewardLines } from "./config";
import { featureEnabledFor } from "./flags";
import { ensureDailyMissions, listMissionCards, liveMissionDefinitions } from "./missions";
import { addSummaries, EMPTY_REWARD, summarise } from "./rewards";
import { manilaDate, manilaDayEndUtc } from "./time";

/**
 * Reads a player's whole gamification state.
 *
 * This is the app's most-called endpoint — every launch, every return from the
 * background — and it is deliberately a read except on the one call a day that
 * has something to write.
 *
 * The daily reset is lazy: today's mission rows are created by the first look
 * of the day rather than by a midnight job. Doing that inside a write
 * transaction on every request would put the primary's write lock on the
 * hottest path in the app, which is exactly what took the hunt snapshot down on
 * 2026-08-18 (see `withReadTx` in `db.ts`). So the write is conditional: check
 * cheaply whether today's rows are already there, and take the lock only when
 * they are not.
 */
export async function gamificationProfile(input: {
  phone: string;
}): Promise<GamificationProfile> {
  const walletId = await resolveWallet(input.phone);
  const features = await featuresFor(walletId);
  // Nothing is assigned to somebody the missions feature is not running for.
  if (features.missions) await ensureTodaysMissions(walletId);

  return withReadTx(async (tx) => {
    const { levels, version: levelVersion } = await loadLevels(tx);
    const { economy, version: economyVersion } = await loadEconomy(tx);

    const standing = await one(
      tx,
      "SELECT lifetime_xp, current_level, announced_level FROM user_levels WHERE wallet_id = ?",
      [walletId],
    );
    const lifetimeXp = Number(standing?.lifetime_xp ?? 0);
    const level = levelForXp(levels, lifetimeXp);
    const date = manilaDate();

    const missions = features.missions
      ? await listMissionCards(tx, {
          walletId,
          level: level.level,
          lifetimeXp,
          date,
        })
      : [];
    const achievements = features.achievements ? await achievementCards(tx, walletId) : [];

    const claimable = missions
      .filter((mission) => mission.state === "CLAIMABLE")
      .reduce((total, mission) => addSummaries(total, mission.reward), EMPTY_REWARD);

    return {
      level,
      levels,
      missions,
      achievements,
      missionDate: date,
      missionsResetAt: manilaDayEndUtc(),
      claimable,
      convertibleLp: await convertibleWallets(tx, walletId),
      conversion: {
        xpPerLp: economy.xpPerLp,
        minLpCentavos: economy.minConversionCentavos,
        minLp: centavosToLoyaltyPoints(economy.minConversionCentavos),
        presetsCentavos: economy.conversionPresetsCentavos,
      },
      unseenUnlocks: await unseenUnlocks(tx, walletId),
      levelUpToAnnounce:
        Number(standing?.current_level ?? 1) > Number(standing?.announced_level ?? 1)
          ? Number(standing?.current_level)
          : null,
      // The economy is what the app's numbers were computed under; the ladder
      // version moves independently and rides along in `levels`.
      configVersion: economyVersion || levelVersion,
      features,
    } satisfies GamificationProfile;
  });
}

/**
 * Which features are running for one player.
 *
 * Read once per profile request and passed down, so every panel on the screen
 * agrees — a rollout that admitted a player to missions but not to the mission
 * count in the header would be worse than not rolling out at all.
 */
export async function featuresFor(walletId: string): Promise<GamificationFeatures> {
  const db = await getDb();
  const { economy } = await loadEconomy(db);
  return {
    levels: featureEnabledFor(economy, "levels", walletId),
    conversion: featureEnabledFor(economy, "conversion", walletId),
    missions: featureEnabledFor(economy, "missions", walletId),
    achievements: featureEnabledFor(economy, "achievements", walletId),
  };
}

/**
 * The player's wallet id, creating the wallet only if there is not one.
 *
 * A read on the common path. `ensureRewardWallet` writes unconditionally - an
 * INSERT and an UPDATE - and doing that on every profile request would make the
 * app's most-called endpoint a writer for no reason.
 */
export async function resolveWallet(phone: string) {
  const db = await getDb();
  const existing = await one(db, "SELECT id FROM reward_wallets WHERE phone = ?", [
    normalizePhone(phone),
  ]);
  if (existing) return String(existing.id);
  return withTx(async (tx) => (await ensureRewardWallet(tx, { phone })).id);
}

/**
 * Creates today's mission rows if this is the first look of the day.
 *
 * The count comparison is the guard: as long as the player already has an
 * instance of every live daily mission, there is nothing to write and no lock
 * to take. Two requests arriving together on a fresh day both reach the write,
 * and the unique key on (wallet, mission, date) settles it.
 */
export async function ensureTodaysMissions(walletId: string) {
  const db = await getDb();
  const date = manilaDate();
  const [held, live] = await Promise.all([
    one(
      db,
      "SELECT COUNT(*) AS total FROM user_missions WHERE wallet_id = ? AND mission_date = ?",
      [walletId, date],
    ),
    liveMissionDefinitions(db, { type: "DAILY" }),
  ]);
  if (Number(held?.total ?? 0) >= live.length) return;

  const { levels } = await loadLevels(db);
  const xpRow = await one(db, "SELECT lifetime_xp FROM user_levels WHERE wallet_id = ?", [
    walletId,
  ]);
  const level = levelForXp(levels, Number(xpRow?.lifetime_xp ?? 0));
  await withTx((tx) => ensureDailyMissions(tx, { walletId, level: level.level, date }));
}

/**
 * Every pot the player could spend on a level, global first.
 *
 * Partner pots are listed even at zero only when they exist — a partner the
 * player has never earned at has no bucket, and inventing one would put a row
 * on the Level Up screen that can never do anything.
 */
async function convertibleWallets(db: Exec, walletId: string): Promise<ConvertibleWallet[]> {
  const wallet = await one(db, "SELECT balance_centavos FROM reward_wallets WHERE id = ?", [
    walletId,
  ]);
  const buckets = await all(
    db,
    `SELECT rbb.business_id, rbb.balance_centavos, b.name AS business_name
     FROM reward_business_balances rbb
     JOIN businesses b ON b.id = rbb.business_id
     WHERE rbb.wallet_id = ? AND rbb.balance_centavos > 0
     ORDER BY rbb.balance_centavos DESC`,
    [walletId],
  );

  const globalCentavos = Number(wallet?.balance_centavos ?? 0);
  return [
    {
      businessId: null,
      businessName: "Global balance",
      balanceCentavos: globalCentavos,
      balance: centavosToLoyaltyPoints(globalCentavos),
    },
    ...buckets.map((row) => ({
      businessId: String(row.business_id),
      businessName: String(row.business_name),
      balanceCentavos: Number(row.balance_centavos),
      balance: centavosToLoyaltyPoints(Number(row.balance_centavos)),
    })),
  ];
}

/**
 * The achievement wall: one card per group, every tier on it, and the counter
 * they are all measured against.
 *
 * Tiers within a group unlock independently, so a card carries all four states
 * rather than a single "current tier" — which is also what lets the app show a
 * player exactly which one they are closest to.
 */
export async function achievementCards(
  db: Exec,
  walletId: string,
): Promise<AchievementCard[]> {
  const definitions = await all(
    db,
    `SELECT d.* FROM achievement_definitions d
     JOIN (
       SELECT group_key, MAX(version) AS version FROM achievement_definitions GROUP BY group_key
     ) live ON live.group_key = d.group_key AND live.version = d.version
     WHERE d.status = 'Active'
     ORDER BY d.sort_order ASC, d.group_key ASC, d.threshold ASC`,
  );
  const progressRows = await all(
    db,
    "SELECT counter_key, counter_value FROM user_achievement_progress WHERE wallet_id = ?",
    [walletId],
  );
  const unlockedRows = await all(
    db,
    `SELECT group_key, tier, unlocked_at, featured_at FROM user_achievements
     WHERE wallet_id = ? AND revoked_at IS NULL`,
    [walletId],
  );

  const counters = new Map(
    progressRows.map((row) => [String(row.counter_key), Number(row.counter_value)]),
  );
  const unlocked = new Map(
    unlockedRows.map((row) => [
      `${row.group_key}:${row.tier}`,
      { at: String(row.unlocked_at), featured: Boolean(row.featured_at) },
    ]),
  );

  const grouped = new Map<string, Record<string, unknown>[]>();
  for (const row of definitions) {
    const key = String(row.group_key);
    grouped.set(key, [...(grouped.get(key) ?? []), row]);
  }

  const cards: AchievementCard[] = [];
  for (const [groupKey, rows] of grouped) {
    const head = rows[0]!;
    const counterKey = String(head.counter_key);
    const progress = counters.get(counterKey) ?? 0;

    // Driven by the tier order rather than by row order, so a group that is
    // missing a tier renders the ones it has in the right sequence instead of
    // however the query returned them.
    const tiers: AchievementTierState[] = [];
    for (const tier of ACHIEVEMENT_TIERS) {
      const row = rows.find((candidate) => String(candidate.tier) === tier);
      if (!row) continue;
      const hit = unlocked.get(`${groupKey}:${tier}`);
      tiers.push({
        tier: tier as AchievementTier,
        threshold: Number(row.threshold),
        reward: summarise(parseRewardLines(row.reward_json ? String(row.reward_json) : null)),
        unlocked: Boolean(hit),
        ...(hit ? { unlockedAt: hit.at, featured: hit.featured } : {}),
      });
    }

    cards.push({
      groupKey,
      title: String(head.title),
      description: String(head.description ?? ""),
      category: String(head.category) as AchievementCategory,
      counterKey,
      progress,
      tiers,
      nextTier: tiers.find((tier) => !tier.unlocked) ?? null,
      unlockedTiers: tiers.filter((tier) => tier.unlocked).length,
    });
  }
  return cards;
}

/** A read-only view for the dashboard's customer-support screens. */
export async function gamificationSupportView(phone: string) {
  return withReadTx(async (tx) => {
    const wallet = await one(tx, "SELECT id FROM reward_wallets WHERE phone = ?", [phone]);
    if (!wallet) return null;
    const walletId = String(wallet.id);
    const { levels } = await loadLevels(tx);
    const xpRow = await one(tx, "SELECT lifetime_xp FROM user_levels WHERE wallet_id = ?", [
      walletId,
    ]);
    return {
      level: levelForXp(levels, Number(xpRow?.lifetime_xp ?? 0)),
      xpLedger: await all(
        tx,
        `SELECT id, delta, balance_after, source_type, source_id, config_version, created_at
         FROM user_xp_ledger WHERE wallet_id = ? ORDER BY created_at DESC LIMIT 100`,
        [walletId],
      ),
      rewards: await all(
        tx,
        `SELECT id, source_type, source_id, xp_amount, lp_centavos, status, funding_source, created_at
         FROM reward_transactions WHERE wallet_id = ? ORDER BY created_at DESC LIMIT 100`,
        [walletId],
      ),
      missions: await all(
        tx,
        `SELECT mission_key, mission_date, state, progress, target, claimed_at
         FROM user_missions WHERE wallet_id = ? ORDER BY mission_date DESC, mission_key ASC LIMIT 100`,
        [walletId],
      ),
      achievements: await achievementCards(tx, walletId),
      today: manilaDate(),
    };
  });
}
