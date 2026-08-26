import { z } from "zod";
import { assertBusinessAccess, requireAdmin } from "@/server/auth";
import { AppError, fail, ok } from "@/server/errors";
import { MAX_MONEY_PESOS } from "@/lib/limits";
import { redeemVoucher, validateVoucher } from "@/server/voucher-engine";

const schema = z.object({
  codeOrToken: z.string().min(3),
  // Bounded here as well as in the engine so a slipped keyboard is answered by
  // the field that took it, rather than by whatever reads the column later.
  purchaseAmount: z.coerce.number().min(0).max(MAX_MONEY_PESOS).optional(),
  note: z.string().optional()
});

export async function POST(request: Request) {
  try {
    const session = await requireAdmin(request);
    const input = schema.parse(await request.json());
    const validation = await validateVoucher({ codeOrToken: input.codeOrToken });
    if (!validation.campaign) {
      throw new AppError("E-VOUCHER-CAMPAIGN", "Voucher campaign was not found", 404);
    }
    assertBusinessAccess(session, validation.campaign.businessId);
    return ok(await redeemVoucher({ ...input, staffName: session.email }));
  } catch (error) {
    return fail(error);
  }
}
