import { requireSignedInCustomerPhone } from "@/server/customer-auth";
import { all, getDb, one } from "@/server/db";
import { fail, ok } from "@/server/errors";
import { loadEconomy, loadLevels } from "@/server/gamification/config";
import { levelForXp } from "@bizflow/shared";
import { resolveWallet } from "@/server/gamification/profile";
import { centavosToLoyaltyPoints } from "@/server/rewards-network";

export const dynamic = "force-dynamic";

/**
 * The whole ladder, plus where the caller stands on it.
 *
 * Locked levels are never hidden — the requirements are explicit that a
 * restriction should read as a goal — so this returns every level's thresholds
 * and benefits regardless of who is asking.
 */
export async function GET(request: Request) {
  try {
    const phone = await requireSignedInCustomerPhone(request);
    const db = await getDb();
    const walletId = await resolveWallet(phone);
    const { levels, version } = await loadLevels(db);
    const { economy, version: economyVersion } = await loadEconomy(db);
    const xpRow = await one(db, "SELECT lifetime_xp FROM user_levels WHERE wallet_id = ?", [
      walletId,
    ]);

    // §3.4 asks the Level Details screen to show partners by level, which is
    // what turns the ladder from a list of numbers into a list of places worth
    // reaching. Only offers whose restriction is meant to be seen: an
    // `level_exclusive` campaign is deliberately invisible below the bar, and
    // advertising it here would undo that in the one screen built to explain
    // the system.
    const gatedOffers = await all(
      db,
      `SELECT c.min_user_level AS level, c.slug AS slug, c.title AS title,
              c.level_offer_label AS label, b.name AS partner_name
       FROM campaigns c
       JOIN businesses b ON b.id = c.business_id
       WHERE c.status = 'active' AND c.min_user_level > 1 AND c.level_exclusive = 0
       ORDER BY c.min_user_level ASC, b.name ASC`,
    );

    return ok({
      levels,
      partnersByLevel: gatedOffers.map((row) => ({
        level: Number(row.level ?? 1),
        slug: String(row.slug ?? ""),
        title: String(row.title ?? ""),
        partnerName: String(row.partner_name ?? ""),
        label: row.label ? String(row.label) : null,
      })),
      configVersion: version,
      current: levelForXp(levels, Number(xpRow?.lifetime_xp ?? 0)),
      // The economy version behind the terms below. The confirmation screen
      // sends it back with the conversion so the server can refuse to convert
      // on terms the player never saw.
      economyVersion,
      conversion: {
        xpPerLp: economy.xpPerLp,
        minLpCentavos: economy.minConversionCentavos,
        minLp: centavosToLoyaltyPoints(economy.minConversionCentavos),
        presetsCentavos: economy.conversionPresetsCentavos,
      },
    });
  } catch (error) {
    return fail(error);
  }
}
