import { redirect } from "next/navigation";
import { getDb } from "@/server/db";
import { cachedBusinesses, currentSession } from "@/server/dashboard-data";
import { listMissionDefinitions, type MissionScope } from "@/server/gamification/mission-admin";
import { centavosToLoyaltyPoints } from "@/server/rewards-network";
import { MissionBuilder } from "../../_components/MissionBuilder";
import { MissionReviewActions } from "../../_components/MissionReviewActions";
import { GamificationNav } from "../_nav";

export const dynamic = "force-dynamic";

/**
 * The mission catalogue and the builder that adds to it — the Partner CMS.
 *
 * A partner account sees only its own campaigns and can only send them for
 * approval; operations sees everything and decides. That split is enforced in
 * `listMissionDefinitions` and in the publish path, not here: this page decides
 * what to draw, never what somebody is allowed to do.
 */
export default async function MissionsPage() {
  const session = await currentSession();
  if (!session) redirect("/dashboard");

  const operations =
    session.role === "super_admin" ||
    (session.role === "admin" && session.businessIds.includes("*"));
  const scope: MissionScope = {
    actor: session.email,
    partnerIds: operations ? null : session.businessIds.filter((value) => value !== "*"),
    canApprove: session.role === "super_admin" || session.role === "admin",
  };

  const [db, businesses] = await Promise.all([getDb(), cachedBusinesses()]);
  const rows = await listMissionDefinitions(db, scope);
  const partners = operations
    ? businesses
    : businesses.filter((business) => session.businessIds.includes(business.id));

  // Only the newest version of each key is worth acting on; the rest are
  // history, shown underneath so a definition an instance points at is still
  // findable.
  const newest = new Map<string, (typeof rows)[number]>();
  for (const row of rows) {
    const key = String(row.mission_key);
    if (!newest.has(key)) newest.set(key, row);
  }
  const current = [...newest.values()];
  const awaitingReview = current.filter((row) => String(row.status) === "Review");

  return (
    <>
      <header className="admin-topbar">
        <div>
          <h1>Missions</h1>
          <p className="muted">
            {operations
              ? "Every campaign on the network. A partner writes one, operations approves it, and only then do players see it."
              : "Your campaigns. Write one and send it for approval; operations decides when it goes live."}
          </p>
        </div>
      </header>

      <GamificationNav active="/dashboard/gamification/missions" partnerOnly={!operations} />

      {awaitingReview.length > 0 && scope.canApprove ? (
        <section className="panel alert">
          <h2>{awaitingReview.length} waiting for approval</h2>
          <p className="muted">
            Approving re-runs the pre-flight. A campaign whose partner deposit no
            longer covers it is refused at that point rather than going live and
            failing halfway through.
          </p>
        </section>
      ) : null}

      <section className="panel">
        <h2>New mission</h2>
        <p className="muted">
          A live mission is never edited. Publishing a change writes a new
          version, and players already mid-mission keep the rules they started
          under.
        </p>
        <MissionBuilder canApprove={scope.canApprove} partners={partners} />
      </section>

      <section className="panel table-wrap">
        <h2>Current</h2>
        <table className="admin-table">
          <thead>
            <tr>
              <th>Mission</th>
              <th>Type</th>
              <th>Partner</th>
              <th>Reward</th>
              <th>Places</th>
              <th>Budget</th>
              <th>Status</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {current.map((row) => {
              const quota =
                row.global_quota === null || row.global_quota === undefined
                  ? "Unlimited"
                  : `${
                      String(row.quota_mode) === "RESERVE_ON_JOIN"
                        ? Number(row.joined_count ?? 0)
                        : Number(row.completed_count ?? 0)
                    } / ${Number(row.global_quota)}`;
              const budget =
                row.reward_budget_centavos === null || row.reward_budget_centavos === undefined
                  ? "—"
                  : `${centavosToLoyaltyPoints(Number(row.spent_budget_centavos ?? 0))} of ${centavosToLoyaltyPoints(Number(row.reward_budget_centavos))}`;
              return (
                <tr key={`${row.mission_key}:${row.definition_version}`}>
                  <td>
                    <div className="cell-title">{String(row.title)}</div>
                    <div className="muted">
                      {String(row.mission_key)} · v{String(row.definition_version)}
                      {Number(row.requires_proof ?? 0) === 1 ? (
                        <>
                          {" "}
                          <span className="badge neutral">evidence</span>
                        </>
                      ) : null}
                    </div>
                  </td>
                  <td>{String(row.type)}</td>
                  <td>
                    {row.partner_name ? (
                      String(row.partner_name)
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                  <td>{describeReward(String(row.reward_json ?? "[]"))}</td>
                  <td className="cell-numeric">{quota}</td>
                  <td className="cell-numeric">{budget}</td>
                  <td>
                    <span
                      className={
                        String(row.status) === "Active"
                          ? "badge success"
                          : String(row.status) === "Review"
                            ? "badge warning"
                            : "badge neutral"
                      }
                    >
                      {String(row.status)}
                    </span>
                  </td>
                  <td>
                    <MissionReviewActions
                      canApprove={scope.canApprove}
                      definitionVersion={Number(row.definition_version)}
                      missionKey={String(row.mission_key)}
                      status={String(row.status)}
                    />
                  </td>
                </tr>
              );
            })}
            {current.length === 0 ? (
              <tr>
                <td className="table-empty" colSpan={8}>
                  No missions yet. Write one above.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </section>
    </>
  );
}

/** Renders a stored reward package as the operator writes it: "10 XP + 5 LP". */
function describeReward(json: string) {
  try {
    const lines = JSON.parse(json) as Array<{ type: string; amount: number }>;
    return (
      lines
        .map((line) => {
          if (line.type === "LP") return centavosToLoyaltyPoints(line.amount);
          if (line.type === "XP") return `${line.amount} XP`;
          if (line.type === "HUNT_TICKET") return `${line.amount} hunt`;
          return "badge";
        })
        .join(" + ") || "—"
    );
  } catch {
    return "—";
  }
}
