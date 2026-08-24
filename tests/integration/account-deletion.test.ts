import { beforeEach, describe, expect, it } from "vitest";
import {
  accountExists,
  deleteCustomerAccount,
  previewCustomerAccount,
  sweepExpiredPersonalData,
} from "@/server/account-deletion";
import { all, getDb, one, resetDb, run } from "@/server/db";
import { runReconciliation, verifyAuditChain } from "@/server/reconciliation";
import { getOrCreateRewardWallet } from "@/server/rewards-network";
import { huntAndSelect } from "../helpers";

/**
 * Deletion is measured against the page that promises it, `/delete-account`,
 * not against what is convenient to implement. Each test below names the
 * sentence it is enforcing, because if the page is reworded these are what
 * should fail.
 */
describe("account deletion", () => {
  const campaignSlug = "july-dinner";
  const phone = "+639171234321";
  const bystander = "+639171234322";

  beforeEach(async () => {
    await resetDb();
  });

  /** A customer with a voucher, a booking, a wallet and a device registered. */
  async function makeCustomer(number: string) {
    const voucher = await huntAndSelect({ campaignSlug, phone: number, name: "Deleting User" });
    const wallet = await getOrCreateRewardWallet({ phone: number, name: "Deleting User" });
    const db = await getDb();
    await run(
      db,
      `INSERT INTO push_devices (id, phone, expo_push_token, platform, created_at, last_seen_at)
       VALUES (?, ?, ?, 'android', ?, ?)`,
      [`pdev_${number.slice(-4)}`, number, `ExponentPushToken[${number}]`, new Date().toISOString(), new Date().toISOString()],
    );
    return { voucher, wallet };
  }

  it("finds the account, then leaves nothing of it behind", async () => {
    await makeCustomer(phone);

    const preview = await previewCustomerAccount(phone);
    expect(preview.vouchers).toBe(1);
    expect(preview.pushDevices).toBe(1);
    expect(preview.wallet).not.toBeNull();

    const summary = await deleteCustomerAccount({ phone, via: "self-serve" });
    expect(summary.ref).toMatch(/^del_[0-9a-f]{24}$/);
    expect(summary.deleted.users).toBe(1);
    expect(summary.deleted.vouchers).toBe(1);
    expect(summary.deleted.push_devices).toBe(1);

    expect(await accountExists(phone)).toBe(false);

    const db = await getDb();
    for (const [table, column] of [
      ["users", "phone"],
      ["push_devices", "phone"],
      ["customer_tokens", "phone"],
      ["customer_sessions", "phone"],
      ["otp_challenges", "phone"],
    ] as const) {
      const row = await one(db, `SELECT COUNT(*) AS c FROM ${table} WHERE ${column} = ?`, [phone]);
      expect(`${table}:${Number(row?.c ?? 0)}`).toBe(`${table}:0`);
    }
  });

  it("leaves everybody else untouched", async () => {
    await makeCustomer(phone);
    await makeCustomer(bystander);

    await deleteCustomerAccount({ phone, via: "self-serve" });

    expect(await accountExists(bystander)).toBe(true);
    const preview = await previewCustomerAccount(bystander);
    expect(preview.vouchers).toBe(1);
    expect(preview.pushDevices).toBe(1);
  });

  it("tombstones the wallet rather than dropping it, and zeroes the balance", async () => {
    await makeCustomer(phone);
    const db = await getDb();
    const before = await one(db, "SELECT id, wallet_token, balance_centavos FROM reward_wallets WHERE phone = ?", [phone]);
    expect(before).toBeDefined();
    // Daily app-use LP is awarded on wallet creation, so this is a real balance
    // being forfeited rather than a zero that was always zero.
    expect(Number(before!.balance_centavos)).toBeGreaterThan(0);

    const summary = await deleteCustomerAccount({ phone, via: "self-serve" });

    const after = await one(db, "SELECT * FROM reward_wallets WHERE id = ?", [String(before!.id)]);
    expect(after).toBeDefined();
    expect(after!.phone).toBe(summary.ref);
    expect(after!.name).toBeNull();
    expect(after!.email).toBeNull();
    expect(Number(after!.balance_centavos)).toBe(0);
    expect(after!.status).toBe("Deleted");
    // The old wallet QR must stop working, so the token cannot survive.
    expect(after!.wallet_token).not.toBe(before!.wallet_token);
  });

  it("de-identifies delivery logs instead of deleting them, and keeps no message text", async () => {
    await makeCustomer(phone);
    const db = await getDb();
    const before = await one(db, "SELECT COUNT(*) AS c FROM sms_logs WHERE to_number = ?", [phone]);
    expect(Number(before?.c ?? 0)).toBeGreaterThan(0);

    const summary = await deleteCustomerAccount({ phone, via: "self-serve" });

    expect(Number((await one(db, "SELECT COUNT(*) AS c FROM sms_logs WHERE to_number = ?", [phone]))?.c ?? 0)).toBe(0);
    const kept = await all(db, "SELECT * FROM sms_logs WHERE to_number = ?", [summary.ref]);
    expect(kept.length).toBeGreaterThan(0);
    for (const row of kept) {
      expect(row.body).toBe("[deleted]");
      // What a provider dispute actually needs is still there.
      expect(row.status).toBeTruthy();
      expect(row.created_at).toBeTruthy();
    }
  });

  it("keeps campaign analytics as counts, with nobody attached", async () => {
    await makeCustomer(phone);
    const db = await getDb();
    const userIds = (await all(db, "SELECT id FROM users WHERE phone = ?", [phone])).map((row) =>
      String(row.id),
    );
    expect(userIds.length).toBeGreaterThan(0);

    const mine = Number(
      (
        await one(db, `SELECT COUNT(*) AS c FROM analytics_events WHERE user_id IN (${userIds.map(() => "?").join(",")})`, userIds)
      )?.c ?? 0,
    );
    expect(mine).toBeGreaterThan(0);
    const total = Number((await one(db, "SELECT COUNT(*) AS c FROM analytics_events"))?.c ?? 0);

    await deleteCustomerAccount({ phone, via: "self-serve" });

    // Same number of rows, none of them mine any more.
    expect(Number((await one(db, "SELECT COUNT(*) AS c FROM analytics_events"))?.c ?? 0)).toBe(total);
    expect(
      Number(
        (
          await one(db, `SELECT COUNT(*) AS c FROM analytics_events WHERE user_id IN (${userIds.map(() => "?").join(",")})`, userIds)
        )?.c ?? 0,
      ),
    ).toBe(0);
  });

  it("refuses a number with no account", async () => {
    await expect(deleteCustomerAccount({ phone: "+639179999999", via: "self-serve" })).rejects.toMatchObject({
      code: "E-ACCOUNT-404",
    });
  });

  it("rejects a number that is not a Philippine mobile", async () => {
    await expect(deleteCustomerAccount({ phone: "12345", via: "self-serve" })).rejects.toMatchObject({
      code: "E-USER-PHONE",
    });
  });

  /**
   * The two properties the rest of the system depends on surviving a deletion.
   * Both were the reason the wallet is tombstoned instead of dropped.
   */
  it("leaves the audit chain verifying and the books balanced", async () => {
    await makeCustomer(phone);
    await makeCustomer(bystander);

    const before = await runReconciliation();

    await deleteCustomerAccount({ phone, via: "self-serve" });

    const chain = await verifyAuditChain();
    expect(chain.entries).toBeGreaterThan(0);
    expect(chain.tampered).toHaveLength(0);
    expect(chain.missingPredecessor).toHaveLength(0);
    expect(chain.forked).toHaveLength(0);

    // A tombstoned wallet must not read as drift, or the nightly job cries wolf
    // every night after the first deletion. Compared against the state before
    // rather than against zero, so this test fails for the deletion's own sake
    // and not for anything the seed happens to carry.
    const after = await runReconciliation();
    expect(after.balanceDrift).toHaveLength(before.balanceDrift.length);
    expect(after.settlementDrift).toHaveLength(before.settlementDrift.length);
  });

  it("writes the deletion into the audit chain", async () => {
    await makeCustomer(phone);
    const summary = await deleteCustomerAccount({ phone, via: "self-serve" });

    const db = await getDb();
    const entry = await one(db, "SELECT * FROM reward_audit_logs WHERE action = 'account_deleted'");
    expect(entry).toBeDefined();
    expect(entry!.actor_id).toBe(summary.ref);
    // The chained record must not reintroduce what the deletion just removed.
    expect(String(entry!.metadata ?? "")).not.toContain(phone);
  });
});

