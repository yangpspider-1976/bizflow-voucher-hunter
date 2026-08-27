import { z } from "zod";
import { assertRewardsAdmin, assertSuperAdmin, requireAdmin } from "@/server/auth";
import { one, withTx } from "@/server/db";
import { AppError, fail, ok } from "@/server/errors";
import { reverseCounter, revokeBadge } from "@/server/gamification/achievements";
import { recordRewardAudit } from "@/server/rewards-network";
import { normalizePhone } from "@/server/phone";

const schema = z.object({
  phone: z.string().min(6),
  counterKey: z.string().min(1).max(64),
  /** How much to take back off the cumulative counter. */
  delta: z.number().int().min(1).max(100_000),
  /**
   * For a distinct-thing counter (partners visited): the member to forget, so
   * the partner can count again if the customer genuinely visits later.
   */
  memberKey: z.string().min(1).max(128).optional(),
  reason: z.string().min(8).max(280),
  /**
   * Badges are not taken back automatically. A counter falling below a
   * threshold is not by itself evidence of anything, so revocation is an
   * explicit decision with a person and a reason behind it.
   */
  revoke: z
    .object({
      groupKey: z.string().min(1).max(64),
      tier: z.enum(["Bronze", "Silver", "Gold", "Royal"]),
    })
    .optional(),
});

export const dynamic = "force-dynamic";

/**
 * Corrects an achievement counter after a cancelled payment, a fraudulent
 * review or an abusive referral.
 *
 * The counter is corrected; the badge is left alone unless `revoke` says
 * otherwise. Both halves are audited with the administrator's reason, which is
 * what the requirements ask for before a badge can be taken back.
 */
export async function POST(request: Request) {
  try {
    const session = await requireAdmin(request);
    assertRewardsAdmin(session);
    // Taking progress back from a customer is a privileged operation, the same
    // class as a reward reversal.
    assertSuperAdmin(session);
    const input = schema.parse(await request.json());

    const result = await withTx(async (tx) => {
      const wallet = await one(tx, "SELECT id FROM reward_wallets WHERE phone = ?", [
        normalizePhone(input.phone),
      ]);
      if (!wallet) {
        throw new AppError("E-REWARD-WALLET-404", "That number has no wallet", 404);
      }
      const walletId = String(wallet.id);

      await reverseCounter(tx, {
        walletId,
        counterKey: input.counterKey,
        delta: input.delta,
        memberKey: input.memberKey,
      });

      if (input.revoke) {
        await revokeBadge(tx, {
          walletId,
          groupKey: input.revoke.groupKey,
          tier: input.revoke.tier,
          reason: input.reason,
        });
      }

      await recordRewardAudit(tx, {
        actorType: "admin",
        actorId: session.email,
        action: "gamification_counter_reversed",
        entityType: "user_achievement_progress",
        entityId: `${walletId}:${input.counterKey}`,
        metadata: {
          delta: input.delta,
          memberKey: input.memberKey ?? null,
          reason: input.reason,
          revoked: input.revoke ?? null,
        },
      });

      const after = await one(
        tx,
        "SELECT counter_value FROM user_achievement_progress WHERE wallet_id = ? AND counter_key = ?",
        [walletId, input.counterKey],
      );
      return { counterValue: Number(after?.counter_value ?? 0) };
    });

    return ok(result);
  } catch (error) {
    return fail(error);
  }
}
