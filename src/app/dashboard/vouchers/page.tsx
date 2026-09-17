import { listPools } from "@/server/admin";
import { FiAlertTriangle } from "react-icons/fi";
import {
  getVoucherPresentation,
  rarityPresentation,
  type VoucherRarity,
} from "@bizflow/shared";
import { manilaDateString } from "@/server/db";
import { campaignSlotPerformance, type SlotPerformance } from "@/server/voucher-engine";
import { ChangeRequestActions } from "../_components/ChangeRequestActions";
import { FlashNotice } from "../_components/FlashNotice";
import { FormLink } from "../_components/FormLink";
import { RedemptionImport } from "../_components/RedemptionImport";
import { scopedHref, selectScope } from "../_components/selectCampaign";
import { ScopeSelector } from "../_components/ScopeSelector";
import {
  cachedBusinesses,
  cachedCampaignsWithIndustry,
  currentSession,
} from "@/server/dashboard-data";
import { filterCampaignsForSession } from "@/server/auth";
import {
  listChangeRequests,
  listStaffChangeRequests,
} from "@/server/change-requests";

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/**
 * "2026-07-08" -> "Jul 8". Built from the string's own parts rather than via
 * `new Date(...)`, which would read the slot date as UTC midnight and render
 * the previous day for anyone west of it.
 */
function shortDate(iso: string) {
  const [year, month, day] = iso.split("-").map(Number);
  if (!year || !month || !day || month < 1 || month > 12) return iso;
  return `${MONTHS[month - 1]} ${day}`;
}

