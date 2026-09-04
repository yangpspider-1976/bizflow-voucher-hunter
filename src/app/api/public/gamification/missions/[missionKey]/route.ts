import { z } from "zod";
import { levelForXp } from "@bizflow/shared";
import { requireSignedInCustomerPhone } from "@/server/customer-auth";
import { one, withReadTx } from "@/server/db";
import { AppError, fail, ok } from "@/server/errors";
import { loadLevels } from "@/server/gamification/config";
import { listMissionCards } from "@/server/gamification/missions";
import { ensureTodaysMissions, featuresFor, resolveWallet } from "@/server/gamification/profile";
import { manilaDate } from "@/server/gamification/time";

const paramsSchema = z.object({ missionKey: z.string().min(1).max(64) });

export const dynamic = "force-dynamic";

/**
 * An optional position, for location-gated missions only.
 *
 * Query parameters rather than a body because this is a GET. Absent is the
 * normal case: a player who has not granted location consent still sees every
 * area campaign, marked OUT_OF_AREA until they do.
 */
function locationFrom(url: URL) {
  const latitude = Number(url.searchParams.get("lat"));
  const longitude = Number(url.searchParams.get("lng"));
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;
  const accuracy = Number(url.searchParams.get("acc"));
  return {
    latitude,
    longitude,
    ...(Number.isFinite(accuracy) && accuracy >= 0 ? { accuracyMeters: accuracy } : {}),
    ...(url.searchParams.get("mock") === "1" ? { mocked: true } : {}),
  };
}


/** One mission's details and this player's progress on it. */
export async function GET(
  request: Request,
  { params }: { params: { missionKey: string } },
) {
  try {
    const phone = await requireSignedInCustomerPhone(request);
    const { missionKey } = paramsSchema.parse(params);
    const location = locationFrom(new URL(request.url));

    const walletId = await resolveWallet(phone);

    // Paused missions are missions this player does not have, which is the
    // answer the board gives and the one the app already knows how to draw.
    if (!(await featuresFor(walletId)).missions) {
      throw new AppError("E-MISSION-NOT-ACTIVE", "That mission is not available to you", 404);
    }

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
        location,
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
