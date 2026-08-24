import crypto from "node:crypto";
import type { Exec } from "@/server/db";
import { all, one, run, withReadTx, withTx } from "@/server/db";
import { AppError } from "@/server/errors";
import { normalizePhone } from "@/server/phone";
import { recordRewardAudit } from "@/server/rewards-network";

/**
 * Account deletion, as published at `/delete-account`.
 *
 * That page is what Google Play holds us to, so this module implements it
 * literally rather than approximately. Three rules follow from it:
 *
 *   1. **Identity is destroyed.** Name, number and email are gone from every
 *      table that holds them, and every credential that could reach the account
 *      — sessions, bearer tokens, push tokens, redeemable QR codes — stops
 *      working. Nothing that remains can be traced back to a person by us or by
 *      a partner.
 *   2. **Money records survive, de-identified.** Loyalty Points that a partner
 *      has already been paid for, or is owed for, cannot be unpicked without
 *      corrupting a settlement that has real pesos behind it. Those rows stay,
 *      keyed to the wallet id — an internal reference with no person on the
 *      other end of it once the wallet is scrubbed.
 *   3. **The audit chain is never rewritten.** `reward_audit_logs` entries hash
 *      their own contents into the next entry, so redacting one would break
 *      verification for every entry after it. This is safe to leave alone: the
 *      chain records wallet ids and amounts, never a phone, a name or an email
 *      (see the `audit()` call sites in rewards-network.ts), so scrubbing the
 *      wallet de-identifies the chain along with it.
 *
 * The wallet row itself is **tombstoned, not dropped**: six tables carry a
 * foreign key to it, including the settlement records rule 2 protects. A
 * tombstone keeps those keys valid while holding nothing about the customer.
 */

const isoNow = () => new Date().toISOString();

/**
 * The internal reference that replaces the customer everywhere a column is
 * NOT NULL and cannot simply be emptied.
 *
 * Random rather than derived from the phone number: a hash of a 10-digit
 * Philippine mobile number is not anonymous, because the whole space can be
 * enumerated in seconds and matched against the digest.
 */
function deletionRef() {
  return `del_${crypto.randomBytes(12).toString("hex")}`;
}

/** What a deletion did, table by table. Returned to the caller and audited. */
export type DeletionSummary = {
  /** The opaque reference that replaced the customer. Keep it: it is the only key left. */
  ref: string;
  deletedAt: string;
  /** Rows destroyed outright. */
  deleted: Record<string, number>;
  /** Rows kept but stripped of identity, or of value. */
  deidentified: Record<string, number>;
};

/** Placeholder text for a NOT NULL column whose contents were personal. */
const REDACTED = "[deleted]";

async function ids(tx: Exec, sql: string, args: unknown[]) {
  return (await all(tx, sql, args)).map((row) => String(row.id));
}

/** `IN (?, ?, ?)` for a list known to be non-empty. */
function inList(values: string[]) {
  return `(${values.map(() => "?").join(", ")})`;
}

/**
 * Deletes the account behind `phone`, and everything the published page says is
 * deleted.
 *
 * Runs as one transaction: a half-deleted account is worse than a live one,
 * because it is neither usable nor honestly reportable as removed.
 */