export default async function VouchersPage({
  searchParams,
}: {
  searchParams: { business?: string; campaign?: string; done?: string };
}) {
  const [session, allCampaigns, businesses] = await Promise.all([
    currentSession(),
    cachedCampaignsWithIndustry(),
    cachedBusinesses(),
  ]);
  const campaigns = filterCampaignsForSession(session!, allCampaigns);
  const scope = selectScope(businesses, campaigns, searchParams);
  const selectedCampaign = scope.campaign;
  const isBusinessScoped = session?.role === "staff";

  // Slots and pools stay a pair: either both load or the page falls back to
  // empty for both, which is what the single try/catch here used to guarantee.
  const [voucherRequests, adminVoucherRequests, [slotRows, pools]] = await Promise.all([
    isBusinessScoped && selectedCampaign && session
      ? listStaffChangeRequests(selectedCampaign.id, session.email, "pool_create")
      : Promise.resolve([]),
    !isBusinessScoped && selectedCampaign
      ? listChangeRequests(selectedCampaign.id, "pool_create")
      : Promise.resolve([]),
    selectedCampaign
      ? Promise.all([
          campaignSlotPerformance(selectedCampaign.id),
          listPools(selectedCampaign.id),
        ]).catch(
          () => [[], []] as [SlotPerformance[], Awaited<ReturnType<typeof listPools>>],
        )
      : Promise.resolve([[], []] as [
          SlotPerformance[],
          Awaited<ReturnType<typeof listPools>>,
        ]),
  ]);
  /**
   * The campaign's slots by id, built once.
   *
   * Both helpers below resolve a tier's slot ids against this list, and both
   * used to scan it with `.find()` per id — for every tier, on every render.
   * A campaign with 20 tiers over 200 slots, each tier offered at 30 of them,
   * walked the slot list 1,200 times for one table.
   */
  const slotsById = new Map(slotRows.map((row) => [row.slot.id, row.slot]));

  /**
   * Availability grouped by date rather than one entry per slot. A tier offered
   * at fifteen slots rendered as fifteen full timestamps, which wrapped over
   * three lines and buried every other column.
   */
  const slotsByDate = (slotIds: string[]) => {
    const byDate = new Map<string, string[]>();
    const unknown: string[] = [];
    for (const slotId of slotIds) {
      const slot = slotsById.get(slotId);
      if (!slot) {
        unknown.push(slotId);
        continue;
      }
      // Pushed into the held array rather than rebuilt around it: spreading the
      // previous times back in copied the whole day's list per slot.
      const held = byDate.get(slot.date);
      if (held) held.push(slot.startTime);
      else byDate.set(slot.date, [slot.startTime]);
    }
    const groups = [...byDate.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, times]) => ({ date, times: [...times].sort() }));
    return { groups, unknown };
  };

  // Weight is only meaningful next to the others, so it is shown as a share of
  // the campaign's total rather than as a bare number.
  const totalWeight = pools.reduce((sum, pool) => sum + pool.probabilityWeight, 0);

  /**
   * A tier whose slots have all passed, sold out or been closed can no longer be
   * booked, so the draw skips it entirely. Flagged here because the cause is a
   * configuration drift an admin cannot otherwise see: the tier still reads as
   * "active" with stock remaining.
   */
  const today = manilaDateString();
  const isBookable = (slotIds: string[]) =>
    slotIds.some((slotId) => {
      const slot = slotsById.get(slotId);
      return (
        slot !== undefined &&
        slot.date >= today &&
        slot.status === "active" &&
        slot.remainingCapacity > 0
      );
    });

  // The form is on its own route now, so the scope has to travel with the link.
  const newPoolQuery = selectedCampaign
    ? scopedHref("", scope.business?.id, selectedCampaign.slug).slice(1)
    : "";

  return (
    <>
      <header className="admin-topbar">
        <div>
          <h1>Vouchers</h1>
          <p className="muted">Voucher benefit tiers and the date/time slots each is offered at.</p>
        </div>
      </header>
      <ScopeSelector
        businesses={businesses}
        campaigns={campaigns}
        selectedBusinessId={scope.business?.id}
        selectedCampaignSlug={selectedCampaign?.slug}
        showBusiness={session?.role !== "staff"}
      />
      <FlashNotice />
      <section className="panel table-wrap">
        {selectedCampaign ? (
          <div className="admin-form-actions">
            <FormLink
              className="button admin-form-toggle"
              href={`/dashboard/vouchers/new?${newPoolQuery}`}
              skeleton="newPool"
            >
              {isBusinessScoped ? "Request Benefit Tier" : "Add Benefit Tier"}
            </FormLink>
            <RedemptionImport campaignId={selectedCampaign.id} />
          </div>
        ) : null}
        <table>
          <thead>
            <tr>
              <th>Benefit</th>
              <th>Qty</th>
              <th>Remaining</th>
              <th>Rarity</th>
              <th>Available at</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {pools.length === 0 ? (
              <tr>
                  <td colSpan={6}>
                    {isBusinessScoped
                      ? "No live benefit tiers yet. Request one above for admin approval."
                      : "No benefit tiers yet. Add one above."}
                  </td>
              </tr>
            ) : (
              pools.map((pool) => {
                const { groups, unknown } = slotsByDate(pool.slotIds);
                const claimed = pool.totalQuantity - pool.remainingQuantity;
                const share = totalWeight
                  ? Math.round((pool.probabilityWeight / totalWeight) * 100)
                  : 0;
                const bookable = isBookable(pool.slotIds);
                return (
                  <tr key={pool.id}>
                    <td>
                      <div className="cell-title">{pool.displayLabel}</div>
                      {pool.status === "active" && !bookable ? (
                        <div className="pool-warning">
                          <FiAlertTriangle aria-hidden="true" />
                          <span>
                            No bookable slots — this tier is skipped in the draw.
                            Add an upcoming slot with capacity.
                          </span>
                        </div>
                      ) : null}
                    </td>
                    <td className="cell-numeric">{pool.totalQuantity}</td>
                    <td className="cell-numeric">
                      <div className="pool-stock">
                        <span>{pool.remainingQuantity}</span>
                        <span
                          aria-hidden="true"
                          className="pool-stock-bar"
                          data-depleted={claimed > 0 ? "true" : undefined}
                        >
                          <span
                            style={{
                              width: `${pool.totalQuantity ? (pool.remainingQuantity / pool.totalQuantity) * 100 : 0}%`,
                            }}
                          />
                        </span>
                      </div>
                    </td>
                    <td className="cell-numeric">
                      <div className="pool-rarity">
                        <span>{getVoucherPresentation(pool).label}</span>
                        <small>{share}%</small>
                      </div>
                    </td>
                    <td>
                      {groups.length === 0 && unknown.length === 0 ? (
                        <span className="muted">—</span>
                      ) : (
                        <div className="pool-slot-chips">
                          {groups.map((group) => (
                            <span className="pool-slot-chip" key={group.date}>
                              <strong>{shortDate(group.date)}</strong>
                              <span>{group.times.join(" · ")}</span>
                            </span>
                          ))}
                          {unknown.map((slotId) => (
                            <span className="pool-slot-chip is-unknown" key={slotId}>
                              <strong>{slotId}</strong>
                            </span>
                          ))}
                        </div>
                      )}
                    </td>
                    <td>
                      <span className="badge">{pool.status}</span>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </section>
      {isBusinessScoped ? (
        <section className="panel table-wrap change-request-table">
          <div className="admin-topbar">
            <div>
              <h2>Your Voucher Tier Requests</h2>
              <p className="muted">
                Requested voucher tiers appear in the live table only after admin approval.
              </p>
            </div>
          </div>
          <table>
            <thead>
              <tr>
                <th>Requested</th>
                <th>Benefit</th>
                <th>Qty</th>
                <th>Rarity</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {voucherRequests.length === 0 ? (
                <tr>
                  <td colSpan={5}>No voucher tier requests yet.</td>
                </tr>
              ) : (
                voucherRequests.map((request) => {
                  const pool = request.payload as {
                    benefitType: string;
                    benefitValue: string;
                    displayLabel: string;
                    totalQuantity: number;
                    rarity: VoucherRarity;
                    minimumSpend?: number;
                    slotIds?: string[];
                  };
                  return (
                    <tr key={request.id}>
                      <td>{request.createdAt.replace("T", " ").slice(0, 16)}</td>
                      <td>{pool.displayLabel}</td>
                      <td>{pool.totalQuantity}</td>
                      <td>{rarityPresentation(pool.rarity).label}</td>
                      <td><span className={`badge ${request.status === "Rejected" ? "danger" : request.status === "Pending" ? "warning" : ""}`}>{request.status}</span></td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </section>
      ) : null}
      {!isBusinessScoped ? (
        <section className="panel table-wrap change-request-table">
          <div className="admin-topbar">
            <div>
              <h2>Staff Voucher Tier Requests</h2>
              <p className="muted">
                Review pending requests and keep approved or rejected requests for reference.
              </p>
            </div>
          </div>
          <table>
            <thead>
              <tr>
                <th>Requested</th>
                <th>Staff</th>
                <th>Benefit</th>
                <th>Qty</th>
                <th>Rarity</th>
                <th>Status</th>
                <th>Review / Action</th>
              </tr>
            </thead>
            <tbody>
              {adminVoucherRequests.length === 0 ? (
                <tr>
                  <td colSpan={7}>No voucher tier requests for this campaign.</td>
                </tr>
              ) : (
                adminVoucherRequests.map((request) => {
                  const pool = request.payload as {
                    benefitType: string;
                    benefitValue: string;
                    displayLabel: string;
                    totalQuantity: number;
                    rarity: VoucherRarity;
                    minimumSpend?: number;
                    slotIds?: string[];
                  };
                  return (
                    <tr key={request.id}>
                      <td>{request.createdAt.replace("T", " ").slice(0, 16)}</td>
                      <td>{request.requestedBy}</td>
                      <td>{pool.displayLabel}</td>
                      <td>{pool.totalQuantity}</td>
                      <td>{rarityPresentation(pool.rarity).label}</td>
                      <td>
                        <span className={`badge ${request.status === "Rejected" ? "danger" : request.status === "Pending" ? "warning" : ""}`}>
                          {request.status}
                        </span>
                      </td>
                      <td>
                        {request.status === "Pending" ? (
                          <ChangeRequestActions id={request.id} />
                        ) : (
                          <div className="request-review-actions">
                            <span className="request-review-meta">
                            {request.reviewedBy || "Reviewed"}
                            {request.reviewedAt
                              ? ` · ${request.reviewedAt.replace("T", " ").slice(0, 16)}`
                              : ""}
                            </span>
                            <FormLink
                              className="button secondary compact-button"
                              href={`/dashboard/vouchers/new?${newPoolQuery}&revise=${request.id}`}
                              skeleton="newPool"
                            >
                              Revise
                            </FormLink>
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </section>
      ) : null}
    </>
  );
}