describe("retention sweep", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("drops logs past their stated retention and keeps the rest", async () => {
    const db = await getDb();
    const old = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString();
    const recent = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();

    for (const [id, createdAt] of [
      ["sms_old", old],
      ["sms_recent", recent],
    ] as const) {
      await run(
        db,
        `INSERT INTO sms_logs (id, campaign_id, user_id, voucher_id, to_number, body, provider, status, created_at)
         VALUES (?, 'camp', 'usr', 'vch', '+639170000000', 'hello', 'mock', 'Sent', ?)`,
        [id, createdAt],
      );
    }
    await run(
      db,
      `INSERT INTO otp_challenges (id, campaign_id, phone, code_hash, expires_at, verified, attempts, created_at)
       VALUES ('otp_old', '__signin__', '+639170000000', 'hash', ?, 0, 0, ?)`,
      [old, old],
    );

    const purged = await sweepExpiredPersonalData();

    expect(purged.sms_logs).toBeGreaterThanOrEqual(1);
    expect(purged.otp_challenges).toBeGreaterThanOrEqual(1);
    expect(await one(db, "SELECT id FROM sms_logs WHERE id = 'sms_old'")).toBeUndefined();
    expect(await one(db, "SELECT id FROM sms_logs WHERE id = 'sms_recent'")).toBeDefined();
    expect(await one(db, "SELECT id FROM otp_challenges WHERE id = 'otp_old'")).toBeUndefined();
  });
});
