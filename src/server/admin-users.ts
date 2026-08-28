import crypto from "node:crypto";
import {
  isPasswordTooShort,
  MIN_PASSWORD_LENGTH,
  PASSWORD_RULE,
} from "@/lib/admin-password";
import { all, getDb, one, run } from "@/server/db";
import { AppError } from "@/server/errors";

const id = () => `au_${crypto.randomBytes(6).toString("hex")}`;

const PREFIX = "scrypt";
const KEY_LENGTH = 32;

export type AdminUserRole = "super_admin" | "admin" | "staff";

/** What the console is allowed to see. The password hash never leaves here. */
export type AdminUser = {
  id: string;
  email: string;
  name: string;
  role: AdminUserRole;
  businessIds: string[];
  status: "active" | "disabled";
  createdAt: string;
  lastLoginAt?: string;
};

// Re-exported so the API routes keep one import for everything about an account.
export { MIN_PASSWORD_LENGTH };

/**
 * Same construction as the business staff PIN: scrypt with a per-credential
 * salt, stored as one string. Passwords are never recoverable, only comparable.
 */
export function hashPassword(password: string) {
  const salt = crypto.randomBytes(16);
  const digest = crypto.scryptSync(password, salt, KEY_LENGTH);
  return `${PREFIX}$${salt.toString("base64url")}$${digest.toString("base64url")}`;
}

/**
 * Constant-time comparison against a stored hash.
 *
 * A malformed or unknown-format hash returns false rather than throwing, so a
 * corrupted row fails the login instead of 500-ing the endpoint.
 */
