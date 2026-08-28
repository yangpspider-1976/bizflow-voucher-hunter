import { useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Image,
  Linking,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import type { MissionCard } from "@bizflow/shared";

import { getMission, submitMissionProof } from "@/api/client";
import { useAuth } from "@/auth/AuthContext";
import { ErrorState } from "@/components/ErrorState";
import { Icon } from "@/components/Icon";
import { Screen } from "@/components/Screen";
import { useGamification } from "@/gamification/GamificationContext";
import { pickEvidence, type PickedEvidence } from "@/gamification/evidence";
import { useTranslation } from "@/i18n/LanguageContext";
import { colors, fonts, radius, spacing } from "@/theme";

/**
 * One mission's details, and the evidence form for the ones that need it.
 *
 * The two belong on the same screen because they are the same question: a
 * player looking at "what do I have to do" is a tap away from "here is what I
 * did". Splitting them would put the instructions behind a back button at the
 * moment they are most needed.
 *
 * A rejected submission shows the reviewer's reason verbatim above the form.
 * That is the whole point of requiring a reason — the mission stays open for a
 * second attempt, and a second attempt only helps if they know what to fix.
 */
export default function MissionDetailScreen() {
  const t = useTranslation();
  const router = useRouter();
  const { token } = useAuth();
  const { refresh } = useGamification();
  const { missionKey } = useLocalSearchParams<{ missionKey: string }>();

  const [mission, setMission] = useState<MissionCard | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);

  const [evidence, setEvidence] = useState<PickedEvidence | null>(null);
  const [note, setNote] = useState("");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [formError, setFormError] = useState("");

  const load = useCallback(async () => {
    if (!token || !missionKey) return;
    setLoading(true);
    setError(null);
    try {
      setMission(await getMission(missionKey, token));
    } catch (caught) {
      setError(caught);
    } finally {
      setLoading(false);
    }
  }, [missionKey, token]);

  useEffect(() => {
    void load();
  }, [load]);

  async function choose() {
    setFormError("");
    const result = await pickEvidence();
    if (result.ok) {
      setEvidence(result.evidence);
      return;
    }
    if (result.reason === "too_large") setFormError(t("proof.tooLarge"));
    else if (result.reason !== "cancelled") setFormError(t("proof.failed"));
  }

  async function send() {
    if (!token || !mission) return;
    // Text is a valid submission on its own; a photo mission is not.
    if (!evidence && note.trim().length < 4) {
      setFormError(t("proof.needPhoto"));
      return;
    }
    setFormError("");
    setSending(true);
    try {
      await submitMissionProof(
        {
          missionKey: mission.missionKey,
          kind: evidence ? "receipt" : "text",
          note: note.trim() || undefined,
          file: evidence
            ? { contentBase64: evidence.contentBase64, contentType: evidence.contentType }
            : null,
        },
        token,
      );
      setSent(true);
      setEvidence(null);
      setNote("");
      await Promise.all([load(), refresh()]);
    } catch (caught) {
      setFormError(caught instanceof Error ? caught.message : t("proof.failed"));
    } finally {
      setSending(false);
    }
  }

  if (loading && !mission) {
    return (
      <Screen title={t("mission.details")}>
        <ActivityIndicator color={colors.primary} style={styles.loader} />
      </Screen>
    );
  }

  if (!mission) {
    return (
      <Screen title={t("mission.details")}>
        <ErrorState error={error} fallback={t("mission.notFound")} onRetry={load} />
      </Screen>
    );
  }

  const reward = [
    mission.reward.xp > 0 ? `${mission.reward.xp} XP` : null,
    mission.reward.lp || null,
  ]
    .filter(Boolean)
    .join(" + ");
  const rejected = mission.proof?.status === "Rejected";
  const pending = mission.proof?.status === "Pending";

  return (
    <Screen onRefresh={load} refreshing={loading} title={mission.title}>
      <View style={styles.stack}>
        <Pressable
          accessibilityRole="button"
          onPress={() => router.back()}
          style={styles.backRow}
        >
          <Icon color={colors.textMuted} name="chevron-left" size={16} />
          <Text style={styles.backText}>{t("quests.title")}</Text>
        </Pressable>

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>{t("mission.howToFinish")}</Text>
          <Text style={styles.body}>{mission.description}</Text>
          <View style={styles.factRow}>
            <Text style={styles.fact}>{reward}</Text>
            {mission.partnerName ? (
              <Text style={styles.factMuted}>{mission.partnerName}</Text>
            ) : null}
            {mission.quotaRemaining !== null ? (
              <Text style={styles.factMuted}>
                {t("mission.placesLeft", { count: mission.quotaRemaining })}
              </Text>
            ) : null}
            {mission.window ? (
              <Text style={styles.factMuted}>
                {mission.window.startTime}-{mission.window.endTime}
              </Text>
            ) : null}
          </View>
          {mission.termsUrl ? (
            <Pressable
              accessibilityRole="link"
              onPress={() => void Linking.openURL(mission.termsUrl!)}
            >
              <Text style={styles.link}>{t("mission.terms")}</Text>
            </Pressable>
          ) : null}
        </View>

        {mission.requiresProof ? (
          <View style={styles.card}>
            <Text style={styles.sectionTitle}>{t("proof.title")}</Text>
            <Text style={styles.body}>{t("proof.subtitle")}</Text>

            {rejected ? (
              <Text style={styles.rejected}>
                {t("mission.evidenceRejected", {
                  reason: mission.proof?.rejectReason ?? "",
                })}
              </Text>
            ) : null}
            {pending && !sent ? (
              <Text style={styles.pending}>{t("mission.verifying")}</Text>
            ) : null}
            {sent ? <Text style={styles.pending}>{t("proof.submitted")}</Text> : null}

            {evidence ? (
              <Image
                accessibilityIgnoresInvertColors
                source={{ uri: evidence.previewUri }}
                style={styles.preview}
              />
            ) : null}

            <Pressable
              accessibilityRole="button"
              onPress={choose}
              style={({ pressed }) => [styles.secondary, pressed && styles.pressed]}
            >
              <Text style={styles.secondaryText}>
                {evidence ? t("proof.changePhoto") : t("proof.pickPhoto")}
              </Text>
            </Pressable>

            <TextInput
              multiline
              onChangeText={setNote}
              placeholder={t("proof.note")}
              placeholderTextColor={colors.textMuted}
              style={styles.input}
              value={note}
            />

            <Text style={styles.privacy}>{t("proof.privacy")}</Text>
            {formError ? <Text style={styles.error}>{formError}</Text> : null}

            <Pressable
              accessibilityRole="button"
              disabled={sending}
              onPress={send}
              style={({ pressed }) => [styles.primary, pressed && styles.pressed]}
            >
              <Text style={styles.primaryText}>
                {sending ? t("proof.submitting") : t("proof.submit")}
              </Text>
            </Pressable>
          </View>
        ) : null}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  loader: {
    marginTop: spacing.xxl,
  },
  stack: {
    gap: spacing.md,
  },
  backRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing.xs,
  },
  backText: {
    color: colors.textMuted,
    fontFamily: fonts.semibold,
    fontSize: 13,
  },
  card: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: radius.md,
    borderWidth: 1,
    gap: spacing.sm,
    padding: spacing.lg,
  },
  sectionTitle: {
    color: colors.ink,
    fontFamily: fonts.bold,
    fontSize: 16,
  },
  body: {
    color: colors.textMuted,
    fontFamily: fonts.regular,
    fontSize: 14,
    lineHeight: 20,
  },
  factRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.sm,
  },
  fact: {
    color: colors.primary,
    fontFamily: fonts.bold,
    fontSize: 13,
  },
  factMuted: {
    color: colors.textMuted,
    fontFamily: fonts.semibold,
    fontSize: 13,
  },
  link: {
    color: colors.primary,
    fontFamily: fonts.semibold,
    fontSize: 13,
    textDecorationLine: "underline",
  },
  rejected: {
    backgroundColor: colors.dangerSoft,
    borderRadius: radius.sm,
    color: colors.danger,
    fontFamily: fonts.semibold,
    fontSize: 13,
    padding: spacing.md,
  },
  pending: {
    color: colors.warning,
    fontFamily: fonts.semibold,
    fontSize: 13,
  },
  preview: {
    borderRadius: radius.sm,
    height: 180,
    width: "100%",
  },
  input: {
    backgroundColor: colors.page,
    borderColor: colors.border,
    borderRadius: radius.sm,
    borderWidth: 1,
    color: colors.ink,
    fontFamily: fonts.regular,
    fontSize: 14,
    minHeight: 80,
    padding: spacing.md,
    textAlignVertical: "top",
  },
  privacy: {
    color: colors.textMuted,
    fontFamily: fonts.regular,
    fontSize: 12,
    lineHeight: 17,
  },
  error: {
    color: colors.danger,
    fontFamily: fonts.semibold,
    fontSize: 13,
  },
  primary: {
    alignItems: "center",
    backgroundColor: colors.primary,
    borderRadius: radius.pill,
    paddingVertical: spacing.md,
  },
  primaryText: {
    color: colors.surface,
    fontFamily: fonts.bold,
    fontSize: 15,
  },
  secondary: {
    alignItems: "center",
    backgroundColor: colors.primarySoft,
    borderRadius: radius.pill,
    paddingVertical: spacing.md,
  },
  secondaryText: {
    color: colors.primary,
    fontFamily: fonts.bold,
    fontSize: 14,
  },
  pressed: {
    opacity: 0.88,
  },
});
