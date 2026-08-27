/**
 * Levels, and the one way to buy them: converting Loyalty Points into XP.
 *
 * The two are deliberately different things. LP is a spendable balance a
 * partner owes; XP is a progression metric with no cash value that cannot be
 * spent, transferred or withdrawn. Spending LP does not cost a level, because
 * the level is derived from `lifetime_xp` and not from what is left in a
 * wallet — a player who converts and then spends keeps what they earned.
 *
 * Converting partner LP extinguishes that partner's liability, which is why the
 * conversion writes `merchant_id` and its transaction id into the loyalty
 * ledger: the monthly statement reports it as its own "Level Conversion" line
 * rather than as a redemption.
 */
import crypto from "node:crypto";
import type { LevelState, PointConversionResult } from "@bizflow/shared";
import { levelForXp } from "@bizflow/shared";
import { one, run, withTx, type Exec } from "@/server/db";
import { AppError } from "@/server/errors";
import {
  centavosToLoyaltyPoints,
  ensureRewardWallet,
  loyaltyPointsToCentavos,
  recordRewardAudit,
} from "@/server/rewards-network";
import { loadEconomy, loadLevels } from "./config";
import { bumpCounter } from "./achievements";
import { publishEvent } from "./events";
import { creditXp } from "./rewards";

const isoNow = () => new Date().toISOString();
const id = (prefix: string) => `${prefix}_${crypto.randomBytes(8).toString("hex")}`;

/** The full level standing for a wallet, as the API returns it. */
export async function levelStateFor(db: Exec, walletId: string): Promise<LevelState> {
  const { levels } = await loadLevels(db);
  const row = await one(db, "SELECT lifetime_xp FROM user_levels WHERE wallet_id = ?", [
    walletId,
  ]);
  return levelForXp(levels, Number(row?.lifetime_xp ?? 0));
}

export type ConvertPointsInput = {
  phone: string;
  /** Null converts from the spend-anywhere global pot. */
  businessId: string | null;
  /** Accepts "500", 500 or "500 LP" — the same forms the rest of the API takes. */
  amount: string | number;
  /**
   * The client's key for this tap. A retried request with the same key returns
   * the original result instead of converting again, which is what makes a
   * flaky network safe rather than expensive.
   */
  idempotencyKey: string;
};

/**
 * Debits LP, credits XP and recalculates the level, atomically.
 *
 * Every step is inside one write transaction and the wallet row is locked
 * before its balance is read, so a conversion racing a storefront purchase
 * cannot both spend the same points. The requirements call this out
 * specifically; the lock, not a re-read, is what enforces it.
 */
