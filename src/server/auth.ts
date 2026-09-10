import { timingSafeEqual } from "node:crypto";
import { findAdminUserForLogin } from "@/server/admin-users";
import { AppError } from "@/server/errors";
import type { Campaign } from "@/types/voucher";
import {
  sessionTokenFromRequest,
  verifyAdminSession,
} from "@/lib/admin-session";

function safeEqual(left: string, right: string) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Re-checks a signed session against the account it names.
 *
 * The session token is self-contained and valid for eight hours, so on its own
 * a disabled, deleted, demoted or re-scoped account kept every right it held at
 * login for the rest of that window — including a staff member scoped to a
 * business they no longer work at. The role and scope are re-read from the row
 * on each request so revocation takes effect immediately.
 *
 * An email with no `admin_users` row is the env bootstrap login, which has no
 * row to check and is left as the signed session claims.
 */
async function withLiveAccountState(session: NonNullable<Awaited<ReturnType<typeof verifyAdminSession>>>) {
  const account = await findAdminUserForLogin(session.email);
  if (!account) return session;
  if (account.status !== "active") {
    throw new AppError("E-ADMIN-DISABLED", "This account is no longer active", 401);
  }
  return {
    ...session,
    role: account.role,
    businessIds: account.businessIds,
  };
}

/** Guards admin endpoints using the signed login cookie or a server-only token. */
export async function requireAdmin(request: Request) {
  const session = await verifyAdminSession(sessionTokenFromRequest(request));
  if (session) return withLiveAccountState(session);

  // Optional server-only token support for trusted scripts and integrations.
  const expected = process.env.ADMIN_ACCESS_TOKEN;
  const bearer = request.headers.get("authorization");
  const headerToken = request.headers.get("x-admin-token");
  const provided = bearer?.toLowerCase().startsWith("bearer ") ? bearer.slice(7).trim() : headerToken?.trim();
  // Constant-time: this single value grants super_admin over every business, so
  // a `!==` here leaks its prefix one byte at a time to a patient caller.
  if (!expected || !provided || !safeEqual(provided, expected)) {
    throw new AppError("E-ADMIN-UNAUTHORIZED", "Admin authorization is required", 401);
  }
  return { email: "integration", name: "API Admin", role: "super_admin" as const, businessIds: ["*"], exp: 0 };
}

/**
 * Whether this session may act on `businessId`.
 *
 * Split out of `assertBusinessAccess` so that anything *offering* a business —
 * a checkout's "Redeeming at" list, say — can filter by exactly the rule that
 * will judge the request. When the two were written separately they diverged:
 * `/api/businesses` narrowed only `staff`, so a scoped `admin` was offered
 * every partner in the network and got a 403 on the ones outside its own scope.
 */
export function canAccessBusiness(
  session: Pick<Awaited<ReturnType<typeof requireAdmin>>, "role" | "businessIds">,
  businessId: string,
) {
  return (
    session.role === "super_admin" ||
    (session.role === "admin" && session.businessIds.includes("*")) ||
    session.businessIds.includes(businessId)
  );
}

export function assertBusinessAccess(
  session: Awaited<ReturnType<typeof requireAdmin>>,
  businessId: string,
) {
  if (canAccessBusiness(session, businessId)) return;
  throw new AppError("E-STAFF-BUSINESS-SCOPE", "You are not allowed to access this business", 403);
}

export function assertRewardsAdmin(session: Awaited<ReturnType<typeof requireAdmin>>) {
  if (session.role === "super_admin" || session.role === "admin") return;
  throw new AppError("E-REWARDS-ADMIN-SCOPE", "Rewards review and settlement actions require admin access", 403);
}

export function assertAdminRole(session: Awaited<ReturnType<typeof requireAdmin>>) {
  if (session.role === "super_admin" || session.role === "admin") return;
  throw new AppError("E-ADMIN-ROLE", "This action requires admin access", 403);
}

export function assertSuperAdmin(session: Awaited<ReturnType<typeof requireAdmin>>) {
  if (session.role === "super_admin") return;
  throw new AppError("E-SUPER-ADMIN-ROLE", "This action requires super-admin access", 403);
}

export function filterCampaignsForSession<T extends Pick<Campaign, "businessId">>(session: { role: "super_admin" | "admin" | "staff"; businessIds: string[] }, campaigns: T[]) {
  return session.role === "staff"
    ? campaigns.filter((campaign) => session.businessIds.includes(campaign.businessId))
    : campaigns;
}
