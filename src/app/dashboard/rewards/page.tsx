import { rewardsNetworkOverview } from "@/server/rewards-network";
import { formatDateTime } from "@/lib/datetime-display";
import { HeldPurchaseActions, SettlementRowActions } from "../_components/RewardsAdminActions";
import { RewardsStaffTools } from "../_components/RewardsStaffTools";
import { cachedBusinesses, currentSession } from "@/server/dashboard-data";

export default async function RewardsNetworkPage() {
  const session = await currentSession();
  if (session?.role === "staff") {
    const business = (await cachedBusinesses()).find((item) =>
      session.businessIds.includes(item.id),
    );
    if (!business) {
      return (
        <section className="panel">
          <h2>Business access is not configured</h2>
          <p className="muted">Ask an administrator to assign this staff account to a business.</p>
        </section>
      );
    }
    return <RewardsStaffTools business={business} />;
  }
  const overview = await rewardsNetworkOverview();
  const settlementBadgeClass = (status: string) =>
    status === "Completed"
      ? "badge success"
      : status === "Adjusted"
        ? "badge"
        : "badge warning";

  return (
    <>
      <header className="admin-topbar">
        <div>
          <h1>Loyalty Points</h1>
          <p className="muted">
            Customer LP wallets, 5% purchase awards, spending vouchers,
            service fees, and partner settlements.
          </p>
        </div>
        <a className="button secondary rewards-audit-export" href="/api/dashboard/rewards/audit/export">
          Export audit CSV
        </a>
      </header>

      <div className="admin-grid rewards-dashboard-grid">
        {[
          ["Wallets", overview.summary.wallets],
          ["Outstanding LP", overview.summary.outstandingCredit],
          // Part of the figure above, not a separate liability: what customers
          // hold in partner buckets and can only spend where they earned it.
          ["Held at Partners", overview.summary.outstandingPartnerCredit],
          ["Lifetime LP Earned", overview.summary.lifetimeEarned],
          ["Converted to LP Vouchers", overview.summary.lifetimeConverted],
          ["Pending Partner Payout", overview.summary.pendingSettlement],
          ["Pending Service Fees", overview.summary.pendingServiceFees],
          ["Pending LP Payments", overview.summary.pendingSettlementCount],
          ["Held Reviews", overview.summary.heldReviewCount],
        ].map(([label, value]) => (
          <article className="card metric span-4" key={label}>
            <span className="muted">{label}</span>
            <strong>{value}</strong>
          </article>
        ))}

        <section className="panel span-12 table-wrap">
          <div className="admin-topbar">
            <div>
              <h2>Recent Loyalty Points</h2>
              <p className="muted">LP issued when staff scan a customer wallet QR and enter the paid amount.</p>
            </div>
          </div>
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Customer</th>
                <th>Business</th>
                <th>Purchase (₱)</th>
                <th>5% LP Earned</th>
                <th>Staff</th>
                <th>Fraud Monitor</th>
                <th>Review</th>
              </tr>
            </thead>
            <tbody>
              {overview.purchases.length === 0 ? (
                <tr>
                  <td colSpan={8}>No Loyalty Points purchases yet.</td>
                </tr>
              ) : (
                overview.purchases.map((purchase) => (
                  <tr key={purchase.id}>
                    <td>{formatDateTime(purchase.createdAt)}</td>
                    <td>{purchase.maskedPhone}</td>
                    <td>{purchase.businessName}</td>
                    <td>{purchase.purchaseAmount}</td>
                    <td>{purchase.rewardAmount}</td>
                    <td>{purchase.staffName}</td>
                    <td>
                      {purchase.fraudFlag ? (
                        <span className="badge warning">{purchase.fraudFlag.replace(/_/g, " ")}</span>
                      ) : (
                        <span className="badge success">Clear</span>
                      )}
                    </td>
                    <td>
                      {purchase.status === "Held" ? <HeldPurchaseActions purchaseId={purchase.id} /> : purchase.status}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </section>

        <section className="panel span-12 table-wrap">
          <div className="admin-topbar">
            <div>
              <h2>LP Usage & Partner Settlement</h2>
              <p className="muted">LP payments settle during the first week of the following month, after the 10% service fee.</p>
            </div>
          </div>
          <table>
            <thead>
              <tr>
                <th>Voucher Payment Date</th>
                <th>Customer Ref</th>
                <th>LP Voucher</th>
                <th>Store / Branch</th>
                <th>LP Spent</th>
                <th>10% Service Fee (LP)</th>
                <th>Partner Payout (90%)</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {overview.redemptions.length === 0 ? (
                <tr>
                  <td colSpan={9}>No LP voucher payments yet.</td>
                </tr>
              ) : (
                overview.redemptions.map((redemption) => (
                  <tr key={redemption.id}>
                    <td>{formatDateTime(redemption.createdAt)}</td>
                    <td>{redemption.maskedPhone}</td>
                    <td>{redemption.voucherCode}</td>
                    <td>{redemption.businessName}</td>
                    <td>{redemption.amount}</td>
                    <td>{redemption.serviceFee}</td>
                    <td>{redemption.settlementAmount}</td>
                    <td><span className={settlementBadgeClass(redemption.settlementStatus)}>{redemption.settlementStatus}</span></td>
                    <td>
                      <SettlementRowActions
                        redemptionId={redemption.id}
                        settlementId={redemption.settlementId}
                        settlementEligible={redemption.settlementEligible}
                        settlementWindow={redemption.settlementWindow}
                        status={redemption.settlementStatus}
                      />
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </section>
      </div>
    </>
  );
}
