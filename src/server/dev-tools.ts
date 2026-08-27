import { AppError } from "@/server/errors";
import { normalizePhone } from "@/server/phone";

/**
 * The deployment-wide gate for every tool that mints value, forces an outcome, or
 * bypasses a real rule: LP grants, forced roulette pools, hunt resets, statement
 * backdating, the bootstrap login fallback, and the OTP code echo.
 *
 * Some of those are additionally reachable by a named developer account in
 * production — see `devToolsEnabledFor`. This function answers only the
 * deployment half of the question.
 *
 * Fails closed. The previous gate was `process.env.NODE_ENV !== "production"`,
 * which is only safe when NODE_ENV is guaranteed to be exactly "production" in
 * every deployment target. It is not: a preview deploy, a standalone `next
 * start` with the variable unset, or a host that sets "staging" all read as
 * not-production and would have opened free LP, a predictable draw, and a
 * published-password super-admin login to the internet.
 *
 * So the rule is inverted — a recognised development environment, or an explicit
 * opt-in, and never in production regardless of either:
 *
 *   NODE_ENV=development | test        enabled (local work and the test suite)
 *   ENABLE_DEV_TOOLS=true              enabled, for a shared demo/staging box
 *   NODE_ENV=production                disabled, even with ENABLE_DEV_TOOLS=true
 *   anything else (unset, preview, …)  disabled
 */
export function devToolsEnabled() {
  if (process.env.NODE_ENV === "production") return false;
  if (process.env.ENABLE_DEV_TOOLS === "true") return true;
  return process.env.NODE_ENV === "development" || process.env.NODE_ENV === "test";
}

/**
 * Guard for a route or server function that must never run in production at all,
 * whoever is asking. Use `assertDevToolsEnabledFor` for the self-scoped tools a
 * developer account carries into production.
 */
export function assertDevToolsEnabled(what: string) {
  if (devToolsEnabled()) return;
  throw new AppError("E-DEV-ONLY", `${what} is a development-only tool`, 403);
}

/**
 * The environment variable pairs that name a production developer account.
 *
 * One slot was not enough once a second person needed to exercise a hunt against
 * the live database, so the slots are numbered. Each is independent and inert
 * until set; the phone half and the OTP half of a slot are also independent of
 * each other (see `@/server/otp`), which is why they are named together here but
 * read apart.
 *
 * Adding a third is one more entry in this list plus the matching block in
 * `.env.example` — no other code knows the names.
 */
export const DEV_ACCOUNT_ENV_PAIRS = [
  { phone: "DEV_ACCOUNT_PHONE", otp: "DEV_ACCOUNT_OTP" },
  { phone: "DEV_ACCOUNT_PHONE_2", otp: "DEV_ACCOUNT_OTP_2" },
] as const;

/**
 * The production developer accounts.
 *
 * `devToolsEnabled()` above is all-or-nothing per deployment and never opens in
 * production, which leaves no way to exercise a hunt against the live database.
 * The DEV_ACCOUNT_PHONE slots name customer numbers that carry the hunt tools
 * with them into production:
 *
 *   POST /api/public/hunt/reset                clears its own hunt, returns stock
 *   POST /api/public/hunt/dev-refresh-vouchers re-dates its own bookings
 *   devPoolId on /api/public/hunt/attempt      forces its own next draw
 *   POST /api/public/rewards/dev-credit        funds its own global LP pot
 *   POST /api/public/rewards/dev-business-credit funds its own partner bucket
 *
 * Every one of those is scoped to the caller's own phone. The two LP grants mint
 * spendable balance, so they are the weightiest thing on the list, but they bill
 * nobody: the ledger entry is a `dev_grant` against this wallet and no partner
 * statement moves. Testing the shop against live data needs them — the global pot
 * and a partner bucket buy different things, and a 5% earn rate cannot reach a
 * 1,200 LP item without a fictional ₱24,000 sale.
 *
 * Deliberately still NOT included are the tools that put a real partner on the
 * hook — the simulated checkout scan and the simulated collection — because those
 * write rows a partner is billed for. They stay on `devToolsEnabled()` and refuse
 * in production for everyone, these accounts included.
 *
 * A slot is inert unless its var is set to a valid PH mobile number, and it
 * grants no admin/dashboard rights: these are ordinary customer accounts with the
 * hunt tools switched on. Unset a var to revoke it — they are read per request,
 * so no redeploy is needed.
 */
function devAccountPhones(): string[] {
  const phones: string[] = [];
  for (const pair of DEV_ACCOUNT_ENV_PAIRS) {
    const configured = process.env[pair.phone]?.trim();
    const normalized = configured ? normalizePhone(configured) : null;
    if (normalized) phones.push(normalized);
  }
  return phones;
}

/**
 * True when `phone` is one of the configured developer accounts.
 * Format-insensitive.
 *
 * Exported because this, and not `devToolsEnabledFor`, is the answer both
 * clients render their dev panel from. The two differ on a development
 * deployment, where `devToolsEnabled()` opens the tools for every account that
 * signs in: the panel is meant for whoever is doing the testing, not for the
 * ordinary test accounts signed in beside them, so visibility follows the
 * account and enforcement keeps the wider deployment gate.
 */
export function isDevAccountPhone(phone: string | null | undefined): boolean {
  if (!phone) return false;
  const normalized = normalizePhone(phone);
  if (!normalized) return false;
  return devAccountPhones().includes(normalized);
}

/**
 * The self-scoped-tool gate: open where the whole deployment is a dev
 * environment, or for a configured developer account anywhere — including
 * production. Callers must pass the phone the tool will act on, so what it opens
 * is always that account's own rows.
 */
export function devToolsEnabledFor(phone: string | null | undefined): boolean {
  return devToolsEnabled() || isDevAccountPhone(phone);
}

/**
 * Whether anyone at all could pass `devToolsEnabledFor` on this deployment.
 *
 * Resolving a session costs a database read, and on a production deploy with no
 * developer account configured the answer is always no — so callers on a hot
 * path (the roulette's pool list, drawn on every spin) check this first and skip
 * looking up who is asking.
 */
export function devToolsPossible(): boolean {
  return devToolsEnabled() || devAccountPhones().length > 0;
}

/** Guard for a self-scoped tool the developer account may run in production. */
export function assertDevToolsEnabledFor(phone: string | null | undefined, what: string) {
  if (devToolsEnabledFor(phone)) return;
  throw new AppError("E-DEV-ONLY", `${what} is a development-only tool`, 403);
}
