import { beforeEach, describe, expect, it } from "vitest";
import { getDb, resetDb, run } from "@/server/db";
import {
  creditRewardFromPurchase,
  getOrCreateRewardWallet,
  listWalletPurchases,
  purchaseRewardProduct,
  redeemRewardVoucher,
} from "@/server/rewards-network";
import {
  listTransactions,
  listTransactionsForExport,
  transactionsToCsv,
} from "@/server/transactions";
import { redeemVoucher } from "@/server/voucher-engine";
import { huntAndSelect } from "../helpers";

const ADMIN = { role: "super_admin", businessIds: ["*"] };
const RESTAURANT = "biz_demo_restaurant";
const SHOP = "biz_demo_shop";
const staffName = "staff@bizflow.local";

const voucherPhone = "+639181111111";
const walkInPhone = "+639182222222";

/**
 * Puts one of each kind of movement on the books.
 *
 * The voucher redemption is deliberately the one that also awards LP, because
 * that pair is the only place two rows describe a single bill and the totals
 * have to know it.
 */
async function seedTransactions() {
  const selected = await huntAndSelect({
    campaignSlug: "july-dinner",
    phone: voucherPhone,
    sessionId: "tx-session",
    name: "Voucher Customer",
  });
  // Above every seeded tier's minimum spend, so the draw's tier cannot decide
  // whether this test redeems.
  await redeemVoucher({
    codeOrToken: selected.voucher.voucherCode,
    staffName: "Cashier",
    purchaseAmount: 2000,
    note: "Table 12",
  });

  const walkIn = await getOrCreateRewardWallet({ phone: walkInPhone });
  await creditRewardFromPurchase({
    walletToken: walkIn.wallet.walletToken,
    businessId: SHOP,
    purchaseAmount: "1000",
    staffName,
    idempotencyKey: "tx-walk-in-purchase-shop",
  });

  // An LP voucher is bought out of the partner's own bucket, then handed over.
  await run(
    await getDb(),
    "UPDATE reward_business_balances SET balance_centavos = 100000 WHERE business_id = ?",
    [RESTAURANT],
  );
  await purchaseRewardProduct({
    phone: voucherPhone,
    walletSecret: (await getOrCreateRewardWallet({ phone: voucherPhone }))
      .walletSecret,
    productId: "rprod_demo_rice_bowl",
  });
  const [bought] = await listWalletPurchases({ phone: voucherPhone });
  await redeemRewardVoucher({
    codeOrToken: bought.voucherCode,
    businessId: RESTAURANT,
    amount: "500",
    staffName,
  });

  return { voucherCode: selected.voucher.voucherCode };
}

