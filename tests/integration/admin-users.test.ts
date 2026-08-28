import { beforeEach, describe, expect, it } from "vitest";
import {
  createAdminUser,
  deleteAdminUser,
  findAdminUserForLogin,
  listAdminUsers,
  updateAdminUser,
  verifyPassword,
} from "@/server/admin-users";
import { getDb, resetDb, run } from "@/server/db";
import { AppError } from "@/server/errors";

// Console accounts are the people who can sign in to /dashboard, as opposed to
// the `users` table, which is the customers who claim vouchers.
describe("admin user accounts", () => {
  beforeEach(async () => {
    await resetDb();
    // resetDb only clears DATA_TABLES, and admin_users is deliberately not in
    // that list — a demo-data reset must not delete real logins. Tests clear it
    // themselves so each one starts from an empty console.
    await run(await getDb(), "DELETE FROM admin_users");
  });

  const owner = {
    email: "Owner@Example.com",
    name: "Owner",
    role: "super_admin" as const,
    password: "correct-horse-battery",
    businessIds: [] as string[],
  };

  it("stores the password as a non-recoverable hash", async () => {
    const created = await createAdminUser(owner);
    const row = await findAdminUserForLogin(created.email);

    expect(row?.passwordHash).not.toContain("correct-horse-battery");
    expect(verifyPassword("correct-horse-battery", row!.passwordHash)).toBe(true);
    expect(verifyPassword("wrong-password-entirely", row!.passwordHash)).toBe(
      false,
    );
  });

  it("normalises the email so login is not case-sensitive", async () => {
    await createAdminUser(owner);
    expect((await findAdminUserForLogin("OWNER@EXAMPLE.COM"))?.name).toBe("Owner");
  });

  it("rejects a duplicate email", async () => {
    await createAdminUser(owner);
    await expect(
      createAdminUser({ ...owner, email: "owner@example.com" }),
    ).rejects.toBeInstanceOf(AppError);
  });

  it("rejects a password under the minimum length", async () => {
    await expect(
      createAdminUser({ ...owner, password: "short" }),
    ).rejects.toBeInstanceOf(AppError);
  });

  // The length used to be counted raw, so spaces made a long-enough password.
  it("rejects a password padded out to the minimum with spaces", async () => {
    await expect(
      createAdminUser({ ...owner, password: "              " }),
    ).rejects.toBeInstanceOf(AppError);
    await expect(
      createAdminUser({ ...owner, password: "   pass   " }),
    ).rejects.toBeInstanceOf(AppError);

    const created = await createAdminUser(owner);
    await expect(
      updateAdminUser(
        created.id,
        { password: "          " },
        { email: "someone-else@example.com" },
      ),
    ).rejects.toBeInstanceOf(AppError);
  });

  // Spaces inside a passphrase are ordinary characters, and the stored password
  // is the one that was typed — not a trimmed copy of it.
  it("keeps a passphrase with spaces exactly as it was typed", async () => {
    const created = await createAdminUser({
      ...owner,
      password: " correct horse battery ",
    });
    const row = await findAdminUserForLogin(created.email);

    expect(verifyPassword(" correct horse battery ", row!.passwordHash)).toBe(
      true,
    );
    expect(verifyPassword("correct horse battery", row!.passwordHash)).toBe(
      false,
    );
  });

  it("gives an admin the wildcard scope and pins staff to one business", async () => {
    const admin = await createAdminUser({ ...owner, role: "admin" });
    expect(admin.businessIds).toEqual(["*"]);

    const staff = await createAdminUser({
      email: "staff@example.com",
      name: "Counter Staff",
      role: "staff",
      password: "counter-staff-password",
      businessIds: ["biz_demo_restaurant"],
    });
    expect(staff.businessIds).toEqual(["biz_demo_restaurant"]);
  });

  // A staff session with no business, or a wildcard one, is rejected by
  // verifyAdminSession — so an account saved that way could never log in.
  it("refuses a staff account that is not scoped to exactly one business", async () => {
    const base = {
      email: "staff@example.com",
      name: "Counter Staff",
      role: "staff" as const,
      password: "counter-staff-password",
    };
    await expect(
      createAdminUser({ ...base, businessIds: [] }),
    ).rejects.toBeInstanceOf(AppError);
    await expect(
      createAdminUser({ ...base, businessIds: ["*"] }),
    ).rejects.toBeInstanceOf(AppError);
    await expect(
      createAdminUser({ ...base, businessIds: ["biz_a", "biz_b"] }),
    ).rejects.toBeInstanceOf(AppError);
  });

  it("leaves the password alone when the patch omits it", async () => {
    const created = await createAdminUser(owner);
    const actor = { email: "someone.else@example.com" };
    await updateAdminUser(created.id, { name: "Owner Renamed" }, actor);

    const row = await findAdminUserForLogin(created.email);
    expect(row?.name).toBe("Owner Renamed");
    expect(verifyPassword("correct-horse-battery", row!.passwordHash)).toBe(true);
  });

  it("replaces the password when the patch supplies one", async () => {
    const created = await createAdminUser(owner);
    await updateAdminUser(
      created.id,
      { password: "a-brand-new-password" },
      { email: "someone.else@example.com" },
    );

    const row = await findAdminUserForLogin(created.email);
    expect(verifyPassword("a-brand-new-password", row!.passwordHash)).toBe(true);
    expect(verifyPassword("correct-horse-battery", row!.passwordHash)).toBe(false);
  });

  // Both of these are one-way doors: there is no recovery short of editing the
  // database by hand, so they are refused rather than warned about.
  it("refuses to demote, disable, or delete the last active super admin", async () => {
    const created = await createAdminUser(owner);
    const actor = { email: "someone.else@example.com" };

    await expect(
      updateAdminUser(created.id, { role: "admin" }, actor),
    ).rejects.toBeInstanceOf(AppError);
    await expect(
      updateAdminUser(created.id, { status: "disabled" }, actor),
    ).rejects.toBeInstanceOf(AppError);
    await expect(deleteAdminUser(created.id, actor)).rejects.toBeInstanceOf(
      AppError,
    );

    // With a second super admin in place, the same edits are allowed.
    await createAdminUser({
      ...owner,
      email: "second@example.com",
      name: "Second Owner",
    });
    await expect(
      updateAdminUser(created.id, { role: "admin" }, actor),
    ).resolves.toMatchObject({ role: "admin" });
  });

  it("refuses to let you change or delete your own account", async () => {
    const created = await createAdminUser(owner);
    await createAdminUser({
      ...owner,
      email: "second@example.com",
      name: "Second Owner",
    });
    const self = { email: "owner@example.com" };

    await expect(
      updateAdminUser(created.id, { role: "admin" }, self),
    ).rejects.toBeInstanceOf(AppError);
    await expect(deleteAdminUser(created.id, self)).rejects.toBeInstanceOf(
      AppError,
    );
    // Renaming yourself is not a lock-out, so it stays allowed.
    await expect(
      updateAdminUser(created.id, { name: "Owner Renamed" }, self),
    ).resolves.toMatchObject({ name: "Owner Renamed" });
  });

  it("survives a demo-data reset, unlike the seeded tables", async () => {
    await createAdminUser(owner);
    await resetDb();
    expect((await listAdminUsers()).map((user) => user.email)).toEqual([
      "owner@example.com",
    ]);
  });
});