export async function convertPointsToXp(
  input: ConvertPointsInput,
): Promise<PointConversionResult> {
  const lpCentavos = loyaltyPointsToCentavos(input.amount, "LP amount");

  const result = await withTx(async (tx) => {
    const wallet = await ensureRewardWallet(tx, { phone: input.phone });
    const { economy, version: configVersion } = await loadEconomy(tx);

    const replay = await one(
      tx,
      "SELECT * FROM point_xp_conversions WHERE idempotency_key = ?",
      [input.idempotencyKey],
    );
    if (replay) {
      const state = await levelStateFor(tx, wallet.id);
      return {
        conversionId: String(replay.id),
        lpDebitedCentavos: Number(replay.lp_centavos),
        lpDebited: centavosToLoyaltyPoints(Number(replay.lp_centavos)),
        xpGranted: Number(replay.xp_amount),
        level: state,
        leveledUp: false,
        previousLevel: state.level,
        xpLedgerId: String(replay.xp_ledger_id ?? ""),
        loyaltyLedgerId: String(replay.loyalty_ledger_id ?? ""),
      } satisfies PointConversionResult;
    }

    if (lpCentavos < economy.minConversionCentavos) {
      throw new AppError(
        "E-INSUFFICIENT-POINTS",
        `The smallest conversion is ${centavosToLoyaltyPoints(economy.minConversionCentavos)}`,
        400,
      );
    }
    // Whole points only. A fractional LP would convert to a fractional XP and
    // XP is an integer, so the rounding has to be refused at the door rather
    // than absorbed silently somewhere downstream.
    if (lpCentavos % 100 !== 0) {
      throw new AppError(
        "E-INSUFFICIENT-POINTS",
        "Convert whole Loyalty Points only",
        400,
      );
    }

    if (String(wallet.status) !== "Active") {
      throw new AppError(
        "E-REWARD-WALLET-SUSPENDED",
        "Loyalty Points wallet is suspended",
        409,
      );
    }

    const debited = await debitLoyaltyPoints(tx, {
      walletId: wallet.id,
      businessId: input.businessId,
      lpCentavos,
    });

    const xpAmount = Math.floor((lpCentavos / 100) * economy.xpPerLp);
    if (xpAmount <= 0) {
      throw new AppError(
        "E-CONFIG-INVALID",
        "The published conversion rate would grant no XP",
        409,
      );
    }

    const conversionId = id("pxc");
    const xp = await creditXp(tx, {
      walletId: wallet.id,
      delta: xpAmount,
      sourceType: "conversion",
      sourceId: conversionId,
      idempotencyKey: `conversion:${input.idempotencyKey}`,
      configVersion,
      metadata: { lpCentavos, businessId: input.businessId },
    });

    await run(
      tx,
      `INSERT INTO point_xp_conversions
       (id, wallet_id, business_id, lp_centavos, xp_amount, status, loyalty_ledger_id,
        xp_ledger_id, idempotency_key, config_version, created_at)
       VALUES (?, ?, ?, ?, ?, 'Completed', ?, ?, ?, ?, ?)`,
      [
        conversionId,
        wallet.id,
        input.businessId,
        lpCentavos,
        xpAmount,
        debited.ledgerId,
        xp.ledgerId,
        input.idempotencyKey,
        configVersion,
        isoNow(),
      ],
    );

    // Level Investor counts whole LP committed, which is how its thresholds are
    // written. Achievement unlocks it triggers are granted by the same call.
    const unlocked = await bumpCounter(tx, {
      walletId: wallet.id,
      counterKey: "lp_converted",
      delta: lpCentavos / 100,
      sourceId: conversionId,
    });

    await publishEvent(tx, {
      eventName: "points_converted_to_xp",
      walletId: wallet.id,
      phone: wallet.phone,
      source: "api",
      partnerId: input.businessId,
      objectType: "point_xp_conversion",
      objectId: conversionId,
      idempotencyKey: `points_converted_to_xp:${conversionId}`,
      amountCentavos: lpCentavos,
      metadata: { xpAmount, configVersion },
      // Already applied inline: the counters and the reward are part of this
      // transaction, so the row is a record, not work still to do.
      status: "Processed",
    });

    if (xp.leveledUp) {
      await publishEvent(tx, {
        eventName: "level_up",
        walletId: wallet.id,
        phone: wallet.phone,
        source: "api",
        objectType: "user_level",
        objectId: wallet.id,
        idempotencyKey: `level_up:${wallet.id}:${xp.level}`,
        metadata: { from: xp.previousLevel, to: xp.level },
        status: "Processed",
      });
    }

    await recordRewardAudit(tx, {
      actorType: "customer",
      actorId: wallet.phone,
      action: "points_converted_to_xp",
      entityType: "point_xp_conversion",
      entityId: conversionId,
      metadata: {
        walletId: wallet.id,
        businessId: input.businessId,
        lpCentavos,
        xpAmount,
        configVersion,
        unlocked: unlocked.map((entry) => `${entry.groupKey}:${entry.tier}`),
      },
    });

    const { levels } = await loadLevels(tx);
    return {
      conversionId,
      lpDebitedCentavos: lpCentavos,
      lpDebited: centavosToLoyaltyPoints(lpCentavos),
      xpGranted: xpAmount,
      level: levelForXp(levels, xp.lifetimeXp),
      leveledUp: xp.leveledUp,
      previousLevel: xp.previousLevel,
      xpLedgerId: xp.ledgerId,
      loyaltyLedgerId: debited.ledgerId,
    } satisfies PointConversionResult;
  });

  return result;
}

/**
 * Takes LP out of the pot the player chose, refusing rather than overdrawing.
 *
 * The conditional UPDATE is the guard, not the SELECT above it: a balance read
 * and then written is a race, while `WHERE balance >= ?` either moves the row
 * or does not. A zero row count means somebody else got there first, which
 * reads back as an insufficient balance — the truthful answer either way.
 */
