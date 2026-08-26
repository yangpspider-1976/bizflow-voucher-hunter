import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { currentSession } from "@/server/dashboard-data";
import { formatLoyaltyPoints, partnerBalanceTotal } from "@/lib/loyalty-display";
import { toDisplayPhone } from "@/lib/phone-display";
import { listCustomers, type CustomerSummary } from "@/server/customers";
import { CustomerSearch } from "../_components/CustomerSearch";
import { ClickableCustomerRow } from "./ClickableCustomerRow";

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleDateString("en-PH", { year: "numeric", month: "short", day: "numeric" });
}

/** Everything a customer holds: the global pot plus every partner bucket. */
function loyaltyTotalCentavos(customer: CustomerSummary) {
  return (
    (customer.loyaltyBalanceCentavos ?? 0) + partnerBalanceTotal(customer.partnerBalances)
  );
}

/**
 * The split under the total.
 *
 * One figure on its own would read as a single spendable balance, and it is
 * not: partner points spend only at the partner that issued them, so the column
 * says how much of the total is locked that way.
 */
function loyaltyBreakdown(customer: CustomerSummary) {
  const parts = [`Global ${formatLoyaltyPoints(customer.loyaltyBalanceCentavos ?? 0)}`];
  const partners = customer.partnerBalances;
  if (partners.length > 0) {
    parts.push(
      `${partners.length} partner${partners.length === 1 ? "" : "s"} ${formatLoyaltyPoints(
        partnerBalanceTotal(partners),
      )}`,
    );
  }
  return parts.join(" · ");
}

/**
 * People, rather than campaign rows.
 *
 * `users` is keyed per campaign, so someone who joins three campaigns has three
 * rows. This page groups by phone — the stable identity across campaigns, and
 * the one the loyalty wallet is keyed by too.
 */
export default async function UsersPage({
  searchParams,
}: {
  searchParams: { q?: string };
}) {
  const session = await currentSession();
  if (!session) redirect("/login");

  const customers = await listCustomers(session, searchParams.q);

  return (
    <>
      <header className="admin-topbar">
        <div>
          <h1>Users</h1>
          <p className="muted">
            {session.role === "staff"
              ? "Customers who joined your campaigns."
              : "Customers across every campaign, with their vouchers and activity."}
          </p>
        </div>
      </header>

      <section className="panel table-wrap">
        <CustomerSearch initialQuery={searchParams.q ?? ""} />

        <table className="admin-table">
          <thead>
            <tr>
              <th>Customer</th>
              <th>Campaigns</th>
              <th>Vouchers</th>
              <th>Redeemed</th>
              <th>Loyalty Points</th>
              <th>Last activity</th>
            </tr>
          </thead>
          <tbody>
            {customers.length === 0 ? (
              <tr>
                <td className="muted" colSpan={6}>
                  {searchParams.q
                    ? "No customers match that search."
                    : "No customers yet. They appear here once someone starts a hunt."}
                </td>
              </tr>
            ) : (
              customers.map((customer) => {
                const href = `/dashboard/users/${encodeURIComponent(customer.phone)}`;
                return (
                <ClickableCustomerRow key={customer.phone} href={href}>
                  <td>
                    <span className="customer-link">
                      {customer.name || toDisplayPhone(customer.phone)}
                    </span>
                    {customer.name ? (
                      <div className="muted customer-phone">{toDisplayPhone(customer.phone)}</div>
                    ) : null}
                  </td>
                  <td>{customer.campaignCount}</td>
                  <td>{customer.voucherCount}</td>
                  <td>{customer.redeemedCount}</td>
                  <td>
                    {customer.loyaltyBalanceCentavos === undefined &&
                    customer.partnerBalances.length === 0 ? (
                      <span className="muted">No wallet</span>
                    ) : (
                      <>
                        <strong>{formatLoyaltyPoints(loyaltyTotalCentavos(customer))}</strong>
                        <div className="muted customer-phone">
                          {loyaltyBreakdown(customer)}
                        </div>
                      </>
                    )}
                  </td>
                  <td>{formatDate(customer.lastActivityAt)}</td>
                </ClickableCustomerRow>
                );
              })
            )}
          </tbody>
        </table>
      </section>
    </>
  );
}
