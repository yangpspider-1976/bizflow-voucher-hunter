import { assertBusinessAccess, requireAdmin } from "@/server/auth";
import { fail, ok } from "@/server/errors";
import {
  partnerGamificationStatement,
  statementToCsv,
} from "@/server/gamification/settlement";
import { manilaDateParts } from "@/server/rewards-network";

export const dynamic = "force-dynamic";

const PERIOD = /^\d{4}-\d{2}$/;

/**
 * The five settlement lines §6.2 asks for, for one partner and one month.
 *
 * Available to the partner's own staff as well as to operations: a partner
 * whose campaign paid out Loyalty Points is entitled to see what it cost them,
 * and `assertBusinessAccess` is what keeps that to their own businesses.
 *
 * `?format=csv` is the finance export.
 */
export async function GET(request: Request) {
  try {
    const session = await requireAdmin(request);
    const url = new URL(request.url);
    const businessId = url.searchParams.get("business");
    if (!businessId) {
      return fail(new Error("business is required"));
    }
    assertBusinessAccess(session, businessId);

    const requested = url.searchParams.get("period");
    const period = requested && PERIOD.test(requested) ? requested : manilaDateParts().period;
    const statement = await partnerGamificationStatement({ businessId, period });

    if (url.searchParams.get("format") === "csv") {
      return new Response(statementToCsv(statement), {
        headers: {
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": `attachment; filename="voucher-hunt-statement-${businessId}-${period}.csv"`,
        },
      });
    }
    return ok(statement);
  } catch (error) {
    return fail(error);
  }
}
