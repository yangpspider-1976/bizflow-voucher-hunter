import { beforeEach, describe, expect, it } from "vitest";
import { getCustomer, listCustomers } from "@/server/customers";
import { getDb, resetDb, run } from "@/server/db";
import { AppError } from "@/server/errors";
import { listBusinesses, listCampaigns } from "@/server/admin";
import { startHunt } from "@/server/voucher-engine";

const ADMIN = { role: "super_admin", businessIds: ["*"] };

describe("dashboard customers", () => {
  beforeEach(async () => {
    await resetDb();
  });

  async function joinCampaign(phone: string, slug: string) {
    await startHunt({ campaignSlug: slug, phone, sessionId: `sess_${phone}` });
  }

  async function seedWallet(id: string, phone: string, balanceCentavos: number) {
    const db = await getDb();
    const now = new Date().toISOString();
    await run(
      db,
      `INSERT INTO reward_wallets
         (id, phone, wallet_token, wallet_secret, balance_centavos, lifetime_earned_centavos,
          lifetime_converted_centavos, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, 'Active', ?, ?)`,
      [id, phone, `tok_${id}`, `sec_${id}`, balanceCentavos, balanceCentavos, now, now],
    );
  }

  /** The bucket a checkout at one partner credits, rather than the global pot. */
  async function seedPartnerBalance(
    walletId: string,
    businessId: string,
    balanceCentavos: number,
    lifetimeEarnedCentavos = balanceCentavos,
  ) {
    const db = await getDb();
    const now = new Date().toISOString();
    await run(
      db,
      `INSERT INTO reward_business_balances
         (id, wallet_id, business_id, balance_centavos, lifetime_earned_centavos,
          lifetime_transferred_centavos, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
      [
        `rbb_${walletId}_${businessId}`,
        walletId,
        businessId,
        balanceCentavos,
        lifetimeEarnedCentavos,
        now,
        now,
      ],
    );
  }

  it("lists nobody before anyone hunts", async () => {
    expect(await listCustomers(ADMIN)).toEqual([]);
  });

  it("groups a phone across campaigns into one customer", async () => {
    const campaigns = await listCampaigns();
    const [first, second] = campaigns;
    await joinCampaign("+639171234567", first.slug);
    await joinCampaign("+639171234567", second.slug);

    const customers = await listCustomers(ADMIN);
    // `users` is keyed per campaign, so this is two rows and must still read as
    // one person.
    expect(customers).toHaveLength(1);
    expect(customers[0].phone).toBe("+639171234567");
    expect(customers[0].campaignCount).toBe(2);
  });

  it("searches by number", async () => {
    const [campaign] = await listCampaigns();
    await joinCampaign("+639171234567", campaign.slug);
    await joinCampaign("+639998887777", campaign.slug);

    expect(await listCustomers(ADMIN, "9171")).toHaveLength(1);
    expect(await listCustomers(ADMIN, "0000")).toHaveLength(0);
  });

  it("shows staff only customers of their own business", async () => {
    const businesses = await listBusinesses();
    const campaigns = await listCampaigns();
    const mine = campaigns[0];
    const theirs = campaigns.find((c) => c.businessId !== mine.businessId);
    expect(theirs).toBeDefined();

    await joinCampaign("+639171234567", mine.slug);
    await joinCampaign("+639998887777", theirs!.slug);

    const staff = { role: "staff", businessIds: [mine.businessId] };
    const visible = await listCustomers(staff);
    expect(visible.map((c) => c.phone)).toEqual(["+639171234567"]);
    expect(businesses.length).toBeGreaterThan(1);
  });

  it("hides an out-of-scope customer behind the same 404 as an unknown one", async () => {
    const campaigns = await listCampaigns();
    const mine = campaigns[0];
    const theirs = campaigns.find((c) => c.businessId !== mine.businessId)!;
    await joinCampaign("+639998887777", theirs.slug);

    const staff = { role: "staff", businessIds: [mine.businessId] };
    // Otherwise the difference between "no such customer" and "not yours" would
    // let staff probe for other businesses' customers.
    await expect(getCustomer(staff, "+639998887777")).rejects.toBeInstanceOf(AppError);
    await expect(getCustomer(staff, "+639000000000")).rejects.toBeInstanceOf(AppError);
  });

  it("shows a staff account with no business nobody at all", async () => {
    const [campaign] = await listCampaigns();
    await joinCampaign("+639171234567", campaign.slug);
    expect(await listCustomers({ role: "staff", businessIds: [] })).toEqual([]);
  });

  it("returns the campaigns a customer joined", async () => {
    const campaigns = await listCampaigns();
    await joinCampaign("+639171234567", campaigns[0].slug);

    const detail = await getCustomer(ADMIN, "+639171234567");
    expect(detail.summary.phone).toBe("+639171234567");
    expect(detail.campaigns).toHaveLength(1);
    expect(detail.campaigns[0].campaignSlug).toBe(campaigns[0].slug);
    expect(detail.vouchers).toEqual([]);
  });

  it("reports the loyalty balance when the phone has a wallet", async () => {
    const [campaign] = await listCampaigns();
    await joinCampaign("+639171234567", campaign.slug);

    const db = await getDb();
    await run(
      db,
      `INSERT INTO reward_wallets
         (id, phone, wallet_token, wallet_secret, balance_centavos, lifetime_earned_centavos,
          lifetime_converted_centavos, status, created_at, updated_at)
       VALUES ('w_test', '+639171234567', 'tok_test', 'sec_test', 2500, 2500, 0, 'Active', ?, ?)`,
      [new Date().toISOString(), new Date().toISOString()],
    );

    const [customer] = await listCustomers(ADMIN);
    expect(customer.loyaltyBalanceCentavos).toBe(2500);

    const detail = await getCustomer(ADMIN, "+639171234567");
    expect(detail.summary.loyaltyBalanceCentavos).toBe(2500);
  });

  it("leaves the balance undefined when there is no wallet", async () => {
    const [campaign] = await listCampaigns();
    await joinCampaign("+639171234567", campaign.slug);
    const [customer] = await listCustomers(ADMIN);
    expect(customer.loyaltyBalanceCentavos).toBeUndefined();
    expect(customer.partnerBalances).toEqual([]);
  });

  it("reports every partner bucket, not only the global pot", async () => {
    const campaigns = await listCampaigns();
    const mine = campaigns[0];
    const other = campaigns.find((c) => c.businessId !== mine.businessId)!;
    await joinCampaign("+639171234567", mine.slug);
    await joinCampaign("+639171234567", other.slug);
    await seedWallet("w_test", "+639171234567", 2500);
    await seedPartnerBalance("w_test", mine.businessId, 8000);
    await seedPartnerBalance("w_test", other.businessId, 1500);

    // The wallet's own balance is the global pot alone. Points earned at a
    // checkout are in the buckets, and used to be invisible to the dashboard.
    const [customer] = await listCustomers(ADMIN);
    expect(customer.loyaltyBalanceCentavos).toBe(2500);
    expect(customer.partnerBalances.map((bucket) => bucket.balanceCentavos)).toEqual([
      8000, 1500,
    ]);

    const detail = await getCustomer(ADMIN, "+639171234567");
    expect(detail.summary.partnerBalances).toHaveLength(2);
    expect(detail.summary.partnerBalances[0].businessId).toBe(mine.businessId);
    expect(detail.summary.partnerBalances[0].lifetimeEarnedCentavos).toBe(8000);
  });

  it("keeps a spent-out bucket, which is not the same as never earning there", async () => {
    const [campaign] = await listCampaigns();
    await joinCampaign("+639171234567", campaign.slug);
    await seedWallet("w_test", "+639171234567", 0);
    await seedPartnerBalance("w_test", campaign.businessId, 0, 5000);

    const [customer] = await listCustomers(ADMIN);
    expect(customer.partnerBalances).toHaveLength(1);
    expect(customer.partnerBalances[0].balanceCentavos).toBe(0);
    expect(customer.partnerBalances[0].lifetimeEarnedCentavos).toBe(5000);
  });

  it("shows staff only the buckets held at their own business", async () => {
    const campaigns = await listCampaigns();
    const mine = campaigns[0];
    const theirs = campaigns.find((c) => c.businessId !== mine.businessId)!;
    await joinCampaign("+639171234567", mine.slug);
    await joinCampaign("+639171234567", theirs.slug);
    await seedWallet("w_test", "+639171234567", 2500);
    await seedPartnerBalance("w_test", mine.businessId, 8000);
    await seedPartnerBalance("w_test", theirs.businessId, 1500);

    // What this customer holds at a competitor is not this staff account's
    // business, the same way the competitor's campaigns are not.
    const staff = { role: "staff", businessIds: [mine.businessId] };
    const [customer] = await listCustomers(staff);
    expect(customer.partnerBalances.map((bucket) => bucket.businessId)).toEqual([
      mine.businessId,
    ]);

    const detail = await getCustomer(staff, "+639171234567");
    expect(detail.summary.partnerBalances.map((bucket) => bucket.businessId)).toEqual([
      mine.businessId,
    ]);
  });
});
