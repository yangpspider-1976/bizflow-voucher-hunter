import { NextResponse } from "next/server";
import { getDb, one, withTx } from "@/server/db";
import { AppError } from "@/server/errors";
import {
  recordAdVerification,
  resolveAdNonce,
  verifySsvSignature,
} from "@/server/gamification/ad-verification";
import { ingestEvent } from "@/server/gamification/events";
import { reportError } from "@/server/monitoring";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * AdMob Server-Side Verification callback.
 *
 * Google calls this, not the app, which is the whole point: the requirements
 * accept only a server-verifiable completion as an ad reward event, so a client
 * claiming to have watched an ad earns nothing.
 *
 * Answers 200 to Google whatever happens. A non-200 makes AdMob retry, and a
 * retry on a callback we have already banked is pure noise - the transaction id
 * has already been recorded and the second delivery would change nothing. The
 * outcome is in the body for anyone reading the logs; a genuine fault is
 * reported through monitoring rather than through the status code.
 */
export async function GET(request: Request) {
  try {
    const callback = await verifySsvSignature(request.url);
    if (!callback.transactionId) {
      throw new AppError("E-ADMOB-SIGNATURE", "Callback carries no transaction id", 400);
    }
    const walletId = resolveAdNonce(callback.customData ?? "");

    const db = await getDb();
    const wallet = await one(db, "SELECT phone FROM reward_wallets WHERE id = ?", [walletId]);
    if (!wallet) {
      throw new AppError("E-ADMOB-NONCE", "Ad verification names no known wallet", 404);
    }

    // The insert is the replay guard. A repeated callback records nothing and
    // is reported as already-counted rather than paid a second time.
    const first = await withTx((tx) =>
      recordAdVerification(tx, {
        walletId,
        transactionId: callback.transactionId!,
        adUnit: callback.adUnit,
        adNetwork: callback.adNetwork,
        rewardAmount: callback.rewardAmount ? Number(callback.rewardAmount) : undefined,
        rewardItem: callback.rewardItem,
        keyId: callback.keyId,
      }),
    );
    if (!first) {
      return NextResponse.json({ status: "duplicate" });
    }

    const result = await ingestEvent({
      eventName: "ad_reward_verified",
      phone: String(wallet.phone),
      source: "admob-ssv",
      objectType: "ad_verification",
      objectId: callback.transactionId,
      idempotencyKey: `ad_reward_verified:${callback.transactionId}`,
      metadata: { adUnit: callback.adUnit ?? null, adNetwork: callback.adNetwork ?? null },
    });

    return NextResponse.json({
      status: "accepted",
      missions: result.missions.map((mission) => mission.missionKey),
    });
  } catch (error) {
    if (!(error instanceof AppError) || error.status >= 500) {
      await reportError(error, { source: "admob-ssv" });
    }
    return NextResponse.json({
      status: "rejected",
      code: error instanceof AppError ? error.code : "E-SYSTEM-500",
    });
  }
}
