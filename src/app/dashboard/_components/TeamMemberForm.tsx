"use client";

import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  isPasswordTooShort,
  MIN_PASSWORD_LENGTH,
  PASSWORD_RULE,
} from "@/lib/admin-password";
import { api } from "@/lib/api-client";
import type { AdminUser, AdminUserRole } from "@/server/admin-users";
import type { Business } from "@/types/voucher";
import { FormCard } from "./FormPage";
import { SelectMenu } from "./SelectMenu";
import { appendDone } from "./SlotForm";

const LIST_HREF = "/dashboard/team";

const ROLES = [
  { value: "staff", label: "Staff" },
  { value: "admin", label: "Admin" },
  { value: "super_admin", label: "Super admin" },
];

const ROLE_HELP: Record<AdminUserRole, string> = {
  staff:
    "Scans and redeems vouchers for one business. Cannot edit campaigns, businesses, or accounts.",
  admin:
    "Runs campaigns, businesses, and Loyalty Points across every business. Cannot manage console accounts.",
  super_admin:
    "Everything an admin can do, plus Settings and this page. Only a super admin can create accounts.",
};

const STATUSES = [
  { value: "active", label: "Active" },
  { value: "disabled", label: "Disabled" },
];

/**
 * Create or edit a console account.
 *
 * One form for both, with two differences that matter. The email is set once
 * and never edited — it is the login identity, and changing it silently moves
 * someone else's account. And the password is required when creating but
 * optional when editing, where a blank field means "leave it as it is" rather
 * than "clear it".
 */
export function TeamMemberForm({
  businesses,
  member,
}: {
  businesses: Business[];
  member?: AdminUser;
}) {
  const router = useRouter();
  const editing = member !== undefined;

  const [email, setEmail] = useState(member?.email ?? "");
  const [name, setName] = useState(member?.name ?? "");
  const [role, setRole] = useState<AdminUserRole>(member?.role ?? "staff");
  const [password, setPassword] = useState("");
  const [status, setStatus] = useState(member?.status ?? "active");
  const [businessId, setBusinessId] = useState(
    member?.businessIds.find((value) => value !== "*") ?? businesses[0]?.id ?? "",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    // `minLength` counts spaces, so the browser happily accepts a password made
    // of them. The server rejects it either way; checking here saves the trip.
    // Blank is left alone: when editing it means "keep the current password",
    // and when creating `required` has already stopped it.
    if (password && isPasswordTooShort(password)) {
      setError(`${PASSWORD_RULE}.`);
      return;
    }
    setBusy(true);
    setError("");
    // Admins see every business, so their scope is the wildcard rather than a
    // list the form would have to keep in step with the businesses table.
    const businessIds = role === "staff" ? [businessId] : ["*"];
    try {
      if (editing) {
        await api(`/api/admin/users/${member.id}`, {
          method: "PATCH",
          body: JSON.stringify({
            name,
            role,
            businessIds,
            status,
            // Omitted entirely when blank: an empty string would fail the
            // minimum-length check rather than meaning "unchanged".
            ...(password ? { password } : {}),
          }),
        });
      } else {
        await api("/api/admin/users", {
          method: "POST",
          body: JSON.stringify({ email, name, role, password, businessIds }),
        });
      }
      router.push(
        appendDone(LIST_HREF, editing ? "member-saved" : "member-created"),
      );
      router.refresh();
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : `Unable to ${editing ? "save" : "create"} the account.`,
      );
      setBusy(false);
    }
  }

  const noBusinesses = businesses.length === 0;

  return (
    <form className="form-page-form" onSubmit={submit}>
      {error ? <p className="alert form-page-alert">{error}</p> : null}

      <FormCard
        title="Identity"
        description={
          editing
            ? "The email is the login and cannot be changed. Create a new account if someone else takes over this role."
            : "The email address this person signs in with."
        }
      >
        <div className="admin-form-grid">
          <label className="field">
            <span>Full name</span>
            <input
              onChange={(event) => setName(event.target.value)}
              required
              value={name}
            />
          </label>
          <label className="field">
            <span>Email</span>
            <input
              autoComplete="off"
              disabled={editing}
              onChange={(event) => setEmail(event.target.value)}
              required
              type="email"
              value={email}
            />
          </label>
        </div>
      </FormCard>

      <FormCard
        title="Role and access"
        description="What this person can reach once they sign in."
      >
        <SelectMenu
          label="Role"
          onChange={(value) => setRole(value as AdminUserRole)}
          options={ROLES}
          value={role}
        />
        <p className="muted form-card-note">{ROLE_HELP[role]}</p>

        {/* Only staff pick a business: an admin sees all of them, so the field
            would be a control with no effect. */}
        {role === "staff" ? (
          noBusinesses ? (
            <p className="alert">
              There are no businesses yet. Create one before adding a staff
              account — staff must be assigned to exactly one business.
            </p>
          ) : (
            <SelectMenu
              label="Business"
              onChange={setBusinessId}
              options={businesses.map((business) => ({
                value: business.id,
                label: business.name,
              }))}
              required
              value={businessId}
            />
          )
        ) : null}

        {editing ? (
          <SelectMenu
            hint="A disabled account keeps its history but cannot sign in."
            label="Status"
            onChange={(value) => setStatus(value as "active" | "disabled")}
            options={STATUSES}
            value={status}
          />
        ) : null}
      </FormCard>

      <FormCard
        title="Password"
        description={
          editing
            ? "Leave blank to keep the current password. Anything you type here replaces it immediately."
            : "Share this with the person once, and ask them to change it after their first sign-in."
        }
      >
        <label className="field">
          <span>{editing ? "New password" : "Password"}</span>
          <input
            autoComplete="new-password"
            minLength={MIN_PASSWORD_LENGTH}
            onChange={(event) => setPassword(event.target.value)}
            required={!editing}
            type="password"
            value={password}
          />
          <small className="muted">
            At least {MIN_PASSWORD_LENGTH} characters. Leading and trailing
            spaces do not count towards the length.
          </small>
        </label>
      </FormCard>

      <div className="form-page-actions">
        <Link className="button secondary" href={LIST_HREF}>
          Cancel
        </Link>
        <button
          className="button"
          disabled={busy || (role === "staff" && noBusinesses)}
          type="submit"
        >
          {busy
            ? editing
              ? "Saving..."
              : "Creating..."
            : editing
              ? "Save Changes"
              : "Create Account"}
        </button>
      </div>
    </form>
  );
}
