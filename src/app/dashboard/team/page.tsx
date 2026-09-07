import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { FiEdit2 } from "react-icons/fi";
import { formatDate as formatDateOnly } from "@/lib/datetime-display";
import { cachedBusinesses, currentSession } from "@/server/dashboard-data";
import { listAdminUsers } from "@/server/admin-users";
import { listBusinesses } from "@/server/admin";
import { FlashNotice } from "../_components/FlashNotice";
import { FormLink } from "../_components/FormLink";
import { TeamMemberActions } from "../_components/TeamMemberActions";

export const dynamic = "force-dynamic";

const ROLE_LABELS: Record<string, string> = {
  super_admin: "Super admin",
  admin: "Admin",
  staff: "Staff",
};

function formatDate(value?: string) {
  return value ? formatDateOnly(value) : null;
}

/**
 * Console accounts, kept apart from `/dashboard/users` on purpose: that page is
 * the customers who claim vouchers, this one is the people who can sign in.
 *
 * Super-admin only. An admin who could create accounts could create itself a
 * super-admin, so the role boundary has to hold here as well as in the API.
 */
export default async function TeamPage() {
  const session = await currentSession();
  if (session?.role !== "super_admin") redirect("/dashboard");

  const [members, businesses] = await Promise.all([
    listAdminUsers(),
    cachedBusinesses(),
  ]);
  const businessName = (id: string) =>
    businesses.find((business) => business.id === id)?.name ?? id;

  return (
    <>
      <header className="admin-topbar">
        <div>
          <h1>Team</h1>
          <p className="muted">
            Admin and staff accounts that can sign in to this console. Staff are
            scoped to a single business; admins can see every business.
          </p>
        </div>
      </header>

      <FlashNotice />

      <section className="panel table-wrap">
        <FormLink
          className="button admin-form-toggle"
          href="/dashboard/team/new"
          skeleton="newTeamMember"
        >
          New Team Member
        </FormLink>

        <table className="admin-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Role</th>
              <th>Business access</th>
              <th>Status</th>
              <th>Last sign-in</th>
              <th aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {members.length === 0 ? (
              <tr>
                <td className="muted" colSpan={6}>
                  No accounts yet. You are signed in with the bootstrap
                  credentials from the environment — create a super admin here
                  so logins are managed in the console.
                </td>
              </tr>
            ) : (
              members.map((member) => (
                <tr key={member.id}>
                  <td>
                    <strong>{member.name}</strong>
                    <div className="muted">{member.email}</div>
                  </td>
                  <td>{ROLE_LABELS[member.role] ?? member.role}</td>
                  <td>
                    {member.businessIds.includes("*") ? (
                      <span className="muted">All businesses</span>
                    ) : (
                      member.businessIds.map(businessName).join(", ")
                    )}
                  </td>
                  <td>
                    {/* `.badge` is green by default, which is the active case. */}
                    <span
                      className={`badge ${member.status === "active" ? "" : "neutral"}`}
                    >
                      {member.status === "active" ? "Active" : "Disabled"}
                    </span>
                  </td>
                  <td>
                    {formatDate(member.lastLoginAt) ?? (
                      <span className="muted">Never</span>
                    )}
                  </td>
                  <td className="business-actions">
                    <FormLink
                      className="campaign-edit-image-button"
                      href={`/dashboard/team/${member.id}/edit`}
                      skeleton="editTeamMember"
                    >
                      <FiEdit2 aria-hidden="true" /> Edit
                    </FormLink>
                    <TeamMemberActions
                      isSelf={member.email === session.email}
                      memberId={member.id}
                      name={member.name}
                    />
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </section>
    </>
  );
}
