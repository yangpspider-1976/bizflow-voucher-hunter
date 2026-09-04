import { useCallback, useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import type {
  AchievementCard,
  AchievementCategory,
  AchievementTierState,
} from "@bizflow/shared";
import { MAX_FEATURED_BADGES } from "@bizflow/shared";

import { setFeaturedBadge } from "@/api/client";
import { useAuth } from "@/auth/AuthContext";
import { localeFor } from "@/lib/format";

import { Icon } from "@/components/Icon";
import { Screen } from "@/components/Screen";
import {
  useGamification,
  useGamificationFocusRefresh,
} from "@/gamification/GamificationContext";
import { useLanguage, useTranslation } from "@/i18n/LanguageContext";
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
  const { token } = useAuth();
  const [busyTier, setBusyTier] = useState<string | null>(null);
  const [featureError, setFeatureError] = useState<string | null>(null);

  // Balances and mission progress move elsewhere in the app, so what this
  // screen shows is re-read every time it comes into view rather than once.
  useGamificationFocusRefresh();

  /**
   * Chosen badges, in the order the server holds them.
   *
   * Derived from the same cards the wall renders rather than tracked
   * separately, so the strip at the top and the rings below it cannot disagree
   * after a refresh.
   */
  const featured = useMemo(
    () =>
      (profile?.achievements ?? []).flatMap((card) =>
        card.tiers
          .filter((tier) => tier.featured)
          .map((tier) => ({ card, tier })),
      ),
    [profile],
  );

  const onToggleFeatured = useCallback(
    async (card: AchievementCard, tier: AchievementTierState) => {
      if (!token || !tier.unlocked) return;
      setBusyTier(`${card.groupKey}:${tier.tier}`);
      setFeatureError(null);
      try {
        await setFeaturedBadge(
          { groupKey: card.groupKey, tier: tier.tier, featured: !tier.featured },
          token,
        );
        await refresh();
      } catch (caught) {
        // The cap lives on the server, so its refusal is the message worth
        // showing rather than a guess made here.
        setFeatureError(caught instanceof Error ? caught.message : t("achievement.featureFailed"));
      } finally {
        setBusyTier(null);
      }
    },
    [refresh, t, token],
  );

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

      <View style={styles.featuredPanel}>
        <Text style={styles.featuredTitle}>{t("achievement.featuredTitle")}</Text>
        {featured.length === 0 ? (
          <Text style={styles.featuredHint}>{t("achievement.featuredEmpty")}</Text>
        ) : (
          <View style={styles.featuredRow}>
            {featured.map(({ card, tier }) => (
              <View key={`${card.groupKey}:${tier.tier}`} style={styles.featuredChip}>
                <View style={[styles.medal, { backgroundColor: TIER_COLOUR[tier.tier] }]}>
                  <Icon color={colors.surface} name="award" size={13} />
                </View>
                <Text numberOfLines={1} style={styles.featuredName}>
                  {card.title}
                </Text>
              </View>
            ))}
          </View>
        )}
        <Text style={styles.featuredHint}>
          {t("achievement.featuredHowTo", { max: MAX_FEATURED_BADGES })}
        </Text>
        {featureError ? <Text style={styles.featureError}>{featureError}</Text> : null}
      </View>

      <View style={styles.stack}>
        {cards.map((card) => (
          <AchievementRow
            busyTier={busyTier}
            card={card}
            key={card.groupKey}
            onToggleFeatured={onToggleFeatured}
          />
        ))}
      </View>
    </Screen>
  );
}

function AchievementRow({
  card,
  busyTier,
  onToggleFeatured,
}: {
  card: AchievementCard;
  busyTier: string | null;
  onToggleFeatured: (card: AchievementCard, tier: AchievementTierState) => void;
}) {
  const t = useTranslation();
  const { language } = useLanguage();
  const next = card.nextTier;
  const share = next ? Math.min(1, card.progress / next.threshold) : 1;

  return (
    <View style={styles.card}>
      <View style={styles.cardHeader}>
        <View style={styles.medals}>
          {card.tiers.map((tier) => (
            <Pressable
              accessibilityLabel={
                tier.unlocked
                  ? t(tier.featured ? "achievement.unfeature" : "achievement.feature")
                  : undefined
              }
              accessibilityRole={tier.unlocked ? "button" : undefined}
              disabled={!tier.unlocked || busyTier === `${card.groupKey}:${tier.tier}`}
              key={tier.tier}
              onPress={() => onToggleFeatured(card, tier)}
              style={({ pressed }) => [
                styles.medal,
                {
                  backgroundColor: tier.unlocked ? TIER_COLOUR[tier.tier] : colors.borderSoft,
                },
                // The chosen ones wear a ring rather than a different colour:
                // the tier colour is the badge's identity and swapping it to
                // say "featured" would make Gold stop looking like Gold.
                tier.featured && styles.medalFeatured,
                pressed && styles.pressed,
              ]}
            >
              <Icon
                color={tier.unlocked ? colors.surface : colors.textMuted}
                name={tier.unlocked ? "award" : "lock"}
                size={13}
              />
            </Pressable>
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

      {/* §5.3's "historical completion dates": when each tier was earned, which
          is the part of a badge wall people actually reminisce over. */}
      {card.tiers.some((tier) => tier.unlockedAt) ? (
        <View style={styles.history}>
          {card.tiers
            .filter((tier) => tier.unlockedAt)
            .map((tier) => (
              <View key={tier.tier} style={styles.historyRow}>
                <Text style={styles.historyTier}>
                  {t(`achievement.tier.${tier.tier}` as never)}
                </Text>
                <Text style={styles.historyDate}>
                  {new Date(tier.unlockedAt!).toLocaleDateString(localeFor(language), {
                    day: "numeric",
                    month: "short",
                    year: "numeric",
                  })}
                </Text>
              </View>
            ))}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  featuredPanel: {
    backgroundColor: colors.surface,
    borderColor: colors.borderSoft,
    borderRadius: radius.lg,
    borderWidth: 1,
    gap: spacing.sm,
    marginBottom: spacing.md,
    padding: spacing.lg,
  },
  featuredTitle: {
    color: colors.ink,
    fontFamily: fonts.semibold,
    fontSize: 15,
  },
  featuredRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.sm,
  },
  featuredChip: {
    alignItems: "center",
    backgroundColor: colors.page,
    borderRadius: radius.pill,
    flexDirection: "row",
    gap: spacing.xs,
    maxWidth: "100%",
    paddingHorizontal: spacing.sm,
    paddingVertical: 5,
  },
  featuredName: {
    color: colors.ink,
    flexShrink: 1,
    fontFamily: fonts.semibold,
    fontSize: 13,
  },
  featuredHint: {
    color: colors.textMuted,
    fontFamily: fonts.regular,
    fontSize: 12,
    lineHeight: 17,
  },
  featureError: {
    color: colors.danger,
    fontFamily: fonts.regular,
    fontSize: 12,
  },
  medalFeatured: {
    borderColor: colors.ink,
    borderWidth: 2,
  },
  pressed: {
    opacity: 0.6,
  },
  history: {
    borderTopColor: colors.borderSoft,
    borderTopWidth: 1,
    gap: 2,
    marginTop: spacing.xs,
    paddingTop: spacing.sm,
  },
  historyRow: {
    flexDirection: "row",
    justifyContent: "space-between",
  },
  historyTier: {
    color: colors.textMuted,
    fontFamily: fonts.regular,
    fontSize: 12,
  },
  historyDate: {
    color: colors.textMuted,
    fontFamily: fonts.semibold,
    fontSize: 12,
  },
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
