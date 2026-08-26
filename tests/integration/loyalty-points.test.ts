import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDb, one, resetDb, run } from "@/server/db";
import {
  businessDepositStatus,
  businessStatementPreview,
  centavosToLoyaltyPoints,
  closeBusinessStatement,
  convertRewardCreditToVoucher,
  creditRewardFromPurchase,
  grantDevBusinessLoyaltyPoints,
  listGlobalRewards,
  getOrCreateRewardWallet,
  listBusinessDepositEntries,
  listRewardProducts,
  listWalletPurchases,
  purchaseRewardProduct,
  recordBusinessDeposit,
  recordStatementPayment,
  redeemRewardVoucher,
  rewardWalletSnapshot,
  transferBusinessLpToGlobal,
} from "@/server/rewards-network";
import { recordReferralOpen, startHunt } from "@/server/voucher-engine";

const phone = "+639171118888";
const businessId = "biz_demo_restaurant";

/**
 * What today's app-use award actually paid this wallet.
 *
 * The award is a fresh 1-10 LP draw per Manila day, so a test that needs to
 * know what a global balance should be reads the draw rather than assuming the
 * top of the band.
 */
async function dailyAppUseCentavos(walletId: string) {
  const row = await one(
    await getDb(),
    `SELECT points_centavos FROM loyalty_daily_rewards
     WHERE wallet_id = ? AND reward_type = 'app_use'`,
    [walletId],
  );
  return Number(row?.points_centavos ?? 0);
}

