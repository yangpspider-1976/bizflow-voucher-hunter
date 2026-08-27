import { toDisplayPhone } from "@bizflow/shared";
import * as Clipboard from "expo-clipboard";
import { LinearGradient } from "expo-linear-gradient";
import { type Href, useFocusEffect, useRouter } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import { useCallback, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  Share,
  StyleSheet,
  Text,
  View,
} from "react-native";
import QRCode from "react-native-qrcode-svg";

import {
  buildClientLandingUrl,
  buildDeleteAccountUrl,
  buildReferralLink,
  getReferralLinkIdentity,
  getOrCreateRewardWallet,
  type RewardWalletSnapshot,
} from "@/api/client";
import { useAuth } from "@/auth/AuthContext";
import { Button, InlineError } from "@/components/FormControls";
import { Icon } from "@/components/Icon";
import { LanguagePicker } from "@/components/LanguagePicker";
import { Screen } from "@/components/Screen";
import { NotificationSettings } from "@/components/NotificationSettings";
import { DevToolsPanel } from "@/dev/DevToolsPanel";
import { getVisitorSessionId } from "@/hunt/session";
import { useTranslation } from "@/i18n/LanguageContext";
import { colors, fonts, radius, shadow, spacing } from "@/theme";

export default function MoreScreen() {
  const { phone, signOut, token } = useAuth();
  const router = useRouter();
  const t = useTranslation();
  const [isSigningOut, setIsSigningOut] = useState(false);
  const [wallet, setWallet] = useState<RewardWalletSnapshot | null>(null);
  const [walletBusy, setWalletBusy] = useState(true);
  const [tokenVisible, setTokenVisible] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [referralBusy, setReferralBusy] = useState(false);

  const loadWallet = useCallback(async () => {
    if (!token) return;
    setWalletBusy(true);
    setError("");
    try {
      setWallet(await getOrCreateRewardWallet(token));
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : t("loyalty.loadError"),
      );
    } finally {
      setWalletBusy(false);
    }
    // `t` changes identity when the language does, which is what we want: a
    // reload after switching should surface errors in the new language.
  }, [t, token]);

  useFocusEffect(
    useCallback(() => {
      void loadWallet();
    }, [loadWallet]),
  );

  async function handleSignOut() {
    setError("");
    setIsSigningOut(true);
    try {
      await signOut();
    } catch {
      setError(t("more.signOutError"));
    } finally {
      setIsSigningOut(false);
    }
  }

  async function copyToClipboard(value: string, label: string) {
    try {
      await Clipboard.setStringAsync(value);
      setError("");
      setNotice(t("loyalty.copiedLabel", { label }));
    } catch {
      setNotice("");
      setError(t("loyalty.copyError", { label: label.toLowerCase() }));
    }
  }

  async function shareDailyReferral() {
    if (!token) return;
    setReferralBusy(true);
    setError("");
    setNotice("");
    try {
      const sessionId = await getVisitorSessionId();
      const referral = await getReferralLinkIdentity(token, sessionId);
      const link = buildReferralLink(
        referral.campaignSlug,
        referral.referrerUserId,
      );
      await Share.share({
        message:
          t("loyalty.referralShareMessage", { link }),
        title: t("loyalty.referralShareTitle"),
      });
      setNotice(
        t("loyalty.referralShared"),
      );
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : t("loyalty.referralError"),
      );
    } finally {
      setReferralBusy(false);
    }
  }

  async function openDeleteAccount() {
    try {
      await WebBrowser.openBrowserAsync(buildDeleteAccountUrl());
    } catch {
      setError(t("more.deleteAccountError"));
    }
  }

  async function openClientLanding() {
    try {
      await WebBrowser.openBrowserAsync(buildClientLandingUrl());
    } catch {
      setError(t("more.aboutError"));
    }
  }

  return (
    <Screen subtitle={t("more.subtitle")} title={t("more.title")}>
      <View style={styles.accountCard}>
        <Text style={styles.sectionTitle}>{t("more.account")}</Text>
        <Text style={styles.accountCopy}>
          {phone
            ? t("more.signedInAs", { phone: toDisplayPhone(phone) })
            : t("more.notSignedIn")}
        </Text>
      </View>

      <View style={styles.walletCard}>
        <View style={styles.sectionHeading}>
          <View style={styles.sectionText}>
            <Text style={styles.sectionTitle}>{t("loyalty.title")}</Text>
            <Text style={styles.sectionCopy}>{t("loyalty.subtitle")}</Text>
          </View>
          <View style={styles.creditPill}>
            <Text style={styles.creditPillText}>{t("loyalty.earnPill")}</Text>
          </View>
        </View>

        {walletBusy && !wallet ? (
          <View style={styles.walletLoading}>
            <ActivityIndicator color={colors.primary} size="large" />
            <Text style={styles.muted}>{t("loyalty.unlocking")}</Text>
          </View>
        ) : wallet ? (
          <>
            <LinearGradient
              colors={["#6637ff", "#7a44f4"]}
              end={{ x: 1, y: 1 }}
              start={{ x: 0, y: 0 }}
              style={styles.balanceCard}
            >
              <Text style={styles.balanceLabel}>{t("loyalty.available")}</Text>
              <Text style={styles.balance}>{wallet.balance}</Text>
              <Text style={styles.balanceHint}>{t("loyalty.balanceHint")}</Text>
            </LinearGradient>

            {/* The only entry point to the storefront: it is meaningless
                without a balance, so it lives with the balance. */}
            <Pressable
              accessibilityRole="button"
              onPress={() => router.push("/shop" as Href)}
              style={({ pressed }) => [styles.shopCta, pressed && styles.shopCtaPressed]}
            >
              <Icon color={colors.primary} name="shopping-bag" size={18} />
              <Text style={styles.shopCtaText}>{t("loyalty.shopCta")}</Text>
              <Icon name="chevron-right" size={18} />
            </Pressable>

            {/* Points earned at a checkout land against the partner that issued
                them, not in the balance above. Without this section they are
                invisible: the holder sees the global pot and concludes their
                purchases earned nothing. */}
            {wallet.businessBalances && wallet.businessBalances.length > 0 ? (
              <View style={styles.partnerCard}>
                <Text style={styles.partnerTitle}>
                  {t("loyalty.partnerTitle")}
                </Text>
                <Text style={styles.partnerCaption}>
                  {t("loyalty.partnerCaption")}
                </Text>
                {/* An overview, not a control surface. Spending and moving a
                    bucket both happen on that partner's own screen, where the
                    items those points buy are in front of you. */}
                {wallet.businessBalances.map((bucket) => (
                  <Pressable
                    accessibilityRole="button"
                    key={bucket.businessId}
                    onPress={() =>
                      router.push(
                        `/shop/${encodeURIComponent(bucket.businessId)}` as Href,
                      )
                    }
                    style={({ pressed }) => [
                      styles.partnerRow,
                      pressed && styles.pressed,
                    ]}
                  >
                    <Text style={styles.partnerName}>{bucket.businessName}</Text>
                    <Text style={styles.partnerAmount}>{bucket.balance}</Text>
                    <Icon name="chevron-right" size={18} />
                  </Pressable>
                ))}
              </View>
            ) : null}

            <View style={styles.dailyCard}>
              <View style={styles.dailyHeading}>
                <View style={styles.dailyHeadingCopy}>
                  <Text style={styles.dailyTitle}>{t("loyalty.dailyTitle")}</Text>
                  <Text style={styles.dailyCaption}>
                    {t("loyalty.dailyCaptionUpTo", { amount: wallet.dailyStatus.monthlyPotential })}
                  </Text>
                </View>
                <Text style={styles.dailyTotal}>
                  {t("loyalty.dailyToday", { amount: wallet.dailyStatus.earnedToday })}
                </Text>
              </View>
              <View style={styles.dailyRow}>
                <Icon color={colors.primary} name="check-circle" size={18} />
                <View style={styles.dailyRowCopy}>
                  <Text style={styles.dailyRowTitle}>{t("loyalty.dailyUseApp")}</Text>
                  <Text style={styles.dailyCaption}>
                    {wallet.dailyStatus.appUsePoints}
                  </Text>
                </View>
                <Text style={styles.dailyEarned}>{t("loyalty.earned")}</Text>
              </View>
              <View style={styles.dailyRow}>
                <Icon
                  color={colors.primary}
                  name={
                    wallet.dailyStatus.referralAwarded
                      ? "check-circle"
                      : "refresh-cw"
                  }
                  size={18}
                />
                <View style={styles.dailyRowCopy}>
                  <Text style={styles.dailyRowTitle}>{t("loyalty.dailyReferral")}</Text>
                  <Text style={styles.dailyCaption}>
                    {wallet.dailyStatus.referralPoints}
                  </Text>
                </View>
                {wallet.dailyStatus.referralAwarded ? (
                  <Text style={styles.dailyEarned}>{t("loyalty.earned")}</Text>
                ) : (
                  <Pressable
                    accessibilityLabel={t("loyalty.shareReferralLabel")}
                    accessibilityRole="button"
                    disabled={referralBusy}
                    onPress={() => void shareDailyReferral()}
                    style={({ pressed }) => [
                      styles.referralButton,
                      pressed && styles.pressed,
                      referralBusy && styles.referralButtonDisabled,
                    ]}
                  >
                    {referralBusy ? (
                      <ActivityIndicator color={colors.primary} size="small" />
                    ) : (
                      <Icon color={colors.primary} name="share-2" size={14} />
                    )}
                    <Text style={styles.referralButtonText}>
                      {referralBusy ? t("loyalty.preparing") : t("loyalty.share")}
                    </Text>
                  </Pressable>
                )}
              </View>
            </View>

            <View style={[styles.qrCard, shadow.soft]}>
              <QRCode
                backgroundColor={colors.surface}
                color={colors.ink}
                quietZone={8}
                size={148}
                value={wallet.wallet.walletToken}
              />
            </View>

            <View style={styles.walletToken}>
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ expanded: tokenVisible }}
                onPress={() => setTokenVisible((visible) => !visible)}
                style={({ pressed }) => [
                  styles.secondaryButton,
                  pressed && styles.pressed,
                ]}
              >
                <Icon
                  color={colors.ink}
                  name={tokenVisible ? "eye-off" : "eye"}
                  size={16}
                />
                <Text style={styles.secondaryButtonText}>
                  {tokenVisible ? t("loyalty.hideWalletToken") : t("loyalty.showWalletToken")}
                </Text>
              </Pressable>
              {tokenVisible ? (
                <View style={styles.walletTokenValue}>
                  <Text selectable style={styles.walletTokenCode}>
                    {wallet.wallet.walletToken}
                  </Text>
                  <Pressable
                    accessibilityLabel={t("loyalty.copyWalletToken")}
                    accessibilityRole="button"
                    onPress={() =>
                      void copyToClipboard(
                        wallet.wallet.walletToken,
                        t("loyalty.walletToken"),
                      )
                    }
                    style={({ pressed }) => [
                      styles.copyButton,
                      pressed && styles.pressed,
                    ]}
                  >
                    <Icon color={colors.ink} name="copy" size={15} />
                    <Text style={styles.copyButtonText}>{t("loyalty.copy")}</Text>
                  </Pressable>
                </View>
              ) : null}
            </View>
          </>
        ) : null}
      </View>

      {notice ? (
        <View style={styles.notice}>
          <Text style={styles.noticeText}>{notice}</Text>
        </View>
      ) : null}
      {error ? <InlineError message={error} /> : null}
      {error && !wallet ? (
        <View style={styles.retry}>
          <Button variant="secondary" onPress={() => void loadWallet()}>
            {t("loyalty.retryWallet")}
          </Button>
        </View>
      ) : null}
      {/* Sits directly above sign out, as it does on the web More page. The dev
          panel renders nothing unless the signed-in number is a configured
          developer account, whatever kind of build this is. */}
      <LanguagePicker />
      <NotificationSettings />
      <DevToolsPanel />
      {/* The landing page the store listing already points at. Opening it in a
          browser rather than restating it in a screen keeps one description of
          the product, the same reasoning as the deletion page below. */}
      <Pressable
        accessibilityRole="link"
        onPress={() => void openClientLanding()}
        style={({ pressed }) => [styles.aboutRow, pressed && styles.pressed]}
      >
        <Icon color={colors.primary} name="info" size={18} />
        <Text style={styles.aboutRowText}>{t("more.about")}</Text>
        <Icon color={colors.textMuted} name="external-link" size={16} />
      </Pressable>
      <Button
        loading={isSigningOut}
        onPress={() => void handleSignOut()}
        variant="secondary"
      >
        {t("more.signOut")}
      </Button>
      {/* Play requires an in-app route to account deletion for any app that lets
          you create an account in-app. The instructions live on the web so the
          store listing and the app can point at one page. */}
      <Pressable
        accessibilityRole="link"
        onPress={() => void openDeleteAccount()}
        style={styles.deleteAccount}
      >
        <Text style={styles.deleteAccountText}>{t("more.deleteAccount")}</Text>
      </Pressable>
    </Screen>
  );
}

