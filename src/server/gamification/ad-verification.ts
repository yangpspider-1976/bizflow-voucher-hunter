/**
 * AdMob Server-Side Verification.
 *
 * The requirements are unambiguous: an ad reward is earned by a signed callback
 * from Google, not by the app saying it watched something. So the client's only
 * role here is to carry a nonce we issued; everything that decides whether LP
 * moves is checked on this side — the ECDSA signature over the callback's own
 * query string, the freshness of the timestamp, and the uniqueness of AdMob's
 * transaction id.
 *
 * Three independent things have to fail before an ad can be farmed: the
 * signature (needs Google's private key), the nonce (needs a session of ours,
 * and expires in minutes), and the transaction id (unique index, so a replayed
 * callback pays nothing). The daily mission windows cap the value of doing it
 * anyway at three rewards a day.
 */
import crypto from "node:crypto";
import { one, run, type Exec } from "@/server/db";
import { AppError } from "@/server/errors";
import { manilaDate } from "./time";

const isoNow = () => new Date().toISOString();
const id = (prefix: string) => `${prefix}_${crypto.randomBytes(8).toString("hex")}`;

/** Where Google publishes the public halves of its SSV signing keys. */
const VERIFIER_KEYS_URL = "https://gstatic.com/admob/reward/verifier-keys.json";

/** How long an issued nonce is good for. Long enough to watch an ad, no more. */
const NONCE_TTL_MS = 15 * 60_000;

/**
 * How far out of date a callback's own timestamp may be.
 *
 * Google's timestamp is in milliseconds and generated at reward time. A wide
 * window would let a captured callback be replayed later; too narrow a one
 * would drop legitimate callbacks during a retry. Fifteen minutes matches the
 * nonce, so the two expire together.
 */
const TIMESTAMP_TOLERANCE_MS = 15 * 60_000;

/* Nonces -------------------------------------------------------------------- */

function nonceSecret() {
  const secret = process.env.ADMOB_SSV_NONCE_SECRET?.trim() || process.env.ADMIN_SESSION_SECRET?.trim();
  if (!secret || secret.length < 32) {
    throw new AppError(
      "E-ADMOB-UNCONFIGURED",
      "Set ADMOB_SSV_NONCE_SECRET to at least 32 random characters",
      503,
    );
  }
  return secret;
}

/**
 * Mints the `custom_data` the app hands to AdMob.
 *
 * Signed rather than stored: the wallet id and an expiry, with an HMAC over
 * both. That keeps the ad flow stateless — no row to write when a player starts
 * an ad and no row to clean up when they abandon one — while still being
 * unforgeable and short-lived. The wallet id is an internal identifier, never a
 * phone number, so nothing personal travels through Google's callback.
 */
export function issueAdNonce(walletId: string) {
  const expiresAt = Date.now() + NONCE_TTL_MS;
  const payload = `${walletId}.${expiresAt}`;
  const signature = crypto
    .createHmac("sha256", nonceSecret())
    .update(payload)
    .digest("base64url");
  return `${payload}.${signature}`;
}

export function resolveAdNonce(nonce: string): string {
  const parts = nonce.split(".");
  if (parts.length !== 3) {
    throw new AppError("E-ADMOB-NONCE", "Ad verification data is malformed", 400);
  }
  const [walletId, expiresAt, signature] = parts as [string, string, string];
  const expected = crypto
    .createHmac("sha256", nonceSecret())
    .update(`${walletId}.${expiresAt}`)
    .digest("base64url");
  // Constant time: a byte-by-byte compare here would leak the signature one
  // character at a time to anyone willing to make enough requests.
  if (
    expected.length !== signature.length ||
    !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature))
  ) {
    throw new AppError("E-ADMOB-NONCE", "Ad verification data failed its check", 401);
  }
  if (Number(expiresAt) < Date.now()) {
    throw new AppError("E-ADMOB-NONCE", "Ad verification data has expired", 401);
  }
  return walletId;
}

/* Signature verification ----------------------------------------------------- */

type VerifierKey = { keyId: number; pem: string };
let keyCache: { fetchedAt: number; keys: Map<string, VerifierKey> } | null = null;
const KEY_CACHE_TTL_MS = 6 * 60 * 60_000;

/**
 * Google's public verifier keys, cached.
 *
 * Refetched every few hours rather than per callback: the key set rotates
 * rarely, and a network hop on every ad reward would put Google's availability
 * in the path of a mission completing. An unknown `key_id` forces a refetch
 * once, which is what makes a rotation self-healing.
 */
async function verifierKeys(forceRefresh = false): Promise<Map<string, VerifierKey>> {
  if (!forceRefresh && keyCache && Date.now() - keyCache.fetchedAt < KEY_CACHE_TTL_MS) {
    return keyCache.keys;
  }
  const response = await fetch(VERIFIER_KEYS_URL, { cache: "no-store" });
  if (!response.ok) {
    throw new AppError("E-ADMOB-KEYS", "Could not fetch AdMob verifier keys", 503);
  }
  const body = (await response.json()) as {
    keys: Array<{ keyId: number; base64: string; pem?: string }>;
  };
  const keys = new Map<string, VerifierKey>();
  for (const key of body.keys ?? []) {
    keys.set(String(key.keyId), {
      keyId: key.keyId,
      pem: key.pem ?? derToPem(key.base64),
    });
  }
  keyCache = { fetchedAt: Date.now(), keys };
  return keys;
}

