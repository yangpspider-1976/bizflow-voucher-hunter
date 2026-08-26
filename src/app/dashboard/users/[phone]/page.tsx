import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { FiArrowLeft } from "react-icons/fi";
import { formatLoyaltyPoints, partnerBalanceTotal } from "@/lib/loyalty-display";
import { toDisplayPhone } from "@/lib/phone-display";
import { AppError } from "@/server/errors";
import { getCustomer } from "@/server/customers";
import { currentSession } from "@/server/dashboard-data";

function formatDateTime(value?: string) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleString("en-PH", {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
}

function formatDate(value?: string) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleDateString("en-PH", { year: "numeric", month: "short", day: "numeric" });
}

/** Redeemed reads as success; terminal-but-unused reads as a problem. */
function statusBadge(status: string) {
  if (status === "Redeemed") return "badge";
  if (status === "Expired" || status === "Cancelled" || status === "NoShow") {
    return "badge danger";
  }
  return "badge warning";
}

export default async function CustomerDetailPage({
  params,
}: {
  params: { phone: string };
}) {
  const session = await currentSession();
  if (!session) redirect("/login");

  const phone = decodeURIComponent(params.phone);

  let customer;
  try {
    customer = await getCustomer(session, phone);
  } catch (error) {
    // Out of scope for this session reads as "not found", so staff cannot probe
    // for customers belonging to other businesses.
    if (error instanceof AppError && error.status === 404) notFound();
    throw error;
  }

  const { summary, campaigns, vouchers } = customer;
  const partners = summary.partnerBalances;
  // A bucket cannot exist without a wallet, but a wallet can exist with no
  // buckets — so either one present means there are points to show.
  const hasWallet = summary.loyaltyBalanceCentavos !== undefined || partners.length > 0;
  const loyaltyTotal = formatLoyaltyPoints(
    (summary.loyaltyBalanceCentavos ?? 0) + partnerBalanceTotal(partners),
  );

  return (
    <>
      <header className="admin-topbar">
        <div>
          <Link className="form-page-back" href="/dashboard/users">
            <FiArrowLeft aria-hidden="true" />
            All users
          </Link>
          <h1>{summary.name || toDisplayPhone(summary.phone)}</h1>
          <p className="muted">
            {summary.name ? `${toDisplayPhone(summary.phone)} · ` : ""}
            First seen {formatDate(summary.firstSeenAt)}
          </p>
        </div>
      </header>

      {/* The same stat card the dashboard overview uses — uppercase micro-label
          over a large figure. The two contact tiles carry text rather than a
          count, so they take the figure size down a step: an email set at
          1.75rem wraps to three lines and stops reading as a card. */}
      <section className="customer-summary">
        <div className="customer-stats">
          <article className="card metric metric-text">
            <span className="muted">Mobile number</span>
            <strong>{toDisplayPhone(summary.phone)}</strong>
          </article>
          <article className="card metric metric-text">
            <span className="muted">Email</span>
            <strong>{summary.email || "—"}</strong>
          </article>
          <article className="card metric">
            <span className="muted">Campaigns joined</span>
            <strong>{summary.campaignCount}</strong>
          </article>
          <article className="card metric">
            <span className="muted">Vouchers issued</span>
            <strong>{summary.voucherCount}</strong>
          </article>
          <article className="card metric">
            <span className="muted">Redeemed</span>
            <strong>{summary.redeemedCount}</strong>
          </article>
          <article className="card metric">
            <span className="muted">Loyalty Points</span>
            <strong>{hasWallet ? loyaltyTotal : "No wallet"}</strong>
          </article>
        </div>
      </section>

      {/* The tile above is every pot added together, which is not a figure the
          customer can spend in one place. This is the breakdown behind it: the
          global pot, then one row per partner they have earned at. */}
      <section className="panel table-wrap">
        <div className="admin-topbar">
          <div>
            <h2>Loyalty Points</h2>
            <p className="muted">
              Points earned at a partner stay with that partner — spendable on its
              storefront, or moved to the global pot for a fee.
            </p>
          </div>
        </div>
        <table className="admin-table">
          <thead>
            <tr>
              <th>Pot</th>
              <th>Balance</th>
              <th>Lifetime earned</th>
              <th>Moved to global</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <strong>Global</strong>
                <div className="muted customer-phone">
                  Daily rewards and referrals · spendable anywhere
                </div>
              </td>
              <td>
                {summary.loyaltyBalanceCentavos === undefined ? (
                  <span className="muted">No wallet</span>
                ) : (
                  formatLoyaltyPoints(summary.loyaltyBalanceCentavos)
                )}
              </td>
              {/* The wallet's lifetime counters cover every pot, so printing
                  them on this row would double-count the partner rows below. */}
              <td className="muted">—</td>
              <td className="muted">—</td>
            </tr>
            {partners.length === 0 ? (
              <tr>
                <td className="muted" colSpan={4}>
                  No points earned at a partner yet.
                </td>
              </tr>
            ) : (
              partners.map((partner) => (
                <tr key={partner.businessId}>
                  <td>
                    <strong>{partner.businessName}</strong>
                  </td>
                  <td>{formatLoyaltyPoints(partner.balanceCentavos)}</td>
                  <td>{formatLoyaltyPoints(partner.lifetimeEarnedCentavos)}</td>
                  <td>{formatLoyaltyPoints(partner.lifetimeTransferredCentavos)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </section>

      <section className="panel table-wrap">
        <div className="admin-topbar">
          <div>
            <h2>Campaigns joined</h2>
            <p className="muted">Every campaign this number has started a hunt on.</p>
          </div>
        </div>
        <table className="admin-table">
          <thead>
            <tr>
              <th>Campaign</th>
              <th>Business</th>
              <th>Joined</th>
              <th>Attempts</th>
              <th>Outcome</th>
            </tr>
          </thead>
          <tbody>
            {campaigns.length === 0 ? (
              <tr>
                <td className="muted" colSpan={5}>
                  No campaign activity.
                </td>
              </tr>
            ) : (
              campaigns.map((campaign) => (
                <tr key={campaign.campaignId}>
                  <td>
                    <strong>{campaign.campaignTitle}</strong>
                  </td>
                  <td>{campaign.businessName}</td>
                  <td>{formatDate(campaign.joinedAt)}</td>
                  <td>{campaign.attemptCount}</td>
                  <td>
                    {campaign.hasVoucher ? (
                      <span className="badge">Voucher issued</span>
                    ) : (
                      <span className="badge warning">Hunting</span>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </section>

      <section className="panel table-wrap">
        <div className="admin-topbar">
          <div>
            <h2>Vouchers</h2>
            <p className="muted">Issued vouchers and where each one ended up.</p>
          </div>
        </div>
        <table className="admin-table">
          <thead>
            <tr>
              <th>Voucher</th>
              <th>Campaign</th>
              <th>Reserved slot</th>
              <th>Issued</th>
              <th>Redeemed</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {vouchers.length === 0 ? (
              <tr>
                <td className="muted" colSpan={6}>
                  No vouchers issued to this customer.
                </td>
              </tr>
            ) : (
              vouchers.map((voucher) => (
                <tr key={voucher.id}>
                  <td>
                    <strong>{voucher.displayLabel}</strong>
                    <div className="muted customer-phone">{voucher.code}</div>
                  </td>
                  <td>
                    {voucher.campaignTitle}
                    <div className="muted customer-phone">{voucher.businessName}</div>
                  </td>
                  <td>
                    {voucher.slotDate
                      ? `${formatDate(voucher.slotDate)}${voucher.slotStartTime ? ` · ${voucher.slotStartTime}` : ""}`
                      : "—"}
                  </td>
                  <td>{formatDate(voucher.issuedAt)}</td>
                  <td>{formatDateTime(voucher.redeemedAt)}</td>
                  <td>
                    <span className={statusBadge(voucher.status)}>{voucher.status}</span>
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
