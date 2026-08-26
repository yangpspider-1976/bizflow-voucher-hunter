import { type Href, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import QRCode from "react-native-qrcode-svg";
import { SafeAreaView } from "react-native-safe-area-context";

import {
  getOrCreateRewardWallet,
  getRewardProduct,
  partnerBalance,
  purchaseRewardProduct,
  type RewardProduct,
  type RewardProductPurchase,
  type RewardWalletSnapshot,
} from "@/api/client";
import { useAuth } from "@/auth/AuthContext";
import { CopyableCode } from "@/components/CopyableCode";
import { Button, InlineError } from "@/components/FormControls";
import { ErrorState } from "@/components/ErrorState";
import { Icon } from "@/components/Icon";
import { RewardProductImage } from "@/components/RewardProductImage";
import { StepHeader } from "@/components/HuntUi";
import { useTranslation } from "@/i18n/LanguageContext";
import { colors, fonts, radius, shadow, spacing } from "@/theme";

/**
 * Steps 2 and 3 of spending LP: confirm the item, then the receipt. The receipt
 * replaces the page rather than pushing a route, so backing out of it cannot
 * land on a confirm screen for points that are already spent.
 */
export default function LpProductScreen() {
  const t = useTranslation();
  const router = useRouter();
  const { token } = useAuth();
  const params = useLocalSearchParams<{ businessId: string; productId: string }>();
  const productId = Array.isArray(params.productId)
    ? params.productId[0]
    : params.productId;
  const businessId = Array.isArray(params.businessId)
    ? params.businessId[0]
    : params.businessId;

  // Up is the storefront, whichever of this screen's states is showing.
  // dismissTo rather than back() or replace(): it pops to the storefront
  // already in the stack instead of stacking a second copy of it, and still
  // gets there when the item was opened without one below it.
  const backToStorefront = () =>
    router.dismissTo(`/shop/${encodeURIComponent(businessId)}` as Href);

  const [product, setProduct] = useState<RewardProduct | null>(null);
  const [wallet, setWallet] = useState<RewardWalletSnapshot | null>(null);
  const [receipt, setReceipt] = useState<RewardProductPurchase | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [actionError, setActionError] = useState("");

  const load = useCallback(async () => {
    if (!token || !productId || !businessId) return;
    setLoading(true);
    setError(null);
    try {
      // Fetched by id, not filtered out of the catalogue: a list that comes
      // back without this item looks identical to a request that failed, and
      // the screen then blamed the item for what was a network error.
      const [item, snapshot] = await Promise.all([
        getRewardProduct(token, productId),
        getOrCreateRewardWallet(token),
      ]);
      setProduct(item);
      setWallet(snapshot);
    } catch (caught) {
      setError(caught);
    } finally {
      setLoading(false);
    }
  }, [businessId, productId, token]);

  useEffect(() => {
    void load();
  }, [load]);

  async function buy() {
    if (!token || !wallet || !product) return;
    setBusy(true);
    setActionError("");
    try {
      setReceipt(
        await purchaseRewardProduct(
          { walletSecret: wallet.walletSecret, productId: product.id },
          token,
        ),
      );
    } catch (caught) {
      setActionError(
        caught instanceof Error ? caught.message : t("shop.purchaseError"),
      );
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <SafeAreaView edges={["top", "left", "right"]} style={styles.safeArea}>
        <ActivityIndicator color={colors.primary} style={styles.loader} />
      </SafeAreaView>
    );
  }

  if (error || !product) {
    return (
      <SafeAreaView edges={["top", "left", "right"]} style={styles.safeArea}>
        <StepHeader onBack={backToStorefront} title={t("shop.title")} />
        <View style={styles.content}>
          <ErrorState
            error={error}
            fallback={t("shop.notFound")}
            onRetry={() => void load()}
          />
        </View>
      </SafeAreaView>
    );
  }

  if (receipt) {
    return (
      <SafeAreaView edges={["top", "left", "right"]} style={styles.safeArea}>
        <StepHeader onBack={backToStorefront} title={t("shop.receiptTitle")} />
        <ScrollView
          contentContainerStyle={styles.content}
          showsVerticalScrollIndicator={false}
        >
          <View style={styles.receiptCard}>
            <View style={styles.receiptBadge}>
              <Icon color={colors.surface} name="check" size={18} />
            </View>
            <Text style={styles.receiptTitle}>{receipt.product.name}</Text>
            <Text style={styles.receiptBusiness}>
              {receipt.product.businessName}
            </Text>
            <View style={styles.qrCard}>
              <QRCode
                backgroundColor={colors.surface}
                color={colors.ink}
                quietZone={8}
                size={190}
                value={receipt.voucher.qrToken}
              />
            </View>
            <Text style={styles.receiptHint}>{t("shop.receiptHint")}</Text>
            <CopyableCode
              label={t("shop.voucherCode")}
              style={styles.receiptRow}
              value={receipt.voucher.voucherCode}
            />
            <View style={styles.receiptRow}>
              <Text style={styles.receiptLabel}>{t("shop.paid")}</Text>
              <Text style={styles.receiptValue}>{receipt.product.price}</Text>
            </View>
            <View style={styles.receiptRow}>
              {/* The server returns the pot that paid, which is this partner's
                  bucket — the global balance did not move, so naming it that
                  would report the wrong number under the wrong label. */}
              <Text style={styles.receiptLabel}>
                {t("shop.balanceHereLabel", {
                  business: receipt.product.businessName,
                })}
              </Text>
              <Text style={styles.receiptValue}>{receipt.balance}</Text>
            </View>
          </View>
          <View style={styles.action}>
            {/* Straight to the saved item rather than back to the catalogue:
                the code just bought is what they need next, and it now lives
                somewhere they can find it again. */}
            <Button onPress={() => router.replace("/shop/purchases" as Href)}>
              {t("shop.viewMyItems")}
            </Button>
          </View>
        </ScrollView>
      </SafeAreaView>
    );
  }

  // Bought from the bucket earned at the partner selling it, so the global pot
  // is not what decides whether this button works.
  const here = partnerBalance(wallet, product.businessId);
  const affordable = here.balanceCentavos >= product.priceCentavos;

  return (
    <SafeAreaView edges={["top", "left", "right"]} style={styles.safeArea}>
      <StepHeader onBack={backToStorefront} title={t("shop.confirmTitle")} />
      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.detailCard}>
          <RewardProductImage
            borderRadius={11}
            product={product}
            style={styles.detailMedia}
          />
          <Text style={styles.detailName}>{product.name}</Text>
          <Text style={styles.detailBusiness}>{product.businessName}</Text>
          {product.description ? (
            <Text style={styles.detailDescription}>{product.description}</Text>
          ) : null}
          <View style={styles.detailRow}>
            <Text style={styles.detailLabel}>{t("shop.price")}</Text>
            <Text style={styles.detailValue}>{product.price}</Text>
          </View>
          <View style={styles.detailRow}>
            <Text style={styles.detailLabel}>
              {t("shop.balanceHereLabel", { business: product.businessName })}
            </Text>
            <Text style={styles.detailValue}>{here.balance}</Text>
          </View>
        </View>

        <View style={styles.notice}>
          <View style={styles.noticeIcon}>
            <Icon name="info" size={16} />
          </View>
          <Text style={styles.noticeText}>{t("shop.confirmNotice")}</Text>
        </View>

        {actionError ? <InlineError message={actionError} /> : null}

        <View style={styles.action}>
          <Button
            disabled={!affordable}
            loading={busy}
            loadingLabel={t("shop.purchasing")}
            onPress={buy}
          >
            {affordable ? t("shop.buyNow") : t("shop.notEnough")}
          </Button>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    backgroundColor: colors.page,
    flex: 1,
  },
  content: {
    padding: spacing.xl,
    paddingBottom: 48,
  },
  loader: {
    marginTop: spacing.xxl,
  },
  detailCard: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: radius.md,
    borderWidth: 1,
    padding: spacing.lg,
    ...shadow.soft,
  },
  detailMedia: {
    marginBottom: spacing.md,
  },
  detailName: {
    color: colors.ink,
    fontFamily: fonts.bold,
    fontSize: 18,
  },
  detailBusiness: {
    color: colors.textMuted,
    fontFamily: fonts.regular,
    fontSize: 13,
    marginTop: 2,
  },
  detailDescription: {
    color: colors.textMuted,
    fontFamily: fonts.regular,
    fontSize: 14,
    lineHeight: 20,
    marginTop: spacing.md,
  },
  detailRow: {
    alignItems: "center",
    borderTopColor: colors.borderSoft,
    borderTopWidth: 1,
    flexDirection: "row",
    justifyContent: "space-between",
    marginTop: spacing.md,
    paddingTop: spacing.md,
  },
  detailLabel: {
    color: colors.ink,
    fontFamily: fonts.semibold,
    fontSize: 13,
  },
  detailValue: {
    color: colors.textMuted,
    fontFamily: fonts.semibold,
    fontSize: 14,
  },
  notice: {
    alignItems: "flex-start",
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: radius.sm,
    borderWidth: 1,
    flexDirection: "row",
    gap: 10,
    marginTop: spacing.lg,
    padding: spacing.md,
  },
  noticeIcon: {
    alignItems: "center",
    paddingTop: 1,
    width: 20,
  },
  noticeText: {
    color: colors.textMuted,
    flex: 1,
    fontFamily: fonts.regular,
    fontSize: 13,
    lineHeight: 19,
  },
  action: {
    marginTop: spacing.lg,
  },
  receiptCard: {
    alignItems: "center",
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: radius.md,
    borderWidth: 1,
    padding: spacing.lg,
    ...shadow.soft,
  },
  receiptBadge: {
    alignItems: "center",
    backgroundColor: colors.primary,
    borderRadius: radius.pill,
    height: 40,
    justifyContent: "center",
    width: 40,
  },
  receiptTitle: {
    color: colors.ink,
    fontFamily: fonts.bold,
    fontSize: 18,
    marginTop: spacing.md,
    textAlign: "center",
  },
  receiptBusiness: {
    color: colors.textMuted,
    fontFamily: fonts.regular,
    fontSize: 13,
    marginTop: 2,
  },
  qrCard: {
    alignItems: "center",
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: radius.md,
    borderWidth: 1,
    marginTop: spacing.lg,
    padding: spacing.md,
  },
  receiptHint: {
    color: colors.textMuted,
    fontFamily: fonts.regular,
    fontSize: 13,
    lineHeight: 19,
    marginTop: spacing.md,
    textAlign: "center",
  },
  receiptRow: {
    alignItems: "center",
    alignSelf: "stretch",
    borderTopColor: colors.borderSoft,
    borderTopWidth: 1,
    flexDirection: "row",
    justifyContent: "space-between",
    marginTop: spacing.md,
    paddingTop: spacing.md,
  },
  receiptLabel: {
    color: colors.ink,
    fontFamily: fonts.semibold,
    fontSize: 13,
  },
  receiptValue: {
    color: colors.textMuted,
    fontFamily: fonts.semibold,
    fontSize: 14,
  },
});
