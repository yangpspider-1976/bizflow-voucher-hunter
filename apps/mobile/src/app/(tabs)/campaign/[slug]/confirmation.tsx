import { useRouter } from "expo-router";
import { useEffect, useRef } from "react";
import {
  ActivityIndicator,
  Image,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import QRCode from "react-native-qrcode-svg";
import { SafeAreaView } from "react-native-safe-area-context";

import { resolveAssetUrl } from "@/api/client";
import { BusinessDetailsCard } from "@/components/BusinessDetailsCard";
import { Button } from "@/components/FormControls";
import { StepHeader, SummaryList, SummaryRow } from "@/components/HuntUi";
import { VoucherTicket } from "@/components/VoucherTicket";
import { useHunt } from "@/hunt/HuntContext";
import { useReturnToLanding } from "@/hunt/useReturnToLanding";
import { useLanguage } from "@/i18n/LanguageContext";
import { formatDate, formatTime, localeFor, voucherStatusLabel } from "@/lib/format";
import { colors, fonts, palette, radius, spacing } from "@/theme";

/** Step 7 — the issued voucher and the QR the outlet scans. */
export default function ConfirmationScreen() {
  const { language, t } = useLanguage();
  const router = useRouter();
  const { campaign, flow, huntWasEntered, loading, slug } = useHunt();
  const returnToLanding = useReturnToLanding(slug);
  const issued = flow.issued;

  // The navigator keeps one stack for every campaign and swaps the parameter, so
  // this screen can find itself rendering a campaign nobody opened it for. Left
  // alone it would tell that campaign's visitor they have no voucher.
  const bounced = useRef(false);
  useEffect(() => {
    if (bounced.current || huntWasEntered()) return;
    bounced.current = true;
    returnToLanding();
  }, [huntWasEntered, returnToLanding]);

  // A campaign resumed straight to this screen renders before its snapshot has
  // arrived. Saying "no voucher" in that gap tells a customer who holds one
  // that it is gone, so the wait is shown as a wait.
  if (loading) {
    return (
      <SafeAreaView edges={["top", "left", "right"]} style={styles.safeArea}>
        <StepHeader title={t("confirmation.stepTitle")} />
        <ActivityIndicator color={colors.primary} style={styles.loader} />
      </SafeAreaView>
    );
  }

  if (!issued) {
    return (
      <SafeAreaView edges={["top", "left", "right"]} style={styles.safeArea}>
        <StepHeader title={t("confirmation.stepTitle")} />
        <View style={styles.content}>
          <Text style={styles.lead}>{t("confirmation.noVoucher")}</Text>
          <Button onPress={() => router.replace("/")}>{t("confirmation.backToCampaigns")}</Button>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView edges={["top", "left", "right"]} style={styles.safeArea}>
      <StepHeader title={t("confirmation.stepTitle")} />
      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        <Image
          accessibilityLabel={t("confirmation.confirmedImage")}
          resizeMode="contain"
          source={{ uri: resolveAssetUrl("/assets/confirmation-check.png") }}
          style={styles.check}
        />
        <Text style={styles.title}>{t("confirmation.reservationConfirmed")}</Text>
        <Text style={styles.lead}>{t("confirmation.arrivalQr")}</Text>

        <VoucherTicket
          benefit={issued.voucher}
          code={issued.voucher.voucherCode}
          copyable
          detail={t("confirmation.yourReward")}
        />

        {/* The QR encodes the voucher's `qrToken`, which is what the staff
            validation screen on the web scans. */}
        <View style={styles.qr}>
          <QRCode
            backgroundColor={palette.surface}
            color={palette.navy}
            size={164}
            value={issued.voucher.qrToken}
          />
        </View>

        <SummaryList>
          <SummaryRow icon="flag" label={t("common.campaign")} value={campaign?.campaign.title ?? "—"} />
          <SummaryRow icon="briefcase" label={t("common.business")} value={campaign?.business?.name ?? "—"} />
          <SummaryRow icon="calendar" label={t("common.date")} value={formatDate(issued.slot.date, localeFor(language))} />
          <SummaryRow
            icon="clock"
            label={t("common.time")}
            value={formatTime(issued.slot.startTime, localeFor(language))}
          />
          <SummaryRow icon="check-circle" label={t("confirmation.status")} value={voucherStatusLabel(t, issued.voucher.status)} />
        </SummaryList>

        <BusinessDetailsCard business={campaign?.business} />

        <View style={styles.action}>
          <Button onPress={() => router.replace("/vouchers")}>
            {t("confirmation.viewVouchers")}
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
    padding: 18,
    paddingBottom: 48,
    paddingTop: 26,
  },
  loader: {
    marginTop: 80,
  },
  check: {
    alignSelf: "center",
    height: 76,
    marginBottom: 14,
    width: 76,
  },
  title: {
    color: colors.ink,
    fontFamily: fonts.bold,
    fontSize: 24,
    marginBottom: 6,
    textAlign: "center",
  },
  lead: {
    color: colors.textMuted,
    fontFamily: fonts.regular,
    fontSize: 14,
    lineHeight: 21,
    marginBottom: spacing.lg,
    textAlign: "center",
  },
  qr: {
    alignItems: "center",
    alignSelf: "center",
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: radius.md,
    borderWidth: 1,
    justifyContent: "center",
    marginVertical: spacing.lg,
    minHeight: 180,
    padding: 8,
    width: 180,
  },
  action: {
    marginTop: spacing.xl,
  },
});
