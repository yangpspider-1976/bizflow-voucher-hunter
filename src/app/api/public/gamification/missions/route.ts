import { z } from "zod";
import { levelForXp } from "@bizflow/shared";
import { requireSignedInCustomerPhone } from "@/server/customer-auth";
import { one, withReadTx } from "@/server/db";
import { fail, ok } from "@/server/errors";
import { loadLevels } from "@/server/gamification/config";
import { listMissionCards } from "@/server/gamification/missions";
import { ensureTodaysMissions, resolveWallet } from "@/server/gamification/profile";
import { manilaDate } from "@/server/gamification/time";

const querySchema = z.object({
  type: z.enum(["DAILY", "URGENT", "ONBOARDING", "PARTNER"]).optional(),
});

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


/**
 * Today's mission board, optionally narrowed to one tab.
 *
 * A read, like the profile: today's rows are created only on the first look of
 * the day, and only that call takes a write transaction.
 */
export async function GET(request: Request) {
  try {
    const phone = await requireSignedInCustomerPhone(request);
    const url = new URL(request.url);
    const query = querySchema.parse({ type: url.searchParams.get("type") ?? undefined });
    const location = locationFrom(url);

    const walletId = await resolveWallet(phone);
    await ensureTodaysMissions(walletId);

    const cards = await withReadTx(async (tx) => {
      const { levels } = await loadLevels(tx);
      const xpRow = await one(tx, "SELECT lifetime_xp FROM user_levels WHERE wallet_id = ?", [
        walletId,
      ]);
      const lifetimeXp = Number(xpRow?.lifetime_xp ?? 0);
      return listMissionCards(tx, {
        walletId,
        level: levelForXp(levels, lifetimeXp).level,
        lifetimeXp,
        date: manilaDate(),
        location,
      });
    });

    return ok(query.type ? cards.filter((card) => card.type === query.type) : cards);
  } catch (error) {
    return fail(error);
  }
}
