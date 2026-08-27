import { Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import type { AchievementUnlockNotice } from "@bizflow/shared";

import { Icon } from "@/components/Icon";
import { useTranslation } from "@/i18n/LanguageContext";
import { colors, fonts, palette, radius, spacing } from "@/theme";

const TIER_COLOURS: Record<string, [string, string]> = {
  Bronze: ["#d08b52", "#a25f2b"],
  Silver: ["#b8c1d1", "#7c889e"],
  Gold: ["#f6c453", "#d09a1c"],
  Royal: ["#8158ee", "#3c208d"],
};

/**
 * The celebration for an unlocked tier.
 *
 * It states what was granted, not just that something happened: the
 * requirements are explicit that a player should never have to open a support
 * ticket to find out whether a badge came with a reward. The reward is already
 * in their ledger by the time this renders — this is an announcement, never a
 * claim step.
 */
export function UnlockCelebration({
  notice,
  onDismiss,
}: {
  notice: AchievementUnlockNotice | null;
  onDismiss: () => void;
}) {
  const t = useTranslation();
  if (!notice) return null;

  const gradient = TIER_COLOURS[notice.tier] ?? [palette.purple, palette.purple2];
  const reward = [
    notice.reward.xp > 0 ? `${notice.reward.xp} XP` : null,
    notice.reward.lp || null,
  ]
    .filter(Boolean)
    .join(" + ");

  return (
    <Modal animationType="fade" onRequestClose={onDismiss} transparent visible>
      <View style={styles.backdrop}>
        <View style={styles.card}>
          <LinearGradient
            colors={gradient}
            end={{ x: 1, y: 1 }}
            start={{ x: 0, y: 0 }}
            style={styles.medal}
          >
            <Icon color={colors.surface} name="award" size={38} />
          </LinearGradient>

          <Text style={styles.kicker}>{t("achievement.unlocked")}</Text>
          <Text style={styles.title}>{notice.title}</Text>
          <Text style={styles.tier}>{t(`achievement.tier.${notice.tier}` as never)}</Text>

          {reward ? (
            <View style={styles.rewardChip}>
              <Text style={styles.rewardText}>{t("achievement.granted", { reward })}</Text>
            </View>
          ) : null}

          <Pressable
            accessibilityRole="button"
            onPress={onDismiss}
            style={({ pressed }) => [styles.button, pressed && styles.buttonPressed]}
          >
            <Text style={styles.buttonText}>{t("achievement.nice")}</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    alignItems: "center",
    backgroundColor: "rgba(11, 29, 58, 0.55)",
    flex: 1,
    justifyContent: "center",
    padding: spacing.xl,
  },
  card: {
    alignItems: "center",
    backgroundColor: colors.surface,
    borderRadius: radius.xl,
    gap: spacing.sm,
    padding: spacing.xxl,
    width: "100%",
  },
  medal: {
    alignItems: "center",
    borderRadius: radius.pill,
    height: 84,
    justifyContent: "center",
    marginBottom: spacing.sm,
    width: 84,
  },
  kicker: {
    color: colors.textMuted,
    fontFamily: fonts.semibold,
    fontSize: 12,
    letterSpacing: 1,
    textTransform: "uppercase",
  },
  title: {
    color: colors.ink,
    fontFamily: fonts.extrabold,
    fontSize: 24,
    textAlign: "center",
  },
  tier: {
    color: colors.textMuted,
    fontFamily: fonts.semibold,
    fontSize: 15,
  },
  rewardChip: {
    backgroundColor: colors.primarySoft,
    borderRadius: radius.pill,
    marginTop: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  rewardText: {
    color: colors.primary,
    fontFamily: fonts.bold,
    fontSize: 14,
  },
  button: {
    alignItems: "center",
    backgroundColor: colors.primary,
    borderRadius: radius.pill,
    marginTop: spacing.lg,
    paddingVertical: spacing.md,
    width: "100%",
  },
  buttonPressed: {
    opacity: 0.85,
  },
  buttonText: {
    color: colors.surface,
    fontFamily: fonts.bold,
    fontSize: 15,
  },
});