const styles = StyleSheet.create({
  aboutRow: {
    alignItems: "center",
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: radius.md,
    borderWidth: 1,
    flexDirection: "row",
    gap: 10,
    marginBottom: spacing.md,
    minHeight: 48,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  aboutRowText: {
    color: colors.ink,
    flex: 1,
    fontFamily: fonts.semibold,
    fontSize: 14,
  },
  deleteAccount: {
    alignItems: "center",
    marginTop: spacing.lg,
    paddingVertical: spacing.sm,
  },
  deleteAccountText: {
    color: colors.textMuted,
    fontFamily: fonts.semibold,
    fontSize: 14,
    textDecorationLine: "underline",
  },
  accountCard: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: radius.md,
    borderWidth: 1,
    gap: spacing.xs,
    marginBottom: spacing.lg,
    padding: spacing.lg,
  },
  accountCopy: {
    color: colors.textMuted,
    fontFamily: fonts.regular,
    fontSize: 13,
    lineHeight: 19,
  },
  walletCard: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: radius.md,
    borderWidth: 1,
    gap: spacing.lg,
    marginBottom: spacing.lg,
    padding: spacing.lg,
  },
  sectionHeading: {
    alignItems: "flex-start",
    flexDirection: "row",
    gap: spacing.md,
    justifyContent: "space-between",
  },
  sectionText: {
    flex: 1,
  },
  sectionTitle: {
    color: colors.ink,
    fontFamily: fonts.bold,
    fontSize: 18,
  },
  sectionCopy: {
    color: colors.textMuted,
    fontFamily: fonts.regular,
    fontSize: 13,
    lineHeight: 19,
    marginTop: spacing.xs,
  },
  creditPill: {
    backgroundColor: colors.successSoft,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  creditPillText: {
    color: colors.success,
    fontFamily: fonts.bold,
    fontSize: 12,
  },
  walletLoading: {
    alignItems: "center",
    gap: spacing.md,
    paddingVertical: 44,
  },
  muted: {
    color: colors.textMuted,
    fontFamily: fonts.regular,
    fontSize: 13,
    lineHeight: 19,
  },
  balanceCard: {
    backgroundColor: colors.primary,
    borderRadius: radius.md,
    padding: spacing.lg,
  },
  balanceLabel: {
    color: "#eeeaff",
    fontFamily: fonts.regular,
    fontSize: 13,
  },
  balance: {
    color: colors.surface,
    fontFamily: fonts.extrabold,
    fontSize: 30,
    marginVertical: spacing.xs,
  },
  shopCta: {
    alignItems: "center",
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: radius.md,
    borderWidth: 1,
    flexDirection: "row",
    gap: 10,
    marginTop: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  shopCtaPressed: {
    opacity: 0.72,
  },
  shopCtaText: {
    color: colors.ink,
    flex: 1,
    fontFamily: fonts.semibold,
    fontSize: 14,
  },
  balanceHint: {
    color: "#eeeaff",
    fontFamily: fonts.regular,
    fontSize: 12,
    lineHeight: 17,
  },
  dailyCard: {
    backgroundColor: colors.surface,
    borderColor: colors.borderSoft,
    borderRadius: radius.md,
    borderWidth: 1,
    overflow: "hidden",
  },
  partnerCard: {
    backgroundColor: colors.surface,
    borderColor: colors.borderSoft,
    borderRadius: radius.md,
    borderWidth: 1,
    gap: spacing.sm,
    padding: spacing.md,
  },
  partnerTitle: {
    color: colors.ink,
    fontFamily: fonts.semibold,
    fontSize: 13,
  },
  partnerCaption: {
    color: colors.textMuted,
    fontFamily: fonts.regular,
    fontSize: 11,
    lineHeight: 15,
  },
  partnerRow: {
    alignItems: "center",
    borderTopColor: colors.borderSoft,
    borderTopWidth: 1,
    flexDirection: "row",
    gap: spacing.sm,
    paddingTop: spacing.sm,
  },
  partnerName: {
    color: colors.ink,
    flex: 1,
    fontFamily: fonts.semibold,
    fontSize: 12,
  },
  partnerAmount: {
    color: colors.primary,
    fontFamily: fonts.semibold,
    fontSize: 13,
  },
  dailyHeading: {
    alignItems: "center",
    backgroundColor: "#faf9ff",
    borderBottomColor: colors.borderSoft,
    borderBottomWidth: 1,
    flexDirection: "row",
    gap: spacing.sm,
    justifyContent: "space-between",
    padding: spacing.md,
  },
  dailyHeadingCopy: {
    flex: 1,
    gap: 2,
  },
  dailyTitle: {
    color: colors.ink,
    fontFamily: fonts.semibold,
    fontSize: 13,
  },
  dailyCaption: {
    color: colors.textMuted,
    fontFamily: fonts.regular,
    fontSize: 11,
    lineHeight: 15,
  },
  dailyTotal: {
    color: colors.primary,
    fontFamily: fonts.semibold,
    fontSize: 11,
  },
  dailyRow: {
    alignItems: "center",
    borderBottomColor: colors.borderSoft,
    borderBottomWidth: 1,
    flexDirection: "row",
    gap: spacing.sm,
    padding: spacing.md,
  },
  dailyRowCopy: {
    flex: 1,
    gap: 2,
  },
  dailyRowTitle: {
    color: colors.ink,
    fontFamily: fonts.semibold,
    fontSize: 12,
  },
  dailyEarned: {
    color: colors.success,
    fontFamily: fonts.semibold,
    fontSize: 11,
  },
  dailyAvailable: {
    color: colors.primary,
    fontFamily: fonts.semibold,
    fontSize: 11,
  },
  referralButton: {
    alignItems: "center",
    backgroundColor: "#f7f4ff",
    borderColor: "#c9bcff",
    borderRadius: radius.pill,
    borderWidth: 1,
    flexDirection: "row",
    gap: 5,
    minHeight: 30,
    paddingHorizontal: spacing.sm,
    paddingVertical: 5,
  },
  referralButtonDisabled: {
    opacity: 0.65,
  },
  referralButtonText: {
    color: colors.primary,
    fontFamily: fonts.semibold,
    fontSize: 11,
  },
  qrCard: {
    alignItems: "center",
    alignSelf: "center",
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: radius.md,
    borderWidth: 1,
    padding: 10,
  },
  walletToken: {
    gap: spacing.sm,
  },
  secondaryButton: {
    alignItems: "center",
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: radius.sm,
    borderWidth: 1,
    flexDirection: "row",
    gap: 6,
    justifyContent: "center",
    minHeight: 44,
    paddingHorizontal: spacing.md,
  },
  secondaryButtonText: {
    color: colors.ink,
    fontFamily: fonts.semibold,
    fontSize: 13,
  },
  /* Stacked, not side by side: the token is a 35-character opaque string that
     wraps to two lines at this width, and a button centred against a wrapping
     block sits at neither line's baseline. Full width also gives the copy
     action the same footprint as the reveal button directly above it. */
  walletTokenValue: {
    alignItems: "stretch",
    backgroundColor: "#fbfdff",
    borderColor: colors.borderSoft,
    borderRadius: radius.md,
    borderWidth: 1,
    gap: spacing.sm,
    padding: 7,
  },
  walletTokenCode: {
    backgroundColor: colors.surface,
    borderRadius: radius.sm,
    color: colors.ink,
    fontFamily: "monospace",
    fontSize: 11,
    fontWeight: "700",
    lineHeight: 16,
    paddingHorizontal: 10,
    paddingVertical: spacing.sm,
  },
  copyButton: {
    alignItems: "center",
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: radius.sm,
    borderWidth: 1,
    flexDirection: "row",
    gap: 5,
    justifyContent: "center",
    minHeight: 36,
    paddingHorizontal: 10,
    paddingVertical: 7,
  },
  copyButtonText: {
    color: colors.ink,
    fontFamily: fonts.semibold,
    fontSize: 12,
  },
  pressed: {
    opacity: 0.78,
  },
  notice: {
    backgroundColor: colors.successSoft,
    borderColor: "#bcebc9",
    borderRadius: radius.sm,
    borderWidth: 1,
    marginBottom: spacing.md,
    padding: spacing.md,
  },
  noticeText: {
    color: "#147a36",
    fontFamily: fonts.regular,
    fontSize: 13,
  },
  retry: {
    marginBottom: spacing.md,
  },
});