export async function deleteCustomerAccount(input: {
  phone: string;
  /** How the request was proven — recorded in the audit entry. */
  via: "self-serve" | "support-request";
}): Promise<DeletionSummary> {
  const phone = normalizePhone(input.phone);
  if (!phone) {
    throw new AppError("E-USER-PHONE", "A valid Philippine mobile number is required", 400);
  }

  const summary = await withTx(async (tx) => {
    const userIds = await ids(tx, "SELECT id FROM users WHERE phone = ?", [phone]);
    const walletRow = await one(tx, "SELECT id FROM reward_wallets WHERE phone = ?", [phone]);
    const walletId = walletRow ? String(walletRow.id) : null;

    if (userIds.length === 0 && !walletId) {
      throw new AppError("E-ACCOUNT-404", "No account exists for this number", 404);
    }

    const ref = deletionRef();
    const now = isoNow();
    const deleted: Record<string, number> = {};
    const deidentified: Record<string, number> = {};

    // ---- The hunt side: deleted outright -----------------------------------
    // Order is forced by the foreign keys into users(id): attempts, vouchers and
    // referral_rewards all reference it, so users goes last.
    if (userIds.length > 0) {
      const users = inList(userIds);
      const voucherIds = await ids(
        tx,
        `SELECT id FROM vouchers WHERE user_id IN ${users}`,
        userIds,
      );
      if (voucherIds.length > 0) {
        deleted.redemption_logs = await run(
          tx,
          `DELETE FROM redemption_logs WHERE voucher_id IN ${inList(voucherIds)}`,
          voucherIds,
        );
      }
      deleted.vouchers = await run(tx, `DELETE FROM vouchers WHERE user_id IN ${users}`, userIds);
      deleted.reservations = await run(tx, `DELETE FROM reservations WHERE user_id IN ${users}`, userIds);
      deleted.attempts = await run(tx, `DELETE FROM attempts WHERE user_id IN ${users}`, userIds);
      deleted.referral_rewards = await run(
        tx,
        `DELETE FROM referral_rewards WHERE referrer_user_id IN ${users}`,
        userIds,
      );

      // Campaign counters, not personal history: a row with no user_id says
      // "someone spun the reel", which is not about anybody. Dropping them
      // instead would silently restate every campaign's funnel long after the
      // fact.
      deidentified.analytics_events = await run(
        tx,
        `UPDATE analytics_events SET user_id = NULL WHERE user_id IN ${users}`,
        userIds,
      );

      // Delivery logs are the one thing the page says outlives the account, for
      // 12 months, to settle disputes with the SMS provider. What survives is
      // the fact of a send and what the carrier said about it — never the
      // number it went to or the words in it. `sweepExpiredPersonalData` sweeps
      // them up when the 12 months are done.
      deidentified.sms_logs = await run(
        tx,
        `UPDATE sms_logs
            SET to_number = ?, body = ?, user_id = ?, delivery_receipt = NULL
          WHERE user_id IN ${users} OR to_number = ?`,
        [ref, REDACTED, ref, ...userIds, phone],
      );

      deleted.users = await run(tx, `DELETE FROM users WHERE id IN ${users}`, userIds);
    } else {
      deidentified.sms_logs = await run(
        tx,
        `UPDATE sms_logs SET to_number = ?, body = ?, user_id = ?, delivery_receipt = NULL WHERE to_number = ?`,
        [ref, REDACTED, ref, phone],
      );
    }

    // ---- Credentials and devices: deleted outright --------------------------
    deleted.customer_tokens = await run(tx, "DELETE FROM customer_tokens WHERE phone = ?", [phone]);
    deleted.customer_sessions = await run(tx, "DELETE FROM customer_sessions WHERE phone = ?", [phone]);
    deleted.otp_challenges = await run(tx, "DELETE FROM otp_challenges WHERE phone = ?", [phone]);
    deleted.push_devices = await run(tx, "DELETE FROM push_devices WHERE phone = ?", [phone]);
    deleted.push_logs = await run(tx, "DELETE FROM push_logs WHERE phone = ?", [phone]);

    // ---- The wallet: tombstoned --------------------------------------------
    if (walletId) {
      // Unspent Loyalty Points are forfeited, and the codes that could spend
      // them are rewritten so a screenshot of a QR is worthless. Terminal state
      // is 'Expired' rather than a new 'Deleted': every guard in
      // rewards-network.ts tests `status === 'Active'`, and the dashboard's
      // status rollups already know this one.
      const liveVouchers = await ids(
        tx,
        "SELECT id FROM reward_vouchers WHERE wallet_id = ? AND status = 'Active'",
        [walletId],
      );
      for (const voucherId of liveVouchers) {
        await run(
          tx,
          `UPDATE reward_vouchers
              SET status = 'Expired', remaining_centavos = 0, voucher_code = ?, qr_token = ?
            WHERE id = ?`,
          [`RWD-VOID-${crypto.randomBytes(8).toString("hex").toUpperCase()}`, deletionRef(), voucherId],
        );
      }
      deidentified.reward_vouchers = liveVouchers.length;

      // Points held against a single partner are forfeited with the rest. The
      // row stays at zero so the partner's own lifetime totals still add up.
      deidentified.reward_business_balances = await run(
        tx,
        "UPDATE reward_business_balances SET balance_centavos = 0, updated_at = ? WHERE wallet_id = ?",
        [now, walletId],
      );

      // The tombstone itself. phone, wallet_token and wallet_secret are all
      // NOT NULL UNIQUE, so each takes a fresh random value rather than NULL —
      // which also invalidates the wallet QR the customer may still be holding.
      deidentified.reward_wallets = await run(
        tx,
        `UPDATE reward_wallets
            SET phone = ?, name = NULL, email = NULL,
                wallet_token = ?, wallet_secret = ?,
                balance_centavos = 0, status = 'Deleted', updated_at = ?
          WHERE id = ?`,
        [ref, deletionRef(), deletionRef(), now, walletId],
      );

      // Written last, inside the same transaction: if anything above fails there
      // must be no audit entry claiming an account was deleted.
      await recordRewardAudit(tx, {
        actorType: "system",
        actorId: ref,
        action: "account_deleted",
        entityType: "reward_wallet",
        entityId: walletId,
        metadata: { ref, via: input.via, deleted, deidentified },
      });
    }

    return { ref, deletedAt: now, deleted, deidentified } satisfies DeletionSummary;
  });

  return summary;
}