describe("dashboard transactions", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("lists nothing before any checkout has taken money", async () => {
    const { rows, totals } = await listTransactions(ADMIN);
    expect(rows).toEqual([]);
    expect(totals.count).toBe(0);
  });

  it("survives a sale too large for the pesos column to multiply", async () => {
    await seedTransactions();
    // Written straight to the column because the checkout will no longer accept
    // a figure this size — the rows that predate that limit are still on the
    // books, and the page has to render them. `purchase_amount` is int4 pesos,
    // so a sale this large stores fine and only overflows on the way to
    // centavos, which used to 500 the page: list and totals share the union.
    await run(await getDb(), "UPDATE redemption_logs SET purchase_amount = ?", [
      2_000_000_000,
    ]);

    const { rows, totals } = await listTransactions(ADMIN);
    const redemption = rows.find((row) => row.kind === "voucher_redemption");
    expect(redemption?.purchaseCentavos).toBe(200_000_000_000);
    expect(totals.salesCentavos).toBeGreaterThan(200_000_000_000);
  });

  it("unions voucher redemptions, LP earned and LP spent, newest first", async () => {
    const { voucherCode } = await seedTransactions();

    const { rows, totals } = await listTransactions(ADMIN);

    // Four movements: the redemption, the LP it awarded, the walk-in award and
    // the LP handed back at checkout.
    expect(rows).toHaveLength(4);
    expect(totals.count).toBe(4);

    const kinds = rows.map((row) => row.kind).sort();
    expect(kinds).toEqual([
      "lp_earned",
      "lp_earned",
      "lp_spent",
      "voucher_redemption",
    ]);

    const timestamps = rows.map((row) => row.createdAt);
    expect([...timestamps].sort().reverse()).toEqual(timestamps);

    const redemption = rows.find((row) => row.kind === "voucher_redemption");
    expect(redemption).toMatchObject({
      businessId: RESTAURANT,
      phone: voucherPhone,
      customerName: "Voucher Customer",
      reference: voucherCode,
      note: "Table 12",
      staffName: "Cashier",
      status: "Redeemed",
      // Written in pesos, normalised to centavos by the union.
      purchaseCentavos: 200000,
      linkedToVoucher: false,
    });
    expect(redemption?.campaignTitle).toBeTruthy();

    const spent = rows.find((row) => row.kind === "lp_spent");
    expect(spent).toMatchObject({
      businessId: RESTAURANT,
      // Negative, so the column can be read as a running effect on the wallet.
      loyaltyDeltaCentavos: -50000,
      detail: "Adobo Rice Bowl",
      // The 10% is charged once on the month's net, not at checkout, so a
      // redemption is booked at its full value and the fee row stays zero.
      serviceFeeCentavos: 0,
      settlementCentavos: 50000,
    });
  });

  it("counts a voucher's bill once even though two rows describe it", async () => {
    await seedTransactions();
    const { rows, totals } = await listTransactions(ADMIN);

    const awards = rows.filter((row) => row.kind === "lp_earned");
    const linked = awards.find((row) => row.linkedToVoucher);
    const walkIn = awards.find((row) => !row.linkedToVoucher);

    // Both rows carry their own bill...
    expect(linked?.purchaseCentavos).toBe(200000);
    expect(walkIn?.purchaseCentavos).toBe(100000);
    // ...and say which of the two they are, in the table and the export alike.
    expect(linked?.detail).toBe("Earned with a voucher redemption");
    expect(walkIn?.detail).toBe("Earned on a walk-in sale");
    // ...but the ₱2,000 the voucher row already reported is not added twice.
    expect(totals.salesCentavos).toBe(300000);

    // 5% of ₱2,000 plus 5% of ₱1,000, both in LP centavos.
    expect(totals.lpEarnedCentavos).toBe(10000 + 5000);
    expect(totals.lpSpentCentavos).toBe(50000);
    expect(totals.settlementCentavos).toBe(50000);
    expect(totals.voucherRedemptionCount).toBe(1);
  });

  it("shows staff only their own business, whatever they ask for", async () => {
    await seedTransactions();
    const staff = { role: "staff", businessIds: [SHOP] };

    const own = await listTransactions(staff);
    expect(own.rows).toHaveLength(1);
    expect(own.rows[0]).toMatchObject({ businessId: SHOP, kind: "lp_earned" });

    // Asking for someone else's business narrows back to their own rather than
    // widening: the scope is taken from the session, not the query string.
    const probing = await listTransactions(staff, { businessId: RESTAURANT });
    expect(probing.rows.map((row) => row.businessId)).toEqual([SHOP]);
    expect(probing.totals.count).toBe(1);
  });

  it("shows a staff account with no business assignment nothing at all", async () => {
    await seedTransactions();
    const unassigned = { role: "staff", businessIds: [] };
    const { rows, totals } = await listTransactions(unassigned);
    expect(rows).toEqual([]);
    expect(totals.count).toBe(0);
  });

  it("filters by business, kind and search term", async () => {
    const { voucherCode } = await seedTransactions();

    const byBusiness = await listTransactions(ADMIN, { businessId: SHOP });
    expect(byBusiness.rows).toHaveLength(1);

    const byKind = await listTransactions(ADMIN, { kind: "lp_spent" });
    expect(byKind.rows).toHaveLength(1);
    expect(byKind.totals.lpSpentCentavos).toBe(50000);
    // The totals describe the filtered set, so LP earned drops out with it.
    expect(byKind.totals.lpEarnedCentavos).toBe(0);

    const byCode = await listTransactions(ADMIN, { search: voucherCode });
    expect(byCode.rows).toHaveLength(1);
    expect(byCode.rows[0].kind).toBe("voucher_redemption");

    // Two: the redemption and the LP award it triggered were both booked
    // against the operator who rang the sale up.
    const byStaff = await listTransactions(ADMIN, { search: "Cashier" });
    expect(byStaff.rows).toHaveLength(2);

    const byPhone = await listTransactions(ADMIN, { search: "9182222222" });
    expect(byPhone.rows.map((row) => row.businessId)).toEqual([SHOP]);

    expect((await listTransactions(ADMIN, { search: "nobody" })).rows).toEqual([]);
  });

  it("reads date filters as Manila days", async () => {
    await seedTransactions();

    // Everything was written just now, so today in Manila must include it and
    // the day before must not.
    const today = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Manila",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
    const yesterday = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Manila",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(Date.now() - 24 * 60 * 60 * 1000));

    expect((await listTransactions(ADMIN, { from: today, to: today })).rows).toHaveLength(4);
    expect((await listTransactions(ADMIN, { to: yesterday })).rows).toEqual([]);
  });

  it("exports the filtered rows as CSV", async () => {
    const { voucherCode } = await seedTransactions();

    const everything = transactionsToCsv(await listTransactionsForExport(ADMIN));
    expect(everything).toContain("Earned with a voucher redemption");
    expect(everything).toContain("Adobo Rice Bowl");

    const rows = await listTransactionsForExport(ADMIN, {
      kind: "voucher_redemption",
    });
    const csv = transactionsToCsv(rows);

    expect(csv.split("\n")).toHaveLength(2);
    expect(csv).toContain("recorded_at,type,business");
    expect(csv).toContain(voucherCode);
    expect(csv).toContain("Voucher redeemed");
    expect(csv).toContain("2000.00");
    expect(csv).toContain("Cashier");
  });

  it("pages without dropping or repeating a row", async () => {
    await seedTransactions();

    const all = await listTransactions(ADMIN);
    expect(all.hasMore).toBe(false);
    expect(all.page).toBe(1);

    // Page 2 of a four-row set is empty rather than an error, which is what a
    // stale page number in a bookmarked URL produces.
    const beyond = await listTransactions(ADMIN, { page: 2 });
    expect(beyond.rows).toEqual([]);
    expect(beyond.totals.count).toBe(4);
  });
});
