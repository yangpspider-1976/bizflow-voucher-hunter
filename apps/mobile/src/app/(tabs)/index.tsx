import type { CampaignCard } from "@bizflow/shared";
import { type Href, useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { listCampaigns } from "@/api/client";
import { useAuth } from "@/auth/AuthContext";
import { CampaignImage } from "@/components/CampaignImage";
import { ErrorState } from "@/components/ErrorState";
import { Icon } from "@/components/Icon";
import {
  useGamification,
  useGamificationFocusRefresh,
} from "@/gamification/GamificationContext";
import { LevelCard } from "@/gamification/LevelCard";
import { LevelUpCelebration } from "@/gamification/LevelUpCelebration";
import { UnlockCelebration } from "@/gamification/UnlockCelebration";
import { useLanguage } from "@/i18n/LanguageContext";
import {
  availabilityLabel,
  CAMPAIGN_MODES,
  campaignModeLabel,
  formatCampaignRange,
  localeFor,
  offerLockLabel,
} from "@/lib/format";
import { colors, fonts, radius, spacing } from "@/theme";

/** `.chip.mode-*` — one tint per industry, matching the web directory cards. */
const MODE_CHIPS: Record<
  string,
  { color: string; border: string; background: string }
> = {
  restaurant: { color: "#c2410c", border: "#fed7aa", background: "#fff7ed" },
  online_shop: { color: "#1d4ed8", border: "#bfdbfe", background: "#eff6ff" },
  beauty: { color: "#be185d", border: "#fbcfe8", background: "#fdf2f8" },
  pet: { color: "#0f766e", border: "#99f6e4", background: "#f0fdfa" },
  retail: { color: "#6d28d9", border: "#ddd6fe", background: "#f5f3ff" },
  other: { color: "#475569", border: "#e2e8f0", background: "#f8fafc" },
};

/** Port of the web `CampaignDirectory`. */
export default function HomeScreen() {
  const { language, t } = useLanguage();
  const { token } = useAuth();
  const router = useRouter();
  const { celebrating, dismissCelebration, dismissLevelUp, levelUpToAnnounce, profile } =
    useGamification();
  const [cards, setCards] = useState<CampaignCard[]>([]);

  // Balances and mission progress move elsewhere in the app, so what this
  // screen shows is re-read every time it comes into view rather than once.
  useGamificationFocusRefresh();
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  // The raw error is kept, not a message: ErrorState needs the code to tell an
  // offline device apart from a server-side failure.
  const [error, setError] = useState<unknown>(null);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("all");

  const load = useCallback(async (asRefresh = false) => {
    if (!token) return;
    if (asRefresh) {
      setRefreshing(true);
    } else {
      setLoading(true);
    }
    setError(null);
    try {
      setCards(await listCampaigns(token));
    } catch (caught) {
      setError(caught);
    } finally {
      if (asRefresh) {
        setRefreshing(false);
      } else {
        setLoading(false);
      }
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  // Only offer category filters that actually appear in the active campaigns.
  const categories = useMemo(() => {
    const present = new Set(cards.map((card) => String(card.businessIndustry)));
    return [
      "all",
      ...CAMPAIGN_MODES.filter((mode) => present.has(mode)),
    ];
  }, [cards]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return cards.filter(({
      businessAddress,
      businessIndustry,
      businessName,
      campaign,
    }) => {
      if (category !== "all" && businessIndustry !== category) return false;
      if (!needle) return true;
      return (
        campaign.title.toLowerCase().includes(needle) ||
        businessName.toLowerCase().includes(needle) ||
        (businessAddress ?? "").toLowerCase().includes(needle) ||
        (campaign.location ?? "").toLowerCase().includes(needle)
      );
    });
  }, [cards, category, query]);

  return (
    <SafeAreaView edges={["top", "left", "right"]} style={styles.safeArea}>
      <ScrollView
        alwaysBounceVertical
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        refreshControl={
          <RefreshControl
            colors={[colors.primary]}
            onRefresh={() => void load(true)}
            progressBackgroundColor={colors.surface}
            refreshing={refreshing}
            tintColor={colors.primary}
          />
        }
        showsVerticalScrollIndicator={false}
      >
        <View>
          <Text style={styles.title}>{t("home.title")}</Text>
          <Text style={styles.subtitle}>{t("home.subtitle")}</Text>
        </View>

        {/* Above the directory on purpose: the level card is what makes a
            return visit feel like continuing something rather than starting
            over, and it is the shortcut into today's missions. */}
        {profile ? (
          <LevelCard
            level={profile.level}
            onPress={() => router.push("/quests" as Href)}
            subtitle={t("quests.subtitle", {
              done: profile.missions.filter((mission) => mission.state === "CLAIMED").length,
              total: profile.missions.length,
            })}
          />
        ) : null}

        <View style={styles.search}>
          <Icon color={colors.textMuted} name="search" size={17} />
          <TextInput
            accessibilityLabel={t("home.searchLabel")}
            onChangeText={setQuery}
            placeholder={t("home.searchPlaceholder")}
            placeholderTextColor={colors.textMuted}
            selectionColor={colors.primary}
            style={styles.searchInput}
            value={query}
          />
        </View>

        {categories.length > 2 ? (
          <ScrollView
            contentContainerStyle={styles.filterRow}
            horizontal
            showsHorizontalScrollIndicator={false}
          >
            {categories.map((entry) => {
              const active = category === entry;
              return (
                <Pressable
                  key={entry}
                  onPress={() => setCategory(entry)}
                  style={[styles.filter, active && styles.filterActive]}
                >
                  <Text
                    style={[
                      styles.filterText,
                      active && styles.filterTextActive,
                    ]}
                  >
                    {entry === "all" ? t("home.filterAll") : campaignModeLabel(t, entry)}
                  </Text>
                </Pressable>
              );
            })}
          </ScrollView>
        ) : null}

        {loading ? (
          <ActivityIndicator color={colors.primary} style={styles.loader} />
        ) : error ? (
          <ErrorState
            error={error}
            fallback={t("home.loadError")}
            onRetry={() => void load()}
          />
        ) : filtered.length === 0 ? (
          <View style={styles.empty}>
            <Text style={styles.emptyText}>
              {cards.length === 0
                ? t("home.emptyNoCampaigns")
                : t("home.empty")}
            </Text>
          </View>
        ) : (
          <View style={styles.list}>
            {filtered.map(({
              availability,
              businessAddress,
              businessIndustry,
              businessName,
              campaign,
              ended,
              levelGate,
            }) => {
              const chip = MODE_CHIPS[businessIndustry] ?? MODE_CHIPS.other;
              // A full campaign stays tappable: its page still carries the
              // venue, the terms, and the booking step for anyone already
              // holding a voucher from it. Only the call to action changes.
              // A finished one has nothing left to serve — the campaign
              // endpoints 404 on it — so its card is disabled outright.
              const bookable = availability.bookable;
              // A locked offer stays tappable. The campaign page is where the
              // level requirement is explained and where the way to earn it
              // is linked from — a card that does nothing when tapped is a
              // dead end, and §3.2 asks for a goal.
              const locked = Boolean(levelGate?.locked) && !ended;
              return (
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ disabled: ended }}
                  disabled={ended}
                  key={campaign.id}
                  onPress={() =>
                    router.push({
                      pathname: "/campaign/[slug]",
                      params: { slug: campaign.slug },
                    })
                  }
                  style={({ pressed }) => [
                    styles.card,
                    !bookable && styles.cardUnavailable,
                    ended && styles.cardEnded,
                    pressed && !ended && styles.cardPressed,
                  ]}
                >
                  <CampaignImage
                    borderRadius={11}
                    campaign={campaign}
                    style={styles.cardMedia}
                  />
                  <View style={styles.cardTop}>
                    <View style={styles.cardDetails}>
                      <Text style={styles.cardTitle}>{campaign.title}</Text>
                      <Text style={styles.cardBusiness}>{businessName}</Text>
                      <View style={styles.cardLocationRow}>
                        <Icon name="map-pin" size={14} />
                        <Text
                          ellipsizeMode="tail"
                          numberOfLines={1}
                          style={styles.cardLocation}
                        >
                          {businessAddress ??
                            campaign.location ??
                            t("home.locationTba")}
                        </Text>
                      </View>
                    </View>
                    <View
                      style={[
                        styles.chip,
                        {
                          backgroundColor: chip.background,
                          borderColor: chip.border,
                        },
                      ]}
                    >
                      <Text style={[styles.chipText, { color: chip.color }]}>
                        {campaignModeLabel(t, businessIndustry)}
                      </Text>
                    </View>
                  </View>
                  <View style={styles.cardFoot}>
                    <Text style={styles.cardDates}>
                      {formatCampaignRange(
                        campaign.startDate,
                        campaign.endDate,
                        localeFor(language),
                      )}
                    </Text>
                    {locked ? (
                      <View style={styles.cardStatus}>
                        <Icon name="lock" size={13} />
                        <Text style={styles.cardStatusText}>
                          {offerLockLabel(t, levelGate, localeFor(language))}
                        </Text>
                      </View>
                    ) : bookable ? (
                      <View style={styles.cardCtaRow}>
                        {levelGate?.earlyAccessActive ? (
                          <Text style={styles.cardEarlyAccess}>
                            {t("home.offerEarlyAccess")}
                          </Text>
                        ) : null}
                        <Text style={styles.cardCta}>{t("home.huntNow")}</Text>
                        <Icon name="arrow-right" size={15} />
                      </View>
                    ) : (
                      <View style={styles.cardStatus}>
                        <Text style={styles.cardStatusText}>
                          {ended
                            ? t("availability.ended")
                            : availabilityLabel(t, availability)}
                        </Text>
                      </View>
                    )}
                  </View>
                </Pressable>
              );
            })}
          </View>
        )}
      </ScrollView>
      <UnlockCelebration notice={celebrating} onDismiss={dismissCelebration} />
      {/* Both can be owed at once - a mission pays XP that crosses a threshold
          and unlocks a badge in the same transaction - so they are separate
          modals rather than one queue of mixed things. */}
      <LevelUpCelebration
        level={levelUpToAnnounce}
        levels={profile?.levels ?? []}
        onDismiss={dismissLevelUp}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    backgroundColor: colors.page,
    flex: 1,
  },
  appBar: {
    paddingHorizontal: 18,
    paddingTop: spacing.md,
  },
  appBarTitle: {
    color: colors.ink,
    fontFamily: fonts.extrabold,
    fontSize: 18,
  },
  content: {
    gap: 14,
    padding: 18,
    paddingBottom: spacing.xxl,
    paddingTop: 22,
  },
  title: {
    color: colors.ink,
    fontFamily: fonts.bold,
    fontSize: 24,
    marginBottom: 4,
  },
  subtitle: {
    color: colors.textMuted,
    fontFamily: fonts.regular,
    fontSize: 14,
  },
  search: {
    alignItems: "center",
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: radius.md,
    borderWidth: 1,
    flexDirection: "row",
    gap: 9,
    paddingHorizontal: 14,
  },
  searchInput: {
    color: colors.ink,
    flex: 1,
    fontFamily: fonts.regular,
    fontSize: 14,
    minHeight: 46,
  },
  filterRow: {
    gap: spacing.sm,
    paddingVertical: 2,
  },
  filter: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: radius.pill,
    borderWidth: 1,
    paddingHorizontal: 15,
    paddingVertical: 8,
  },
  filterActive: {
    backgroundColor: colors.primary,
    borderColor: "transparent",
  },
  filterText: {
    color: colors.textMuted,
    fontFamily: fonts.bold,
    fontSize: 13,
  },
  filterTextActive: {
    color: colors.surface,
  },
  loader: {
    marginTop: spacing.xxl,
  },
  list: {
    gap: spacing.md,
  },
  card: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 14,
    borderWidth: 1,
    gap: 6,
    padding: 16,
  },
  cardMedia: {
    marginBottom: 8,
  },
  cardPressed: {
    borderColor: "rgba(92, 61, 255, 0.35)",
    transform: [{ scale: 0.99 }],
  },
  // Dimmed rather than greyed out: the card is still a link to the campaign,
  // it just cannot be hunted right now.
  cardUnavailable: {
    opacity: 0.62,
  },
  // A finished campaign is not a link at all, so it reads as inert: flatter
  // than the surface around it, and dimmer than a merely full card.
  cardEnded: {
    backgroundColor: colors.page,
    opacity: 0.55,
  },
  cardTop: {
    // Without this the chip stretches to the row's full height and its pill
    // radius renders as a large ellipse (`.directory-card-top` is flex-start).
    alignItems: "flex-start",
    flexDirection: "row",
    gap: 12,
    justifyContent: "space-between",
  },
  cardDetails: {
    flex: 1,
    gap: 4,
  },
  cardTitle: {
    color: colors.ink,
    fontFamily: fonts.bold,
    fontSize: 18,
  },
  cardBusiness: {
    color: colors.textMuted,
    fontFamily: fonts.semibold,
    fontSize: 13,
  },
  cardLocation: {
    color: colors.ink,
    flex: 1,
    fontFamily: fonts.semibold,
    fontSize: 13,
    lineHeight: 18,
  },
  cardLocationRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: 6,
  },
  cardCtaRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: 5,
  },
  cardStatus: {
    alignItems: "center",
    backgroundColor: colors.page,
    borderColor: colors.border,
    borderRadius: radius.pill,
    borderWidth: 1,
    flexDirection: "row",
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  cardStatusText: {
    color: colors.textMuted,
    fontFamily: fonts.semibold,
    fontSize: 12,
  },
  chip: {
    borderRadius: radius.pill,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  chipText: {
    fontFamily: fonts.bold,
    fontSize: 12,
  },
  cardFoot: {
    alignItems: "center",
    borderTopColor: colors.borderSoft,
    borderTopWidth: 1,
    flexDirection: "row",
    justifyContent: "space-between",
    marginTop: 10,
    paddingTop: 10,
  },
  cardDates: {
    color: colors.textMuted,
    fontFamily: fonts.bold,
    fontSize: 12,
  },
  cardCta: {
    color: colors.primary,
    fontFamily: fonts.extrabold,
    fontSize: 13,
  },
  // The head start is worth saying out loud: it is the one level benefit a
  // player experiences without being told they have it.
  cardEarlyAccess: {
    color: colors.primary,
    fontFamily: fonts.semibold,
    fontSize: 11,
  },
  empty: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 14,
    borderStyle: "dashed",
    borderWidth: 1,
    paddingHorizontal: 18,
    paddingVertical: 44,
  },
  emptyText: {
    color: colors.textMuted,
    fontFamily: fonts.regular,
    fontSize: 14,
    textAlign: "center",
  },
});