describe("Loyalty Points", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("awards daily app-use LP once and referral LP once per day", async () => {
    const first = await getOrCreateRewardWallet({ phone, name: "LP User" });
    const second = await getOrCreateRewardWallet({ phone, name: "LP User" });

    // The draw, not a fixed 10: what is under test is that today's award is
    // paid exactly once, whatever it came out as.
    const drawn = await dailyAppUseCentavos(first.wallet.id);
    expect(drawn).toBeGreaterThanOrEqual(1_00);
    expect(drawn).toBeLessThanOrEqual(10_00);
    expect(drawn % 100).toBe(0);

    expect(first.balance).toBe(centavosToLoyaltyPoints(drawn));
    expect(second.balance).toBe(centavosToLoyaltyPoints(drawn));
    expect(first.appUseAwardedNow).toBe(true);
    expect(second.appUseAwardedNow).toBe(false);
    expect(second.dailyStatus).toMatchObject({
      appUseAwarded: true,
      referralAwarded: false,
      appUsePoints: centavosToLoyaltyPoints(drawn),
      earnedToday: centavosToLoyaltyPoints(drawn),
      // Still the ceiling the product advertises: the top of the draw plus a
      // referral every day for a month.
      monthlyPotential: "600 LP",
    });

    const user = (
      await startHunt({
        campaignSlug: "july-dinner",
        phone,
        sessionId: "lp-referrer",
        name: "LP User",
      })
    ).user;
    await recordReferralOpen({
      campaignSlug: "july-dinner",
      ref: user.id,
      visitorSessionId: "lp-visitor-1",
    });
    await recordReferralOpen({
      campaignSlug: "july-dinner",
      ref: user.id,
      visitorSessionId: "lp-visitor-2",
    });

    const snapshot = await rewardWalletSnapshot({
      phone,
      walletSecret: first.walletSecret,
    });
    expect(snapshot.balance).toBe(centavosToLoyaltyPoints(drawn + 10_00));
    expect(snapshot.dailyStatus).toMatchObject({
      appUseAwarded: true,
      referralAwarded: true,
      earnedToday: centavosToLoyaltyPoints(drawn + 10_00),
    });

    const dailyRows = await one(
      await getDb(),
      "SELECT COUNT(*) AS count FROM loyalty_daily_rewards WHERE wallet_id = ?",
      [first.wallet.id],
    );
    expect(Number(dailyRows.count)).toBe(2);
  });

  it("adds 5% LP from purchases and makes retries idempotent", async () => {
    const wallet = await getOrCreateRewardWallet({ phone });
    const first = await creditRewardFromPurchase({
      walletToken: wallet.wallet.walletToken,
      businessId,
      purchaseAmount: "500",
      staffName: "staff@bizflow.local",
      idempotencyKey: "purchase-500-restaurant-1",
    });
    const replay = await creditRewardFromPurchase({
      walletToken: wallet.wallet.walletToken,
      businessId,
      purchaseAmount: "500",
      staffName: "staff@bizflow.local",
      idempotencyKey: "purchase-500-restaurant-1",
    });
    const second = await creditRewardFromPurchase({
      walletToken: wallet.wallet.walletToken,
      businessId,
      purchaseAmount: "500",
      staffName: "staff@bizflow.local",
      idempotencyKey: "purchase-500-restaurant-2",
    });

    expect(first.rewardAmount).toBe("25 LP");
    expect(replay.idempotentReplay).toBe(true);
    expect(second.rewardAmount).toBe("25 LP");
    // The two scans land in this partner's bucket. The once-daily app-use
    // award is a global-pot credit, so the two no longer sum into one figure —
    // which is the whole point of splitting them.
    expect(second.balance).toBe("50 LP");
    expect(second.globalBalance).toBe(
      centavosToLoyaltyPoints(await dailyAppUseCentavos(wallet.wallet.id)),
    );
  });

  // The partner's two sides are netted once, at month end. Charging the 10%
  // fee per redemption instead would bill them on gross LP spend even in a
  // month they finish owing us money.
  it("nets LP issued against LP redeemed and charges the fee on the payout", async () => {
    const wallet = await getOrCreateRewardWallet({ phone });
    // PHP 10,000 spent earns 500 LP, so the partner owes us PHP 500.
    await creditRewardFromPurchase({
      walletToken: wallet.wallet.walletToken,
      businessId,
      purchaseAmount: "10,000",
      staffName: "staff@bizflow.local",
      idempotencyKey: "purchase-for-500-lp-voucher",
    });
    const db = await getDb();
    // Earning lands in the partner's bucket now rather than the global pot, so
    // the spendable side is funded directly: what is under test here is
    // month-end netting, not how the customer came by convertible LP.
    // Five vouchers at 500 LP each. The cost is what leaves the wallet; the
    // ₱100 face value is what the partner is later reimbursed, so the two
    // figures below are deliberately different.
    await run(db, "UPDATE reward_wallets SET balance_centavos = 250000");

    // Conversion mints fixed ₱100 coupons, so 500 LP of redemption is five of
    // them rather than one voucher for the whole amount.
    const redemptions = [];
    for (let index = 0; index < 5; index += 1) {
      const converted = await convertRewardCreditToVoucher({
        phone,
        walletSecret: wallet.walletSecret,
      });
      redemptions.push(
        await redeemRewardVoucher({
          codeOrToken: converted.voucher.voucherCode,
          businessId,
          amount: "100",
          purchaseAmount: "600",
          staffName: "staff@bizflow.local",
        }),
      );
    }

    // No fee at checkout any more: each redemption carries its full value.
    const redeemed = redemptions[redemptions.length - 1];
    expect(redeemed.amount).toBe("100 LP");
    expect(redeemed.serviceFee).toBe("0 LP");
    expect(redeemed.settlementAmount).toBe("100 LP");
    // Move both sides into June so July 1-7 can close them.
    await run(db, "UPDATE reward_purchases SET created_at = ?", [
      "2026-06-15T12:00:00.000Z",
    ]);
    await run(db, "UPDATE reward_voucher_redemptions SET created_at = ?", [
      "2026-06-30T12:00:00.000Z",
    ]);

    // 500 LP issued against 500 LP redeemed leaves nothing owed either way.
    const balanced = await businessStatementPreview({ businessId, period: "2026-06" });
    expect(balanced).toMatchObject({
      issued: "₱500.00",
      redeemed: "₱500.00",
      direction: "Balanced",
      serviceFee: "₱0.00",
    });

    // A second redemption, funded by LP earned at another partner, tips the
    // month in the partner's favour: PHP 1,000 net, fee PHP 100, payout PHP 900.
    await run(db, "UPDATE reward_wallets SET balance_centavos = 500000");
    for (let index = 0; index < 10; index += 1) {
      const second = await convertRewardCreditToVoucher({
        phone,
        walletSecret: wallet.walletSecret,
      });
      await redeemRewardVoucher({
        codeOrToken: second.voucher.voucherCode,
        businessId,
        amount: "100",
        purchaseAmount: "600",
        staffName: "staff@bizflow.local",
      });
    }
    // The first five were stamped 12:00 above; everything still carrying a live
    // timestamp is this second batch.
    await run(
      db,
      "UPDATE reward_voucher_redemptions SET created_at = ? WHERE created_at <> ?",
      ["2026-06-30T13:00:00.000Z", "2026-06-30T12:00:00.000Z"],
    );

    await expect(
      closeBusinessStatement({
        businessId,
        period: "2026-07",
        reviewer: "admin@bizflow.local",
      }),
    ).rejects.toThrow(/completed month/);

    vi.setSystemTime(new Date("2026-07-10T12:00:00+08:00"));
    await expect(
      closeBusinessStatement({
        businessId,
        period: "2026-06",
        reviewer: "admin@bizflow.local",
      }),
    ).rejects.toThrow(/first 7 days/);
    vi.setSystemTime(new Date("2026-07-03T12:00:00+08:00"));

    const closed = await closeBusinessStatement({
      businessId,
      period: "2026-06",
      reviewer: "admin@bizflow.local",
    });
    expect(closed).toMatchObject({
      period: "2026-06",
      issued: "₱500.00",
      redeemed: "₱1,500.00",
      net: "₱1,000.00",
      direction: "Payout",
      serviceFee: "₱100.00",
      payout: "₱900.00",
      depositDeduction: "₱0.00",
    });

    // The deposit is untouched when the month runs the partner's way.
    const afterClose = await businessDepositStatus(businessId);
    expect(afterClose.balance).toBe("₱5,000.00");

    // Closing twice would double-pay.
    await expect(
      closeBusinessStatement({
        businessId,
        period: "2026-06",
        reviewer: "admin@bizflow.local",
      }),
    ).rejects.toThrow(/already been closed/);

    const paid = await recordStatementPayment({
      statementId: closed.statementId,
      reference: "GCASH-88231",
      recordedBy: "finance@bizflow.local",
    });
    expect(paid).toMatchObject({ status: "Paid", paymentReference: "GCASH-88231" });
  });

  it("draws the deposit down when the partner owes more than they are owed", async () => {
    const wallet = await getOrCreateRewardWallet({ phone });
    await creditRewardFromPurchase({
      walletToken: wallet.wallet.walletToken,
      businessId,
      purchaseAmount: "20,000",
      staffName: "staff@bizflow.local",
      idempotencyKey: "purchase-with-no-redemption",
    });

    const db = await getDb();
    await run(db, "UPDATE reward_purchases SET created_at = ?", [
      "2026-06-15T12:00:00.000Z",
    ]);

    // 1,000 LP issued, nothing spent back: PHP 1,000 comes off the deposit and
    // no service fee applies, because we are not paying them anything.
    const closed = await closeBusinessStatement({
      businessId,
      period: "2026-06",
      reviewer: "admin@bizflow.local",
    });
    expect(closed).toMatchObject({
      direction: "Collection",
      issued: "₱1,000.00",
      redeemed: "₱0.00",
      serviceFee: "₱0.00",
      payout: "₱0.00",
      depositDeduction: "₱1,000.00",
    });

    const status = await businessDepositStatus(businessId);
    expect(status.balance).toBe("₱4,000.00");
    // Under the PHP 5,000 minimum, but still trading.
    expect(status).toMatchObject({ belowMinimum: true, blocked: false, topUpDue: "₱1,000.00" });

    const entries = await listBusinessDepositEntries(businessId);
    expect(entries[0]).toMatchObject({
      type: "StatementDeduction",
      amount: "-₱1,000.00",
      balanceAfter: "₱4,000.00",
    });

    // Nothing to pay out, so the payout recorder refuses the statement.
    await expect(
      recordStatementPayment({
        statementId: closed.statementId,
        reference: "GCASH-00001",
        recordedBy: "finance@bizflow.local",
      }),
    ).rejects.toThrow(/nothing to pay/);
  });

  it("stops issuing LP once a partner's deposit is exhausted, and resumes on top-up", async () => {
    const wallet = await getOrCreateRewardWallet({ phone });
    const db = await getDb();
    await run(db, "UPDATE businesses SET deposit_balance_centavos = 0 WHERE id = ?", [
      businessId,
    ]);

    await expect(
      creditRewardFromPurchase({
        walletToken: wallet.wallet.walletToken,
        businessId,
        purchaseAmount: "1,000",
        staffName: "staff@bizflow.local",
        idempotencyKey: "purchase-while-deposit-empty",
      }),
    ).rejects.toThrow(/deposit is used up/);

    const topUp = await recordBusinessDeposit({
      businessId,
      amount: "5,000",
      reference: "BPI-4471",
      recordedBy: "finance@bizflow.local",
    });
    expect(topUp.status).toMatchObject({ blocked: false, belowMinimum: false });

    const credited = await creditRewardFromPurchase({
      walletToken: wallet.wallet.walletToken,
      businessId,
      purchaseAmount: "1,000",
      staffName: "staff@bizflow.local",
      idempotencyKey: "purchase-after-top-up",
    });
    expect(credited.rewardAmount).toBe("50 LP");
  });

  it("buys a storefront item with LP and bills it to the partner", async () => {
    const wallet = await getOrCreateRewardWallet({ phone });
    const db = await getDb();
    // A storefront item is bought with points earned at the partner selling it,
    // so the bucket is funded the way a customer would fill it: ₱20,000 spent
    // there earns the 1,000 LP this test spends down.
    await creditRewardFromPurchase({
      walletToken: wallet.wallet.walletToken,
      businessId,
      purchaseAmount: "20,000",
      staffName: "staff@bizflow.local",
      idempotencyKey: "purchase-funding-storefront-item",
    });

    const products = await listRewardProducts({ businessId });
    const bowl = products.find((item) => item.id === "rprod_demo_rice_bowl");
    expect(bowl).toMatchObject({
      price: "500 LP",
      businessName: "Mesa Manila Test Kitchen",
      imageUrl: "/images/rewards/adobo-rice-bowl.png",
    });

    const bought = await purchaseRewardProduct({
      phone,
      walletSecret: wallet.walletSecret,
      productId: "rprod_demo_rice_bowl",
    });
    expect(bought.balance).toBe("500 LP");
    expect(bought.voucher.amountCentavos).toBe(500_00);

    // The partner is credited only once staff hand the item over.
    const beforeHandover = await businessStatementPreview({ businessId });
    expect(beforeHandover.redeemed).toBe("₱0.00");

    await redeemRewardVoucher({
      codeOrToken: bought.voucher.voucherCode,
      businessId,
      amount: "500",
      staffName: "staff@bizflow.local",
    });
    const afterHandover = await businessStatementPreview({ businessId });
    expect(afterHandover.redeemed).toBe("₱500.00");
  });
  // The purchase has to outlive the receipt screen: the QR is the only way to
  // collect the item, so it is kept and its state tracked, not shown once.
  it("keeps a bought item and marks it collected once staff scan it", async () => {
    const wallet = await getOrCreateRewardWallet({ phone });
    const db = await getDb();
    // Funds this partner's bucket, which is what a storefront purchase spends.
    await creditRewardFromPurchase({
      walletToken: wallet.wallet.walletToken,
      businessId,
      purchaseAmount: "20,000",
      staffName: "staff@bizflow.local",
      idempotencyKey: "purchase-funding-collected-item",
    });

    const bought = await purchaseRewardProduct({
      phone,
      walletSecret: wallet.walletSecret,
      productId: "rprod_demo_rice_bowl",
    });

    const [saved] = await listWalletPurchases({ phone });
    expect(saved).toMatchObject({
      productName: "Adobo Rice Bowl",
      businessName: "Mesa Manila Test Kitchen",
      price: "500 LP",
      status: "Active",
      collectable: true,
      voucherCode: bought.voucher.voucherCode,
    });

    await redeemRewardVoucher({
      codeOrToken: bought.voucher.voucherCode,
      businessId,
      amount: "500",
      staffName: "staff@bizflow.local",
    });

    const [collected] = await listWalletPurchases({ phone });
    expect(collected).toMatchObject({ status: "Redeemed", collectable: false });
    expect(collected.redeemedAt).not.toBe("");
  });
});

