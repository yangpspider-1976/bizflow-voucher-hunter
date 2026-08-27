import { useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import type { AchievementCard, AchievementCategory } from "@bizflow/shared";

import { Icon } from "@/components/Icon";
import { Screen } from "@/components/Screen";
import {
  useGamification,
  useGamificationFocusRefresh,
} from "@/gamification/GamificationContext";
import { useTranslation } from "@/i18n/LanguageContext";
import { colors, fonts, radius, spacing } from "@/theme";

const CATEGORIES: Array<AchievementCategory | "all"> = [
  "all",
  "hunt",
  "visit",
  "mission",
  "streak",
  "review",
  "referral",
  "explore",
  "points",
];

const TIER_COLOUR: Record<string, string> = {
  Bronze: "#a25f2b",
  Silver: "#7c889e",
  Gold: "#d09a1c",
  Royal: "#5c3dff",
};

/** The badge wall: every group, all four tiers, and how far off each one is. */
export default function AchievementsScreen() {
  const t = useTranslation();
  const { isLoading, profile, refresh } = useGamification();
  const [category, setCategory] = useState<AchievementCategory | "all">("all");

  // Balances and mission progress move elsewhere in the app, so what this
  // screen shows is re-read every time it comes into view rather than once.
  useGamificationFocusRefresh();

  const cards = useMemo(
    () =>
      (profile?.achievements ?? []).filter(
        (card) => category === "all" || card.category === category,
      ),
    [category, profile],
  );

  if (!profile) return null;

  return (
    <Screen
      onRefresh={refresh}
      refreshing={isLoading}
      subtitle={t("achievement.subtitle")}
      title={t("achievement.title")}
    >
      <ScrollView
        contentContainerStyle={styles.filters}
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.filterStrip}
      >
        {CATEGORIES.map((candidate) => (
          <Pressable
            accessibilityRole="button"
            key={candidate}
            onPress={() => setCategory(candidate)}
            style={[styles.chip, category === candidate && styles.chipActive]}
          >
            <Text
              style={[styles.chipText, category === candidate && styles.chipTextActive]}
            >
              {t(`achievement.category.${candidate}` as never)}
            </Text>
          </Pressable>
        ))}
      </ScrollView>

      <View style={styles.stack}>
        {cards.map((card) => (
          <AchievementRow card={card} key={card.groupKey} />
        ))}
      </View>
    </Screen>
  );
}

function AchievementRow({ card }: { card: AchievementCard }) {
  const t = useTranslation();
  const next = card.nextTier;
  const share = next ? Math.min(1, card.progress / next.threshold) : 1;

  return (
    <View style={styles.card}>
      <View style={styles.cardHeader}>
        <View style={styles.medals}>
          {card.tiers.map((tier) => (
            <View
              key={tier.tier}
              style={[
                styles.medal,
                {
                  backgroundColor: tier.unlocked ? TIER_COLOUR[tier.tier] : colors.borderSoft,
                },
              ]}
            >
              <Icon
                color={tier.unlocked ? colors.surface : colors.textMuted}
                name={tier.unlocked ? "award" : "lock"}
                size={13}
              />
            </View>
          ))}
        </View>
        <Text style={styles.count}>
          {card.unlockedTiers}/{card.tiers.length}
        </Text>
      </View>

      <Text style={styles.title}>{card.title}</Text>
      <Text style={styles.description}>{card.description}</Text>

      <View style={styles.track}>
        <View style={[styles.fill, { width: `${Math.round(share * 100)}%` }]} />
      </View>

      <Text style={styles.progress}>
        {next
          ? t("achievement.toNextTier", {
              progress: card.progress.toLocaleString(),
              threshold: next.threshold.toLocaleString(),
              tier: t(`achievement.tier.${next.tier}` as never),
            })
          : t("achievement.allTiers")}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  filterStrip: {
    marginBottom: spacing.lg,
    marginHorizontal: -spacing.xl,
  },
  filters: {
    gap: spacing.sm,
    paddingHorizontal: spacing.xl,
  },
  chip: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: radius.pill,
    borderWidth: 1,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  chipActive: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  },
  chipText: {
    color: colors.textMuted,
    fontFamily: fonts.semibold,
    fontSize: 13,
  },
  chipTextActive: {
    color: colors.surface,
  },
  stack: {
    gap: spacing.md,
  },
  card: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: radius.md,
    borderWidth: 1,
    gap: spacing.xs,
    padding: spacing.lg,
  },
  cardHeader: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
  },
  medals: {
    flexDirection: "row",
    gap: spacing.xs,
  },
  medal: {
    alignItems: "center",
    borderRadius: radius.pill,
    height: 26,
    justifyContent: "center",
    width: 26,
  },
  count: {
    color: colors.textMuted,
    fontFamily: fonts.bold,
    fontSize: 13,
  },
  title: {
    color: colors.ink,
    fontFamily: fonts.bold,
    fontSize: 16,
    marginTop: spacing.xs,
  },
  description: {
    color: colors.textMuted,
    fontFamily: fonts.regular,
    fontSize: 13,
    lineHeight: 18,
  },
  track: {
    backgroundColor: colors.borderSoft,
    borderRadius: radius.pill,
    height: 6,
    marginTop: spacing.sm,
    overflow: "hidden",
  },
  fill: {
    backgroundColor: colors.primary,
    borderRadius: radius.pill,
    height: 6,
  },
  progress: {
    color: colors.ink,
    fontFamily: fonts.semibold,
    fontSize: 12,
  },
});
