import { FiAlertTriangle } from "react-icons/fi";
import { cachedBusinesses, currentSession } from "@/server/dashboard-data";
import {
  businessBillingOverview,
  centavosToMoney,
  manilaDateParts,
} from "@/server/rewards-network";
import { partnerGamificationStatement } from "@/server/gamification/settlement";
import { BillingActions } from "../_components/BillingActions";
import { ScopeSelector } from "../_components/ScopeSelector";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/** The month before this one — the only period that can be closed. */
function previousPeriod(period: string) {
  const [year, month] = period.split("-").map(Number);
  const previous = new Date(Date.UTC(year, month - 2, 1));
  return `${previous.getUTCFullYear()}-${String(previous.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** "2026-08" -> "August 2026". Read by finance staff, not sorted by them. */
function periodLabel(period: string) {
  const [year, month] = period.split("-").map(Number);
  if (!year || !month || month < 1 || month > 12) return period;
  return `${new Date(Date.UTC(2000, month - 1, 1)).toLocaleString("en-US", {
    month: "long",
    timeZone: "UTC",
  })} ${year}`;
}

export default async function BillingPage({
  searchParams,
}: {
  searchParams: { business?: string };
}) {
  const [session, businesses] = await Promise.all([
    currentSession(),
    cachedBusinesses(),
  ]);
  // Staff see only their own partner; admins pick from all of them. Unlike the
  // campaign-scoped pages this is not filtered to businesses that run a
  // campaign — a partner still owes for LP their checkout issued either way.
  const visible =
    session?.role === "staff"
      ? businesses.filter((item) => session.businessIds.includes(item.id))
      : businesses;

  if (visible.length === 0) {
    return (
      <section className="panel">
        <h2>No business access</h2>
        <p className="muted">
          Ask an administrator to assign this account to a business.
        </p>
      </section>
    );
  }

  const business =
    visible.find((item) => item.id === searchParams.business) ?? visible[0];
  const overview = await businessBillingOverview(business.id);
  // The five lines §6.2 asks the settlement report to separate. Two of them are
  // the net above; the other three are new with levels and missions and are
  // reported without being billed, because the settlement policy itself has not
  // changed.
  const gamification = await partnerGamificationStatement({
    businessId: business.id,
    period: manilaDateParts().period,
  });
  const { current, deposit, deposits, statements } = overview;
  const closable = previousPeriod(manilaDateParts().period);
  const alreadyClosed = statements.some((row) => row.period === closable);
  const monthLabel = periodLabel(current.period);
  const closableLabel = periodLabel(closable);
  // "Owes" language only makes sense once something has actually moved.
  const settling = current.netCentavos !== 0;
  const projectedDeposit = centavosToMoney(
    deposit.balanceCentavos - current.depositDeductionCentavos,
  );

  return (
    <>
      <header className="admin-topbar">
        <div>
          <h1>LP Billing</h1>
          <p className="muted">
            What a partner owes for Loyalty Points issued, what they are owed
            for LP spent with them, and the deposit both settle against.
          </p>
        </div>
      </header>

      <ScopeSelector
        businesses={visible}
        campaigns={[]}
        selectedBusinessId={business.id}
        showBusiness={session?.role !== "staff"}
      />

      {deposit.blocked ? (
        <p className="alert">
          <FiAlertTriangle aria-hidden="true" />{" "}
          <strong>Deposit exhausted — LP issuing is paused.</strong> This
          partner&apos;s checkout cannot award Loyalty Points until the deposit is
          topped up. {deposit.topUpDue} brings them back to the{" "}
          {deposit.minimum} minimum.
        </p>
      ) : deposit.belowMinimum ? (
        <p className="alert">
          <FiAlertTriangle aria-hidden="true" />{" "}
          <strong>Deposit below the {deposit.minimum} minimum.</strong> Trading
          continues, but {deposit.topUpDue} is due to restore it. Issuing stops
          only if the deposit reaches zero.
        </p>
      ) : null}

      {/* Same modifier the Loyalty Points overview uses: metric values in this
          area are money, and full-weight figures at 1.55rem shout. Only the
          deposit is a headline figure — the month's arithmetic reads as a
          running total below, where each line can be labelled with who owes
          whom rather than guessed at from a card title. */}
      <div className="admin-grid rewards-dashboard-grid">
        {[
          ["Deposit balance", deposit.balance],
          ["Network minimum", deposit.minimum],
          [
            settling
              ? current.direction === "Collection"
                ? "Partner owes us so far"
                : "We owe partner so far"
              : "Balance so far",
            current.net,
          ],
        ].map(([label, value]) => (
          <article className="card metric span-4" key={label}>
            <span className="muted">{label}</span>
            <strong>{value}</strong>
          </article>
        ))}

        <section className="panel span-12 table-wrap">
          <div className="admin-topbar">
            <div>
              <h2 className="billing-period-title">
                <span>{monthLabel}</span>
                <span className="badge warning">Still open</span>
              </h2>
              <p className="muted">
                A running total, not a bill. Nothing moves until the month ends
                and the statement is closed.
              </p>
            </div>
          </div>
          <table>
            <thead>
              <tr>
                <th>Line</th>
                <th>Movements</th>
                <th>Amount</th>
                <th>Settles as</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>LP awarded to customers</td>
                <td className="muted">
                  {current.issuedCount} purchase
                  {current.issuedCount === 1 ? "" : "s"} paid in cash
                </td>
                <td>{current.issued}</td>
                <td className="muted">Charge to partner</td>
              </tr>
              <tr>
                <td>LP redeemed by customers</td>
                <td className="muted">
                  {current.redeemedCount} redemption
                  {current.redeemedCount === 1 ? "" : "s"} at this partner
                </td>
                <td>{current.redeemed}</td>
                <td className="muted">Credit to partner</td>
              </tr>
              <tr>
                <td>Net</td>
                <td className="muted">redeemed − awarded</td>
                <td>{current.net}</td>
                <td>
                  {settling ? (
                    <span
                      className={`badge ${
                        current.direction === "Collection" ? "warning" : ""
                      }`}
                    >
                      {current.direction === "Collection"
                        ? "In our favour"
                        : "In partner's favour"}
                    </span>
                  ) : (
                    <span className="muted">Balanced</span>
                  )}
                </td>
              </tr>
              <tr>
                <td>Service fee (10%)</td>
                <td className="muted">
                  {current.direction === "Payout"
                    ? "taken from the net payout"
                    : "only applies when we pay out"}
                </td>
                <td>{current.serviceFee}</td>
                <td className="muted">
                  {current.direction === "Payout" ? "Retained by us" : "—"}
                </td>
              </tr>
              <tr>
                <td>
                  {current.direction === "Collection"
                    ? "Deducted from deposit"
                    : "Paid to partner"}
                </td>
                <td className="muted">if the month closed now</td>
                <td>
                  {current.direction === "Collection"
                    ? current.depositDeduction
                    : current.payout}
                </td>
                <td className="muted">
                  {current.direction === "Collection"
                    ? `Deposit falls to ${projectedDeposit}`
                    : "Manual transfer"}
                </td>
              </tr>
            </tbody>
          </table>
        </section>

        <section className="panel span-12 table-wrap">
          <div className="admin-topbar">
            <div>
              <h2>Where the Loyalty Points went</h2>
              <p className="muted">
                Every movement this partner was party to this month, by cause.
                The two billed lines are the net above. The rest are reported
                for the record — mission rewards come out of a campaign budget
                the partner already funded, and a level conversion extinguishes
                the liability rather than creating one, so neither changes what
                is owed under the current settlement policy.
              </p>
            </div>
            <a
              className="button secondary"
              href={`/api/dashboard/rewards/settlements/gamification?business=${business.id}&period=${gamification.period}&format=csv`}
            >
              Export CSV
            </a>
          </div>
          <table>
            <thead>
              <tr>
                <th>Line</th>
                <th>Movements</th>
                <th>Amount</th>
                <th>In the bill</th>
              </tr>
            </thead>
            <tbody>
              {gamification.lines.map((line) => (
                <tr key={line.kind}>
                  <td>
                    {line.label}
                    <br />
                    <span className="muted">{line.note}</span>
                  </td>
                  <td className="muted">{line.count}</td>
                  <td>{line.amount}</td>
                  <td>
                    <span className={line.billed ? "badge" : "badge neutral"}>
                      {line.billed ? "Billed" : "Memo"}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section className="panel span-12 billing-month-end-panel">
          <h2>Month end</h2>
          <p className="muted">
            Closing nets {closableLabel} in one statement and settles it —
            against the deposit if the partner owes us, or as a payout we then
            transfer and record. Deposits can be taken at any time.
          </p>
          {/* Below the explanation rather than beside the heading: these act on
              a period the copy has to introduce first. */}
          <div className="admin-form-actions billing-month-end-actions">
            <BillingActions
              businessId={business.id}
              closablePeriod={closable}
              closed={alreadyClosed}
              isDev={process.env.NODE_ENV !== "production"}
            />
          </div>
        </section>

        <section className="panel span-12 table-wrap">
          <div className="admin-topbar">
            <div>
              <h2>Monthly statements</h2>
              <p className="muted">
                One closed statement per month, netting both sides.
              </p>
            </div>
          </div>
          <table>
            <thead>
              <tr>
                <th>Period</th>
                <th>LP issued</th>
                <th>LP redeemed</th>
                <th>Net</th>
                <th>Service fee</th>
                <th>Payout</th>
                <th>From deposit</th>
                <th>Status</th>
                <th>Reference</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {statements.length === 0 ? (
                <tr>
                  <td colSpan={10}>
                    No month has been closed for this partner yet.
                  </td>
                </tr>
              ) : (
                statements.map((row) => (
                  <tr key={row.id}>
                    <td>{row.period}</td>
                    <td>{row.issued}</td>
                    <td>{row.redeemed}</td>
                    <td>
                      {row.net}
                      {row.direction === "Payout" ? (
                        <span className="muted"> to partner</span>
                      ) : row.direction === "Collection" ? (
                        <span className="muted"> to us</span>
                      ) : null}
                    </td>
                    <td>{row.serviceFee}</td>
                    <td>{row.payout}</td>
                    <td>{row.depositDeduction}</td>
                    <td>
                      <span
                        className={`badge ${
                          row.status === "Paid" || row.status === "Collected"
                            ? ""
                            : "warning"
                        }`}
                      >
                        {row.status}
                      </span>
                    </td>
                    <td>{row.paymentReference || "—"}</td>
                    <td>
                      {row.direction === "Payout" && !row.paidAt ? (
                        <BillingActions
                          businessId={business.id}
                          payableStatementId={row.id}
                        />
                      ) : null}
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
              <h2>Deposit ledger</h2>
              <p className="muted">
                Every movement against the deposit. The balance above is the sum
                of these rows.
              </p>
            </div>
          </div>
          <table>
            <thead>
              <tr>
                <th>Recorded</th>
                <th>Type</th>
                <th>Amount</th>
                <th>Balance after</th>
                <th>Reference</th>
                <th>Note</th>
                <th>By</th>
              </tr>
            </thead>
            <tbody>
              {deposits.length === 0 ? (
                <tr>
                  <td colSpan={7}>No deposit movements recorded.</td>
                </tr>
              ) : (
                deposits.map((entry) => (
                  <tr key={entry.id}>
                    <td>{entry.createdAt.slice(0, 10)}</td>
                    <td>
                      <span
                        className={`badge ${
                          entry.amountCentavos < 0 ? "warning" : ""
                        }`}
                      >
                        {entry.type}
                      </span>
                    </td>
                    <td>{entry.amount}</td>
                    <td>{entry.balanceAfter}</td>
                    <td>{entry.reference || "—"}</td>
                    <td>{entry.note || "—"}</td>
                    <td>{entry.recordedBy}</td>
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
