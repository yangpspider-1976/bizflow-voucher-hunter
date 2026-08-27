import { z } from "zod";
import { levelForXp } from "@bizflow/shared";
import { requireSignedInCustomerPhone } from "@/server/customer-auth";
import { one, withReadTx } from "@/server/db";
import { AppError, fail, ok } from "@/server/errors";
import { loadLevels } from "@/server/gamification/config";
import { listMissionCards } from "@/server/gamification/missions";
import { ensureTodaysMissions, resolveWallet } from "@/server/gamification/profile";
import { manilaDate } from "@/server/gamification/time";

const paramsSchema = z.object({ missionKey: z.string().min(1).max(64) });

export const dynamic = "force-dynamic";

/** One mission's details and this player's progress on it. */
export async function GET(
  request: Request,
  { params }: { params: { missionKey: string } },
) {
  try {
    const phone = await requireSignedInCustomerPhone(request);
    const { missionKey } = paramsSchema.parse(params);

    const walletId = await resolveWallet(phone);
    await ensureTodaysMissions(walletId);

    const card = await withReadTx(async (tx) => {
      const { levels } = await loadLevels(tx);
      const xpRow = await one(tx, "SELECT lifetime_xp FROM user_levels WHERE wallet_id = ?", [
        walletId,
      ]);
      const lifetimeXp = Number(xpRow?.lifetime_xp ?? 0);
      const cards = await listMissionCards(tx, {
        walletId,
        level: levelForXp(levels, lifetimeXp).level,
        lifetimeXp,
        date: manilaDate(),
      });
      return cards.find((candidate) => candidate.missionKey === missionKey);
    });

    if (!card) {
      throw new AppError("E-MISSION-NOT-ACTIVE", "That mission is not available to you", 404);
    }
    return ok(card);
  } catch (error) {
    return fail(error);
  }
}
