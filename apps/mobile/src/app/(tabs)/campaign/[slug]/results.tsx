import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AppState,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { isSelectableAttempt } from "@bizflow/shared";

import { buildReferralLink } from "@/api/client";
import { Button, InlineError } from "@/components/FormControls";
import { InfoCard, StepHeader } from "@/components/HuntUi";
import { VoucherTicket } from "@/components/VoucherTicket";
import { useHunt } from "@/hunt/HuntContext";
import { useReturnToLanding } from "@/hunt/useReturnToLanding";
import { voucherDetail } from "@/lib/format";
import { useTranslation } from "@/i18n/LanguageContext";
import { colors, fonts, spacing } from "@/theme";

/** Step 4 — the revealed candidates, one per spin the visitor has taken. */
export default function ResultsScreen() {
  const t = useTranslation();
  const router = useRouter();
  const {
    campaign,
    flow,
    huntWasEntered,
    refreshSnapshot,
    requestSpin,
    save,
    selectedAttempt,
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

  const [sharing, setSharing] = useState(false);
  const [shareError, setShareError] = useState("");

  // The snapshot carries every attempt this number has ever drawn on the
  // campaign, expired ones included — a spin from a fortnight ago came back as a
  // full-price card the customer could tap, and only the 409 at selection said
  // otherwise. Options are what can still be picked.
  const options = useMemo(
    () => flow.attempts.filter(isSelectableAttempt),
    [flow.attempts],
  );

  const refreshReferralState = useCallback(() => {
    void refreshSnapshot().catch(() => {
      // A transient refresh failure should not replace the vouchers already shown.
    });
  }, [refreshSnapshot]);

  useFocusEffect(
    useCallback(() => {
      refreshReferralState();
      const interval = setInterval(refreshReferralState, 5000);
      return () => clearInterval(interval);
    }, [refreshReferralState]),
  );

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") refreshReferralState();
    });
    return () => subscription.remove();
  }, [refreshReferralState]);

  async function handleShareOrSpin() {
    setShareError("");
    if (flow.bonusAttempts > 0) {
      // Flagged as a fresh spin: opening the reel any other way resumes a draw
      // that was never revealed, and this is a request for a new one. The flag
      // says which kind of spin; the ask below is what permits one at all.
      requestSpin();
      router.push({
        pathname: "/campaign/[slug]/roulette",
        params: { slug, spin: "fresh" },
      });
      return;
    }
    if (!flow.userId) {
      setShareError(t("results.linkNotReady"));
      return;
    }

    setSharing(true);
    try {
      const link = buildReferralLink(slug, flow.userId);
      await Share.share({
        title: t("results.shareTitle"),
        message: t("results.shareMessage", { link }),
      });
      refreshReferralState();
    } catch (caught) {
      setShareError(
        caught instanceof Error ? caught.message : t("results.shareError"),
      );
    } finally {
      setSharing(false);
    }
  }

  return (
    <SafeAreaView edges={["top", "left", "right"]} style={styles.safeArea}>
      <StepHeader title={t("results.stepTitle")} />
      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        <Text style={styles.title}>{t("results.title")}</Text>
        <Text style={styles.lead}>{t("results.lead")}</Text>

        {options.length === 0 ? (
          <InfoCard>
            <Text style={styles.infoText}>{t("results.noResult")}</Text>
            <Button onPress={returnToLanding}>{t("results.returnCampaign")}</Button>
          </InfoCard>
        ) : (
          <View style={styles.stack}>
            {options.map((attempt) => {
              const selected = attempt.id === flow.selectedAttemptId;
              return (
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ selected }}
                  key={attempt.id}
                  onPress={() =>
                    save({
                      selectedAttemptId: attempt.id,
                      selectedDate: "",
                      selectedSlotId: "",
                      issued: null,
                    })
                  }
                >
                  <VoucherTicket
                    benefit={attempt}
                    detail={voucherDetail(t, attempt)}
                    footnote={t("results.minSpend")}
                    selected={selected}
                  />
                </Pressable>
              );
            })}

            <View style={styles.shareBlock}>
              <Button
                loading={sharing}
                loadingLabel={t("results.openingShare")}
                variant="secondary"
                onPress={() => void handleShareOrSpin()}
              >
                {flow.bonusAttempts > 0
                  ? t("results.spinAgain", { count: flow.bonusAttempts })
                  : t("results.shareToUnlock")}
              </Button>
              {shareError ? <InlineError message={shareError} /> : null}
              <Text style={styles.shareHint}>{t("results.shareHint")}</Text>
              <Text style={styles.shareNote}>
                {t("results.shareCount", {
                  count: flow.shareCount,
                  limit: campaign?.campaign.referralDailyLimit ?? 0,
                })}
              </Text>
            </View>
          </View>
        )}

        <View style={styles.action}>
          <Button
            disabled={!selectedAttempt}
            onPress={() =>
              router.push({ pathname: "/campaign/[slug]/datetime", params: { slug } })
            }
          >
            {t("results.pickDateTime")}
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
  title: {
    color: colors.ink,
    fontFamily: fonts.bold,
    fontSize: 25,
    lineHeight: 28,
    marginBottom: 12,
  },
  lead: {
    color: colors.textMuted,
    fontFamily: fonts.regular,
    fontSize: 14,
    lineHeight: 21,
    marginBottom: spacing.lg,
  },
  infoText: {
    color: colors.ink,
    fontFamily: fonts.regular,
    fontSize: 14,
  },
  stack: {
    gap: spacing.md,
  },
  shareBlock: {
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
  shareHint: {
    color: colors.textMuted,
    fontFamily: fonts.regular,
    fontSize: 13,
    lineHeight: 19,
  },
  shareNote: {
    color: colors.textMuted,
    fontFamily: fonts.regular,
    fontSize: 13,
  },
  action: {
    marginTop: spacing.xl,
  },
});