// Points are held per partner and reach the spend-anywhere pot only by paying
// to move them, so these cover the two prices a holder can pay: the transfer
// fee, or spending at face value where the points were earned.
describe("business Loyalty Points", () => {
  beforeEach(async () => {
    await resetDb();
  });

  async function earn(amount: string, key: string) {
    const wallet = await getOrCreateRewardWallet({ phone });
    await creditRewardFromPurchase({
      walletToken: wallet.wallet.walletToken,
      businessId,
      purchaseAmount: amount,
      staffName: "staff@bizflow.local",
      idempotencyKey: key,
    });
    return wallet;
  }

  it("earns 5% into the partner's bucket and leaves the global pot alone", async () => {
    const wallet = await earn("1,000", "business-lp-earn-basic");
    const db = await getDb();

    const bucket = await one(
      db,
      "SELECT balance_centavos FROM reward_business_balances WHERE business_id = ?",
      [businessId],
    );
    expect(Number(bucket?.balance_centavos)).toBe(50_00);

    // The daily app-use award is a global credit, so the pot holds today's
    // draw and nothing more — none of the 50 LP earned at checkout is in it.
    const global = await one(db, "SELECT balance_centavos FROM reward_wallets WHERE phone = ?", [phone]);
    expect(Number(global?.balance_centavos)).toBe(
      await dailyAppUseCentavos(wallet.wallet.id),
    );
  });

  it("charges 10% to move points to the global pot", async () => {
    // ₱20,000 spent earns 1,000 LP, the figure the fee is easiest to read on.
    const wallet = await earn("20,000", "business-lp-transfer-funding");
    const before = await one(
      await getDb(),
      "SELECT balance_centavos FROM reward_wallets WHERE phone = ?",
      [phone],
    );

    const moved = await transferBusinessLpToGlobal({
      phone,
      walletSecret: wallet.walletSecret,
      businessId,
      amount: "1000",
    });

    expect(moved.transferred).toBe("1,000 LP");
    expect(moved.fee).toBe("100 LP");
    expect(moved.credited).toBe("900 LP");
    // The bucket gives up the full 1,000 while the pot gains 900: the missing
    // 100 is burned, not parked somewhere.
    expect(moved.businessBalance).toBe("0 LP");
    const globalAfter = Number(before?.balance_centavos) + 900_00;
    expect(moved.wallet.balanceCentavos).toBe(globalAfter);
  });

  it("refuses a transfer larger than the bucket holds", async () => {
    const wallet = await earn("1,000", "business-lp-overdraw");
    await expect(
      transferBusinessLpToGlobal({
        phone,
        walletSecret: wallet.walletSecret,
        businessId,
        amount: "500",
      }),
    ).rejects.toThrow(/Not enough/);
  });

  // Dust transfers are refused: below the rounding edge the fee floors to
  // nothing, so repeating them would be a free route out of a bucket.
  it("refuses a transfer too small to carry a fee", async () => {
    const wallet = await earn("1,000", "business-lp-tiny");
    await expect(
      transferBusinessLpToGlobal({
        phone,
        walletSecret: wallet.walletSecret,
        businessId,
        amount: "5",
      }),
    ).rejects.toThrow(/fee applies/);
  });

  it("mints a fixed ₱100 voucher and holds it to its minimum spend", async () => {
    const wallet = await getOrCreateRewardWallet({ phone });
    const db = await getDb();
    await run(db, "UPDATE reward_wallets SET balance_centavos = 100000");

    const converted = await convertRewardCreditToVoucher({
      phone,
      walletSecret: wallet.walletSecret,
    });
    expect(converted.voucher.amountCentavos).toBe(100_00);
    expect(converted.voucher.minimumSpendCentavos).toBe(500_00);

    // Under the minimum spend, and the voucher does not apply.
    await expect(
      redeemRewardVoucher({
        codeOrToken: converted.voucher.voucherCode,
        businessId,
        amount: "100",
        purchaseAmount: "499",
        staffName: "staff@bizflow.local",
      }),
    ).rejects.toThrow(/₱500.00 minimum spend/);

    // Nor can it be split across smaller bills to dodge that floor.
    await expect(
      redeemRewardVoucher({
        codeOrToken: converted.voucher.voucherCode,
        businessId,
        amount: "40",
        purchaseAmount: "600",
        staffName: "staff@bizflow.local",
      }),
    ).rejects.toThrow(/in full/);

    // A qualifying bill spends it whole.
    const spent = await redeemRewardVoucher({
      codeOrToken: converted.voucher.voucherCode,
      businessId,
      amount: "100",
      purchaseAmount: "600",
      staffName: "staff@bizflow.local",
    });
    expect(spent.voucher.remainingCentavos).toBe(0);
  });

  it("lists partner buckets in the wallet snapshot", async () => {
    const wallet = await earn("1,000", "business-lp-snapshot");
    const snapshot = await rewardWalletSnapshot({
      phone,
      walletSecret: wallet.walletSecret,
    });

    expect(snapshot.businessBalances).toEqual([
      expect.objectContaining({
        businessId,
        businessName: "Mesa Manila Test Kitchen",
        balance: "50 LP",
      }),
    ]);
  });

  // The app opens the wallet through this call, not the snapshot above. While
  // it omitted the buckets the phone had no way to see partner points at all,
  // and the storefront priced its Buy button off the global pot instead.
  it("lists partner buckets when the app opens the wallet", async () => {
    await earn("1,000", "business-lp-wallet-open");
    const opened = await getOrCreateRewardWallet({ phone });

    expect(opened.businessBalances).toEqual([
      expect.objectContaining({
        businessId,
        businessName: "Mesa Manila Test Kitchen",
        balance: "50 LP",
        balanceCentavos: 50_00,
      }),
    ]);
    // The two pots stay distinct: earning never touched the spend-anywhere one.
    expect(opened.wallet.balanceCentavos).toBe(
      await dailyAppUseCentavos(opened.wallet.id),
    );
  });

  // The dev tool for the bucket side. Its whole point is landing in the pot the
  // storefront spends from, without touching the global one.
  it("grants LP into one partner's bucket from the dev tools", async () => {
    const wallet = await getOrCreateRewardWallet({ phone });

    const granted = await grantDevBusinessLoyaltyPoints({
      phone,
      businessId,
      amount: "1,500",
    });
    expect(granted).toMatchObject({
      businessId,
      businessName: "Mesa Manila Test Kitchen",
      granted: "1,500 LP",
      balance: "1,500 LP",
    });

    const snapshot = await rewardWalletSnapshot({
      phone,
      walletSecret: wallet.walletSecret,
    });
    expect(snapshot.businessBalances).toEqual([
      expect.objectContaining({ businessId, balance: "1,500 LP" }),
    ]);
    // The global pot is untouched — it still holds only the app-use award.
    expect(snapshot.balance).toBe(
      centavosToLoyaltyPoints(await dailyAppUseCentavos(wallet.wallet.id)),
    );

    // Enough to actually buy the partner's dearest demo item, which is the
    // reason for granting directly rather than simulating a sale.
    const bought = await purchaseRewardProduct({
      phone,
      walletSecret: wallet.walletSecret,
      productId: "rprod_demo_rice_bowl",
    });
    expect(bought.balance).toBe("1,000 LP");
  });

  // The Global LP storefront. Cost and face value are different numbers, which
  // is the thing most likely to get collapsed back into one by mistake.
  it("sells a global voucher for its cost, not its face value", async () => {
    const wallet = await getOrCreateRewardWallet({ phone });
    const [reward] = listGlobalRewards();
    expect(reward).toMatchObject({
      id: "global_voucher_100",
      cost: "500 LP",
      value: "₱100.00",
      minimumSpend: "₱500.00",
    });

    const db = await getDb();
    await run(db, "UPDATE reward_wallets SET balance_centavos = 60000");

    const bought = await convertRewardCreditToVoucher({
      phone,
      walletSecret: wallet.walletSecret,
      rewardId: reward.id,
    });
    // 500 LP left the wallet; the voucher is worth ₱100 off a ₱500 bill.
    expect(bought.cost).toBe("500 LP");
    expect(bought.balance).toBe("100 LP");
    expect(bought.voucher.amountCentavos).toBe(100_00);
    expect(bought.voucher.minimumSpendCentavos).toBe(500_00);

    // Too little left for a second one.
    await expect(
      convertRewardCreditToVoucher({
        phone,
        walletSecret: wallet.walletSecret,
        rewardId: reward.id,
      }),
    ).rejects.toThrow(/You need 500 LP in Global LP/);
  });

  it("refuses a reward that is not in the catalogue", async () => {
    const wallet = await getOrCreateRewardWallet({ phone });
    await expect(
      convertRewardCreditToVoucher({
        phone,
        walletSecret: wallet.walletSecret,
        rewardId: "global_voucher_free_car",
      }),
    ).rejects.toThrow(/was not found/);
  });

  it("refuses a business LP grant for a partner that does not exist", async () => {
    await getOrCreateRewardWallet({ phone });
    await expect(
      grantDevBusinessLoyaltyPoints({
        phone,
        businessId: "biz_does_not_exist",
        amount: "100",
      }),
    ).rejects.toThrow(/Business was not found/);
  });
});
