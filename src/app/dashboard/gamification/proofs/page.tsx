import { redirect } from "next/navigation";
import { currentSession } from "@/server/dashboard-data";
import { listProofQueue } from "@/server/gamification/proofs";
import { maskPhone } from "@/server/rewards-network";
import { ProofReviewActions } from "../../_components/ProofReviewActions";
import { GamificationNav } from "../_nav";

export const dynamic = "force-dynamic";

/**
 * The evidence review queue.
 *
 * Oldest first, because it is a queue and not a feed: the person who has been
 * waiting longest for their reward is the person to deal with next.
 *
 * Phone numbers are masked. A reviewer needs to tell two submissions apart, not
 * to know who sent them, and the requirements ask for sensitive-data masking on
 * exactly this kind of screen.
 */
export default async function ProofQueuePage({
  searchParams,
}: {
  searchParams: { status?: string };
}) {
  const session = await currentSession();
  if (!session) redirect("/dashboard");

  const operations =
    session.role === "super_admin" ||
    (session.role === "admin" && session.businessIds.includes("*"));
  const status = searchParams.status === "Rejected" || searchParams.status === "Approved"
    ? searchParams.status
    : "Pending";

  const rows = await listProofQueue({
    status,
    partnerIds: operations ? null : session.businessIds.filter((value) => value !== "*"),
    limit: 100,
  });

  return (
    <>
      <header className="admin-topbar">
        <div>
          <h1>Evidence</h1>
          <p className="muted">
            Missions that need a person to look before they pay. Approving pays
            the reward in the same transaction as the decision; rejecting leaves
            the mission open so the player can try again.
          </p>
        </div>
      </header>

      <GamificationNav active="/dashboard/gamification/proofs" partnerOnly={!operations} />

      <section className="panel">
        <h2>
          {status} · {rows.length}
        </h2>
        <table className="data-table">
          <thead>
            <tr>
              <th>Submitted</th>
              <th>Mission</th>
              <th>Partner</th>
              <th>Player</th>
              <th>What they sent</th>
              <th>Decision</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.proofId}>
                <td>{row.submittedAt.replace("T", " ").slice(0, 16)}</td>
                <td>
                  <strong>{row.missionTitle}</strong>
                  <br />
                  <span className="muted">{row.missionState}</span>
                </td>
                <td>{row.partnerName ?? "—"}</td>
                <td>{maskPhone(row.phone)}</td>
                <td>
                  {row.hasFile ? (
                    <a
                      href={`/api/admin/gamification/proofs/${encodeURIComponent(row.proofId)}/file`}
                      rel="noreferrer"
                      target="_blank"
                    >
                      Open {row.kind}
                    </a>
                  ) : (
                    <span className="muted">{row.kind}</span>
                  )}
                  {row.note ? <p className="muted">{row.note}</p> : null}
                </td>
                <td>
                  {status === "Pending" ? (
                    <ProofReviewActions proofId={row.proofId} />
                  ) : (
                    <span className="muted">
                      {row.status} by {row.reviewer || "—"}
                      {row.rejectReason ? ` — ${row.rejectReason}` : ""}
                    </span>
                  )}
                </td>
              </tr>
            ))}
            {rows.length === 0 ? (
              <tr>
                <td colSpan={6}>
                  <span className="muted">Nothing waiting.</span>
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </section>
    </>
  );
}
