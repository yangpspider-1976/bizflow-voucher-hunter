import { LinearGradient } from "expo-linear-gradient";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { LevelState } from "@bizflow/shared";

import { Icon } from "@/components/Icon";
import { useTranslation } from "@/i18n/LanguageContext";
import { colors, fonts, palette, radius, spacing } from "@/theme";

/**
 * Where the player stands, in one card.
 *
 * The requirements' success criterion is that today's actions, the distance to
 * the next level and achievement progress are readable on one screen, so this
 * leads with the gap rather than the total: "310 XP to Pro Hunter" is a thing
 * to do, "1,190 XP" is trivia.
 */
export function LevelCard({
  level,
  onPress,
  subtitle,
}: {
  level: LevelState;
  onPress?: () => void;
  subtitle?: string;
}) {
  const t = useTranslation();
  const atTop = level.nextLevelXp === null;

  return (
    <Pressable
      accessibilityRole={onPress ? "button" : undefined}
      disabled={!onPress}
      onPress={onPress}
      style={({ pressed }) => [styles.card, pressed && onPress && styles.pressed]}
    >
      <LinearGradient
        colors={[palette.purple, palette.purple2]}
        end={{ x: 1, y: 1 }}
        start={{ x: 0, y: 0 }}
        style={StyleSheet.absoluteFill}
      />

      <View style={styles.header}>
        <View style={styles.badge}>
          <Text style={styles.badgeNumber}>{level.level}</Text>
        </View>
        <View style={styles.headerText}>
          <Text style={styles.levelName}>{level.name}</Text>
          <Text style={styles.xpTotal}>
            {t("level.xpTotal", { xp: level.lifetimeXp.toLocaleString() })}
          </Text>
        </View>
        {onPress ? <Icon color="rgba(255,255,255,0.8)" name="chevron-right" size={20} /> : null}
      </View>

      <View style={styles.track}>
        <View style={[styles.fill, { width: `${Math.round(level.progress * 100)}%` }]} />
      </View>

      <Text style={styles.gap}>
        {atTop
          ? t("level.atTop")
          : t("level.toNext", {
              xp: (level.xpToNextLevel ?? 0).toLocaleString(),
            })}
      </Text>

      {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}

      {level.bonusHunts > 0 ? (
        <View style={styles.perk}>
          <Icon color={colors.surface} name="zap" size={13} />
          <Text style={styles.perkText}>
            {t("level.bonusHunts", { count: level.bonusHunts })}
          </Text>
        </View>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: radius.lg,
    gap: spacing.md,
    overflow: "hidden",
    padding: spacing.xl,
  },
  pressed: {
    opacity: 0.9,
  },
  header: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing.md,
  },
  badge: {
    alignItems: "center",
    backgroundColor: "rgba(255,255,255,0.18)",
    borderColor: "rgba(255,255,255,0.35)",
    borderRadius: radius.pill,
    borderWidth: 1,
    height: 44,
    justifyContent: "center",
    width: 44,
  },
  badgeNumber: {
    color: colors.surface,
    fontFamily: fonts.extrabold,
    fontSize: 19,
  },
  headerText: {
    flex: 1,
    gap: 2,
  },
  levelName: {
    color: colors.surface,
    fontFamily: fonts.extrabold,
    fontSize: 20,
    letterSpacing: -0.3,
  },
  xpTotal: {
    color: "rgba(255,255,255,0.78)",
    fontFamily: fonts.regular,
    fontSize: 13,
  },
  track: {
    backgroundColor: "rgba(255,255,255,0.22)",
    borderRadius: radius.pill,
    height: 8,
    overflow: "hidden",
  },
  fill: {
    backgroundColor: colors.surface,
    borderRadius: radius.pill,
    height: 8,
  },
  gap: {
    color: colors.surface,
    fontFamily: fonts.semibold,
    fontSize: 14,
  },
  subtitle: {
    color: "rgba(255,255,255,0.78)",
    fontFamily: fonts.regular,
    fontSize: 13,
    lineHeight: 19,
  },
  perk: {
    alignItems: "center",
    alignSelf: "flex-start",
    backgroundColor: "rgba(255,255,255,0.16)",
    borderRadius: radius.pill,
    flexDirection: "row",
    gap: spacing.xs,
    paddingHorizontal: spacing.md,
    paddingVertical: 5,
  },
  perkText: {
    color: colors.surface,
    fontFamily: fonts.semibold,
    fontSize: 12,
  },
});
