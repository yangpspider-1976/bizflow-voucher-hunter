import Link from "next/link";
import { redirect } from "next/navigation";
import { isTransactionKind, transactionKindLabel } from "@/lib/transaction-kinds";
import { formatDateTime } from "@/lib/datetime-display";
import { toDisplayPhone } from "@/lib/phone-display";
import { cachedBusinesses, currentSession } from "@/server/dashboard-data";
import { centavosToLoyaltyPoints, centavosToMoney } from "@/server/rewards-network";
import { listTransactions, TRANSACTIONS_PAGE_SIZE } from "@/server/transactions";
import { TransactionFilters } from "../_components/TransactionFilters";

// Every row is a movement recorded seconds ago by a checkout. A cached page would
// show an operator a list that is missing the sale they just rang up.
export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * Held and rejected awards, and unsettled LP, are the rows an operator is
 * looking for; everything that simply worked reads as neutral.
 */
function statusBadge(status: string) {
  if (status === "Held" || status === "Pending") return "badge warning";
  if (status === "Rejected") return "badge danger";
  if (status === "Redeemed" || status === "Accepted" || status === "Completed") {
    return "badge success";
  }
  return "badge";
}

export default async function TransactionsPage({
  searchParams,
}: {
  searchParams: {
    business?: string;
    kind?: string;
    from?: string;
    to?: string;
    q?: string;
    page?: string;
  };
}) {
  const [session, businesses] = await Promise.all([
    currentSession(),
    cachedBusinesses(),
  ]);
  if (!session) redirect("/login");

  const isStaff = session.role === "staff";
  // Staff pick from their own partners only. The server narrows to them
  // regardless, so this is about not offering a choice that does nothing.
  const selectable = isStaff
    ? businesses.filter((business) => session.businessIds.includes(business.id))
    : businesses;

  const filters = {
    businessId: searchParams.business || undefined,
    kind: isTransactionKind(searchParams.kind) ? searchParams.kind : undefined,
    from: searchParams.from || undefined,
    to: searchParams.to || undefined,
    search: searchParams.q || undefined,
    page: Number(searchParams.page) || 1,
  };

  const { rows, totals, page, hasMore } = await listTransactions(session, filters);

  // Figures for everything the filters match, not just this page — see
  // listTransactions. The service fee is deliberately not a card: it is charged
  // on the month's net over on LP Billing, so at this level it reads as zero.
  const summaryCards: [string, string][] = [
    ["Transactions", totals.count.toLocaleString("en-PH")],
    ["Vouchers redeemed", totals.voucherRedemptionCount.toLocaleString("en-PH")],
    ["Sales recorded", centavosToMoney(totals.salesCentavos)],
    ["LP earned", centavosToLoyaltyPoints(totals.lpEarnedCentavos)],
    ["LP spent", centavosToLoyaltyPoints(totals.lpSpentCentavos)],
    ["Partner payout", centavosToLoyaltyPoints(totals.settlementCentavos)],
  ];

  // Taken from what the query actually ran with, not from the raw query string,
  // so an unrecognised `kind=` neither narrows the list nor claims to have.
  const activeFilters = {
    business: filters.businessId ?? "",
    kind: filters.kind ?? "",
    from: filters.from ?? "",
    to: filters.to ?? "",
    q: filters.search ?? "",
  };
  const anyFilter = Object.values(activeFilters).some(Boolean);

  // Paging keeps whatever filters are in effect; only the page number moves.
  const pageHref = (target: number) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(activeFilters)) {
      if (value) params.set(key, value);
    }
    if (target > 1) params.set("page", String(target));
    const query = params.toString();
    return query ? `/dashboard/transactions?${query}` : "/dashboard/transactions";
  };

  const firstOnPage = (page - 1) * TRANSACTIONS_PAGE_SIZE + 1;
  const lastOnPage = (page - 1) * TRANSACTIONS_PAGE_SIZE + rows.length;

  return (
    <>
      <header className="admin-topbar">
        <div>
          <h1>Transactions</h1>
          <p className="muted">
            Every voucher redeemed, every Loyalty Point earned and every LP
            payment taken, newest first.
          </p>
        </div>
      </header>

      {/* The table lives inside the metric grid, as it does on Loyalty Points
          and LP Billing. Outside it the panel was a bare sibling with no margin
          and sat flush against the bottom row of cards. */}
      <div className="admin-grid rewards-dashboard-grid">
        {summaryCards.map(([label, value]) => (
          <article className="card metric span-4" key={label}>
            <span className="muted">{label}</span>
            <strong>{value}</strong>
          </article>
        ))}

        <section className="panel span-12 table-wrap">
          <TransactionFilters
            businesses={selectable}
            initial={activeFilters}
            showBusiness={selectable.length > 1}
          />

          <table className="admin-table">
            <thead>
              <tr>
                <th>When</th>
                <th>Type</th>
                <th>Customer</th>
                <th>Business</th>
                <th>Detail</th>
                <th>Paid</th>
                <th>Loyalty Points</th>
                <th>Staff</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td className="muted" colSpan={9}>
                    {/* `totals.count` describes the filtered set, so it is 0 for a
                        search that matched nothing as well as for a business that
                        has never traded. Only the absence of filters tells the two
                        apart. */}
                    {anyFilter
                      ? "No transactions match these filters."
                      : "No transactions yet. They appear here as soon as a checkout marks a voucher used or records a sale."}
                  </td>
                </tr>
              ) : (
                rows.map((row) => (
                  <tr key={`${row.kind}-${row.id}`}>
                    <td className="cell-nowrap">{formatDateTime(row.createdAt)}</td>
                    <td>
                      <span className={`transaction-kind is-${row.kind}`}>
                        {transactionKindLabel(row.kind)}
                      </span>
                    </td>
                    <td>
                      <Link
                        className="customer-link"
                        href={`/dashboard/users/${encodeURIComponent(row.phone)}`}
                      >
                        {row.customerName || toDisplayPhone(row.phone)}
                      </Link>
                      {row.customerName ? (
                        <div className="muted customer-phone">
                          {toDisplayPhone(row.phone)}
                        </div>
                      ) : null}
                    </td>
                    <td>
                      {row.businessName}
                      {row.campaignTitle ? (
                        <div className="muted customer-phone">{row.campaignTitle}</div>
                      ) : null}
                    </td>
                    <td>
                      <div className="cell-title">
                        {row.detail ?? transactionKindLabel(row.kind)}
                      </div>
                      {row.reference ? (
                        <div className="muted customer-phone">{row.reference}</div>
                      ) : null}
                      {row.note ? (
                        <div className="muted customer-phone">{row.note}</div>
                      ) : null}
                    </td>
                    <td className="cell-numeric">
                      {row.purchaseCentavos === undefined ? (
                        <span className="muted">—</span>
                      ) : (
                        centavosToMoney(row.purchaseCentavos)
                      )}
                    </td>
                    <td className="cell-numeric">
                      {row.loyaltyDeltaCentavos === undefined ? (
                        <span className="muted">—</span>
                      ) : (
                        <span
                          className={
                            row.loyaltyDeltaCentavos < 0
                              ? "transaction-lp is-spent"
                              : "transaction-lp is-earned"
                          }
                        >
                          {row.loyaltyDeltaCentavos > 0 ? "+" : ""}
                          {centavosToLoyaltyPoints(row.loyaltyDeltaCentavos)}
                        </span>
                      )}
                      {row.serviceFeeCentavos ? (
                        <div className="muted customer-phone">
                          fee {centavosToLoyaltyPoints(row.serviceFeeCentavos)} · payout{" "}
                          {centavosToLoyaltyPoints(row.settlementCentavos ?? 0)}
                        </div>
                      ) : null}
                    </td>
                    <td>{row.staffName}</td>
                    <td>
                      <span className={statusBadge(row.status)}>{row.status}</span>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>

          {rows.length > 0 ? (
            <div className="transaction-pager">
              <span className="muted">
                Showing {firstOnPage.toLocaleString("en-PH")}–
                {lastOnPage.toLocaleString("en-PH")} of{" "}
                {totals.count.toLocaleString("en-PH")}
              </span>
              <div className="transaction-pager-actions">
                {page > 1 ? (
                  <Link className="button secondary" href={pageHref(page - 1)}>
                    Previous
                  </Link>
                ) : null}
                {hasMore ? (
                  <Link className="button secondary" href={pageHref(page + 1)}>
                    Next
                  </Link>
                ) : null}
              </div>
            </div>
            ) : null}
        </section>
      </div>
    </>
  );
}