/**
 * Whether this number has anything to delete.
 *
 * Used to decide, quietly, whether to send a deletion code at all. A number with
 * no account gets no SMS: an unexpected text saying something is about to be
 * deleted is alarming, and it would be entirely at an attacker's choosing who
 * received it.
 */
export async function accountExists(phoneInput: string) {
  const phone = normalizePhone(phoneInput);
  if (!phone) return false;
  return withReadTx(async (tx) => {
    const user = await one(tx, "SELECT id FROM users WHERE phone = ? LIMIT 1", [phone]);
    if (user) return true;
    return Boolean(await one(tx, "SELECT id FROM reward_wallets WHERE phone = ?", [phone]));
  });
}

/**
 * What deleting this number would remove, without removing it.
 *
 * For answering "what do you hold about me?" — a Data Privacy Act access
 * request — and for checking a support request found the right account before
 * anything is destroyed.
 */
export async function previewCustomerAccount(phoneInput: string) {
  const phone = normalizePhone(phoneInput);
  if (!phone) {
    throw new AppError("E-USER-PHONE", "A valid Philippine mobile number is required", 400);
  }

  return withReadTx(async (tx) => {
    const userIds = await ids(tx, "SELECT id FROM users WHERE phone = ?", [phone]);
    const wallet = await one(
      tx,
      "SELECT id, balance_centavos, status FROM reward_wallets WHERE phone = ?",
      [phone],
    );
    if (userIds.length === 0 && !wallet) {
      throw new AppError("E-ACCOUNT-404", "No account exists for this number", 404);
    }

    const count = async (sql: string, args: unknown[]) =>
      Number((await one(tx, sql, args))?.c ?? 0);
    const users = userIds.length > 0 ? inList(userIds) : null;

    return {
      phone,
      campaignsJoined: userIds.length,
      vouchers: users ? await count(`SELECT COUNT(*) AS c FROM vouchers WHERE user_id IN ${users}`, userIds) : 0,
      reservations: users
        ? await count(`SELECT COUNT(*) AS c FROM reservations WHERE user_id IN ${users}`, userIds)
        : 0,
      attempts: users ? await count(`SELECT COUNT(*) AS c FROM attempts WHERE user_id IN ${users}`, userIds) : 0,
      pushDevices: await count("SELECT COUNT(*) AS c FROM push_devices WHERE phone = ?", [phone]),
      smsLogs: await count("SELECT COUNT(*) AS c FROM sms_logs WHERE to_number = ?", [phone]),
      wallet: wallet
        ? {
            id: String(wallet.id),
            status: String(wallet.status),
            balanceCentavos: Number(wallet.balance_centavos ?? 0),
          }
        : null,
    };
  });
}

/**
 * Retention sweep for the logs that hold a number but no account.
 *
 * The deletion path above can only reach data belonging to someone who asked.
 * These tables accumulate phone numbers for everyone else too — a number that
 * was sent one OTP and never came back still sits in `otp_challenges` — and the
 * privacy policy puts a clock on them. Nothing was enforcing it, so every one of
 * these tables held every row it had ever written.
 *
 * Idempotent, and safe to run more often than daily.
 */
export async function sweepExpiredPersonalData(now = new Date()) {
  const cutoff = (days: number) =>
    new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();

  return withTx(async (tx) => ({
    // "kept for 12 months to resolve delivery disputes with our provider, then
    // deleted" — /delete-account.
    sms_logs: await run(tx, "DELETE FROM sms_logs WHERE created_at < ?", [cutoff(365)]),
    push_logs: await run(tx, "DELETE FROM push_logs WHERE created_at < ?", [cutoff(365)]),
    // A challenge is dead five minutes after it is written. Thirty days is
    // generous, and leaves enough history to investigate an OTP flood.
    otp_challenges: await run(tx, "DELETE FROM otp_challenges WHERE created_at < ?", [cutoff(30)]),
    // Sessions and tokens past their own expiry are unusable but still name a
    // phone number.
    customer_sessions: await run(tx, "DELETE FROM customer_sessions WHERE expires_at < ?", [
      now.toISOString(),
    ]),
    customer_tokens: await run(tx, "DELETE FROM customer_tokens WHERE expires_at < ?", [
      now.toISOString(),
    ]),
    // Rate-limit buckets are hashed, not personal, but the window is minutes and
    // the table is written on every public request.
    rate_events: await run(tx, "DELETE FROM rate_events WHERE created_at < ?", [cutoff(7)]),
  }));
}
