import { beforeEach, describe, expect, it } from "vitest";
import { getDb, one, resetDb, run } from "@/server/db";
import { redeemVoucher } from "@/server/voucher-engine";
import { huntAndSelect } from "../helpers";
import { AppError } from "@/server/errors";
import {
  businessBillingOverview,
  closeBusinessStatement,
  convertRewardCreditToVoucher,
  creditRewardFromPurchase,
  getOrCreateRewardWallet,
  listWalletPurchases,
  purchaseRewardProduct,
  recordBusinessDeposit,
  recordStatementPayment,
  redeemRewardVoucher,
  validateRewardVoucher,
} from "@/server/rewards-network";

const phone = "+639171119999";
const businessId = "biz_demo_restaurant";
const staffName = "staff@bizflow.local";

/**
 * The whole LP money loop in the order it happens in the real world, so a
 * change to any one leg is caught against the legs either side of it:
 *
 *   deposit -> customer pays cash -> LP issued (partner owes us)
 *           -> customer spends LP on an item -> staff hand it over (we owe partner)
 *           -> month closes, sides net, fee on the payout -> payout recorded
 */
describe("LP lifecycle end to end", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("runs a month that ends owing the partner", async () => {
    const wallet = await getOrCreateRewardWallet({ phone });
    const db = await getDb();

    // 1. The partner is funded. Seeded at the PHP 5,000 minimum.
    const opening = await businessBillingOverview(businessId);
    expect(opening.deposit).toMatchObject({
      balance: "₱5,000.00",
      blocked: false,
      belowMinimum: false,
    });

    // 2. A customer pays PHP 4,000 in cash at checkout and earns 5% as LP.
    const credited = await creditRewardFromPurchase({
      walletToken: wallet.wallet.walletToken,
      businessId,
      purchaseAmount: "4000",
      staffName,
      idempotencyKey: "lifecycle-cash-purchase",
    });
    expect(credited.rewardAmount).toBe("200 LP");
    expect(credited.heldForReview).toBe(false);

    // The partner now owes us for those points.
    const afterEarning = await businessBillingOverview(businessId);
    expect(afterEarning.current).toMatchObject({
      issued: "₱200.00",
      redeemed: "₱0.00",
      direction: "Collection",
    });

    // 3. Top this partner's bucket up so an item is affordable, then buy one —
    //    a storefront item is bought with points earned there, not global ones.
    //    Points leave the bucket immediately; the partner is not paid yet.
    await run(
      db,
      "UPDATE reward_business_balances SET balance_centavos = 100000 WHERE business_id = ?",
      [businessId],
    );
    const bought = await purchaseRewardProduct({
      phone,
      walletSecret: wallet.walletSecret,
      productId: "rprod_demo_rice_bowl",
    });
    expect(bought.balance).toBe("500 LP");
    expect(
      (await businessBillingOverview(businessId)).current.redeemed,
    ).toBe("₱0.00");

    // The item is kept, with the code staff will scan.
    const [saved] = await listWalletPurchases({ phone });
    expect(saved).toMatchObject({ status: "Active", collectable: true });

    // 4. Staff scan it. They can see what to hand over.
    const validated = await validateRewardVoucher({
      codeOrToken: saved.voucherCode,
    });
    expect(validated.product).toMatchObject({
      name: "Adobo Rice Bowl",
      businessName: "Mesa Manila Test Kitchen",
    });

    // An item voucher is that item, not a balance: no part-redeeming it, and
    // not at a partner who never sold it.
    await expect(
      redeemRewardVoucher({
        codeOrToken: saved.voucherCode,
        businessId,
        amount: "100",
        staffName,
      }),
    ).rejects.toThrow(/in full/);
    await expect(
      redeemRewardVoucher({
        codeOrToken: saved.voucherCode,
        businessId: "biz_demo_shop",
        amount: "500",
        staffName,
      }),
    ).rejects.toThrow(/collected there/);

    const handedOver = await redeemRewardVoucher({
      codeOrToken: saved.voucherCode,
      businessId,
      amount: "500",
      staffName,
    });
    // No fee at checkout any more — that is charged once, on the month's net.
    expect(handedOver).toMatchObject({
      amount: "500 LP",
      serviceFee: "0 LP",
    });
    expect((await listWalletPurchases({ phone }))[0]).toMatchObject({
      status: "Redeemed",
      collectable: false,
    });

    // 5. Close the month. 200 LP issued against 500 LP redeemed leaves PHP 300
    //    owed to the partner, less the 10% fee.
    await run(db, "UPDATE reward_purchases SET created_at = ?", [
      "2026-06-10T12:00:00.000Z",
    ]);
    await run(db, "UPDATE reward_voucher_redemptions SET created_at = ?", [
      "2026-06-20T12:00:00.000Z",
    ]);
    const statement = await closeBusinessStatement({
      businessId,
      period: "2026-06",
      reviewer: "admin@bizflow.local",
    });
    expect(statement).toMatchObject({
      issued: "₱200.00",
      redeemed: "₱500.00",
      net: "₱300.00",
      direction: "Payout",
      serviceFee: "₱30.00",
      payout: "₱270.00",
      depositDeduction: "₱0.00",
    });

    // 6. We pay them. The transfer is manual, so the reference is the record.
    const paid = await recordStatementPayment({
      statementId: statement.statementId,
      reference: "GCASH-LIFECYCLE-1",
      recordedBy: "finance@bizflow.local",
    });
    expect(paid).toMatchObject({
      status: "Paid",
      paymentReference: "GCASH-LIFECYCLE-1",
    });

    // The deposit is untouched: it only absorbs months that end in our favour.
    const closing = await businessBillingOverview(businessId);
    expect(closing.deposit.balance).toBe("₱5,000.00");
    expect(closing.statements).toHaveLength(1);
  });

  it("runs a month that ends owing us, and stops the checkout at zero", async () => {
    const wallet = await getOrCreateRewardWallet({ phone });
    const db = await getDb();

    // Cash spend with nothing redeemed back: PHP 300 of LP issued.
    await creditRewardFromPurchase({
      walletToken: wallet.wallet.walletToken,
      businessId,
      purchaseAmount: "6000",
      staffName,
      idempotencyKey: "lifecycle-collection-purchase",
    });
    await run(db, "UPDATE reward_purchases SET created_at = ?", [
      "2026-06-10T12:00:00.000Z",
    ]);

    const statement = await closeBusinessStatement({
      businessId,
      period: "2026-06",
      reviewer: "admin@bizflow.local",
    });
    expect(statement).toMatchObject({
      direction: "Collection",
      serviceFee: "₱0.00",
      payout: "₱0.00",
      depositDeduction: "₱300.00",
    });

    // Nothing to pay out, and the deposit carries the shortfall instead.
    await expect(
      recordStatementPayment({
        statementId: statement.statementId,
        reference: "GCASH-NOPE",
        recordedBy: "finance@bizflow.local",
      }),
    ).rejects.toThrow(/nothing to pay/);
    expect((await businessBillingOverview(businessId)).deposit.balance).toBe(
      "₱4,700.00",
    );

    // Drain the deposit: the checkout stops issuing until it is topped up.
    await run(db, "UPDATE businesses SET deposit_balance_centavos = 0 WHERE id = ?", [
      businessId,
    ]);
    await expect(
      creditRewardFromPurchase({
        walletToken: wallet.wallet.walletToken,
        businessId,
        purchaseAmount: "1000",
        staffName,
        idempotencyKey: "lifecycle-blocked-purchase",
      }),
    ).rejects.toThrow(AppError);

    await recordBusinessDeposit({
      businessId,
      amount: "5000",
      reference: "BPI-LIFECYCLE",
      recordedBy: "finance@bizflow.local",
    });
    const resumed = await creditRewardFromPurchase({
      walletToken: wallet.wallet.walletToken,
      businessId,
      purchaseAmount: "1000",
      staffName,
      idempotencyKey: "lifecycle-resumed-purchase",
    });
    expect(resumed.rewardAmount).toBe("50 LP");
  });

  it("keeps a plain LP voucher spendable at any partner", async () => {
    const wallet = await getOrCreateRewardWallet({ phone });
    const db = await getDb();
    await run(db, "UPDATE reward_wallets SET balance_centavos = 100000");

    // Converted credit is a fixed coupon, not an item and not a balance: spent
    // in full, at whichever partner the customer chooses, on a qualifying bill.
    const converted = await convertRewardCreditToVoucher({
      phone,
      walletSecret: wallet.walletSecret,
    });
    expect(converted.voucher.amountCentavos).toBe(100_00);
    expect(converted.voucher.minimumSpendCentavos).toBe(500_00);

    const spent = await redeemRewardVoucher({
      codeOrToken: converted.voucher.voucherCode,
      businessId: "biz_demo_shop",
      amount: "100",
      purchaseAmount: "600",
      staffName,
    });
    expect(spent.voucher.remainingCentavos).toBe(0);

    // It is kept alongside bought items, since both are things LP turned into
    // and both are collected with a code — but tagged apart, because this one
    // belongs to no partner and carries a minimum spend instead.
    expect(await listWalletPurchases({ phone })).toEqual([
      expect.objectContaining({
        kind: "global_voucher",
        productId: "",
        businessId: "",
        price: "₱100.00",
        minimumSpend: "₱500.00",
      }),
    ]);

    const remaining = await one(
      db,
      "SELECT product_id FROM reward_vouchers WHERE id = ?",
      [converted.voucher.id],
    );
    expect(remaining?.product_id ?? null).toBeNull();
  });
  // Staff mark a campaign voucher used and enter what the customer paid; the
  // 5% follows from that one action, with no second scan.
  it("awards the 5% automatically when a campaign voucher is redeemed", async () => {
    const issued = await huntAndSelect({
      campaignSlug: "july-dinner",
      phone,
      sessionId: "lifecycle-session",
      name: "Lifecycle Customer",
      guestCount: 2,
    });

    const redeemed = await redeemVoucher({
      codeOrToken: issued.voucher.voucherCode,
      staffName,
      purchaseAmount: 2000,
    });
    expect(redeemed.loyalty).toMatchObject({ awarded: true, amount: "100 LP" });

    // The partner is billed for those points, exactly as a checkout scan would be.
    expect((await businessBillingOverview(businessId)).current).toMatchObject({
      issued: "₱100.00",
      direction: "Collection",
    });

    // A customer with no wallet gets one, but not the daily app-use bonus:
    // the balance is the sale's 5% and nothing else.
    const [wallet] = await listWalletPurchases({ phone });
    expect(wallet).toBeUndefined();
    // The 5% is held against the partner it was earned at, so it shows in that
    // bucket and the global pot stays empty until the customer transfers it.
    const db = await getDb();
    const bucket = await one(
      db,
      `SELECT rbb.balance_centavos AS balance_centavos
       FROM reward_business_balances rbb
       JOIN reward_wallets w ON w.id = rbb.wallet_id
       WHERE w.phone = ? AND rbb.business_id = ?`,
      [phone, businessId],
    );
    expect(Number(bucket?.balance_centavos)).toBe(100_00);
    const global = await one(
      db,
      "SELECT balance_centavos FROM reward_wallets WHERE phone = ?",
      [phone],
    );
    // None of the 5% reached the global pot. What is in there is the 5 LP the
    // "visit a partner and scan" daily mission pays for the same scan — a
    // platform-funded reward, which is why it lands in the spend-anywhere pot
    // rather than in the partner's bucket, and why the partner is billed for
    // ₱100.00 above and not a centavo more.
    expect(Number(global?.balance_centavos)).toBe(5_00);
  });

  // A voucher already served cannot be refused because the money side failed.
  it("still redeems the voucher when the partner deposit is exhausted", async () => {
    const issued = await huntAndSelect({
      campaignSlug: "july-dinner",
      phone,
      sessionId: "lifecycle-session-2",
      name: "Lifecycle Customer",
      guestCount: 2,
    });
    await run(
      await getDb(),
      "UPDATE businesses SET deposit_balance_centavos = 0 WHERE id = ?",
      [businessId],
    );

    const redeemed = await redeemVoucher({
      codeOrToken: issued.voucher.voucherCode,
      staffName,
      purchaseAmount: 2000,
    });
    expect(redeemed.voucher.status).toBe("Redeemed");
    expect(redeemed.loyalty).toMatchObject({ awarded: false });
    expect(redeemed.loyalty?.reason).toMatch(/deposit/i);
  });
});