function derToPem(base64Der: string) {
  const wrapped = base64Der.replace(/(.{64})/g, "$1\n").trimEnd();
  return `-----BEGIN PUBLIC KEY-----\n${wrapped}\n-----END PUBLIC KEY-----\n`;
}

export type SsvCallback = {
  adNetwork?: string;
  adUnit?: string;
  customData?: string;
  keyId?: string;
  rewardAmount?: string;
  rewardItem?: string;
  signature?: string;
  timestamp?: string;
  transactionId?: string;
  userId?: string;
};

/**
 * Checks the signature over the callback URL.
 *
 * Google signs the query string from the first parameter up to — but not
 * including — `&signature=`, so the raw URL is what has to be verified, not a
 * re-serialisation of parsed parameters. Re-encoding would reorder or re-escape
 * something and every signature would fail; this is the one place where the
 * literal bytes matter more than the parsed values.
 */
export async function verifySsvSignature(rawUrl: string): Promise<SsvCallback> {
  const url = new URL(rawUrl);
  const query = url.search.startsWith("?") ? url.search.slice(1) : url.search;
  const signatureAt = query.indexOf("signature=");
  if (signatureAt <= 0) {
    throw new AppError("E-ADMOB-SIGNATURE", "Callback carries no signature", 400);
  }
  // Everything before "&signature=" is what was signed.
  const signedContent = query.slice(0, signatureAt - 1);
  const params = url.searchParams;
  const signature = params.get("signature") ?? "";
  const keyId = params.get("key_id") ?? "";

  let keys = await verifierKeys();
  let key = keys.get(keyId);
  if (!key) {
    // An unrecognised key id usually means a rotation, so try once with a fresh
    // fetch before calling it a forgery.
    keys = await verifierKeys(true);
    key = keys.get(keyId);
  }
  if (!key) {
    throw new AppError("E-ADMOB-SIGNATURE", "Unknown AdMob signing key", 401);
  }

  const valid = crypto.verify(
    "sha256",
    Buffer.from(signedContent, "utf8"),
    { key: key.pem, dsaEncoding: "der" },
    Buffer.from(signature, "base64url"),
  );
  if (!valid) {
    throw new AppError("E-ADMOB-SIGNATURE", "Ad callback signature is invalid", 401);
  }

  const timestamp = Number(params.get("timestamp") ?? 0);
  if (!timestamp || Math.abs(Date.now() - timestamp) > TIMESTAMP_TOLERANCE_MS) {
    throw new AppError("E-ADMOB-STALE", "Ad callback is outside its validity window", 401);
  }

  return {
    adNetwork: params.get("ad_network") ?? undefined,
    adUnit: params.get("ad_unit") ?? undefined,
    customData: params.get("custom_data") ?? undefined,
    keyId,
    rewardAmount: params.get("reward_amount") ?? undefined,
    rewardItem: params.get("reward_item") ?? undefined,
    signature,
    timestamp: String(timestamp),
    transactionId: params.get("transaction_id") ?? undefined,
    userId: params.get("user_id") ?? undefined,
  };
}

/**
 * Records one verified ad view, once.
 *
 * The unique index on `ad_transaction_id` is the replay guard, and the insert's
 * own result — not a preceding SELECT — is what decides whether this callback
 * is the first. Two deliveries arriving together both reach the insert and
 * exactly one of them wins.
 */
export async function recordAdVerification(
  tx: Exec,
  input: {
    walletId: string;
    transactionId: string;
    adUnit?: string;
    adNetwork?: string;
    nonce?: string;
    rewardAmount?: number;
    rewardItem?: string;
    keyId?: string;
  },
) {
  const now = isoNow();
  const inserted = await run(
    tx,
    `INSERT OR IGNORE INTO ad_verifications
     (id, wallet_id, ad_transaction_id, ad_unit, ad_network, nonce, reward_amount,
      reward_item, signature_key_id, verified_at, manila_date, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id("adv"),
      input.walletId,
      input.transactionId,
      input.adUnit ?? null,
      input.adNetwork ?? null,
      input.nonce ?? null,
      input.rewardAmount ?? null,
      input.rewardItem ?? null,
      input.keyId ?? null,
      now,
      manilaDate(),
      now,
    ],
  );
  return inserted === 1;
}

/** How many verified ad views this player has today, for the abuse dashboard. */
export async function adViewsToday(db: Exec, walletId: string) {
  const row = await one(
    db,
    "SELECT COUNT(*) AS total FROM ad_verifications WHERE wallet_id = ? AND manila_date = ?",
    [walletId, manilaDate()],
  );
  return Number(row?.total ?? 0);
}
