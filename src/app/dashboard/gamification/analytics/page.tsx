import { redirect } from "next/navigation";
import { currentSession } from "@/server/dashboard-data";
import {
  defaultRange,
  gamificationKpis,
  type AnalyticsRange,
} from "@/server/gamification/analytics";
import { centavosToLoyaltyPoints } from "@/server/rewards-network";
import { GamificationNav } from "../_nav";

export const dynamic = "force-dynamic";
/** Seven rollups over the whole history; past the default budget. */
export const maxDuration = 60;

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const percent = (value: number) => `${(value * 100).toFixed(1)}%`;

/** One stage of a funnel against the one before it; a dash when there is no base. */
const share = (value: number, base: number) => (base === 0 ? "—" : percent(value / base));

/**
 * The KPI dashboard: §13's eight areas on one screen.
 *
 * Read straight from the engine's own tables rather than from an analytics
 * store, so the dashboard and the ledger cannot disagree about what happened.
 * The date range is in Manila days, matching every reset and window in the
 * system, and every panel uses the same one.
 */
export default async function GamificationAnalyticsPage({
  searchParams,
}: {
  searchParams: { from?: string; to?: string; partner?: string };
}) {
  const session = await currentSession();
  if (!session || session.role === "staff") redirect("/dashboard");

  const fallback = defaultRange();
  const range: AnalyticsRange = {
    from: searchParams.from && DATE.test(searchParams.from) ? searchParams.from : fallback.from,
    to: searchParams.to && DATE.test(searchParams.to) ? searchParams.to : fallback.to,
    partnerId: searchParams.partner || null,
  };
  const kpis = await gamificationKpis(range);
  const csv = `/api/admin/gamification/analytics?format=csv&from=${range.from}&to=${range.to}`;

  return (
    <>
      <header className="admin-topbar">
        <div>
          <h1>Analytics</h1>
          <p className="muted">
            {range.from} to {range.to}, Manila days. Every figure comes from the
            ledgers and the event log, so what this page says and what finance
            can trace are the same numbers.
          </p>
        </div>
      </header>

      <GamificationNav active="/dashboard/gamification/analytics" />

      <form className="admin-form-actions" method="get">
        <label className="field">
          <span>From</span>
          <input defaultValue={range.from} name="from" type="date" />
        </label>
        <label className="field">
          <span>To</span>
          <input defaultValue={range.to} name="to" type="date" />
        </label>
        <button className="button" type="submit">
          Apply
        </button>
        <a className="button secondary" href={csv}>
          Export missions CSV
        </a>
      </form>

      <div className="admin-grid rewards-dashboard-grid">
        {[
          ["Active players", kpis.engagement.activePlayers.toLocaleString()],
          ["Mission participants", kpis.engagement.missionParticipants.toLocaleString()],
          ["Promotions", kpis.levels.promotions.toLocaleString()],
          ["Badges unlocked", kpis.achievements.totalUnlocks.toLocaleString()],
        ].map(([label, value]) => (
          <div className="panel metric span-3" key={label}>
            <span className="muted">{label}</span>
            <strong>{value}</strong>
          </div>
        ))}
      </div>

      <section className="panel">
        <h2>Missions</h2>
        <p className="muted">
          Exposure to reward, per campaign. Conversion is claims over
          assignments — the whole funnel in one number.
        </p>
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Mission</th>
                <th>Type</th>
                <th>Partner</th>
                <th>Assigned</th>
                <th>Started</th>
                <th>Completed</th>
                <th>Claimed</th>
                <th>Expired</th>
                <th>Conversion</th>
                <th>Avg minutes</th>
              </tr>
            </thead>
            <tbody>
              {kpis.missions.map((row) => (
                <tr key={row.missionKey}>
                  <td>{row.title}</td>
                  <td>{row.type}</td>
                  <td>{row.partnerName || "—"}</td>
                  <td>{row.assigned.toLocaleString()}</td>
                  <td>{row.started.toLocaleString()}</td>
                  <td>{row.completed.toLocaleString()}</td>
                  <td>{row.claimed.toLocaleString()}</td>
                  <td>{row.expired.toLocaleString()}</td>
                  <td>{percent(row.conversion)}</td>
                  <td>{row.averageMinutesToComplete || "—"}</td>
                </tr>
              ))}
              {kpis.missions.length === 0 ? (
                <tr>
                  <td colSpan={10}>
                    <span className="muted">No missions were assigned in this window.</span>
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel">
        <h2>Levels</h2>
        <table className="data-table">
          <thead>
            <tr>
              <th>Level</th>
              <th>Name</th>
              <th>Players</th>
            </tr>
          </thead>
          <tbody>
            {kpis.levels.distribution.map((row) => (
              <tr key={row.level}>
                <td>Lv.{row.level}</td>
                <td>{row.name}</td>
                <td>{row.players.toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted">
          {kpis.levels.conversionCount.toLocaleString()} conversions in this
          window, {kpis.levels.conversionLp} spent on experience. XP came from:{" "}
          {kpis.levels.xpBySource
            .map((row) => `${row.source} ${row.xp.toLocaleString()}`)
            .join(" · ") || "nothing yet"}
          .
        </p>
      </section>

      <section className="panel">
        <h2>Economy</h2>
        <table className="data-table">
          <tbody>
            <tr>
              <td>Loyalty Points issued</td>
              <td>{kpis.economy.issuedLp}</td>
            </tr>
            <tr>
              <td>Funded by Voucher Hunt</td>
              <td>{centavosToLoyaltyPoints(kpis.economy.platformLpCentavos)}</td>
            </tr>
            <tr>
              <td>Funded by partners</td>
              <td>{centavosToLoyaltyPoints(kpis.economy.partnerLpCentavos)}</td>
            </tr>
            <tr>
              <td>XP granted</td>
              <td>{kpis.economy.xpGranted.toLocaleString()}</td>
            </tr>
            <tr>
              <td>Held for review</td>
              <td>
                {kpis.economy.heldCount.toLocaleString()} ·{" "}
                {centavosToLoyaltyPoints(kpis.economy.heldLpCentavos)}
              </td>
            </tr>
            <tr>
              <td>Reversed</td>
              <td>
                {kpis.economy.reversedCount.toLocaleString()} ·{" "}
                {centavosToLoyaltyPoints(kpis.economy.reversedLpCentavos)}
              </td>
            </tr>
          </tbody>
        </table>
      </section>

      <section className="panel">
        <h2>Vouchers</h2>
        <p className="muted">
          The hunt&rarr;select&rarr;booking&rarr;QR funnel. Each stage counts what
          happened inside the window on its own timestamp, so a voucher won in one
          month and redeemed in the next is counted where the settlement counts it
          rather than dragged back to the hunt that produced it.
        </p>
        <table className="data-table">
          <thead>
            <tr>
              <th>Stage</th>
              <th>Count</th>
              <th>Of previous stage</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Hunted</td>
              <td>{kpis.vouchers.funnel.hunted.toLocaleString()}</td>
              <td>&mdash;</td>
            </tr>
            <tr>
              <td>Voucher selected</td>
              <td>{kpis.vouchers.funnel.selected.toLocaleString()}</td>
              <td>{share(kpis.vouchers.funnel.selected, kpis.vouchers.funnel.hunted)}</td>
            </tr>
            <tr>
              <td>Booked</td>
              <td>{kpis.vouchers.funnel.booked.toLocaleString()}</td>
              <td>{share(kpis.vouchers.funnel.booked, kpis.vouchers.funnel.selected)}</td>
            </tr>
            <tr>
              <td>Redeemed at the counter</td>
              <td>{kpis.vouchers.funnel.redeemed.toLocaleString()}</td>
              <td>{share(kpis.vouchers.funnel.redeemed, kpis.vouchers.funnel.booked)}</td>
            </tr>
          </tbody>
        </table>

        <h3>Level-gated offers</h3>
        <p className="muted">
          Whether the restrictions partners write are actually being taken up.{" "}
          {kpis.vouchers.levelOffers.gatedCampaigns.toLocaleString()} campaign
          {kpis.vouchers.levelOffers.gatedCampaigns === 1 ? " carries" : "s carry"} a
          level rule, {kpis.vouchers.levelOffers.exclusiveCampaigns.toLocaleString()} of
          them hidden from anyone below the bar.
        </p>
        <table className="data-table">
          <tbody>
            <tr>
              <td>Vouchers won on a gated offer</td>
              <td>
                {kpis.vouchers.levelOffers.selectedOnGated.toLocaleString()} ·{" "}
                {percent(kpis.vouchers.levelOffers.shareOfSelected)} of all
              </td>
            </tr>
            <tr>
              <td>Redeemed from those</td>
              <td>
                {kpis.vouchers.levelOffers.redeemedOnGated.toLocaleString()} ·{" "}
                {share(
                  kpis.vouchers.levelOffers.redeemedOnGated,
                  kpis.vouchers.levelOffers.selectedOnGated,
                )}
              </td>
            </tr>
          </tbody>
        </table>
      </section>

      <div className="admin-grid">
        <section className="panel span-6">
          <h2>Vouchers by level</h2>
          <p className="muted">
            The hunter&rsquo;s level <em>now</em>, not at the moment of the hunt &mdash;
            nothing snapshots a level onto an attempt, so a player promoted mid-window
            counts entirely at their new level.
          </p>
          <table className="data-table">
            <thead>
              <tr>
                <th>Level</th>
                <th>Won</th>
                <th>Redeemed</th>
              </tr>
            </thead>
            <tbody>
              {kpis.vouchers.byLevel.length === 0 ? (
                <tr>
                  <td colSpan={3} className="muted">
                    No vouchers in this window.
                  </td>
                </tr>
              ) : (
                kpis.vouchers.byLevel.map((row) => (
                  <tr key={row.level}>
                    <td>
                      Lv.{row.level} {row.name}
                    </td>
                    <td>{row.selected.toLocaleString()}</td>
                    <td>
                      {row.redeemed.toLocaleString()} · {share(row.redeemed, row.selected)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </section>

        <section className="panel span-6">
          <h2>Vouchers by discount band</h2>
          <p className="muted">
            Twenty-point bands for percentage discounts; everything else is grouped by
            the kind of benefit it is, because a free item is a category a partner
            reasons about rather than a discount of zero.
          </p>
          <table className="data-table">
            <thead>
              <tr>
                <th>Band</th>
                <th>Won</th>
                <th>Redeemed</th>
              </tr>
            </thead>
            <tbody>
              {kpis.vouchers.byDiscountBand.length === 0 ? (
                <tr>
                  <td colSpan={3} className="muted">
                    No vouchers in this window.
                  </td>
                </tr>
              ) : (
                kpis.vouchers.byDiscountBand.map((row) => (
                  <tr key={row.band}>
                    <td>{row.band}</td>
                    <td>{row.selected.toLocaleString()}</td>
                    <td>
                      {row.redeemed.toLocaleString()} · {share(row.redeemed, row.selected)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </section>
      </div>

      <section className="panel">
        <h2>Vouchers by partner</h2>
        <table className="data-table">
          <thead>
            <tr>
              <th>Partner</th>
              <th>Won</th>
              <th>Redeemed</th>
              <th>Redemption rate</th>
            </tr>
          </thead>
          <tbody>
            {kpis.vouchers.byPartner.length === 0 ? (
              <tr>
                <td colSpan={4} className="muted">
                  No vouchers in this window.
                </td>
              </tr>
            ) : (
              kpis.vouchers.byPartner.map((row) => (
                <tr key={row.partnerId}>
                  <td>{row.partnerName}</td>
                  <td>{row.selected.toLocaleString()}</td>
                  <td>{row.redeemed.toLocaleString()}</td>
                  <td>{share(row.redeemed, row.selected)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </section>

      <div className="admin-grid">
        <section className="panel span-6">
          <h2>Retention</h2>
          <p className="muted">
            Still active in the last seven days, split by whether they finished a
            mission in this window. The comparison is the point: a feature that
            does not move this is not earning its keep.
          </p>
          <table className="data-table">
            <tbody>
              <tr>
                <td>Completed a mission</td>
                <td>{percent(kpis.retention.playingRetention)}</td>
              </tr>
              <tr>
                <td>Did not</td>
                <td>{percent(kpis.retention.nonPlayingRetention)}</td>
              </tr>
            </tbody>
          </table>
        </section>

        <section className="panel span-6">
          <h2>Risk</h2>
          <table className="data-table">
            <tbody>
              <tr>
                <td>Open signals</td>
                <td>{kpis.risk.openSignals.toLocaleString()}</td>
              </tr>
              <tr>
                <td>Wallets held</td>
                <td>{kpis.risk.heldWallets.toLocaleString()}</td>
              </tr>
              <tr>
                <td>Wallets suspended</td>
                <td>{kpis.risk.suspendedWallets.toLocaleString()}</td>
              </tr>
              <tr>
                <td>Events in the dead-letter queue</td>
                <td>{kpis.risk.deadLetteredEvents.toLocaleString()}</td>
              </tr>
              <tr>
                <td>Evidence rejection rate</td>
                <td>{percent(kpis.risk.proofRejectionRate)}</td>
              </tr>
            </tbody>
          </table>
        </section>
      </div>
    </>
  );
}
