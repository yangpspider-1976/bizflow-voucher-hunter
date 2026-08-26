import { LinearGradient } from "expo-linear-gradient";
import { type Href, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import {
  getOrCreateRewardWallet,
  listRewardProducts,
  partnerBalance,
  transferBusinessLp,
  type RewardProduct,
  type RewardWalletSnapshot,
} from "@/api/client";
import { useAuth } from "@/auth/AuthContext";
import { ErrorState } from "@/components/ErrorState";
import { Button, Field, InlineError } from "@/components/FormControls";
import { Icon } from "@/components/Icon";
import { RewardProductImage } from "@/components/RewardProductImage";
import { StepHeader } from "@/components/HuntUi";
import { useTranslation } from "@/i18n/LanguageContext";
import {
  businessTypeGradient,
  colors,
  fonts,
  radius,
  shadow,
  spacing,
} from "@/theme";

/**
 * The server's own floor on a transfer (`MIN_TRANSFER_CENTAVOS`), mirrored so
 * the button can be disabled instead of posting an amount that is certain to be
 * rejected. Below 0.1 LP the 10% fee rounds to nothing, which is what the floor
 * exists to prevent.
 */
const MIN_TRANSFER_LP = 10;
const MIN_TRANSFER_CENTAVOS = MIN_TRANSFER_LP * 100;

/** Step 2: what this partner sells for LP, and what this balance can reach. */
export default function ShopProductsScreen() {
  const t = useTranslation();
  const router = useRouter();
  const { token } = useAuth();
  const params = useLocalSearchParams<{
    businessId: string;
    industry?: string;
  }>();
  const businessId = Array.isArray(params.businessId)
    ? params.businessId[0]
    : params.businessId;
  // Carried from the shop list so the header paints this partner's colour on
  // the first frame; the loaded products take over once they arrive and are the
  // authority if the two ever disagree.
  const industryParam = Array.isArray(params.industry)
    ? params.industry[0]
    : params.industry;

  const [products, setProducts] = useState<RewardProduct[]>([]);
  const [wallet, setWallet] = useState<RewardWalletSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [transferAmount, setTransferAmount] = useState("");
  const [transferring, setTransferring] = useState(false);
  const [transferError, setTransferError] = useState("");
  const [transferNotice, setTransferNotice] = useState("");

  const load = useCallback(
    async (asRefresh = false) => {
      if (!token || !businessId) return;
      if (asRefresh) setRefreshing(true);
      else setLoading(true);
      setError(null);
      try {
        const [items, snapshot] = await Promise.all([
          listRewardProducts(token, businessId),
          getOrCreateRewardWallet(token),
        ]);
        setProducts(items);
        setWallet(snapshot);
      } catch (caught) {
        setError(caught);
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [businessId, token],
  );

  useEffect(() => {
    void load();
  }, [load]);

  // This partner's bucket, which is what its items are actually bought with.
  const here = partnerBalance(wallet, businessId);
  const businessName = products[0]?.businessName ?? t("shop.title");
  // Coloured by trade so this card never reads as the global balance. The list
  // is uniform per partner, so the first row is as good as any.
  const gradient = businessTypeGradient(
    products[0]?.businessIndustry ?? industryParam,
  );
  const canTransfer = here.balanceCentavos >= MIN_TRANSFER_CENTAVOS;

  /**
   * Moves this partner's points into the global pot, where they are worth a
   * fixed voucher instead of this partner's items. Lives here rather than on the
   * More tab because it is a per-partner action, and this is the only screen
   * that shows the balance it spends.
   */
  async function moveToGlobal() {
    if (!token || !wallet || !businessId) return;
    const amount = transferAmount.trim();
    if (!amount) {
      setTransferNotice("");
      setTransferError(t("shop.transferAmountRequired"));
      return;
    }
    setTransferring(true);
    setTransferError("");
    setTransferNotice("");
    try {
      const result = await transferBusinessLp(
        { walletSecret: wallet.walletSecret, businessId, amount },
        token,
      );
      // The fee comes out of what arrives, so credited and moved differ. Naming
      // both is the only way the gap is explained rather than just missing.
      setTransferNotice(
        t("shop.transferDone", { credited: result.credited, fee: result.fee }),
      );
      setTransferAmount("");
      await load(true);
    } catch (caught) {
      setTransferError(
        caught instanceof Error ? caught.message : t("shop.transferError"),
      );
    } finally {
      setTransferring(false);
    }
  }

  return (
    <SafeAreaView edges={["top", "left", "right"]} style={styles.safeArea}>
      {/* dismissTo, not back(): this screen's parent is the shop, but the
          history above it is not dependable — returning here from an item after
          a purchase replaces that screen, so back() lands on the storefront
          again rather than leaving it. dismissTo pops to the shop wherever it
          sits, and falls back to navigating there when it is not in the stack
          at all (a deep link, or a jump in from outside the shop). */}
      <StepHeader
        onBack={() => router.dismissTo("/shop")}
        title={businessName}
      />
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl
            onRefresh={() => void load(true)}
            refreshing={refreshing}
            tintColor={colors.primary}
          />
        }
        showsVerticalScrollIndicator={false}
      >
        {/* Same shape as the global card on the previous screen, in this
            partner's colour: two balances that behave differently should look
            different, not identical but for a number. */}
        <LinearGradient
          colors={gradient}
          end={{ x: 1, y: 1 }}
          start={{ x: 0, y: 0 }}
          style={styles.balanceCard}
        >
          <Text style={styles.balanceLabel}>
            {t("shop.balanceHereLabel", { business: businessName })}
          </Text>
          <Text style={styles.balanceValue}>{here.balance}</Text>
          <Text style={styles.balanceHint}>
            {t("shop.balanceHereHint", { business: businessName })}
          </Text>
        </LinearGradient>

        {/* Always on screen, even at zero. The balance card above points down
            here, and hiding the control at the exact moment someone reads that
            sentence makes the app look broken — and leaves the feature
            undiscoverable until a bucket happens to be funded. */}
        <View style={styles.transferCard}>
          <Text style={styles.transferTitle}>{t("shop.transferTitle")}</Text>
          <Text style={styles.transferCaption}>
            {canTransfer
              ? t("shop.transferCaption", { business: businessName })
              : t("shop.transferMinimum", {
                  amount: MIN_TRANSFER_LP,
                  business: businessName,
                })}
          </Text>
          {canTransfer ? (
            <>
              <Field
                inputMode="decimal"
                keyboardType="decimal-pad"
                label={t("shop.transferLabel")}
                onChangeText={setTransferAmount}
                placeholder={t("shop.transferPlaceholder")}
                value={transferAmount}
              />
              {transferError ? <InlineError message={transferError} /> : null}
              {transferNotice ? (
                <Text style={styles.transferNotice}>{transferNotice}</Text>
              ) : null}
            </>
          ) : null}
          <Button
            disabled={!canTransfer}
            loading={transferring}
            loadingLabel={t("shop.transferring")}
            onPress={() => void moveToGlobal()}
            variant="secondary"
          >
            {t("shop.transferCta")}
          </Button>
        </View>

        {loading ? (
          <ActivityIndicator color={colors.primary} style={styles.loader} />
        ) : error ? (
          <ErrorState
            error={error}
            fallback={t("shop.loadError")}
            onRetry={() => void load()}
          />
        ) : products.length === 0 ? (
          <View style={styles.empty}>
            <Text style={styles.emptyText}>{t("shop.empty")}</Text>
          </View>
        ) : (
          <View style={styles.list}>
            {products.map((product) => {
              const affordable = here.balanceCentavos >= product.priceCentavos;
              return (
                <Pressable
                  key={product.id}
                  onPress={() =>
                    router.push(
                      `/shop/${encodeURIComponent(businessId)}/item/${encodeURIComponent(product.id)}` as Href,
                    )
                  }
                  style={({ pressed }) => [
                    styles.card,
                    !affordable && styles.cardLocked,
                    pressed && styles.cardPressed,
                  ]}
                >
                  <RewardProductImage
                    borderRadius={11}
                    product={product}
                    style={styles.cardMedia}
                  />
                  <View style={styles.cardRow}>
                  <View style={styles.cardCopy}>
                    <Text style={styles.cardName}>{product.name}</Text>
                    {product.description ? (
                      <Text numberOfLines={2} style={styles.cardDescription}>
                        {product.description}
                      </Text>
                    ) : null}
                  </View>
                  <View style={styles.cardSide}>
                    <Text style={styles.cardPrice}>{product.price}</Text>
                    {affordable ? (
                      <Icon name="chevron-right" size={18} />
                    ) : (
                      <Text style={styles.cardShort}>
                        {t("shop.shortBy", {
                          amount: `${(
                            (product.priceCentavos - here.balanceCentavos) / 100
                          ).toLocaleString("en-PH")} LP`,
                        })}
                      </Text>
                    )}
                  </View>
                  </View>
                </Pressable>
              );
            })}
          </View>
        )}
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
  balanceCard: {
    borderRadius: radius.md,
    marginBottom: spacing.lg,
    padding: spacing.lg,
  },
  balanceLabel: {
    // Fixed near-white rather than a token: every business gradient is a
    // saturated mid-tone, so the copy on top is light in all of them.
    color: "rgba(255, 255, 255, 0.88)",
    fontFamily: fonts.semibold,
    fontSize: 11,
    letterSpacing: 0.4,
    textTransform: "uppercase",
  },
  balanceValue: {
    color: colors.surface,
    fontFamily: fonts.extrabold,
    fontSize: 30,
    marginVertical: spacing.xs,
  },
  balanceHint: {
    color: "rgba(255, 255, 255, 0.88)",
    fontFamily: fonts.regular,
    fontSize: 13,
    lineHeight: 19,
  },
  transferCard: {
    backgroundColor: colors.surface,
    borderColor: colors.borderSoft,
    borderRadius: radius.md,
    borderWidth: 1,
    gap: spacing.xs,
    marginBottom: spacing.lg,
    padding: spacing.md,
  },
  transferTitle: {
    color: colors.ink,
    fontFamily: fonts.semibold,
    fontSize: 13,
  },
  transferCaption: {
    color: colors.textMuted,
    fontFamily: fonts.regular,
    fontSize: 11,
    lineHeight: 15,
  },
  transferNotice: {
    color: colors.success,
    fontFamily: fonts.semibold,
    fontSize: 12,
  },
  loader: {
    marginTop: spacing.md,
  },
  list: {
    gap: spacing.md,
  },
  card: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: radius.md,
    borderWidth: 1,
    gap: spacing.md,
    padding: spacing.lg,
  },
  cardMedia: {
    marginBottom: 2,
  },
  cardRow: {
    alignItems: "flex-start",
    flexDirection: "row",
    gap: spacing.md,
  },
  cardLocked: {
    opacity: 0.62,
  },
  cardPressed: {
    borderColor: "rgba(92, 61, 255, 0.35)",
    transform: [{ scale: 0.99 }],
  },
  cardCopy: {
    flex: 1,
    gap: 2,
  },
  cardName: {
    color: colors.ink,
    fontFamily: fonts.bold,
    fontSize: 15,
  },
  cardDescription: {
    color: colors.textMuted,
    fontFamily: fonts.regular,
    fontSize: 13,
    lineHeight: 18,
    marginTop: 2,
  },
  cardSide: {
    alignItems: "flex-end",
    gap: 4,
  },
  cardPrice: {
    color: colors.primary,
    fontFamily: fonts.extrabold,
    fontSize: 15,
  },
  cardShort: {
    color: colors.textMuted,
    fontFamily: fonts.semibold,
    fontSize: 11,
    textAlign: "right",
  },
  empty: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: radius.md,
    borderWidth: 1,
    padding: spacing.xl,
  },
  emptyText: {
    color: colors.textMuted,
    fontFamily: fonts.regular,
    fontSize: 14,
    textAlign: "center",
  },
});
