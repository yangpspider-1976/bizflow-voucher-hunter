import { beforeEach, describe, expect, it } from "vitest";
import { ADMIN_SESSION_COOKIE, createAdminSession, type AdminSession } from "@/lib/admin-session";
import { all, getDb, resetDb, run } from "@/server/db";
import {
  convertRewardCreditToVoucher,
  getOrCreateRewardWallet,
} from "@/server/rewards-network";
import { GET as listBusinesses } from "@/app/api/businesses/route";
import { POST as redeemLoyaltyVoucher } from "@/app/api/staff/rewards/redeem/route";

const phone = "+639171119901";
const OWN_BUSINESS = "biz_demo_restaurant";
const OTHER_BUSINESS = "biz_demo_shop";

async function requestFor(
  role: AdminSession["role"],
  businessIds: string[],
  url: string,
  body?: unknown,
) {
  const token = await createAdminSession({
    email: `${role}-${businessIds.join("-")}@example.com`,
    name: `${role} user`,
    role,
    businessIds,
  });
  return new Request(url, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      cookie: `${ADMIN_SESSION_COOKIE}=${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/**
 * A plain LP voucher: a spend-anywhere balance pinned to no partner. Conversion
 * mints a fixed ₱100 coupon, so it goes in whole against a qualifying bill.
 */
async function mintGlobalVoucher() {
  const wallet = await getOrCreateRewardWallet({ phone });
  const db = await getDb();
  await run(db, "UPDATE reward_wallets SET balance_centavos = 250000 WHERE id = ?", [
    wallet.wallet.id,
  ]);
  const converted = await convertRewardCreditToVoucher({
    phone,
    walletSecret: wallet.walletSecret,
  });
  return converted.voucher.voucherCode;
}

/**
 * Who a plain LP voucher is redeemed *against*.
 *
 * The voucher itself names no partner — that is the point of it — so the
 * answer comes from the session, and every leg that decides it went untested:
 * the engine had thorough coverage while the route resolving `businessId` and
 * the endpoint feeding the checkout's partner list had none between them.
 */
describe("LP checkout partner resolution", () => {
  beforeEach(async () => {
    process.env.ADMIN_SESSION_SECRET = "test-only-admin-session-secret-with-more-than-32-characters";
    await resetDb();
  });

  it("resolves the partner from the session when the checkout names none", async () => {
    const voucherCode = await mintGlobalVoucher();
    const response = await redeemLoyaltyVoucher(
      await requestFor("staff", [OWN_BUSINESS], "http://localhost/api/staff/rewards/redeem", {
        codeOrToken: voucherCode,
        amount: "100",
        purchaseAmount: "600",
      }),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.amount).toBe("100 LP");
    expect(body.data.voucher.status).toBe("Redeemed");

    // Credited to the one business the session is bound to, not to nobody.
    const db = await getDb();
    const rows = await all(db, "SELECT business_id FROM reward_voucher_redemptions");
    expect(rows.map((row) => String(row.business_id))).toEqual([OWN_BUSINESS]);
  });

  it("asks an unscoped account which partner is accepting it", async () => {
    const voucherCode = await mintGlobalVoucher();
    const response = await redeemLoyaltyVoucher(
      await requestFor("super_admin", ["*"], "http://localhost/api/staff/rewards/redeem", {
        codeOrToken: voucherCode,
        amount: "100",
        purchaseAmount: "600",
      }),
    );

    // A named error rather than the generic "Invalid request input" a required
    // `businessId` used to produce: the checkout has a control to point at.
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe("E-REWARD-VOUCHER-PARTNER");
  });

  it("refuses a partner the session is not scoped to", async () => {
    const voucherCode = await mintGlobalVoucher();
    const response = await redeemLoyaltyVoucher(
      await requestFor("staff", [OWN_BUSINESS], "http://localhost/api/staff/rewards/redeem", {
        codeOrToken: voucherCode,
        businessId: OTHER_BUSINESS,
        amount: "100",
        purchaseAmount: "600",
      }),
    );

    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error.code).toBe("E-STAFF-BUSINESS-SCOPE");
  });

  /**
   * The checkout builds its "Redeeming at" list from this endpoint, so a
   * business listed here and refused by `assertBusinessAccess` is a dead end:
   * the operator picks it, the redemption 403s, and nothing on screen explains
   * why. It narrowed only `staff`, leaving a scoped `admin` the whole network.
   */
  it("offers an account only the partners it may redeem against", async () => {
    const scopedAdmin = await listBusinesses(
      await requestFor("admin", [OWN_BUSINESS], "http://localhost/api/businesses"),
    );
    expect(scopedAdmin.status).toBe(200);
    const scopedBody = await scopedAdmin.json();
    expect(scopedBody.data.map((business: { id: string }) => business.id)).toEqual([
      OWN_BUSINESS,
    ]);

    const staff = await listBusinesses(
      await requestFor("staff", [OWN_BUSINESS], "http://localhost/api/businesses"),
    );
    const staffBody = await staff.json();
    expect(staffBody.data.map((business: { id: string }) => business.id)).toEqual([
      OWN_BUSINESS,
    ]);

    // An unscoped account still sees the whole network, so a super admin can
    // still accept a voucher on any partner's behalf.
    const superAdmin = await listBusinesses(
      await requestFor("super_admin", ["*"], "http://localhost/api/businesses"),
    );
    const superBody = await superAdmin.json();
    expect(superBody.data.length).toBeGreaterThan(1);
    expect(superBody.data.map((business: { id: string }) => business.id)).toContain(
      OTHER_BUSINESS,
    );
  });
});
