import crypto from "node:crypto";
import { all, getDb, one, run } from "@/server/db";
import { DEV_ACCOUNT_ENV_PAIRS, devToolsEnabled } from "@/server/dev-tools";
import { AppError } from "@/server/errors";
import { normalizePhone } from "@/server/phone";
import { sendSms, type SmsResult } from "@/server/sms";

const OTP_TTL_MS = 5 * 60_000;
const isoNow = () => new Date().toISOString();
const otpId = () => `otp_${crypto.randomBytes(6).toString("hex")}`;

/**
 * Wrong guesses a single challenge tolerates before it is burned.
 *
 * The code is 20 bits. Five tries per challenge means an attacker's odds are
 * 5-in-a-million per code sent, and MAX_CODES_PER_PHONE_WINDOW caps how many
 * codes they can cause to exist — so the whole attack is bounded by SMS the
 * victim would notice, rather than by how fast the attacker can send requests.
 */
const MAX_VERIFY_ATTEMPTS = 5;
/** Codes one number can have issued inside the window, however many addresses ask. */
const MAX_CODES_PER_PHONE_WINDOW = 5;
const PHONE_REQUEST_WINDOW_MS = 15 * 60_000;

// Sign-in OTP is campaign-agnostic — it proves phone ownership for the account
// itself, not for one campaign. The challenge table's campaign_id is plain
// NOT NULL text with no FK, so a sentinel scope is safe.
const SIGNIN_SCOPE = "__signin__";
/**
 * Account deletion gets a scope of its own, and it is not decoration: the scope
 * is hashed into the code, so a code someone was talked into reading out "to
 * sign in" cannot be replayed to erase their account, and the two flows cannot
 * consume each other's challenges. The SMS says which one it is, too.
 */
const DELETION_SCOPE = "__delete__";

function hashCode(scope: string, phone: string, code: string) {
  const salt = process.env.OTP_SALT ?? process.env.ADMIN_ACCESS_TOKEN ?? "bizflow-otp";
  return crypto.createHash("sha256").update(`${salt}:${scope}:${phone}:${code}`).digest("hex");
}

function requireValidPhone(phone: string) {
  const normalized = normalizePhone(phone);
  if (!normalized) throw new AppError("E-USER-PHONE", "A valid Philippine mobile number is required", 400);
  return normalized;
}

/**
 * Numbers that sign in with a fixed code instead of an SMS.
 *
 * Two callers need this, for the same reason: sign-in is an SMS OTP to a
 * Philippine handset and `devCode` is suppressed in production by design, so
 * whoever holds neither is locked out of the live app.
 *
 *   REVIEW_ACCOUNT_PHONE / REVIEW_ACCOUNT_OTP
 *     The Google Play reviewer. Play's App access form demands "reusable login
 *     details that do not expire". An ordinary customer account, no elevated
 *     rights. Unset once review passes — see docs/PLAY_CONSOLE_ANSWERS.md §2.
 *
 *   DEV_ACCOUNT_PHONE / DEV_ACCOUNT_OTP  (and the numbered slots after it)
 *     The production developer accounts (see `@/server/dev-tools`, which owns the
 *     list of slot names). The OTP half is optional and independent of the tools
 *     half: leave it unset when the number is a handset you actually hold, and
 *     sign in by real SMS — a code that never expires is strictly more attack
 *     surface than one that does.
 *
 * Each pair is inert unless both of its vars are set and the code is six digits,
 * so no deploy acquires one by accident. A fixed code is long-lived, so it wants
 * to be random rather than memorable — it is a password, not a one-time code.
 */
type FixedCodeAccount = { phone: string; code: string };

function fixedCodeAccount(phoneVar: string, codeVar: string): FixedCodeAccount | null {
  const configuredPhone = process.env[phoneVar]?.trim();
  const code = process.env[codeVar]?.trim();
  if (!configuredPhone || !code || !/^\d{6}$/.test(code)) return null;
  const phone = normalizePhone(configuredPhone);
  return phone ? { phone, code } : null;
}

