"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { FiCheck, FiRefreshCw, FiShield, FiX } from "react-icons/fi";
import { api } from "@/lib/api-client";
import type { Business } from "@/types/voucher";

type CreditResult = {
  rewardAmount: string;
  /** What the customer holds *at this business* — the pot the award lands in. */
  balance: string;
  /** Their spend-anywhere pot, which a purchase award never touches. */
  globalBalance: string;
  fraudFlag?: string;
  heldForReview?: boolean;
  idempotentReplay?: boolean;
};

/**
 * Points earned at a checkout are held against the partner that issued them, so
 * "wallet balance" on its own named the wrong pot: staff read the figure as
 * spend-anywhere credit, and the global pot it suggested had not moved at all.
 */
function balanceDetail(businessName: string, result: CreditResult) {
  return `${businessName}: ${result.balance} · Global: ${result.globalBalance}`;
}

export function RewardsStaffTools({
  business,
}: {
  business: Pick<Business, "id" | "name">;
}) {
  const router = useRouter();
  const businessId = business.id;
  const [walletToken, setWalletToken] = useState("");
  const [purchaseAmount, setPurchaseAmount] = useState("");
  const [creditIdempotencyKey, setCreditIdempotencyKey] = useState(() => crypto.randomUUID());
  const [toast, setToast] = useState<{ tone: "success" | "error"; title: string; detail?: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!toast) return;
    const timeout = window.setTimeout(() => setToast(null), 4200);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  function showError(error: unknown, fallback: string) {
    setToast({ tone: "error", title: error instanceof Error ? error.message : fallback });
  }

  async function creditWallet() {
    setBusy(true);
    try {
      const result = await api<CreditResult>("/api/staff/rewards/credit", {
        method: "POST",
        body: JSON.stringify({
          walletToken: walletToken.trim(),
          businessId,
          purchaseAmount,
          idempotencyKey: creditIdempotencyKey,
        }),
      });
      setCreditIdempotencyKey(crypto.randomUUID());
      if (result.heldForReview) {
        setToast({
          tone: "error",
          title: "Loyalty Points held for review",
          detail: result.fraudFlag?.replace(/_/g, " ") ?? "Suspicious activity",
        });
      } else if (result.idempotentReplay) {
        setToast({
          tone: "success",
          title: "Duplicate request safely ignored",
          detail: `Existing LP: ${result.rewardAmount} · ${balanceDetail(business.name, result)}`,
        });
      } else {
        setToast({
          tone: "success",
          title: `${result.rewardAmount} added`,
          detail: balanceDetail(business.name, result),
        });
      }
      router.refresh();
    } catch (error) {
      showError(error, "Unable to add Loyalty Points.");
    } finally {
      setBusy(false);
    }
  }

  const canCredit = walletToken.trim().length > 10 && businessId && purchaseAmount.trim();

  return (
    <section className="panel span-12 rewards-staff-tools">
      <div className="admin-topbar">
        <div>
          <h2>Award points without a voucher</h2>
          <p className="muted">
            For a customer who simply bought something, with no voucher to
            scan. If they presented a booking voucher or an LP code, use{" "}
            <a href="/dashboard/staff">Scan &amp; Redeem</a> instead — a
            voucher already awards its 5% when you mark it used, so entering
            the sale here as well would pay it twice.
          </p>
        </div>
        <span className="badge success">
          <FiShield aria-hidden="true" />
          Audit logged
        </span>
      </div>

      {/* One tool, so no inner card: the panel is the card. A two-column grid
          with a single child left half the row empty. */}
      <div className="rewards-award-form">
        <label className="field">
          <span>Customer Wallet QR Token</span>
          <input
            value={walletToken}
            onChange={(event) => setWalletToken(event.target.value)}
            placeholder="Scan or paste customer wallet token"
          />
        </label>
        <label className="field">
          <span>Actual Paid Amount (₱)</span>
          <input
            inputMode="decimal"
            value={purchaseAmount}
            onChange={(event) => setPurchaseAmount(event.target.value)}
            placeholder="0.00"
          />
          <small className="muted">
            The customer earns 5% of this. ₱1,000 becomes 50 LP.
          </small>
        </label>
        <button className="button" disabled={!canCredit || busy} onClick={creditWallet} type="button">
          {busy ? <FiRefreshCw aria-hidden="true" /> : <FiCheck aria-hidden="true" />}
          Add Loyalty Points
        </button>
      </div>

      {toast ? (
        <div className="rewards-snackbar" role="status" aria-live="polite">
          <span className="rewards-snackbar-copy">
            <strong>{toast.title}</strong>
            {toast.detail ? <small>{toast.detail}</small> : null}
          </span>
          <button
            aria-label="Dismiss notification"
            className="rewards-snackbar-close"
            onClick={() => setToast(null)}
            type="button"
          >
            <FiX aria-hidden="true" />
          </button>
        </div>
      ) : null}
    </section>
  );
}
