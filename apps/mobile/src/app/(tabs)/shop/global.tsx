import { LinearGradient } from "expo-linear-gradient";
import { type Href, useRouter } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import {
  convertRewardCredit,
  getOrCreateRewardWallet,
  listGlobalRewards,
  type GlobalReward,
  type RewardWalletSnapshot,
} from "@/api/client";
import { useAuth } from "@/auth/AuthContext";
import { ErrorState } from "@/components/ErrorState";
import { Button, InlineError } from "@/components/FormControls";
import { StepHeader } from "@/components/HuntUi";
import { useTranslation } from "@/i18n/LanguageContext";
import { colors, fonts, radius, shadow, spacing } from "@/theme";

/**
 * The Global LP storefront: what the spend-anywhere pot converts into.
 *
 * Deliberately the same shape as a partner's storefront — a balance card, then
 * the things it buys — because it is the same errand. The catalogue comes from
 * the server rather than being hardcoded here, so a second denomination is a row
 * in `GLOBAL_REWARDS` and needs no change in the app.
 */
export default function GlobalRewardsScreen() {
  const t = useTranslation();
  const router = useRouter();
  const { token } = useAuth();
  const [rewards, setRewards] = useState<GlobalReward[]>([]);
  const [wallet, setWallet] = useState<RewardWalletSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [redeemingId, setRedeemingId] = useState("");
  const [actionError, setActionError] = useState("");
  const [notice, setNotice] = useState("");

  const load = useCallback(
    async (asRefresh = false) => {
      if (!token) return;
      if (asRefresh) setRefreshing(true);
      else setLoading(true);
      setError(null);
      try {
        const [catalogue, snapshot] = await Promise.all([
          listGlobalRewards(token),
          getOrCreateRewardWallet(token),
        ]);
        setRewards(catalogue);
        setWallet(snapshot);
      } catch (caught) {
        setError(caught);
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [token],
  );

  useEffect(() => {
    void load();
  }, [load]);

  async function redeem(reward: GlobalReward) {
    if (!token || !wallet) return;
    setRedeemingId(reward.id);
    setActionError("");
    setNotice("");
    try {
      const result = await convertRewardCredit(
        { walletSecret: wallet.walletSecret, rewardId: reward.id },
        token,
      );
      setNotice(
        t("shop.globalRedeemed", {
          value: result.reward.value,
          code: result.voucher.voucherCode,
        }),
      );
      // The balance moved and a voucher now exists, so re-read rather than
      // patching: this screen shows both.
      await load(true);
    } catch (caught) {
      setActionError(
        caught instanceof Error ? caught.message : t("shop.globalRedeemError"),
      );
    } finally {
      setRedeemingId("");
    }
  }

  const balanceCentavos = wallet?.wallet.balanceCentavos ?? 0;

  return (
    <SafeAreaView edges={["top", "left", "right"]} style={styles.safeArea}>
      {/* Up is the shop, not wherever the history happens to lead. */}
      <StepHeader
        onBack={() => router.dismissTo("/shop")}
        title={t("shop.globalStoreTitle")}
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
        <LinearGradient
          colors={["#6637ff", "#7a44f4"]}
          end={{ x: 1, y: 1 }}
          start={{ x: 0, y: 0 }}
          style={styles.balanceCard}
        >
          <Text style={styles.balanceLabel}>{t("shop.balanceLabel")}</Text>
          <Text style={styles.balanceValue}>{wallet?.balance ?? "—"}</Text>
          <Text style={styles.balanceHint}>{t("shop.globalStoreHint")}</Text>
        </LinearGradient>

        {notice ? <Text style={styles.notice}>{notice}</Text> : null}
        {actionError ? <InlineError message={actionError} /> : null}

        {loading ? (
          <ActivityIndicator color={colors.primary} style={styles.loader} />
        ) : error ? (
          <ErrorState
            error={error}
            fallback={t("shop.loadError")}
            onRetry={() => void load()}
          />
        ) : (
          <View style={styles.list}>
            {rewards.map((reward) => {
              const affordable = balanceCentavos >= reward.costCentavos;
              return (
                <View key={reward.id} style={styles.card}>
                  <View style={styles.cardHead}>
                    <Text style={styles.cardName}>{reward.name}</Text>
                    <Text style={styles.cardCost}>{reward.cost}</Text>
                  </View>
                  <Text style={styles.cardCopy}>{reward.description}</Text>
                  <Text style={styles.cardTerms}>
                    {t("shop.globalMinSpend", { amount: reward.minimumSpend })}
                  </Text>
                  <Button
                    disabled={!affordable}
                    loading={redeemingId === reward.id}
                    loadingLabel={t("shop.globalRedeeming")}
                    onPress={() => void redeem(reward)}
                    variant="secondary"
                  >
                    {affordable
                      ? t("shop.globalRedeemCta")
                      : t("shop.globalShortBy", {
                          amount: `${(
                            (reward.costCentavos - balanceCentavos) / 100
                          ).toLocaleString("en-PH")} LP`,
                        })}
                  </Button>
                </View>
              );
            })}
          </View>
        )}

        <Text style={styles.footnote}>{t("shop.globalWhereKept")}</Text>
        <Button
          onPress={() => router.push("/shop/purchases" as Href)}
          variant="secondary"
        >
          {t("shop.viewMyItems")}
        </Button>
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
    color: "#eeeaff",
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
    color: "#eeeaff",
    fontFamily: fonts.regular,
    fontSize: 13,
    lineHeight: 19,
  },
  notice: {
    color: colors.success,
    fontFamily: fonts.semibold,
    fontSize: 13,
    marginBottom: spacing.sm,
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
    gap: spacing.xs,
    padding: spacing.lg,
    ...shadow.soft,
  },
  cardHead: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
  },
  cardName: {
    color: colors.ink,
    fontFamily: fonts.bold,
    fontSize: 17,
  },
  cardCost: {
    color: colors.primary,
    fontFamily: fonts.bold,
    fontSize: 15,
  },
  cardCopy: {
    color: colors.textMuted,
    fontFamily: fonts.regular,
    fontSize: 13,
    lineHeight: 19,
  },
  cardTerms: {
    color: colors.textMuted,
    fontFamily: fonts.semibold,
    fontSize: 12,
    marginBottom: spacing.xs,
  },
  footnote: {
    color: colors.textMuted,
    fontFamily: fonts.regular,
    fontSize: 12,
    lineHeight: 17,
    marginBottom: spacing.sm,
    marginTop: spacing.xl,
  },
});
