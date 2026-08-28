import { redirect } from "next/navigation";
import { all, getDb } from "@/server/db";
import { currentSession } from "@/server/dashboard-data";
import { loadEconomy, loadLevels } from "@/server/gamification/config";
import { listBackfillJobs } from "@/server/gamification/backfill";
import { deadLetteredEvents } from "@/server/gamification/events";
import { centavosToLoyaltyPoints } from "@/server/rewards-network";
import { EconomyForm, LevelLadderForm, BackfillButton } from "../_components/GamificationSettings";
import { GamificationNav } from "./_nav";

export const dynamic = "force-dynamic";

/**
 * Levels, missions and achievements, as operations sees them.
 *
 * Every number the reward engine uses is on this page, and none of them is in
 * the code — the point of the whole configuration layer is that a payout can be
 * changed without a deployment. Publishing writes a new version rather than
 * editing the old one, so a settled month can still be explained afterwards.
 */
export default async function GamificationPage() {
  const session = await currentSession();
  if (!session) redirect("/dashboard");
  // A partner account has no business setting the network economy, but it does
  // have missions to write. Send it there rather than bouncing it to the top.
  if (session.role === "staff") redirect("/dashboard/gamification/missions");

  const db = await getDb();
  const [{ economy, version: economyVersion }, { levels, version: levelVersion }] =
    await Promise.all([loadEconomy(db), loadLevels(db)]);

  const missions = await all(
    db,
    `SELECT d.*, b.name AS partner_name
     FROM mission_definitions d
     LEFT JOIN businesses b ON b.id = d.partner_id
     WHERE d.status <> 'Archived'
     ORDER BY d.type ASC, d.sort_order ASC`,
  );
  const achievements = await all(
    db,
    `SELECT group_key, title, category, counter_key,
            MIN(threshold) AS bronze, MAX(threshold) AS royal, COUNT(*) AS tiers
     FROM achievement_definitions
     WHERE status = 'Active'
     GROUP BY group_key, title, category, counter_key
     ORDER BY title ASC`,
  );
  const [jobs, deadLetters] = await Promise.all([listBackfillJobs(5), deadLetteredEvents(10)]);

  return (
    <>
      <header className="admin-topbar">
        <div>
          <h1>Levels &amp; Missions</h1>
          <p className="muted">
            The economy behind levels, daily missions and achievements. Changes
            are published as a new version and take effect without a deploy.
          </p>
        </div>
      </header>

      <GamificationNav active="/dashboard/gamification" />

      {deadLetters.length > 0 ? (
        <section className="panel alert">
          <h2>{deadLetters.length} events could not be processed</h2>
          <p className="muted">
            These were verified and recorded but the rules engine could not
            apply them after several attempts. The rewards they would have paid
            are still owed.
          </p>
          <table className="data-table">
            <thead>
              <tr>
                <th>Event</th>
                <th>Occurred</th>
                <th>Attempts</th>
                <th>Last error</th>
              </tr>
            </thead>
            <tbody>
              {deadLetters.map((row) => (
                <tr key={String(row.event_id)}>
                  <td>{String(row.event_name)}</td>
                  <td>{String(row.occurred_at_utc).replace("T", " ").slice(0, 16)}</td>
                  <td>{String(row.retry_count)}</td>
                  <td className="muted">{String(row.last_error ?? "")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}

      <section className="panel">
        <h2>Economy — version {economyVersion || "defaults"}</h2>
        <p className="muted">
          Loyalty Points are spent to buy experience. Experience decides the
          level; it has no cash value and is never spendable. A payout above the
          review threshold is held for approval instead of being paid, and past
          the daily cap a Loyalty Point reward becomes experience instead — so a
          capped player still progresses rather than seeing a mission pay
          nothing.
        </p>
        <EconomyForm economy={economy} version={economyVersion} />
      </section>

      <section className="panel">
        <h2>Level ladder — version {levelVersion || "defaults"}</h2>
        <p className="muted">
          A level never changes a discount rate on its own. Partners decide what
          a level unlocks through their own minimum level and level offer;
          these thresholds only decide who reaches it.
        </p>
        <LevelLadderForm levels={levels} version={levelVersion} />
      </section>

      <section className="panel">
        <h2>Missions</h2>
        <p className="muted">
          A live mission is never edited. Publishing a change writes a new
          version, and instances already in progress keep the version they
          started under. Urgent campaigns are written and approved on the{" "}
          <a href="/dashboard/gamification/missions">Missions</a> screen.
        </p>
        <table className="data-table">
          <thead>
            <tr>
              <th>Mission</th>
              <th>Type</th>
              <th>Trigger</th>
              <th>Window</th>
              <th>Reward</th>
              <th>Status</th>
              <th>Version</th>
            </tr>
          </thead>
          <tbody>
            {missions.map((mission) => (
              <tr key={`${mission.mission_key}:${mission.definition_version}`}>
                <td>
                  <strong>{String(mission.title)}</strong>
                  <br />
                  <span className="muted">{String(mission.mission_key)}</span>
                </td>
                <td>{String(mission.type)}</td>
                <td className="muted">{String(mission.trigger_event)}</td>
                <td>
                  {mission.window_start
                    ? `${mission.window_start}-${mission.window_end}`
                    : "All day"}
                </td>
                <td>{describeReward(String(mission.reward_json))}</td>
                <td>
                  <span
                    className={
                      String(mission.status) === "Active" ? "badge success" : "badge warning"
                    }
                  >
                    {String(mission.status)}
                  </span>
                </td>
                <td>v{String(mission.definition_version)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="panel">
        <h2>Achievements</h2>
        <p className="muted">
          Cumulative and permanent. Each tier unlocks and pays once. Existing
          players are given credit for their history by the backfill below.
        </p>
        <table className="data-table">
          <thead>
            <tr>
              <th>Achievement</th>
              <th>Category</th>
              <th>Counter</th>
              <th>Tiers</th>
              <th>Range</th>
            </tr>
          </thead>
          <tbody>
            {achievements.map((achievement) => (
              <tr key={String(achievement.group_key)}>
                <td>
                  <strong>{String(achievement.title)}</strong>
                </td>
                <td>{String(achievement.category)}</td>
                <td className="muted">{String(achievement.counter_key)}</td>
                <td>{String(achievement.tiers)}</td>
                <td>
                  {String(achievement.bronze)} – {String(achievement.royal)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <h3>Backfill</h3>
        <p className="muted">
          Rebuilds every player&apos;s counters from their existing hunts,
          redemptions and referrals, then unlocks whatever that earns. Safe to
          run more than once, and safe to interrupt — it resumes from where it
          stopped.
        </p>
        <BackfillButton />
        {jobs.length > 0 ? (
          <table className="data-table">
            <thead>
              <tr>
                <th>Started</th>
                <th>Status</th>
                <th>Wallets</th>
                <th>Unlocks</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((job) => (
                <tr key={job.id}>
                  <td>{job.startedAt.replace("T", " ").slice(0, 16)}</td>
                  <td>{job.status}</td>
                  <td>{job.walletsDone}</td>
                  <td>{job.unlocksGranted}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </section>
    </>
  );
}

/** Renders a stored reward package as the operator writes it: "10 XP + 5 LP". */
function describeReward(json: string) {
  try {
    const lines = JSON.parse(json) as Array<{ type: string; amount: number }>;
    return lines
      .map((line) => {
        if (line.type === "LP") return centavosToLoyaltyPoints(line.amount);
        if (line.type === "XP") return `${line.amount} XP`;
        if (line.type === "HUNT_TICKET") return `${line.amount} hunt`;
        return "badge";
      })
      .join(" + ");
  } catch {
    return "—";
  }
}