export function verifyPassword(password: string, stored: string) {
  const [prefix, salt, digest] = stored.split("$");
  if (prefix !== PREFIX || !salt || !digest) return false;
  try {
    const expected = Buffer.from(digest, "base64url");
    const actual = crypto.scryptSync(
      password,
      Buffer.from(salt, "base64url"),
      expected.length,
    );
    return crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

// libSQL rows come back keyed by column name.
type Row = Record<string, any>;

function mapAdminUser(row: Row): AdminUser {
  return {
    id: row.id as string,
    email: row.email as string,
    name: row.name as string,
    role: row.role as AdminUserRole,
    businessIds: String(row.business_ids ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
    status: row.status === "disabled" ? "disabled" : "active",
    createdAt: row.created_at as string,
    lastLoginAt: (row.last_login_at as string | null) ?? undefined,
  };
}

function normaliseEmail(email: string) {
  return email.trim().toLowerCase();
}

/**
 * Business scope, validated against the role.
 *
 * Staff must resolve to exactly one business: `verifyAdminSession` rejects a
 * staff session that is unscoped or wildcarded, so a staff account saved any
 * other way would be created successfully and then be unable to log in.
 */
function resolveBusinessIds(role: AdminUserRole, businessIds: string[]) {
  const cleaned = businessIds.map((value) => value.trim()).filter(Boolean);
  if (role === "staff") {
    if (cleaned.length !== 1 || cleaned[0] === "*") {
      throw new AppError(
        "E-ADMIN-USER-SCOPE",
        "A staff account must be assigned to exactly one business",
        422,
      );
    }
    return cleaned;
  }
  // Admins default to every business; an explicit list narrows them.
  if (cleaned.length === 0 || cleaned.includes("*")) return ["*"];
  return cleaned;
}

function assertPassword(password: string) {
  if (isPasswordTooShort(password)) {
    throw new AppError("E-ADMIN-USER-PASSWORD", PASSWORD_RULE, 422);
  }
}

export async function listAdminUsers(): Promise<AdminUser[]> {
  const db = await getDb();
  const rows = await all(
    db,
    // LOWER(name) rather than a collation: SQLite spells case-insensitive
    // ordering as COLLATE NOCASE, Postgres has no such collation, and the only
    // thing this needs is that "alice" and "Alice" sort together.
    "SELECT * FROM admin_users ORDER BY role, LOWER(name)",
  );
  return rows.map(mapAdminUser);
}

export async function getAdminUser(userId: string): Promise<AdminUser> {
  const db = await getDb();
  const row = await one(db, "SELECT * FROM admin_users WHERE id = ?", [userId]);
  if (!row) throw new AppError("E-ADMIN-USER-404", "User not found", 404);
  return mapAdminUser(row);
}

/** Login path only — this is the one place the stored hash is read out. */
export async function findAdminUserForLogin(email: string) {
  const db = await getDb();
  const row = await one(db, "SELECT * FROM admin_users WHERE email = ?", [
    normaliseEmail(email),
  ]);
  if (!row) return null;
  return { ...mapAdminUser(row), passwordHash: row.password_hash as string };
}

export async function countAdminUsers() {
  const db = await getDb();
  const row = await one(db, "SELECT COUNT(*) AS total FROM admin_users");
  return Number(row?.total ?? 0);
}

export async function recordAdminLogin(userId: string) {
  const db = await getDb();
  await run(db, "UPDATE admin_users SET last_login_at = ? WHERE id = ?", [
    new Date().toISOString(),
    userId,
  ]);
}

export async function createAdminUser(input: {
  email: string;
  name: string;
  role: AdminUserRole;
  password: string;
  businessIds: string[];
}): Promise<AdminUser> {
  const db = await getDb();
  const email = normaliseEmail(input.email);
  const name = input.name.trim();
  if (!name) {
    throw new AppError("E-ADMIN-USER-NAME", "Name is required", 422);
  }
  assertPassword(input.password);
  const businessIds = resolveBusinessIds(input.role, input.businessIds);

  const existing = await one(db, "SELECT id FROM admin_users WHERE email = ?", [
    email,
  ]);
  if (existing) {
    throw new AppError(
      "E-ADMIN-USER-DUPLICATE",
      "An account with that email already exists",
      409,
    );
  }

  const user: AdminUser = {
    id: id(),
    email,
    name,
    role: input.role,
    businessIds,
    status: "active",
    createdAt: new Date().toISOString(),
  };
  await run(
    db,
    `INSERT INTO admin_users (id, email, name, role, password_hash, business_ids, status, created_at)
     VALUES (@id, @email, @name, @role, @passwordHash, @businessIds, @status, @createdAt)`,
    {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      passwordHash: hashPassword(input.password),
      businessIds: user.businessIds.join(","),
      status: user.status,
      createdAt: user.createdAt,
    },
  );
  return user;
}

/**
 * Partial update. Every field is optional; an omitted field is left alone, so
 * saving the details form never silently resets a password.
 */
export async function updateAdminUser(
  userId: string,
  input: {
    name?: string;
    role?: AdminUserRole;
    businessIds?: string[];
    status?: "active" | "disabled";
    password?: string;
  },
  actor: { email: string },
): Promise<AdminUser> {
  const db = await getDb();
  const current = await getAdminUser(userId);

  const nextRole = input.role ?? current.role;
  const nextStatus = input.status ?? current.status;

  // Losing the last active super-admin locks everyone out of user management
  // permanently — there is no recovery path short of editing the database.
  if (
    current.role === "super_admin" &&
    current.status === "active" &&
    (nextRole !== "super_admin" || nextStatus !== "active")
  ) {
    await assertNotLastSuperAdmin(userId);
  }
  // Same trap, one step smaller: demoting or disabling yourself takes away the
  // page you are standing on.
  if (
    current.email === normaliseEmail(actor.email) &&
    (nextRole !== current.role || nextStatus !== current.status)
  ) {
    throw new AppError(
      "E-ADMIN-USER-SELF",
      "You cannot change your own role or status",
      422,
    );
  }

  const assignments: string[] = [];
  const args: Record<string, string> = { id: userId };

  if (input.name !== undefined) {
    const name = input.name.trim();
    if (!name) throw new AppError("E-ADMIN-USER-NAME", "Name is required", 422);
    assignments.push("name = @name");
    args.name = name;
  }
  // Role and scope are validated together: the rules for a valid scope depend
  // on the role being saved, not the one already stored.
  if (input.role !== undefined || input.businessIds !== undefined) {
    assignments.push("role = @role", "business_ids = @businessIds");
    args.role = nextRole;
    args.businessIds = resolveBusinessIds(
      nextRole,
      input.businessIds ?? current.businessIds,
    ).join(",");
  }
  if (input.status !== undefined) {
    assignments.push("status = @status");
    args.status = nextStatus;
  }
  if (input.password !== undefined) {
    assertPassword(input.password);
    assignments.push("password_hash = @passwordHash");
    args.passwordHash = hashPassword(input.password);
  }

  if (assignments.length > 0) {
    await run(
      db,
      `UPDATE admin_users SET ${assignments.join(", ")} WHERE id = @id`,
      args,
    );
  }
  return getAdminUser(userId);
}

export async function deleteAdminUser(
  userId: string,
  actor: { email: string },
) {
  const db = await getDb();
  const user = await getAdminUser(userId);
  if (user.email === normaliseEmail(actor.email)) {
    throw new AppError(
      "E-ADMIN-USER-SELF",
      "You cannot delete your own account",
      422,
    );
  }
  if (user.role === "super_admin") await assertNotLastSuperAdmin(userId);
  await run(db, "DELETE FROM admin_users WHERE id = ?", [userId]);
}

async function assertNotLastSuperAdmin(userId: string) {
  const db = await getDb();
  const row = await one(
    db,
    "SELECT COUNT(*) AS total FROM admin_users WHERE role = 'super_admin' AND status = 'active' AND id <> ?",
    [userId],
  );
  if (Number(row?.total ?? 0) === 0) {
    throw new AppError(
      "E-ADMIN-USER-LAST-SUPER",
      "This is the last active super admin. Promote another account first.",
      422,
    );
  }
}
