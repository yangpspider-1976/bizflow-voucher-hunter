import { beforeEach, describe, expect, it } from "vitest";
import { resetDb } from "@/server/db";
import { importRedemptions, validateVoucher } from "@/server/voucher-engine";
import { huntAndSelect } from "../helpers";

const issueShopVoucher = async (phone: string) =>
  (await huntAndSelect({ campaignSlug: "8pm-drop", phone, name: "Import User" })).voucher;

describe("redemption CSV import", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("marks matching codes redeemed and reports per-row outcomes", async () => {
    const a = await issueShopVoucher("+639170005001");
    const b = await issueShopVoucher("+639170005002");

    const csv = ["voucher_code,purchase_amount", `${a.voucherCode},1500`, `${b.voucherCode},2000`, "BIZ-UNKNOWN,999"].join("\n");
    const result = await importRedemptions({ campaignId: "camp_8pm_drop", csv, staffName: "Ops" });

    expect(result.redeemed).toBe(2);
    expect(result.results.find((r) => r.code === a.voucherCode)?.status).toBe("redeemed");
    expect(result.results.find((r) => r.code === "BIZ-UNKNOWN")?.status).toBe("not_found");
    expect((await validateVoucher({ codeOrToken: a.voucherCode })).voucher.status).toBe("Redeemed");
  });

  it("refuses a row whose amount would overflow the column, and keeps the rest", async () => {
    const a = await issueShopVoucher("+639170005004");
    const b = await issueShopVoucher("+639170005005");
    const csv = [
      "voucher_code,purchase_amount",
      `${a.voucherCode},2000000000`,
      `${b.voucherCode},1500`,
    ].join("\n");

    const result = await importRedemptions({ campaignId: "camp_8pm_drop", csv, staffName: "Ops" });

    // The bad row costs itself and nothing else: redeeming it and dropping the
    // amount would spend the voucher and lose the bill.
    expect(result.results.find((r) => r.code === a.voucherCode)?.status).toBe(
      "amount_out_of_range",
    );
    expect((await validateVoucher({ codeOrToken: a.voucherCode })).voucher.status).not.toBe(
      "Redeemed",
    );
    expect(result.results.find((r) => r.code === b.voucherCode)?.status).toBe("redeemed");
    expect(result.redeemed).toBe(1);
  });

  it("reports already-redeemed codes on a second import", async () => {
    const a = await issueShopVoucher("+639170005003");
    const csv = `voucher_code\n${a.voucherCode}`;
    await importRedemptions({ campaignId: "camp_8pm_drop", csv, staffName: "Ops" });
    const second = await importRedemptions({ campaignId: "camp_8pm_drop", csv, staffName: "Ops" });
    expect(second.results[0].status).toBe("already_redeemed");
    expect(second.redeemed).toBe(0);
  });
});
