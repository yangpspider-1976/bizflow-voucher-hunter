import { assertBusinessAccess, assertRewardsAdmin, requireAdmin } from "@/server/auth";
import { getDb } from "@/server/db";
import { fail, ok } from "@/server/errors";
import {
  defaultRange,
  gamificationKpis,
  missionFunnel,
  missionFunnelToCsv,
  type AnalyticsRange,
} from "@/server/gamification/analytics";

export const dynamic = "force-dynamic";
/** Several whole-table rollups in one request. */
export const maxDuration = 60;

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Reads the date range and partner filter from the query string.
 *
 * Both ends are Manila dates and both are validated, because they go into a
 * timestamp conversion rather than into a parameter — a malformed date would
 * otherwise become an `Invalid Date` and silently widen the window to
 * everything.
 */
function rangeFrom(url: URL): AnalyticsRange {
  const fallback = defaultRange();
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  return {
    from: from && DATE.test(from) ? from : fallback.from,
    to: to && DATE.test(to) ? to : fallback.to,
    partnerId: url.searchParams.get("partner") || null,
  };
}

/**
 * The KPI set behind the analytics dashboard, or the mission funnel as CSV.
 *
 * `?format=csv` exports the funnel, which is the table an operator actually
 * takes away — the rest are single figures they read on the page.
 */
export async function GET(request: Request) {
  try {
    const session = await requireAdmin(request);
    assertRewardsAdmin(session);
    const url = new URL(request.url);
    const range = rangeFrom(url);
    // A partner filter has to be one this account may look at, or the export
    // becomes a way to read another partner's campaign performance.
    if (range.partnerId) assertBusinessAccess(session, range.partnerId);

    if (url.searchParams.get("format") === "csv") {
      const db = await getDb();
      const rows = await missionFunnel(db, range);
      return new Response(missionFunnelToCsv(rows), {
        headers: {
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": `attachment; filename="voucher-hunt-missions-${range.from}-to-${range.to}.csv"`,
        },
      });
    }

    return ok(await gamificationKpis(range));
  } catch (error) {
    return fail(error);
  }
}
