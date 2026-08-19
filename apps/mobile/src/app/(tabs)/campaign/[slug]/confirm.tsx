import { toDisplayPhone } from "@bizflow/shared";
import { useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { selectVoucher } from "@/api/client";
import { useAuth } from "@/auth/AuthContext";
import { Button, Field, InlineError, ReadOnlyField } from "@/components/FormControls";
import { BusinessDetailsCard } from "@/components/BusinessDetailsCard";
import { StepHeader, SummaryList, SummaryRow } from "@/components/HuntUi";
import { VoucherTicket } from "@/components/VoucherTicket";
import { useHunt } from "@/hunt/HuntContext";
import { useReturnToLanding } from "@/hunt/useReturnToLanding";
import {
  campaignModeLabel,
  formatDate,
  formatTime,
  localeFor,
} from "@/lib/format";
import { useLanguage } from "@/i18n/LanguageContext";
import { colors, fonts, spacing } from "@/theme";

/** Step 6 — name/email/guests, then issue the final voucher. */
export default function ConfirmScreen() {
  const { language, t } = useLanguage();
  const router = useRouter();
  const { phone, token } = useAuth();
  const {
    campaign,
    flow,
    huntWasEntered,
    save,
    selectedAttempt,
    sessionId,
    settleVoucher,
    slotById,
    slug,
  } = useHunt();
  const returnToLanding = useReturnToLanding(slug);
  // The navigator keeps one stack for every campaign and swaps the parameter,
  // so this screen can find itself rendering a campaign nobody opened it for —
  // the customer taps a new campaign in the directory and lands here instead of
  // on its page. Checked in an effect that runs before the provider's own, which
  // is why the answer comes from a ref rather than from state.
  const bounced = useRef(false);
  useEffect(() => {
    if (bounced.current || huntWasEntered()) return;
    bounced.current = true;
    returnToLanding();
  }, [huntWasEntered, returnToLanding]);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const slot = slotById(flow.selectedSlotId);
  const isRestaurant = campaign?.campaign.mode === "restaurant";

  async function issue() {
    if (!token || !selectedAttempt) return;
    setBusy(true);
    setError("");
    try {
      const issued = await selectVoucher(
        {
          campaignSlug: slug,
          attemptId: selectedAttempt.id,
          slotId: flow.selectedSlotId,
          sessionId,
          name: flow.name.trim(),
          email: flow.email.trim() || undefined,
          guestCount: isRestaurant ? Number(flow.guestCount) || 1 : undefined,
        },
        token,
      );
      // Not `save`: the booking has to survive a snapshot read that has not
      // caught up with it yet, and only this records that it is ours.
      settleVoucher({ voucher: issued.voucher, slot: issued.slot });
      router.replace({ pathname: "/campaign/[slug]/confirmation", params: { slug } });
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : t("confirm.reserveError"),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <SafeAreaView edges={["top", "left", "right"]} style={styles.safeArea}>
      <StepHeader onBack={() => router.back()} title={t("confirm.stepTitle")} />
      <ScrollView
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <Text style={styles.lead}>{t("confirm.lead")}</Text>

        {selectedAttempt ? (
          <View style={styles.ticket}>
            <VoucherTicket benefit={selectedAttempt} detail={t("confirm.selectedVoucher")} />
          </View>
        ) : (
          <InlineError message={t("confirm.selectFirst")} />
        )}

        <Field
          autoCapitalize="words"
          label={t("confirm.fullName")}
          onChangeText={(value) => save({ name: value })}
          placeholder={t("confirm.fullNamePlaceholder")}
          value={flow.name}
        />
        <ReadOnlyField
          label={t("confirm.mobileNumber")}
          value={phone ? toDisplayPhone(phone) : "—"}
        />
        <Field
          autoCapitalize="none"
          keyboardType="email-address"
          label={t("confirm.emailOptional")}
          onChangeText={(value) => save({ email: value })}
          placeholder="jane@example.com"
          value={flow.email}
        />
        {isRestaurant ? (
          <Field
            keyboardType="number-pad"
            label={t("confirm.guests")}
            onChangeText={(value) => save({ guestCount: value })}
            value={flow.guestCount}
          />
        ) : null}

        <SummaryList>
          <SummaryRow
            icon="flag"
            label={t("common.campaign")}
            value={campaign?.campaign.title ?? "—"}
          />
          <SummaryRow
            icon="briefcase"
            label={t("common.business")}
            value={campaign?.business?.name ?? "—"}
          />
          <SummaryRow
            icon="calendar"
            label={t("common.date")}
            value={
              slot
                ? formatDate(slot.date, localeFor(language))
                : t("confirm.noSlot")
            }
          />
          <SummaryRow
            icon="clock"
            label={t("common.time")}
            value={
              slot
                ? formatTime(slot.startTime, localeFor(language))
                : t("confirm.noSlot")
            }
          />
          <SummaryRow
            icon="tag"
            label={t("confirm.category")}
            value={campaignModeLabel(t, campaign?.campaign.mode ?? "other")}
          />
        </SummaryList>

        <BusinessDetailsCard business={campaign?.business} />

        {error ? <InlineError message={error} /> : null}

        <View style={styles.action}>
          <Button
            disabled={!selectedAttempt || !flow.selectedSlotId || !flow.name.trim()}
            loading={busy}
            loadingLabel={t("confirm.reserving")}
            onPress={issue}
          >
            {t("confirm.submit")}
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
  lead: {
    color: colors.textMuted,
    fontFamily: fonts.regular,
    fontSize: 14,
    lineHeight: 21,
    marginBottom: spacing.lg,
  },
  ticket: {
    marginBottom: spacing.lg,
  },
  action: {
    marginTop: spacing.xl,
  },
});
