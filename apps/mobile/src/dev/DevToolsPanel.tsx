import type { CampaignCard } from "@bizflow/shared";
import { useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { StyleSheet, Text, View } from "react-native";

import { listCampaigns } from "@/api/client";
import { useAuth } from "@/auth/AuthContext";
import { Button, Field, InlineError, Select } from "@/components/FormControls";
import {
  clearDevPoolIds,
  devBuild,
  getDevPoolId,
  grantBusinessLoyaltyPoints,
  grantLoyaltyPoints,
  listDevPools,
  refreshMyVouchers,
  resetHunt,
  setDevPoolId,
  simulateCollection,
  simulatePurchase,
  type DevPoolOption,
} from "@/dev/devTools";
import { clearHuntProgress } from "@/hunt/progressStore";
import {
  publishHuntResetCompleted,
  publishHuntResetStarting,
} from "@/hunt/resetSignal";
import { colors, fonts, radius, spacing } from "@/theme";

/**
 * Port of the web More page's `.dev-voucher-picker`.
 *
 * The web panel is campaign-scoped because that page lives under
 * `/campaign/[slug]/more`. The app's More tab is global, so this adds a campaign
 * selector first and then applies both tools to whichever campaign is picked.
 *
 * Renders nothing unless this is a dev build or the session says the signed-in
 * number is the production developer account. The developer account gets the
 * self-scoped tools, LP grants included; only the two that bill a real partner
 * are held back to a dev build — see `@/dev/devTools`.
 */
export function DevToolsPanel() {
  const { devTools, token } = useAuth();
  const visible = devBuild || devTools;
  // Funding a wallet mints LP but bills nobody, so the developer account keeps
  // it in production — which today is everyone who sees this panel at all.
  // Named separately anyway: `visible` answers whether the panel belongs on the
  // More tab, this answers who may mint, and the two coincide only because the
  // server happens to draw its line in the same place.
  const lpToolsVisible = visible;
  // Simulating a checkout scan or a collection does bill a real partner, so
  // those stay on a dev build — see `@/dev/devTools`.
  const billingToolsVisible = devBuild;
  const router = useRouter();
  const [campaigns, setCampaigns] = useState<CampaignCard[]>([]);
  const [slug, setSlug] = useState("");
  const [pools, setPools] = useState<DevPoolOption[]>([]);
  const [poolId, setPoolId] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  // Enough for the dearest demo item (1,200 LP) in one tap.
  const [lpAmount, setLpAmount] = useState("1500");
  const [lpBusy, setLpBusy] = useState(false);
  // The earning side of the loop: pesos spent at a partner's checkout, of which 5%
  // becomes LP that the same partner is billed for.
  const [scanBusinessId, setScanBusinessId] = useState("");
  const [scanAmount, setScanAmount] = useState("1000");
  const [scanBusy, setScanBusy] = useState(false);
  const [collectCode, setCollectCode] = useState("");
  const [collectBusy, setCollectBusy] = useState(false);
  const [refreshBusy, setRefreshBusy] = useState(false);
  // The bucket side of the wallet: which partner, and how much to put in it.
  const [businessLpId, setBusinessLpId] = useState("");
  const [businessLpAmount, setBusinessLpAmount] = useState("1500");
  const [businessLpBusy, setBusinessLpBusy] = useState(false);

  useEffect(() => {
    if (!visible || !token) return;
    let active = true;
    void listCampaigns(token)
      .then((cards) => {
        if (!active) return;
        setCampaigns(cards);
        setSlug((current) => current || (cards[0]?.campaign.slug ?? ""));
        // Both partner pickers default to the first partner, so neither opens
        // on an empty select the tool then refuses to run against.
        const firstBusinessId = cards[0]?.campaign.businessId ?? "";
        setScanBusinessId((current) => current || firstBusinessId);
        setBusinessLpId((current) => current || firstBusinessId);
      })
      .catch(() => {
        if (active) setCampaigns([]);
      });
    return () => {
      active = false;
    };
  }, [token, visible]);

  useEffect(() => {
    if (!visible || !token || !slug) return;
    let active = true;
    void listDevPools(slug, token)
      .then((options) => {
        if (active) setPools(options);
      })
      .catch(() => {
        if (active) setPools([]);
      });
    void getDevPoolId(slug).then((stored) => {
      if (active) setPoolId(stored);
    });
    return () => {
      active = false;
    };
  }, [slug, token, visible]);

  // Campaign cards already carry their partner; deriving the list here avoids a
  // second request just to name three businesses.
  const businessOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const card of campaigns) {
      if (!seen.has(card.campaign.businessId)) {
        seen.set(card.campaign.businessId, card.businessName);
      }
    }
    return [...seen.entries()].map(([value, label]) => ({ label, value }));
  }, [campaigns]);

  const choosePool = useCallback(
    (nextPoolId: string) => {
      setPoolId(nextPoolId);
      setMessage("");
      void setDevPoolId(slug, nextPoolId);
    },
    [slug],
  );

  // Unlike the pool picker above, this is not scoped to the selected campaign:
  // it clears every campaign this number has hunted.
  async function runReset() {
    if (!token) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      // Cancel any roulette request kept mounted behind the More tab before the
      // server deletes its attempt. Otherwise that request can recreate it.
      publishHuntResetStarting();
      const result = await resetHunt(token);
      // Only now is the server's state actually gone, so only now may the rest
      // of the app drop its own. Announcing it before the request meant a reset
      // that failed left every campaign screen believing a hunt had been
      // cleared that the server still held.
      publishHuntResetCompleted();
      // The rows those resume points pointed at are gone; left behind, they
      // would send the next visit to a booking screen for a deleted attempt.
      // Cleared here rather than only in the campaign provider, because a reset
      // covers every campaign and at most one of them has a stack mounted.
      await clearHuntProgress();
      // Forcing a pool only makes sense for a hunt that has not been spent.
      await clearDevPoolIds();
      setPoolId("");
      setMessage(
        `Hunt reset — cleared ${result.attemptsCleared} attempt(s) and ${result.vouchersCleared} voucher(s) across ${result.campaignsReset} campaign(s).`,
      );
      // Remove the hidden campaign stack. Re-entering a campaign now always
      // begins at its details page.
      router.replace("/");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to reset the hunt.");
    } finally {
      setBusy(false);
    }
  }

  async function grantLp() {
    if (!token) return;
    setLpBusy(true);
    setError("");
    setMessage("");
    try {
      const result = await grantLoyaltyPoints(lpAmount, token);
      setMessage(`Granted ${result.granted} — balance is now ${result.balance}.`);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Unable to grant Loyalty Points.",
      );
    } finally {
      setLpBusy(false);
    }
  }

  async function runSimulatedPurchase() {
    if (!token || !scanBusinessId) return;
    setScanBusy(true);
    setError("");
    setMessage("");
    try {
      const result = await simulatePurchase(
        { businessId: scanBusinessId, purchaseAmount: scanAmount },
        token,
      );
      setMessage(
        result.heldForReview
          ? `Purchase held for fraud review — no LP awarded yet.`
          : `Earned ${result.rewardAmount} — balance is now ${result.balance}. The partner owes this on their statement.`,
      );
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Unable to simulate the purchase.",
      );
    } finally {
      setScanBusy(false);
    }
  }

  async function grantBusinessLp() {
    if (!token || !businessLpId) return;
    setBusinessLpBusy(true);
    setError("");
    setMessage("");
    try {
      const result = await grantBusinessLoyaltyPoints(
        { businessId: businessLpId, amount: businessLpAmount },
        token,
      );
      setMessage(
        `Granted ${result.granted} at ${result.businessName} — that bucket is now ${result.balance}.`,
      );
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Unable to grant business Loyalty Points.",
      );
    } finally {
      setBusinessLpBusy(false);
    }
  }

  async function runSimulatedCollection() {
    if (!token || !collectCode.trim()) return;
    setCollectBusy(true);
    setError("");
    setMessage("");
    try {
      const result = await simulateCollection(collectCode.trim(), token);
      setMessage(
        `Collected ${result.product?.name ?? "item"} at ${result.businessName} — ${result.amount} now owed to them.`,
      );
      setCollectCode("");
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Unable to collect that item.",
      );
    } finally {
      setCollectBusy(false);
    }
  }

  async function runVoucherRefresh() {
    if (!token) return;
    setRefreshBusy(true);
    setError("");
    setMessage("");
    try {
      const result = await refreshMyVouchers(token);
      const moved = result.refreshed.filter((item) => item.movedTo);
      // Surface per-voucher problems: a booking that could not be moved is the
      // difference between a usable voucher and one that still reads expired.
      const blocked = result.refreshed.filter((item) => item.note);
      setMessage(
        result.refreshed.length === 0
          ? "No vouchers to refresh."
          : `Refreshed ${result.refreshed.length} voucher(s)${
              moved.length > 0 ? `, moved ${moved.length} to a new slot` : ""
            }.${blocked.length > 0 ? ` ${blocked[0].note}.` : ""}`,
      );
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Unable to refresh vouchers.",
      );
    } finally {
      setRefreshBusy(false);
    }
  }

  if (!visible) return null;

  return (
    <View style={styles.panel}>
      <View style={styles.heading}>
        <Text style={styles.headingText}>Development tools</Text>
        <Text style={styles.headingBadge}>
          {devBuild ? "Local only" : "Your account only"}
        </Text>
      </View>

      <Select
        disabled={campaigns.length === 0}
        label="Campaign"
        onChange={setSlug}
        options={campaigns.map((card) => ({
          label: card.campaign.title,
          value: card.campaign.slug,
        }))}
        placeholder="No campaigns available"
        value={slug}
      />

      <Select
        label="Choose the next voucher"
        onChange={choosePool}
        options={[
          { label: "Random — use campaign odds", value: "" },
          ...pools.map((pool) => ({
            label: `${pool.displayLabel} (${pool.remainingQuantity ?? 0} remaining)`,
            value: pool.poolId,
          })),
        ]}
        value={poolId}
      />
      <Text style={styles.copy}>
        This choice applies to the next roulette spin for this campaign.
      </Text>

      <View style={styles.divider} />

      <Text style={styles.label}>Make my vouchers valid again</Text>
      <Button
        loading={refreshBusy}
        loadingLabel="Refreshing…"
        variant="secondary"
        onPress={runVoucherRefresh}
      >
        Refresh my vouchers
      </Button>
      <Text style={styles.copy}>
        Demo bookings age out. This moves any past booking to the next slot with
        room and re-dates the voucher — expiry still applies, so the expired
        path keeps working as it does in production.
      </Text>

      <View style={styles.divider} />

      <Text style={styles.label}>Reset the voucher hunt</Text>
      <Button
        disabled={!token}
        loading={busy}
        loadingLabel="Resetting…"
        variant="secondary"
        onPress={runReset}
      >
        Reset My Hunt
      </Button>
      <Text style={styles.copy}>
        Clears this number&apos;s attempts, vouchers, and reservations across every
        campaign it has hunted and returns the stock, so you can hunt again from the
        start.
      </Text>

      {/* Both grants below mint Loyalty Points out of nothing, but neither puts
          the amount on a partner's statement, so the server allows them for the
          developer account in production against its own wallet. */}
      {lpToolsVisible ? (
        <>
          <View style={styles.divider} />

          {/* Named for the pot it credits. The tool below it adds LP to a
              partner bucket instead, and the two are not interchangeable —
              only this one converts to the ₱100 voucher. */}
          <Text style={styles.label}>Add Global LP</Text>
          <Field
            inputMode="decimal"
            keyboardType="decimal-pad"
            label="Amount (LP)"
            onChangeText={setLpAmount}
            placeholder="1500"
            value={lpAmount}
          />
          <Button
            disabled={!lpAmount.trim()}
            loading={lpBusy}
            loadingLabel="Granting…"
            variant="secondary"
            onPress={grantLp}
          >
            Add to Global LP
          </Button>
          <Text style={styles.copy}>
            Credits the spend-anywhere pot with no purchase behind it, so no
            partner is billed. This is the balance the ₱100 voucher converts
            from — it cannot buy storefront items.
          </Text>

          <View style={styles.divider} />

          <Text style={styles.label}>Add Business LP</Text>
          <Select
            disabled={businessOptions.length === 0}
            label="Partner"
            onChange={setBusinessLpId}
            options={businessOptions}
            placeholder="No partners available"
            value={businessLpId}
          />
          <Field
            inputMode="decimal"
            keyboardType="decimal-pad"
            label="Amount (LP)"
            onChangeText={setBusinessLpAmount}
            placeholder="1500"
            value={businessLpAmount}
          />
          <Button
            disabled={!businessLpId || !businessLpAmount.trim()}
            loading={businessLpBusy}
            loadingLabel="Granting…"
            variant="secondary"
            onPress={grantBusinessLp}
          >
            Add to this partner
          </Button>
          <Text style={styles.copy}>
            Puts LP straight into one partner&apos;s bucket — the balance its
            storefront items are bought with. A real checkout scan funds the same
            bucket at only 5%, so a 1,200 LP item needs a ₱24,000 sale; this sets
            it directly. No partner is billed either way.
          </Text>
        </>
      ) : null}

      {/* These two do bill a real partner — one writes the liability, the other
          settles it — so the server refuses them in production for every
          account. Hidden rather than offered as buttons that always 403. */}
      {billingToolsVisible ? (
        <>
          <View style={styles.divider} />

          <Text style={styles.label}>Simulate a purchase at a partner</Text>
          <Select
            disabled={businessOptions.length === 0}
            label="Partner"
            onChange={setScanBusinessId}
            options={businessOptions}
            placeholder="No partners available"
            value={scanBusinessId}
          />
          <Field
            inputMode="decimal"
            keyboardType="decimal-pad"
            label="Amount paid (₱)"
            onChangeText={setScanAmount}
            placeholder="1000"
            value={scanAmount}
          />
          <Button
            disabled={!scanBusinessId || !scanAmount.trim()}
            loading={scanBusy}
            loadingLabel="Scanning…"
            variant="secondary"
            onPress={runSimulatedPurchase}
          >
            Earn 5% as LP
          </Button>
          <Text style={styles.copy}>
            Stands in for staff scanning your wallet at checkout. Unlike the
            grant above, the partner is billed for this LP, so it shows up on
            their monthly statement.
          </Text>

          <View style={styles.divider} />

          <Text style={styles.label}>Collect an item as staff</Text>
          <Field
            autoCapitalize="characters"
            label="Voucher code"
            onChangeText={setCollectCode}
            placeholder="RWD-975A4F"
            value={collectCode}
          />
          <Button
            disabled={!collectCode.trim()}
            loading={collectBusy}
            loadingLabel="Collecting…"
            variant="secondary"
            onPress={runSimulatedCollection}
          >
            Mark as handed over
          </Button>
          <Text style={styles.copy}>
            Redeems one of your own item vouchers, the step that puts the amount
            on the partner&apos;s statement. Find codes under LP Shop → My items.
          </Text>
        </>
      ) : null}

      {message ? <Text style={styles.message}>{message}</Text> : null}
      {error ? <InlineError message={error} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  panel: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: radius.md,
    borderStyle: "dashed",
    borderWidth: 1,
    gap: spacing.sm,
    marginBottom: spacing.lg,
    padding: 16,
  },
  heading: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
    marginBottom: spacing.xs,
  },
  headingText: {
    color: colors.ink,
    fontFamily: fonts.extrabold,
    fontSize: 14,
  },
  headingBadge: {
    backgroundColor: colors.warningSoft,
    borderRadius: radius.pill,
    color: colors.alertText,
    fontFamily: fonts.bold,
    fontSize: 11,
    overflow: "hidden",
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  label: {
    color: colors.textMuted,
    fontFamily: fonts.semibold,
    fontSize: 12,
    marginTop: spacing.xs,
  },
  copy: {
    color: colors.textMuted,
    fontFamily: fonts.regular,
    fontSize: 12,
    lineHeight: 18,
  },
  divider: {
    backgroundColor: colors.borderSoft,
    height: 1,
    marginVertical: spacing.sm,
  },
  message: {
    color: colors.success,
    fontFamily: fonts.semibold,
    fontSize: 13,
    lineHeight: 19,
  },
});
