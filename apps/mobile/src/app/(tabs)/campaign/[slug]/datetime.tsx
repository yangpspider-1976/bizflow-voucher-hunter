import { useRouter } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { ApiError, getAttemptSlots, type PublicSlot } from "@/api/client";
import { useAuth } from "@/auth/AuthContext";
import { Button, InlineError } from "@/components/FormControls";
import { InfoCard, SelectedStrip, SlotRow, StepHeader } from "@/components/HuntUi";
import { useHunt } from "@/hunt/HuntContext";
import { recoverSelection } from "@/hunt/recoverSelection";
import {
  formatDate,
  formatTime,
  localeFor,
  voucherDisplayLabel,
} from "@/lib/format";
import { useLanguage } from "@/i18n/LanguageContext";
import { colors, fonts, spacing } from "@/theme";

/**
 * Step 5 — the tier-gated slot picker. The slots come from `GET /hunt/slots`, not
 * the campaign's full slot list: a higher-value voucher is offered at fewer times.
 */
export default function DateTimeScreen() {
  const { language, t } = useLanguage();
  const router = useRouter();
  const { token } = useAuth();
  const { begin, flow, save, selectedAttempt, slug } = useHunt();
  const [slots, setSlots] = useState<PublicSlot[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  // Kept apart from `error` because the two need opposite affordances: `error`
  // is retryable and keeps the picker usable, while this one means the server
  // has no candidate left to book and the only way out is a new hunt.
  const [expired, setExpired] = useState(false);

  const load = useCallback(async () => {
    if (!token || !flow.selectedAttemptId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError("");
    setExpired(false);
    try {
      const result = await getAttemptSlots(
        { campaignSlug: slug, attemptId: flow.selectedAttemptId },
        token,
      );
      setSlots(result.slots);
    } catch (caught) {
      if (
        caught instanceof ApiError &&
        (caught.code === "E-USER-404" || caught.code === "E-ATTEMPT-404")
      ) {
        // Reconcile with the authoritative campaign session before discarding
        // the selected voucher. A stale local attempt can coexist with a newer
        // valid server attempt after a reset/reload or campaign switch.
        try {
          const snapshot = await begin();
          const recovery = recoverSelection({
            selectedAttemptId: flow.selectedAttemptId,
            snapshot,
          });

          if (recovery.kind === "retry") {
            setSlots([]);
            setError(t("datetime.loadError"));
            return;
          }

          if (recovery.kind === "voucher") {
            router.replace({
              pathname: "/campaign/[slug]/confirmation",
              params: { slug },
            });
            return;
          }

          if (recovery.kind === "attempt") {
            save({
              attempts: snapshot?.attempts ?? [],
              selectedAttemptId: recovery.attempt.id,
              selectedSlotId: "",
              selectedDate: "",
            });
            const recovered = await getAttemptSlots(
              { campaignSlug: slug, attemptId: recovery.attempt.id },
              token,
            );
            setSlots(recovered.slots);
            return;
          }
        } catch (recoveryFailure) {
          // Reconciliation itself failed, so nothing here is authoritative about
          // the selection — the network or the campaign read is what broke. Stay
          // retryable rather than sending the customer back to the reel on a
          // guess that would silently cost them their candidate.
          setSlots([]);
          setError(
            recoveryFailure instanceof Error
              ? recoveryFailure.message
              : t("datetime.loadError"),
          );
          return;
        }

        // The server answered and holds no bookable candidate for this campaign,
        // so the selection really is gone. This is the only branch that earns
        // the expired state.
        setSlots([]);
        setExpired(true);
        return;
      }
      setSlots([]);
      setError(
        caught instanceof Error ? caught.message : t("datetime.loadError"),
      );
    } finally {
      setLoading(false);
    }
  }, [begin, flow.selectedAttemptId, router, save, slug, t, token]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!flow.selectedAttemptId) {
    return (
      <SafeAreaView edges={["top", "left", "right"]} style={styles.safeArea}>
        <StepHeader onBack={() => router.back()} title={t("datetime.stepTitle")} />
        <View style={styles.content}>
          <InfoCard>
            <Text style={styles.infoText}>{t("datetime.revealFirst")}</Text>
            <Button
              onPress={() =>
                router.replace({ pathname: "/campaign/[slug]", params: { slug } })
              }
            >
              {t("results.returnCampaign")}
            </Button>
          </InfoCard>
        </View>
      </SafeAreaView>
    );
  }

  const dates = Array.from(new Set(slots.map((slot) => slot.date)));
  const selectedLabel = selectedAttempt
    ? voucherDisplayLabel(t, selectedAttempt)
    : "";

  return (
    <SafeAreaView edges={["top", "left", "right"]} style={styles.safeArea}>
      <StepHeader onBack={() => router.back()} title={t("datetime.stepTitle")} />
      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        {selectedAttempt ? (
          <SelectedStrip
            label={selectedLabel}
            onChange={() => router.back()}
          />
        ) : null}
        <Text style={styles.helper}>
          {t("datetime.helper", { label: selectedLabel })}
        </Text>

        {loading ? (
          <ActivityIndicator color={colors.primary} style={styles.loader} />
        ) : expired ? (
          <InfoCard>
            <Text style={styles.infoText}>{t("datetime.selectionExpired")}</Text>
            <Button
              onPress={() =>
                router.replace({ pathname: "/campaign/[slug]", params: { slug } })
              }
            >
              {t("results.returnCampaign")}
            </Button>
          </InfoCard>
        ) : slots.length === 0 ? (
          error ? null : (
            <InfoCard>
              <Text style={styles.infoText}>
                {t("datetime.noSlotsForVoucher")}
              </Text>
            </InfoCard>
          )
        ) : (
          dates.map((date) => (
            <View key={date}>
              <Text style={styles.dateTitle}>
                {formatDate(date, localeFor(language))}
              </Text>
              <View style={styles.slotList}>
                {slots
                  .filter((slot) => slot.date === date)
                  .map((slot) => {
                    const soldOut =
                      slot.remainingCapacity <= 0 || slot.status !== "active";
                    const low = slot.remainingCapacity <= 3;
                    return (
                      <SlotRow
                        key={slot.id}
                        low={low}
                        note={
                          soldOut
                            ? t("datetime.fullyBooked")
                            : low
                              ? t("datetime.spotsLeft", { count: slot.remainingCapacity })
                              : t("datetime.spotsAvailable", {
                                  count: slot.remainingCapacity,
                                })
                        }
                        onPress={() =>
                          save({ selectedSlotId: slot.id, selectedDate: slot.date })
                        }
                        selected={slot.id === flow.selectedSlotId}
                        soldOut={soldOut}
                        time={`${formatTime(
                          slot.startTime,
                          localeFor(language),
                        )} – ${formatTime(slot.endTime, localeFor(language))}`}
                      />
                    );
                  })}
              </View>
            </View>
          ))
        )}

        {error ? (
          <View style={styles.errorBlock}>
            <InlineError message={error} />
            <Button onPress={() => void load()}>{t("common.retry")}</Button>
          </View>
        ) : null}

        {/* Hidden while expired: the InfoCard above owns the way out, and a
            permanently disabled Continue reads as the screen being broken. */}
        {expired ? null : (
          <View style={styles.action}>
            <Button
              disabled={!flow.selectedSlotId}
              onPress={() =>
                router.push({ pathname: "/campaign/[slug]/confirm", params: { slug } })
              }
            >
              {t("common.continue")}
            </Button>
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
    padding: 18,
    paddingBottom: 48,
    paddingTop: 26,
  },
  infoText: {
    color: colors.ink,
    fontFamily: fonts.regular,
    fontSize: 14,
  },
  helper: {
    alignSelf: "center",
    color: colors.textMuted,
    fontFamily: fonts.regular,
    fontSize: 14,
    lineHeight: 21,
    marginBottom: 18,
    maxWidth: 280,
    textAlign: "center",
  },
  helperStrong: {
    color: colors.ink,
    fontFamily: fonts.bold,
  },
  loader: {
    marginTop: spacing.xl,
  },
  dateTitle: {
    color: "#6b7385",
    fontFamily: fonts.semibold,
    fontSize: 12,
    letterSpacing: 0.5,
    marginBottom: 14,
    marginTop: 26,
    textTransform: "uppercase",
  },
  slotList: {
    gap: 9,
  },
  action: {
    marginTop: spacing.xl,
  },
  // Keeps the retry button with the message that explains it, rather than
  // letting it drift down next to Continue.
  errorBlock: {
    gap: spacing.md,
    marginTop: spacing.md,
  },
});
