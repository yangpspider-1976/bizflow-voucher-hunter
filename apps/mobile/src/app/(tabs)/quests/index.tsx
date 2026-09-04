import { type Href, useRouter } from "expo-router";
import { useCallback, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { ALL_FEATURES_ON, type MissionCard } from "@bizflow/shared";

import { claimMission, joinMission } from "@/api/client";
import { useAuth } from "@/auth/AuthContext";
import { ErrorState } from "@/components/ErrorState";
import { Icon } from "@/components/Icon";
import { Screen } from "@/components/Screen";
import {
  useGamification,
  useGamificationFocusRefresh,
} from "@/gamification/GamificationContext";
import { LevelCard } from "@/gamification/LevelCard";
import { readMissionLocation } from "@/gamification/location";
import { MissionRow } from "@/gamification/MissionRow";
import { LevelUpCelebration } from "@/gamification/LevelUpCelebration";
import { UnlockCelebration } from "@/gamification/UnlockCelebration";
import { useTranslation } from "@/i18n/LanguageContext";
import { colors, fonts, radius, spacing } from "@/theme";

type Tab = "DAILY" | "URGENT";

/**
 * The quests screen: level, today's missions and achievement progress.
 *
 * Deliberately one screen rather than three tabs of its own. The requirements'
 * final success criterion is that a player can see today's actions, the
 * distance to the next level and their achievement progress together, and
 * splitting them is exactly how that stops being true.
 */
export default function QuestsScreen() {
  const t = useTranslation();
  const router = useRouter();
  const { token } = useAuth();
  const {
    celebrating,
    dismissCelebration,
    dismissLevelUp,
    error,
    isLoading,
    levelUpToAnnounce,
    profile,
    refresh,
  } = useGamification();

  const [tab, setTab] = useState<Tab>("DAILY");

  // What is actually running for this player. The server has already applied
  // these — a switched-off feature comes back empty — so this decides what to
  // draw, never what to allow. A section for a paused feature is worse than no
  // section: an empty board with no explanation reads as a bug.
  //
  // A server too old to send the field is a server where nothing is switched
  // off, so the fallback is everything on.
  const features = profile?.features ?? ALL_FEATURES_ON;

  // Balances and mission progress move elsewhere in the app, so what this
  // screen shows is re-read every time it comes into view rather than once.
  useGamificationFocusRefresh();
  const [claimingKey, setClaimingKey] = useState<string | null>(null);
  const [joiningKey, setJoiningKey] = useState<string | null>(null);
  const [claimError, setClaimError] = useState<string | null>(null);

  // The Urgent tab is everything that is not the daily set. A partner or
  // onboarding campaign is an urgent mission as far as a player is concerned,
  // and giving each its own tab would be three tabs for one idea.
  const missions = useMemo(
    () =>
      (profile?.missions ?? []).filter((mission) =>
        tab === "DAILY" ? mission.type === "DAILY" : mission.type !== "DAILY",
      ),
    [profile, tab],
  );

  const daily = useMemo(
    () => (profile?.missions ?? []).filter((mission) => mission.type === "DAILY"),
    [profile],
  );
  const doneToday = useMemo(
    () => daily.filter((mission) => mission.state === "CLAIMED").length,
    [daily],
  );

  const onClaim = useCallback(
    async (mission: MissionCard) => {
      if (!token) return;
      setClaimingKey(mission.missionKey);
      setClaimError(null);
      try {
        await claimMission({ missionKey: mission.missionKey }, token);
        await refresh();
      } catch (caught) {
        // The server is the authority on whether a claim is allowed, so its
        // message is shown rather than a guess about what went wrong.
        setClaimError(caught instanceof Error ? caught.message : t("mission.claimFailed"));
      } finally {
        setClaimingKey(null);
      }
    },
    [refresh, t, token],
  );

  /**
   * Joins an urgent campaign.
   *
   * Location is read only for a campaign that has a radius, and only at this
   * moment — a permission prompt with no visible reason is the one people deny.
   * The server still does the radius test; this only supplies the measurement.
   */
  const onJoin = useCallback(
    async (mission: MissionCard) => {
      if (!token) return;
      setJoiningKey(mission.missionKey);
      setClaimError(null);
      try {
        let location = null;
        if (mission.area) {
          const reading = await readMissionLocation();
          if (!reading.ok) {
            setClaimError(t("location.needed"));
            return;
          }
          location = reading.location;
        }
        await joinMission(mission.missionKey, token, location);
        await refresh();
      } catch (caught) {
        setClaimError(caught instanceof Error ? caught.message : t("mission.joinFailed"));
      } finally {
        setJoiningKey(null);
      }
    },
    [refresh, t, token],
  );

  const onOpen = useCallback(
    (mission: MissionCard) => {
      router.push(`/quests/${encodeURIComponent(mission.missionKey)}` as Href);
    },
    [router],
  );

  if (isLoading && !profile) {
    return (
      <Screen title={t("quests.title")}>
        <ActivityIndicator color={colors.primary} style={styles.loader} />
      </Screen>
    );
  }

  if (error && !profile) {
    return (
      <Screen title={t("quests.title")}>
        <ErrorState error={error} fallback={t("quests.loadFailed")} onRetry={refresh} />
      </Screen>
    );
  }

  if (!profile) return null;

  const nextUp = profile.achievements
    .filter((card) => card.nextTier)
    .sort(
      (a, b) =>
        (a.nextTier!.threshold - a.progress) - (b.nextTier!.threshold - b.progress),
    )
    .slice(0, 3);

  return (
    <Screen
      onRefresh={refresh}
      refreshing={isLoading}
      subtitle={
        features.missions
          ? t("quests.subtitle", { done: doneToday, total: daily.length })
          : undefined
      }
      title={t("quests.title")}
    >
      <View style={styles.stack}>
        {features.levels ? (
          <LevelCard
            level={profile.level}
            onPress={features.conversion ? () => router.push("/quests/level-up" as Href) : undefined}
            subtitle={features.conversion ? t("level.convertHint") : undefined}
          />
        ) : null}

        {features.missions ? (
          <>
            <View style={styles.tabs}>
              {(["DAILY", "URGENT"] as Tab[]).map((candidate) => (
                <Pressable
                  accessibilityRole="button"
                  key={candidate}
                  onPress={() => setTab(candidate)}
                  style={[styles.tab, tab === candidate && styles.tabActive]}
                >
                  <Text style={[styles.tabText, tab === candidate && styles.tabTextActive]}>
                    {candidate === "DAILY" ? t("quests.daily") : t("quests.urgent")}
                  </Text>
                </Pressable>
              ))}
            </View>

            <View style={styles.resetRow}>
              <Icon color={colors.textMuted} name="clock" size={13} />
              <Text style={styles.resetText}>
                {t("quests.resetsAt", {
                  time: new Date(profile.missionsResetAt).toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit",
                  }),
                })}
              </Text>
            </View>

            {claimError ? <Text style={styles.claimError}>{claimError}</Text> : null}

            {missions.length === 0 ? (
              <View style={styles.empty}>
                <Icon color={colors.textMuted} name="coffee" size={22} />
                <Text style={styles.emptyText}>
                  {tab === "DAILY" ? t("quests.emptyDaily") : t("quests.emptyUrgent")}
                </Text>
              </View>
            ) : (
              missions.map((mission) => (
                <MissionRow
                  claiming={claimingKey === mission.missionKey}
                  joining={joiningKey === mission.missionKey}
                  key={`${mission.missionKey}:${mission.definitionVersion}`}
                  mission={mission}
                  onClaim={onClaim}
                  onJoin={onJoin}
                  onOpen={onOpen}
                />
              ))
            )}
          </>
        ) : (
          <View style={styles.empty}>
            <Icon color={colors.textMuted} name="coffee" size={22} />
            <Text style={styles.emptyText}>{t("quests.missionsPaused")}</Text>
          </View>
        )}

        {features.achievements ? (
          <Pressable
            accessibilityRole="button"
            onPress={() => router.push("/quests/achievements" as Href)}
            style={({ pressed }) => [styles.achievements, pressed && styles.pressed]}
          >
            <View style={styles.achievementsHeader}>
              <Text style={styles.sectionTitle}>{t("quests.achievements")}</Text>
              <Icon color={colors.textMuted} name="chevron-right" size={18} />
            </View>
            <Text style={styles.sectionMeta}>
              {t("achievement.unlockedCount", {
                count: profile.achievements.reduce(
                  (total, card) => total + card.unlockedTiers,
                  0,
                ),
                total: profile.achievements.reduce(
                  (total, card) => total + card.tiers.length,
                  0,
                ),
              })}
            </Text>
            {nextUp.map((card) => (
              <View key={card.groupKey} style={styles.nextRow}>
                <Text style={styles.nextTitle}>{card.title}</Text>
                <Text style={styles.nextProgress}>
                  {card.progress}/{card.nextTier!.threshold}
                </Text>
              </View>
            ))}
          </Pressable>
        ) : null}
      </View>

      <UnlockCelebration notice={celebrating} onDismiss={dismissCelebration} />
      {/* Both can be owed at once - a mission pays XP that crosses a threshold
          and unlocks a badge in the same transaction - so they are separate
          modals rather than one queue of mixed things. */}
      <LevelUpCelebration
        level={levelUpToAnnounce}
        levels={profile?.levels ?? []}
        onDismiss={dismissLevelUp}
      />
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
  tabs: {
    backgroundColor: colors.borderSoft,
    borderRadius: radius.pill,
    flexDirection: "row",
    padding: 4,
  },
  tab: {
    alignItems: "center",
    borderRadius: radius.pill,
    flex: 1,
    paddingVertical: spacing.sm,
  },
  tabActive: {
    backgroundColor: colors.surface,
  },
  tabText: {
    color: colors.textMuted,
    fontFamily: fonts.semibold,
    fontSize: 14,
  },
  tabTextActive: {
    color: colors.ink,
    fontFamily: fonts.bold,
  },
  resetRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing.xs,
  },
  resetText: {
    color: colors.textMuted,
    fontFamily: fonts.regular,
    fontSize: 12,
  },
  claimError: {
    backgroundColor: colors.dangerSoft,
    borderRadius: radius.sm,
    color: colors.danger,
    fontFamily: fonts.semibold,
    fontSize: 13,
    padding: spacing.md,
  },
  empty: {
    alignItems: "center",
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: radius.md,
    borderWidth: 1,
    gap: spacing.sm,
    padding: spacing.xxl,
  },
  emptyText: {
    color: colors.textMuted,
    fontFamily: fonts.regular,
    fontSize: 14,
    textAlign: "center",
  },
  achievements: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: radius.md,
    borderWidth: 1,
    gap: spacing.sm,
    marginTop: spacing.sm,
    padding: spacing.lg,
  },
  pressed: {
    opacity: 0.9,
  },
  achievementsHeader: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
  },
  sectionTitle: {
    color: colors.ink,
    fontFamily: fonts.bold,
    fontSize: 16,
  },
  sectionMeta: {
    color: colors.textMuted,
    fontFamily: fonts.regular,
    fontSize: 12,
  },
  nextRow: {
    borderTopColor: colors.borderSoft,
    borderTopWidth: 1,
    flexDirection: "row",
    justifyContent: "space-between",
    paddingTop: spacing.sm,
  },
  nextTitle: {
    color: colors.ink,
    fontFamily: fonts.semibold,
    fontSize: 14,
  },
  nextProgress: {
    color: colors.primary,
    fontFamily: fonts.bold,
    fontSize: 14,
  },
});
