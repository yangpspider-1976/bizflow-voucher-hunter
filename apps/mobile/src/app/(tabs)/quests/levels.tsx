import { type Href, useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { ALL_FEATURES_ON } from "@bizflow/shared";

import { getLevelLadder, type LevelLadder } from "@/api/client";
import { useAuth } from "@/auth/AuthContext";
import { ErrorState } from "@/components/ErrorState";
import { Icon } from "@/components/Icon";
import { Screen } from "@/components/Screen";
import { useGamification } from "@/gamification/GamificationContext";
import { useTranslation } from "@/i18n/LanguageContext";
import { colors, fonts, radius, spacing } from "@/theme";

/**
 * Level Details: the whole ladder, what each rung costs, what it unlocks, and
 * which partners are waiting on it.
 *
 * §3.2 is explicit that a restriction should read as a goal rather than a
 * locked door, and a locked card in the directory can only say "level 3" — this
 * is the screen it points at, where "level 3" becomes five named benefits and
 * the partners that come with them.
 *
 * Read from `/levels` rather than from the profile: the partner list behind it
 * is a join the app's most-called endpoint has no reason to pay for on every
 * launch, and this is a screen a player opens deliberately.
 */
export default function LevelDetailsScreen() {
  const t = useTranslation();
  const router = useRouter();
  const { token } = useAuth();
  const { profile } = useGamification();

  const [ladder, setLadder] = useState<LevelLadder | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [isLoading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    setError(null);
    try {
      setLadder(await getLevelLadder(token));
    } catch (caught) {
      setError(caught);
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  // The offers waiting on each rung, bucketed once rather than filtered inside
  // the row for every level on screen.
  const offersByLevel = useMemo(() => {
    const grouped = new Map<number, LevelLadder["partnersByLevel"]>();
    for (const offer of ladder?.partnersByLevel ?? []) {
      const bucket = grouped.get(offer.level);
      if (bucket) bucket.push(offer);
      else grouped.set(offer.level, [offer]);
    }
    return grouped;
  }, [ladder]);

  if (isLoading && !ladder) {
    return (
      <Screen title={t("level.detailsTitle")}>
        <ActivityIndicator color={colors.primary} style={styles.loader} />
      </Screen>
    );
  }

  if (error && !ladder) {
    return (
      <Screen title={t("level.detailsTitle")}>
        <ErrorState error={error} fallback={t("level.detailsFailed")} onRetry={load} />
      </Screen>
    );
  }

  if (!ladder) return null;

  const standing = ladder.current;
  const conversionOn = (profile?.features ?? ALL_FEATURES_ON).conversion;

  return (
    <Screen
      onRefresh={load}
      refreshing={isLoading}
      subtitle={t("level.detailsLead")}
      title={t("level.detailsTitle")}
    >
      <View style={styles.stack}>
        {[...ladder.levels]
          .sort((a, b) => a.minXp - b.minXp)
          .map((level) => {
            const reached = standing.lifetimeXp >= level.minXp;
            const current = standing.level === level.level;
            const offers = offersByLevel.get(level.level) ?? [];
            const xpToGo = Math.max(0, level.minXp - standing.lifetimeXp);

            return (
              <View
                key={level.level}
                style={[styles.card, current && styles.cardCurrent, !reached && styles.cardLocked]}
              >
                <View style={styles.head}>
                  <View style={styles.headText}>
                    <Text style={[styles.levelName, !reached && styles.mutedText]}>
                      Lv.{level.level} {level.name}
                    </Text>
                    <Text style={styles.requirement}>
                      {level.minXp === 0
                        ? t("level.startsHere")
                        : t("level.requiresXp", { xp: level.minXp.toLocaleString() })}
                    </Text>
                  </View>
                  {/* One badge, and only one: the rung you are on says "you are
                      here", a rung behind you says nothing (it is not news),
                      and a rung ahead says what it still costs. */}
                  {current ? (
                    <View style={styles.pill}>
                      <Text style={styles.pillText}>{t("level.youAreHere")}</Text>
                    </View>
                  ) : reached ? (
                    <Icon color={colors.success} name="check" size={18} />
                  ) : (
                    <View style={styles.pillLocked}>
                      <Icon color={colors.textMuted} name="lock" size={12} />
                      <Text style={styles.pillLockedText}>
                        {t("level.xpToGo", { xp: xpToGo.toLocaleString() })}
                      </Text>
                    </View>
                  )}
                </View>

                {level.benefits.map((benefit) => (
                  <View key={benefit} style={styles.benefitRow}>
                    <Icon
                      color={reached ? colors.success : colors.textMuted}
                      name={reached ? "check" : "lock"}
                      size={13}
                    />
                    <Text style={[styles.benefitText, !reached && styles.mutedText]}>
                      {t(`level.benefit.${benefit}` as never)}
                    </Text>
                  </View>
                ))}

                {level.bonusHunts > 0 ? (
                  <View style={styles.benefitRow}>
                    <Icon
                      color={reached ? colors.success : colors.textMuted}
                      name={reached ? "check" : "lock"}
                      size={13}
                    />
                    <Text style={[styles.benefitText, !reached && styles.mutedText]}>
                      {t("level.bonusHunts", { count: level.bonusHunts })}
                    </Text>
                  </View>
                ) : null}

                {level.earlyAccessMinutes > 0 ? (
                  <View style={styles.benefitRow}>
                    <Icon
                      color={reached ? colors.success : colors.textMuted}
                      name={reached ? "check" : "lock"}
                      size={13}
                    />
                    <Text style={[styles.benefitText, !reached && styles.mutedText]}>
                      {t("level.earlyAccessMinutes", { minutes: level.earlyAccessMinutes })}
                    </Text>
                  </View>
                ) : null}

                {offers.length > 0 ? (
                  <View style={styles.offers}>
                    <Text style={styles.offersTitle}>{t("level.partnersHere")}</Text>
                    {offers.map((offer) => (
                      <Pressable
                        accessibilityRole="button"
                        key={offer.slug}
                        onPress={() => router.push(`/campaign/${offer.slug}` as Href)}
                        style={({ pressed }) => [styles.offerRow, pressed && styles.pressed]}
                      >
                        <View style={styles.offerText}>
                          <Text style={styles.offerPartner}>{offer.partnerName}</Text>
                          <Text style={styles.offerTitle}>{offer.label ?? offer.title}</Text>
                        </View>
                        <Icon color={colors.textMuted} name="chevron-right" size={16} />
                      </Pressable>
                    ))}
                  </View>
                ) : null}
              </View>
            );
          })}

        {/* The way to act on all of the above, when there is one. */}
        {conversionOn ? (
          <Pressable
            accessibilityRole="button"
            onPress={() => router.push("/quests/level-up" as Href)}
            style={({ pressed }) => [styles.cta, pressed && styles.pressed]}
          >
            <Text style={styles.ctaText}>{t("level.convertHint")}</Text>
            <Icon color={colors.surface} name="chevron-right" size={18} />
          </Pressable>
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
  card: {
    backgroundColor: colors.surface,
    borderColor: colors.borderSoft,
    borderRadius: radius.lg,
    borderWidth: 1,
    gap: spacing.sm,
    padding: spacing.lg,
  },
  cardCurrent: {
    borderColor: colors.primary,
    borderWidth: 2,
  },
  cardLocked: {
    backgroundColor: colors.page,
  },
  head: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing.sm,
    justifyContent: "space-between",
  },
  headText: {
    flex: 1,
    gap: 2,
  },
  levelName: {
    color: colors.ink,
    fontFamily: fonts.semibold,
    fontSize: 16,
  },
  requirement: {
    color: colors.textMuted,
    fontFamily: fonts.regular,
    fontSize: 13,
  },
  mutedText: {
    color: colors.textMuted,
  },
  pill: {
    backgroundColor: colors.primarySoft,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
  },
  pillText: {
    color: colors.primary,
    fontFamily: fonts.semibold,
    fontSize: 11,
  },
  pillLocked: {
    alignItems: "center",
    backgroundColor: colors.borderSoft,
    borderRadius: radius.pill,
    flexDirection: "row",
    gap: 4,
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
  },
  pillLockedText: {
    color: colors.textMuted,
    fontFamily: fonts.semibold,
    fontSize: 11,
  },
  benefitRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing.sm,
  },
  benefitText: {
    color: colors.ink,
    flex: 1,
    fontFamily: fonts.regular,
    fontSize: 14,
  },
  offers: {
    borderTopColor: colors.borderSoft,
    borderTopWidth: 1,
    gap: spacing.xs,
    marginTop: spacing.xs,
    paddingTop: spacing.sm,
  },
  offersTitle: {
    color: colors.textMuted,
    fontFamily: fonts.semibold,
    fontSize: 12,
    textTransform: "uppercase",
  },
  offerRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing.sm,
    paddingVertical: spacing.xs,
  },
  offerText: {
    flex: 1,
  },
  offerPartner: {
    color: colors.ink,
    fontFamily: fonts.semibold,
    fontSize: 14,
  },
  offerTitle: {
    color: colors.textMuted,
    fontFamily: fonts.regular,
    fontSize: 13,
  },
  pressed: {
    opacity: 0.6,
  },
  cta: {
    alignItems: "center",
    backgroundColor: colors.primary,
    borderRadius: radius.lg,
    flexDirection: "row",
    gap: spacing.sm,
    justifyContent: "space-between",
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  ctaText: {
    color: colors.surface,
    fontFamily: fonts.semibold,
    fontSize: 15,
  },
});
