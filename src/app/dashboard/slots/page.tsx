import { campaignSlotPerformance, type SlotPerformance } from "@/server/voucher-engine";
import { ChangeRequestActions } from "../_components/ChangeRequestActions";
import { FlashNotice } from "../_components/FlashNotice";
import { FormLink } from "../_components/FormLink";
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

export default async function SlotsPage({
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
  // Which of the two request lists is used still depends on the role exactly as
  // before; only the waiting is shared.
  const [slotRequests, adminSlotRequests, slotRows] = await Promise.all([
    isBusinessScoped && selectedCampaign && session
      ? listStaffChangeRequests(selectedCampaign.id, session.email, "slot_create")
      : Promise.resolve([]),
    !isBusinessScoped && selectedCampaign
      ? listChangeRequests(selectedCampaign.id, "slot_create")
      : Promise.resolve([]),
    selectedCampaign
      ? campaignSlotPerformance(selectedCampaign.id).catch(() => [] as SlotPerformance[])
      : Promise.resolve([] as SlotPerformance[]),
  ]);

  // The form is on its own route now, so the scope has to travel with the link.
  const newSlotQuery = selectedCampaign
    ? scopedHref("", scope.business?.id, selectedCampaign.slug).slice(1)
    : "";

  return (
    <>
      <header className="admin-topbar">
        <div>
          <h1>Slots</h1>
          <p className="muted">Date/time slots and remaining capacity.</p>
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
          <FormLink
            className="button admin-form-toggle"
            href={`/dashboard/slots/new?${newSlotQuery}`}
            skeleton="newSlot"
          >
            {isBusinessScoped ? "Request Slot" : "New Slot"}
          </FormLink>
        ) : null}
        <table>
          <thead>
            <tr>
              <th>Date</th>
              <th>Start Time</th>
              <th>End Time</th>
              <th>Capacity</th>
              <th>Remaining</th>
              <th>Booked</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {slotRows.length === 0 ? (
              <tr>
                  <td colSpan={7}>
                    {isBusinessScoped
                      ? "No live slots yet. Request one above for admin approval."
                      : "No slots yet. Add one above."}
                  </td>
              </tr>
            ) : (
              slotRows.map((row) => {
                // Low stock is the last quarter of the slot's own capacity: a
                // flat threshold called a full 4-seat slot "low" the moment it
                // opened. Rounded up so small slots still warn before selling
                // out — a quarter of 3 seats is less than one seat.
                const soldOut = row.slot.remainingCapacity === 0;
                const lowStock =
                  !soldOut &&
                  row.slot.remainingCapacity <= Math.ceil(row.slot.totalCapacity * 0.25);
                return (
                  <tr key={row.slot.id}>
                    <td>{row.slot.date}</td>
                    <td>{row.slot.startTime}</td>
                    <td>{row.slot.endTime}</td>
                    <td>{row.slot.totalCapacity}</td>
                    <td>{row.slot.remainingCapacity}</td>
                    <td>{row.issued}</td>
                    <td>
                      <span className={`badge ${soldOut ? "danger" : lowStock ? "warning" : ""}`}>
                        {soldOut ? "Sold Out" : lowStock ? "Low Stock" : "Active"}
                      </span>
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
              <h2>Your Slot Requests</h2>
              <p className="muted">
                Requested changes remain here until an admin approves or rejects them.
              </p>
            </div>
          </div>
          <table>
            <thead>
              <tr>
                <th>Requested</th>
                <th>Date</th>
                <th>Time</th>
                <th>Capacity</th>
                <th>Branch</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {slotRequests.length === 0 ? (
                <tr>
                  <td colSpan={6}>No slot requests yet.</td>
                </tr>
              ) : (
                slotRequests.map((request) => {
                  const slot = request.payload as {
                    date: string;
                    startTime: string;
                    endTime: string;
                    totalCapacity: number;
                    branchId?: string;
                  };
                  return (
                    <tr key={request.id}>
                      <td>{request.createdAt.replace("T", " ").slice(0, 16)}</td>
                      <td>{slot.date}</td>
                      <td>{slot.startTime}–{slot.endTime}</td>
                      <td>{slot.totalCapacity}</td>
                      <td>{slot.branchId || "—"}</td>
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
              <h2>Staff Slot Requests</h2>
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
                <th>Date</th>
                <th>Time</th>
                <th>Capacity</th>
                <th>Branch</th>
                <th>Status</th>
                <th>Review / Action</th>
              </tr>
            </thead>
            <tbody>
              {adminSlotRequests.length === 0 ? (
                <tr>
                  <td colSpan={8}>No slot requests for this campaign.</td>
                </tr>
              ) : (
                adminSlotRequests.map((request) => {
                  const slot = request.payload as {
                    date: string;
                    startTime: string;
                    endTime: string;
                    totalCapacity: number;
                    branchId?: string;
                  };
                  return (
                    <tr key={request.id}>
                      <td>{request.createdAt.replace("T", " ").slice(0, 16)}</td>
                      <td>{request.requestedBy}</td>
                      <td>{slot.date}</td>
                      <td>{slot.startTime}–{slot.endTime}</td>
                      <td>{slot.totalCapacity}</td>
                      <td>{slot.branchId || "—"}</td>
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
                              href={`/dashboard/slots/new?${newSlotQuery}&revise=${request.id}`}
                              skeleton="newSlot"
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
