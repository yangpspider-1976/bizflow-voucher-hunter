import { requireSignedInCustomerPhone } from "@/server/customer-auth";
import { getDb, one } from "@/server/db";
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

    return ok({
      levels,
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