/** The fixed-code entry for `phone`, or null when it signs in by SMS like everyone else. */
function fixedCodeAccountFor(phone: string): FixedCodeAccount | null {
  const accounts = [
    fixedCodeAccount("REVIEW_ACCOUNT_PHONE", "REVIEW_ACCOUNT_OTP"),
    ...DEV_ACCOUNT_ENV_PAIRS.map((pair) => fixedCodeAccount(pair.phone, pair.otp)),
  ];
  return accounts.find((account) => account?.phone === phone) ?? null;
}

/** Constant-time compare, so a wrong guess leaks nothing about the real code. */
function codeMatches(expected: string, provided: string) {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(provided, "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * How many codes this number has been sent recently.
 *
 * Per-address limits do not protect a phone: the address is the attacker's to
 * choose, and the number being pumped is the victim's. This counts what was
 * actually sent to the number, so an SMS flood costs the same whether it comes
 * from one address or a thousand.
 */
async function codesSentRecently(
  db: Awaited<ReturnType<typeof getDb>>,
  phone: string,
  scope: string,
) {
  const since = new Date(Date.now() - PHONE_REQUEST_WINDOW_MS).toISOString();
  const row = await one(
    db,
    "SELECT COUNT(*) AS c FROM otp_challenges WHERE campaign_id = ? AND phone = ? AND created_at >= ?",
    [scope, phone, since],
  );
  return Number(row?.c ?? 0);
}

/** Generates a 6-digit code for one scope, stores its hash, and sends it via SMS. */
async function requestOtp(input: {
  phone: string;
  scope: string;
  message: (code: string) => string;
}): Promise<{ sent: boolean; expiresAt: string; devCode?: string }> {
  const db = await getDb();
  const { scope } = input;
  const phone = requireValidPhone(input.phone);

  // No challenge row and no SMS for a fixed-code account: the number may not be
  // a real handset, so sending would only burn provider credit and log a
  // failure. The client advances to the code screen on a successful response,
  // which is all the caller needs.
  if (fixedCodeAccountFor(phone)) {
    return { sent: true, expiresAt: new Date(Date.now() + OTP_TTL_MS).toISOString() };
  }

  if ((await codesSentRecently(db, phone, scope)) >= MAX_CODES_PER_PHONE_WINDOW) {
    throw new AppError(
      "E-OTP-THROTTLED",
      "Too many codes have been sent to this number. Try again in a few minutes.",
      429,
    );
  }

  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
  const expiresAt = new Date(Date.now() + OTP_TTL_MS).toISOString();
  // Supersede any code still outstanding for this number. Leaving them live
  // multiplied the attacker's surface: every unconsumed challenge was another
  // 20-bit target, and only the newest was ever checked.
  await run(
    db,
    `UPDATE otp_challenges SET consumed_at = ?
     WHERE campaign_id = ? AND phone = ? AND consumed_at IS NULL`,
    [isoNow(), scope, phone],
  );
  await run(
    db,
    `INSERT INTO otp_challenges (id, campaign_id, phone, code_hash, expires_at, verified, attempts, created_at)
     VALUES (?, ?, ?, ?, ?, 0, 0, ?)`,
    [otpId(), scope, phone, hashCode(scope, phone, code), expiresAt, isoNow()]
  );
  const result: SmsResult = await sendSms(phone, input.message(code));
  // Surface the code outside production so local/demo/tests can complete the
  // flow without a live SMS — but only when nothing was actually sent. With the
  // "Live SMS" switch on, a real text goes out and echoing the code back would
  // hand it to any caller, defeating the point of testing the real path.
  const usedMockProvider = result.provider === "mock";
  return {
    sent: result.success,
    expiresAt,
    devCode: devToolsEnabled() && usedMockProvider ? code : undefined
  };
}

/**
 * Verifies a code within one scope and returns the now-proven phone. The
 * challenge is consumed so a code cannot be replayed.
 */
async function verifyOtp(input: {
  phone: string;
  code: string;
  scope: string;
}): Promise<{ phone: string }> {
  const db = await getDb();
  const { scope } = input;
  const phone = requireValidPhone(input.phone);

  // A fixed code is accepted without a stored challenge and is never consumed —
  // Play re-reviews on every update, so it must not expire. Nothing here limits
  // guesses; the per-number limiter on the verify route is what bounds a brute
  // force against a code that never rotates itself.
  const fixed = fixedCodeAccountFor(phone);
  if (fixed) {
    if (!codeMatches(fixed.code, input.code)) {
      throw new AppError("E-OTP-MISMATCH", "Incorrect verification code", 400);
    }
    return { phone };
  }

  const rows = await all(
    db,
    `SELECT * FROM otp_challenges
     WHERE campaign_id = ? AND phone = ? AND consumed_at IS NULL
     ORDER BY created_at DESC LIMIT 1`,
    [scope, phone]
  );
  const row = rows[0] as
    | { id: string; code_hash: string; expires_at: string; attempts?: number }
    | undefined;
  if (!row) throw new AppError("E-OTP-404", "No verification code was requested for this number", 404);
  if (new Date(row.expires_at).getTime() < Date.now()) throw new AppError("E-OTP-EXPIRED", "Verification code has expired", 409);

  // Count the guess before checking it, and burn the challenge once the budget
  // is gone. Charging on failure alone would let a crash or a dropped response
  // hand back a free attempt, and consuming the row is what makes the limit
  // real: a spent challenge cannot be retried from a fresh address.
  const attempts = Number(row.attempts ?? 0) + 1;
  if (attempts > MAX_VERIFY_ATTEMPTS) {
    await run(db, "UPDATE otp_challenges SET consumed_at = ? WHERE id = ?", [isoNow(), row.id]);
    throw new AppError(
      "E-OTP-ATTEMPTS",
      "Too many incorrect codes. Request a new one.",
      429,
    );
  }
  await run(db, "UPDATE otp_challenges SET attempts = ? WHERE id = ?", [attempts, row.id]);

  if (!codeMatches(row.code_hash, hashCode(scope, phone, input.code))) {
    if (attempts >= MAX_VERIFY_ATTEMPTS) {
      await run(db, "UPDATE otp_challenges SET consumed_at = ? WHERE id = ?", [isoNow(), row.id]);
    }
    throw new AppError("E-OTP-MISMATCH", "Incorrect verification code", 400);
  }
  await run(db, "UPDATE otp_challenges SET verified = 1, consumed_at = ? WHERE id = ?", [isoNow(), row.id]);
  return { phone };
}

/** Generates a 6-digit sign-in code, stores its hash, and sends it via SMS. */
export function requestSignInOtp(input: { phone: string }) {
  return requestOtp({
    phone: input.phone,
    scope: SIGNIN_SCOPE,
    message: (code) => `[Voucher Hunt] Your sign-in code is ${code}. It expires in 5 minutes.`,
  });
}

/** Verifies a sign-in code and returns the now-proven phone. */
export function verifySignInOtp(input: { phone: string; code: string }) {
  return verifyOtp({ ...input, scope: SIGNIN_SCOPE });
}

/**
 * Sends the code that authorises deleting an account.
 *
 * The message spells out what the code does. An OTP whose text does not say
 * what it authorises is the whole mechanism behind a "read me the code" scam,
 * and this one destroys a balance rather than opening a session. It stays
 * inside one SMS segment.
 *
 * A fixed-code account (the Play reviewer, the dev numbers) can delete itself
 * with its fixed code, exactly as it can sign in with it. That is deliberate:
 * a reviewer asked to check the deletion path has to be able to walk it, and
 * the account rebuilds itself on the next sign-in.
 */
export function requestAccountDeletionOtp(input: { phone: string }) {
  return requestOtp({
    phone: input.phone,
    scope: DELETION_SCOPE,
    message: (code) =>
      `[Voucher Hunt] Code ${code} DELETES your account. Expires in 5 minutes. Deletion is permanent and unspent Loyalty Points are lost.`,
  });
}

/** Verifies a deletion code and returns the now-proven phone. */
export function verifyAccountDeletionOtp(input: { phone: string; code: string }) {
  return verifyOtp({ ...input, scope: DELETION_SCOPE });
}
