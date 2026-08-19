// Operator-flippable runtime settings, stored in the `meta` key/value table so
// they survive a restart without a deploy or an env change.

import { getDb, one, run } from "@/server/db";

const LIVE_SMS_KEY = "dev_live_sms";

/**
 * Whether a non-production server may send real SMS.
 *
 * Development defaults to the mock provider: it prints the code and returns it
 * to the client, so the sign-in flow completes without spending aggregator
 * credit or texting a real handset. Turning this on makes a dev server use the
 * configured SMS_PROVIDER for real, which is the only way to exercise delivery
 * end to end from a machine whose IP the SMSC whitelists.
 *
 * Production ignores this entirely — see resolveSmsProvider() in
 * src/server/sms.ts. It always uses SMS_PROVIDER.
 */
export async function isDevLiveSmsEnabled(): Promise<boolean> {
  const db = await getDb();
  const row = await one(db, "SELECT value FROM meta WHERE key = ?", [LIVE_SMS_KEY]);
  return row?.value === "true";
}

export async function setDevLiveSmsEnabled(enabled: boolean): Promise<void> {
  const db = await getDb();
  await run(db, "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [
    LIVE_SMS_KEY,
    enabled ? "true" : "false",
  ]);
}
