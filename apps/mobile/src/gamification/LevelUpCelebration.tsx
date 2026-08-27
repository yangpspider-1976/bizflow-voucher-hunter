import { LinearGradient } from "expo-linear-gradient";
import { Modal, Pressable, StyleSheet, Text, View } from "react-native";
import type { LevelDefinition } from "@bizflow/shared";

import { Icon } from "@/components/Icon";
import { useTranslation } from "@/i18n/LanguageContext";
import { colors, fonts, palette, radius, spacing } from "@/theme";

/**
 * The promotion screen.
 *
 * Shown once per promotion, not once per app launch: the server holds the
 * "announced" watermark, so a level won while the app was closed is celebrated
 * on whichever device is opened next and never again after that.
 *
 * It leads with what the level unlocked rather than with the number, because a
 * benefit is the reason to keep going and "Level 3" on its own is not.
 */
export function LevelUpCelebration({
  level,
  levels,
  onDismiss,
}: {
  level: number | null;
  levels: LevelDefinition[];
  onDismiss: () => void;
}) {
  const t = useTranslation();
  if (level === null) return null;

  const reached = levels.find((entry) => entry.level === level);
  const previous = levels.find((entry) => entry.level === level - 1);
  // Only what is new. Repeating benefits they already had would make a
  // promotion read as a list rather than as a gain.
  const gained = (reached?.benefits ?? []).filter(
    (benefit) => !(previous?.benefits ?? []).includes(benefit),
  );

  return (
    <Modal animationType="fade" onRequestClose={onDismiss} transparent visible>
      <View style={styles.backdrop}>
        <View style={styles.card}>
          <LinearGradient
            colors={[palette.purple, palette.purple2]}
            end={{ x: 1, y: 1 }}
            start={{ x: 0, y: 0 }}
            style={styles.badge}
          >
            <Text style={styles.badgeNumber}>{level}</Text>
          </LinearGradient>

          <Text style={styles.kicker}>{t("level.upKicker")}</Text>
          <Text style={styles.title}>{reached?.name ?? `Level ${level}`}</Text>

          {gained.length > 0 ? (
            <View style={styles.benefits}>
              {gained.map((benefit) => (
                <View key={benefit} style={styles.benefitRow}>
                  <Icon color={colors.primary} name="unlock" size={15} />
                  <Text style={styles.benefitText}>
                    {t(`level.benefit.${benefit}` as never)}
                  </Text>
                </View>
              ))}
            </View>
          ) : null}

          {reached && reached.bonusHunts > (previous?.bonusHunts ?? 0) ? (
            <Text style={styles.bonus}>
              {t("level.bonusHunts", { count: reached.bonusHunts })}
            </Text>
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
  badge: {
    alignItems: "center",
    borderRadius: radius.pill,
    height: 84,
    justifyContent: "center",
    marginBottom: spacing.sm,
    width: 84,
  },
  badgeNumber: {
    color: colors.surface,
    fontFamily: fonts.black,
    fontSize: 36,
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
    fontSize: 26,
    textAlign: "center",
  },
  benefits: {
    alignSelf: "stretch",
    backgroundColor: colors.primarySoft,
    borderRadius: radius.md,
    gap: spacing.sm,
    marginTop: spacing.md,
    padding: spacing.lg,
  },
  benefitRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing.sm,
  },
  benefitText: {
    color: colors.ink,
    flex: 1,
    fontFamily: fonts.semibold,
    fontSize: 14,
  },
  bonus: {
    color: colors.primary,
    fontFamily: fonts.bold,
    fontSize: 14,
    marginTop: spacing.sm,
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