async function debitLoyaltyPoints(
  tx: Exec,
  input: { walletId: string; businessId: string | null; lpCentavos: number },
) {
  const now = isoNow();
  const ledgerId = id("rled");

  if (input.businessId) {
    const moved = await run(
      tx,
      `UPDATE reward_business_balances
       SET balance_centavos = balance_centavos - ?, updated_at = ?
       WHERE wallet_id = ? AND business_id = ? AND balance_centavos >= ?`,
      [input.lpCentavos, now, input.walletId, input.businessId, input.lpCentavos],
    );
    if (moved !== 1) {
      const held = await one(
        tx,
        "SELECT balance_centavos FROM reward_business_balances WHERE wallet_id = ? AND business_id = ?",
        [input.walletId, input.businessId],
      );
      throw new AppError(
        "E-INSUFFICIENT-POINTS",
        `That partner wallet holds ${centavosToLoyaltyPoints(Number(held?.balance_centavos ?? 0))}`,
        409,
      );
    }
    const after = await one(
      tx,
      "SELECT balance_centavos FROM reward_business_balances WHERE wallet_id = ? AND business_id = ?",
      [input.walletId, input.businessId],
    );
    await run(
      tx,
      `INSERT INTO reward_ledger_entries
       (id, wallet_id, type, delta_centavos, balance_after_centavos, source_type, source_id, business_id, metadata, created_at)
       VALUES (?, ?, 'level_conversion', ?, ?, 'level_conversion', ?, ?, ?, ?)`,
      [
        ledgerId,
        input.walletId,
        -input.lpCentavos,
        Number(after?.balance_centavos ?? 0),
        ledgerId,
        input.businessId,
        JSON.stringify({ merchantId: input.businessId, settlementLine: "Level Conversion" }),
        now,
      ],
    );
    return { ledgerId };
  }

  const moved = await run(
    tx,
    `UPDATE reward_wallets
     SET balance_centavos = balance_centavos - ?, updated_at = ?
     WHERE id = ? AND status = 'Active' AND balance_centavos >= ?`,
    [input.lpCentavos, now, input.walletId, input.lpCentavos],
  );
  if (moved !== 1) {
    const held = await one(tx, "SELECT balance_centavos FROM reward_wallets WHERE id = ?", [
      input.walletId,
    ]);
    throw new AppError(
      "E-INSUFFICIENT-POINTS",
      `Your global balance is ${centavosToLoyaltyPoints(Number(held?.balance_centavos ?? 0))}`,
      409,
    );
  }
  const after = await one(tx, "SELECT balance_centavos FROM reward_wallets WHERE id = ?", [
    input.walletId,
  ]);
  await run(
    tx,
    `INSERT INTO reward_ledger_entries
     (id, wallet_id, type, delta_centavos, balance_after_centavos, source_type, source_id, metadata, created_at)
     VALUES (?, ?, 'level_conversion', ?, ?, 'level_conversion', ?, ?, ?)`,
    [
      ledgerId,
      input.walletId,
      -input.lpCentavos,
      Number(after?.balance_centavos ?? 0),
      ledgerId,
      JSON.stringify({ settlementLine: "Level Conversion", pot: "global" }),
      now,
    ],
  );
  return { ledgerId };
}

/**
 * Extra hunt attempts the player's level is worth today.
 *
 * Kept separate from the campaign's base attempts and from share bonuses, as
 * the requirements ask: three sources, three fields, so a support question
 * about "why do I have six" has an answer.
 */
export async function levelBonusHunts(db: Exec, walletId: string) {
  const state = await levelStateFor(db, walletId);
  return state.bonusHunts;
}

/**
 * Marks a promotion as announced, returning whether this call was the one that
 * did it. The celebration screen fires once per transaction, not once per app
 * launch, which is what stops a level-up animation replaying forever.
 */
export async function acknowledgeLevelUp(db: Exec, walletId: string) {
  const row = await one(
    db,
    "SELECT current_level, announced_level FROM user_levels WHERE wallet_id = ?",
    [walletId],
  );
  if (!row) return { announced: false, level: 1 };
  const current = Number(row.current_level);
  if (current <= Number(row.announced_level)) return { announced: false, level: current };
  await run(
    db,
    "UPDATE user_levels SET announced_level = ?, updated_at = ? WHERE wallet_id = ?",
    [current, isoNow(), walletId],
  );
  return { announced: true, level: current };
}
