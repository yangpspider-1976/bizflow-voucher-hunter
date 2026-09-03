/**
 * Level-gated offers.
 *
 * §3.4 lets a partner put four restrictions on a campaign — a minimum level,
 * exclusivity, a head start and an extra hunt allowance — and §3.2 is explicit
 * that the restriction must read as a goal rather than as a locked door with no
 * label: a locked card shows the level it wants, the XP still to earn, and a
 * way to go and earn it.
 *
 * The decision itself is `evaluateOfferGate` in @bizflow/shared, so the card the
 * app draws and the refusal the server issues are one function rather than two
 * that happen to agree. This module is the part that needs a database: what the
 * viewer's level is, and what the published ladder says.
 */
import type { Campaign, OfferGate, OfferLevelRules, OfferViewer } from "@bizflow/shared";
import { ANONYMOUS_VIEWER, evaluateOfferGate, levelForXp, normalizePhone } from "@bizflow/shared";
import { one, type Exec } from "@/server/db";
import { AppError } from "@/server/errors";
import { loadEconomy, loadLevels } from "./config";
import { featureEnabledFor } from "./flags";

/** The restrictions on one campaign, defaulted to "no restriction". */
export function offerRulesOf(campaign: Campaign): OfferLevelRules {
  return {
    minUserLevel: campaign.minUserLevel ?? 1,
    levelExclusive: Boolean(campaign.levelExclusive),
    levelQuota: campaign.levelQuota ?? 0,
    levelOfferLabel: campaign.levelOfferLabel ?? null,
    earlyAccessAt: campaign.earlyAccessAt ?? null,
  };
}

/** True when a campaign has no level rules at all, so nothing need be loaded. */
const unrestricted = (rules: OfferLevelRules) =>
  rules.minUserLevel <= 1 && rules.earlyAccessAt === null && rules.levelQuota <= 0;

export const OPEN_GATE: OfferGate = {
  locked: false,
  reason: null,
  requiredLevel: 1,
  missingXp: null,
  opensAt: null,
  opensForViewerAt: null,
  earlyAccessActive: false,
  levelQuota: 0,
  label: null,
  hidden: false,
};

/**
 * Everything the gate needs about one viewer, read once.
 *
 * Deliberately read-only: a public campaign list must not create a rewards
 * wallet for everybody who scrolls past a card. A visitor with no wallet is the
 * floor of the ladder, which is exactly what they are.
 */
export async function offerViewerFor(db: Exec, phone: string | null | undefined) {
  const { levels } = await loadLevels(db);
  const normalized = phone ? normalizePhone(phone) : null;
  if (!normalized) return { viewer: ANONYMOUS_VIEWER, ladder: levels, walletId: null };

  const row = await one(
    db,
    `SELECT w.id AS wallet_id, COALESCE(l.lifetime_xp, 0) AS lifetime_xp
     FROM reward_wallets w
     LEFT JOIN user_levels l ON l.wallet_id = w.id
     WHERE w.phone = ?`,
    [normalized],
  );
  if (!row) return { viewer: ANONYMOUS_VIEWER, ladder: levels, walletId: null };

  const state = levelForXp(levels, Number(row.lifetime_xp ?? 0));
  const viewer: OfferViewer = {
    level: state.level,
    lifetimeXp: state.lifetimeXp,
    earlyAccessMinutes: state.earlyAccessMinutes,
  };
  return { viewer, ladder: levels, walletId: String(row.wallet_id) };
}

export type OfferViewerContext = Awaited<ReturnType<typeof offerViewerFor>>;

/**
 * The gate for one campaign against an already-loaded viewer.
 *
 * Split from `offerGateFor` so a directory of forty cards costs one ladder read
 * and one level read rather than eighty.
 */
export function gateWithViewer(
  campaign: Campaign,
  context: OfferViewerContext,
  options: { levelsEnabled: boolean; now?: string },
): OfferGate {
  const rules = offerRulesOf(campaign);
  // With levels switched off, a level rule cannot lock anybody out. The
  // restriction is a benefit of a system that is not running, and applying it
  // anyway would leave players staring at a lock with no way to earn past it.
  if (!options.levelsEnabled || unrestricted(rules)) return OPEN_GATE;
  return evaluateOfferGate(rules, context.viewer, context.ladder, options.now ?? new Date().toISOString());
}

/** The gate for one campaign and one phone number, loading what it needs. */
export async function offerGateFor(
  db: Exec,
  campaign: Campaign,
  phone: string | null | undefined,
): Promise<OfferGate> {
  const rules = offerRulesOf(campaign);
  if (unrestricted(rules)) return OPEN_GATE;
  const context = await offerViewerFor(db, phone);
  const { economy } = await loadEconomy(db);
  return gateWithViewer(campaign, context, {
    levelsEnabled: featureEnabledFor(economy, "levels", context.walletId),
  });
}

/**
 * Refuses a hunt on a campaign the viewer's level does not open.
 *
 * Called where an attempt is about to be spent, not only where a card is drawn:
 * the card is a courtesy and the server is the authority, and §2.1 is explicit
 * that the client makes no final decision about eligibility.
 */
export async function assertOfferUnlocked(
  db: Exec,
  campaign: Campaign,
  phone: string | null | undefined,
): Promise<OfferGate> {
  const gate = await offerGateFor(db, campaign, phone);
  if (!gate.locked) return gate;

  if (gate.reason === "LEVEL_REQUIRED") {
    throw new AppError(
      "E-LEVEL-REQUIRED",
      gate.missingXp === null
        ? `This offer opens at level ${gate.requiredLevel}.`
        : `This offer opens at level ${gate.requiredLevel} — ${gate.missingXp} XP to go.`,
      403,
    );
  }
  throw new AppError(
    "E-OFFER-NOT-OPEN",
    "This offer has not opened yet.",
    409,
  );
}

/**
 * Extra hunts a campaign's own level quota grants a qualifying player.
 *
 * Zero for anybody the gate locks out, so a quota cannot be spent on a campaign
 * the player is not allowed to hunt in the first place.
 */
export async function campaignLevelQuota(
  db: Exec,
  campaign: Campaign,
  phone: string | null | undefined,
): Promise<number> {
  const gate = await offerGateFor(db, campaign, phone);
  return gate.locked ? 0 : gate.levelQuota;
}
