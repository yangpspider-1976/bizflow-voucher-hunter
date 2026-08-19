import {
  buildDirectionsUrl,
  buildTelUrl,
  isCoordinate,
  isSelectableAttempt,
} from "@bizflow/shared";
import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Animated,
  Linking,
  Modal,
  PanResponder,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { WebView } from "react-native-webview";

import { Button, InlineError } from "@/components/FormControls";
import { CampaignImage } from "@/components/CampaignImage";
import { Icon, type IconName } from "@/components/Icon";
import { ErrorState } from "@/components/ErrorState";
import { StepHeader } from "@/components/HuntUi";
import { useHunt } from "@/hunt/HuntContext";
import { resumeStep, type HuntStep } from "@/hunt/progress";
import {
  availabilityLabel,
  availabilityNotice,
  campaignInstruction,
  formatCampaignRange,
  localeFor,
} from "@/lib/format";
import { useLanguage } from "@/i18n/LanguageContext";
import { colors, fonts, radius, shadow, spacing } from "@/theme";

function buildEmbeddedMapsHtml(latitude: number, longitude: number) {
  const query = encodeURIComponent(`${latitude},${longitude}`);
  const mapUrl = `https://www.google.com/maps?q=${query}&z=16&output=embed`;

  return `<!doctype html>
<html>
  <head>
    <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no" />
    <style>
      html, body, iframe {
        border: 0;
        height: 100%;
        margin: 0;
        overflow: hidden;
        padding: 0;
        width: 100%;
      }
    </style>
  </head>
  <body>
    <iframe
      allowfullscreen
      loading="eager"
      referrerpolicy="no-referrer-when-downgrade"
      src="${mapUrl}"
    ></iframe>
  </body>
</html>`;
}

/**
 * Where each resumable step lives. The landing itself is not one: it is where a
 * resume is offered, never a place to be returned to.
 */
const STEP_ROUTES = {
  roulette: "/campaign/[slug]/roulette",
  results: "/campaign/[slug]/results",
  datetime: "/campaign/[slug]/datetime",
  confirm: "/campaign/[slug]/confirm",
  confirmation: "/campaign/[slug]/confirmation",
} as const satisfies Record<HuntStep, string>;

/** Step 1 — the campaign landing (`.campaign-landing-card` on the web). */
export default function CampaignLandingScreen() {
  const { language, t } = useLanguage();
  const router = useRouter();
  const [venueError, setVenueError] = useState("");
  const {
    begin,
    campaign,
    error,
    flow,
    loading,
    markHuntEntered,
    refreshSnapshot,
    reload,
    slug,
  } = useHunt();
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState("");
  const [mapVisible, setMapVisible] = useState(false);
  const mapSheetTranslateY = useRef(new Animated.Value(0)).current;

  const closeMapSheet = useCallback(() => {
    setMapVisible(false);
  }, []);

  const openMapSheet = useCallback(() => {
    mapSheetTranslateY.setValue(900);
    setMapVisible(true);
  }, [mapSheetTranslateY]);

  const animateMapSheetOpen = useCallback(() => {
    Animated.spring(mapSheetTranslateY, {
      damping: 24,
      mass: 0.85,
      stiffness: 210,
      toValue: 0,
      useNativeDriver: true,
    }).start();
  }, [mapSheetTranslateY]);

  const dismissMapSheet = useCallback(() => {
    Animated.timing(mapSheetTranslateY, {
      duration: 220,
      toValue: 900,
      useNativeDriver: true,
    }).start(({ finished }) => {
      if (finished) closeMapSheet();
    });
  }, [closeMapSheet, mapSheetTranslateY]);

  const mapSheetPanResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: (_, gesture) =>
          gesture.dy > 6 && Math.abs(gesture.dy) > Math.abs(gesture.dx),
        onPanResponderGrant: () => {
          mapSheetTranslateY.stopAnimation();
        },
        onPanResponderMove: (_, gesture) => {
          mapSheetTranslateY.setValue(Math.max(0, gesture.dy));
        },
        onPanResponderRelease: (_, gesture) => {
          if (gesture.dy > 70 || gesture.vy > 0.55) {
            dismissMapSheet();
            return;
          }
          Animated.spring(mapSheetTranslateY, {
            damping: 22,
            mass: 0.8,
            stiffness: 230,
            toValue: 0,
            useNativeDriver: true,
          }).start();
        },
        onPanResponderTerminate: () => {
          Animated.spring(mapSheetTranslateY, {
            damping: 22,
            stiffness: 230,
            toValue: 0,
            useNativeDriver: true,
          }).start();
        },
        onPanResponderTerminationRequest: () => false,
      }),
    [dismissMapSheet, mapSheetTranslateY],
  );

  // The landing screen stays mounted in the tab navigator. Re-read the
  // authoritative hunt state whenever it becomes active so its CTA cannot show
  // "Let's Hunt!" after progress was made on another campaign step.
  useFocusEffect(
    useCallback(() => {
      if (loading) return;
      void refreshSnapshot().catch(() => {
        // A missing snapshot means this campaign has not been started yet.
      });
    }, [loading, refreshSnapshot]),
  );

  const hasActiveAttempt = flow.attempts.some(isSelectableAttempt);
  // `flow.step` is what keeps this steady. The other three depend on the
  // snapshot, so a refresh that comes back empty — a slow read, a dropped
  // request — flipped the button from Continue back to Let's Hunt under the
  // customer, offering a fresh hunt for one they had already started. A hunt
  // this phone began on this campaign is a fact about the phone, and stays true
  // whether or not the server answers.
  const canResume = Boolean(
    flow.issued || flow.selectedSlotId || hasActiveAttempt || flow.step,
  );

  const goToStep = useCallback(
    (step: HuntStep) => {
      // Stamps this campaign as entered from its own landing. The step screens
      // check it before acting, because the navigator hands them on to whichever
      // campaign is opened next.
      markHuntEntered();
      router.push({ pathname: STEP_ROUTES[step], params: { slug } });
    },
    [markHuntEntered, router, slug],
  );

  async function startHunt() {
    // One rule behind both labels this button carries: "Continue" returns to
    // the furthest step this phone reached, and "Let's Hunt!" falls out of the
    // same rule, because a hunt holding nothing can only go to the reel.
    if (canResume) {
      goToStep(
        resumeStep({
          attempts: flow.attempts,
          hasVoucher: Boolean(flow.issued),
          selectedAttemptId: flow.selectedAttemptId,
          selectedSlotId: flow.selectedSlotId,
          step: flow.step,
        }),
      );
      return;
    }
    setBusy(true);
    setActionError("");
    try {
      // `startHunt` is also the authoritative resume snapshot. A campaign switch
      // can reach this handler before the focus refresh has painted, so decide
      // from this response instead of always spending another base spin.
      const started = await begin();
      if (!started) {
        throw new Error(t("campaign.sessionNotReady"));
      }
      // This button said "Let's Hunt!", so the customer asked for a spin and a
      // spin is what they get. The server can still turn out to hold a candidate
      // they never saw revealed — the reel drew it on a previous visit and they
      // left before stopping it — and sending them to the results list then
      // hands over a voucher with no reel at all. The reel reveals it instead.
      // Only a voucher already issued outranks that.
      goToStep(started.voucher ? "confirmation" : "roulette");
    } catch (caught) {
      setActionError(
        caught instanceof Error ? caught.message : t("campaign.startError"),
      );
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <SafeAreaView edges={["top", "left", "right"]} style={styles.safeArea}>
        <ActivityIndicator color={colors.primary} style={styles.loader} />
      </SafeAreaView>
    );
  }

  if (!campaign) {
    return (
      <SafeAreaView edges={["top", "left", "right"]} style={styles.safeArea}>
        <StepHeader onBack={() => router.back()} title={t("campaign.stepTitle")} />
        <View style={styles.content}>
          <ErrorState
            error={error}
            fallback={t("campaign.unavailable")}
            onRetry={reload}
          />
        </View>
      </SafeAreaView>
    );
  }

  const { availability, business, campaign: details } = campaign;
  // A customer who already holds a voucher (or a live attempt) still needs the
  // button: their next step is booking or confirming, not drawing. Only a fresh
  // hunt is blocked, and only when the draw would refuse it anyway.
  const huntBlocked = !canResume && !availability.bookable;
  const businessPin =
    business &&
    isCoordinate(business.latitude) &&
    isCoordinate(business.longitude)
      ? {
          latitude: business.latitude,
          longitude: business.longitude,
        }
      : null;
  const embeddedMapHtml = businessPin
    ? buildEmbeddedMapsHtml(businessPin.latitude, businessPin.longitude)
    : "";

  async function openExternal(url: string, failureKey: "venue.mapsError" | "venue.callError") {
    setVenueError("");
    try {
      // openURL rejects when nothing can handle the URL — no maps app and no
      // browser, or a device with no dialer — so surface that rather than
      // leaving a tap that silently does nothing.
      await Linking.openURL(url);
    } catch {
      setVenueError(t(failureKey));
    }
  }

  const openMaps = () =>
    openExternal(
      buildDirectionsUrl({
        address: business?.address,
        latitude: business?.latitude,
        longitude: business?.longitude,
      }),
      "venue.mapsError",
    );
  const callBusiness = (contactNumber: string) =>
    openExternal(buildTelUrl(contactNumber), "venue.callError");

  return (
    <SafeAreaView edges={["top", "left", "right"]} style={styles.safeArea}>
      <View style={styles.appBar}>
        <Text style={styles.appBarTitle}>Voucher Hunt</Text>
      </View>
      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.landingCard}>
          <CampaignImage campaign={details} showCategory />
          <View style={styles.landingBody}>
          <Text style={styles.eyebrow}>{t("campaign.selectedEyebrow")}</Text>
          <Text style={styles.campaignTitle}>{details.title}</Text>
          <Text style={styles.business}>{campaign.business?.name ?? ""}</Text>
          <Text style={styles.offer}>{campaignInstruction(t, details.mode)}</Text>
          <View style={styles.metaRow}>
            <View style={styles.metaIcon}>
              <Icon name="calendar" size={14} />
            </View>
            <Text style={styles.metaText}>
              {formatCampaignRange(
                details.startDate,
                details.endDate,
                localeFor(language),
              )}
            </Text>
          </View>
          </View>
        </View>

        <View style={styles.huntSection}>
          <View style={styles.actionIntro}>
            <Text style={styles.actionTitle}>{t("campaign.readyTitle")}</Text>
            <Text style={styles.actionCopy}>{t("campaign.readySubtitle")}</Text>
          </View>

          <View style={styles.ruleCard}>
            <RuleRow icon="clock" text={t("campaign.ruleOneSpin")} />
            <RuleRow icon="shield" text={t("campaign.ruleHigherDiscount")} last />
          </View>

          {huntBlocked ? (
            <View style={styles.notice}>
              <View style={styles.noticeIcon}>
                <Icon name="info" size={16} />
              </View>
              <Text style={styles.noticeText}>
                {availabilityNotice(t, availability)}
              </Text>
            </View>
          ) : null}

          {actionError ? <InlineError message={actionError} /> : null}

          {/* Sits with the button rather than up by the title: the question it
              answers — why does this say Continue — is asked at the button. */}
          {canResume ? (
            <View style={styles.progressNote}>
              <View style={styles.progressDot} />
              <Text style={styles.progressNoteText}>{t("campaign.inProgress")}</Text>
            </View>
          ) : null}

          <View style={styles.action}>
            <Button
              disabled={huntBlocked}
              loading={busy}
              loadingLabel={t("campaign.searching")}
              onPress={startHunt}
            >
              {huntBlocked
                ? availabilityLabel(t, availability)
                : canResume
                  ? t("campaign.continue")
                  : t("campaign.startHunt")}
            </Button>
          </View>
        </View>

        {business &&
        (business.address || business.contactNumber || businessPin) ? (
          <View style={styles.venueCard}>
            <Text style={styles.venueTitle}>{t("venue.title")}</Text>
            <Text style={styles.venueBusiness}>{business.name}</Text>

            {business.contactNumber ? (
              <View style={styles.venueRow}>
                <View style={styles.venueIcon}>
                  <Icon name="phone" size={16} />
                </View>
                <View style={styles.venueRowCopy}>
                  <Text style={styles.venueLabel}>{t("venue.contact")}</Text>
                  <Text style={styles.venueValue}>{business.contactNumber}</Text>
                </View>
              </View>
            ) : null}

            {business.address ? (
              <View style={styles.venueRow}>
                <View style={styles.venueIcon}>
                  <Icon name="map-pin" size={16} />
                </View>
                <View style={styles.venueRowCopy}>
                  <Text style={styles.venueLabel}>{t("venue.address")}</Text>
                  <Text style={styles.venueValue}>{business.address}</Text>
                </View>
              </View>
            ) : null}

            {businessPin && embeddedMapHtml ? (
              <Pressable
                accessibilityHint={t("venue.viewFullMap")}
                accessibilityLabel={`${business.name} ${t("venue.address")}`}
                accessibilityRole="button"
                onPress={openMapSheet}
                style={({ pressed }) => [
                  styles.mapPreview,
                  pressed && styles.mapPreviewPressed,
                ]}
              >
                <WebView
                  cacheEnabled={false}
                  javaScriptEnabled
                  nestedScrollEnabled={false}
                  onShouldStartLoadWithRequest={() => false}
                  originWhitelist={["https://*"]}
                  pointerEvents="none"
                  scrollEnabled={false}
                  source={{
                    baseUrl: "https://www.google.com",
                    html: embeddedMapHtml,
                  }}
                  style={styles.map}
                />
                {/* The embedded map's own links (place pins, attribution) can
                    trigger navigation; this shield keeps every tap on the
                    thumbnail routed to the Pressable instead of the WebView. */}
                <View pointerEvents="box-only" style={styles.mapPreviewShield} />
                <View style={styles.mapPreviewBadge}>
                  <Icon color={colors.ink} name="maximize-2" size={14} />
                  <Text style={styles.mapPreviewBadgeText}>
                    {t("venue.viewFullMap")}
                  </Text>
                </View>
              </Pressable>
            ) : null}

            <View style={styles.venueActions}>
              {business.address || businessPin ? (
                <Pressable
                  accessibilityRole="button"
                  onPress={() => void openMaps()}
                  style={({ pressed }) => [
                    styles.venueAction,
                    pressed && styles.venueActionPressed,
                  ]}
                >
                  <Icon color={colors.primary} name="navigation" size={15} />
                  <Text style={styles.venueActionText}>{t("venue.directions")}</Text>
                </Pressable>
              ) : null}
              {business.contactNumber ? (
                <Pressable
                  accessibilityRole="button"
                  onPress={() => void callBusiness(business.contactNumber as string)}
                  style={({ pressed }) => [
                    styles.venueAction,
                    styles.venueActionPrimary,
                    pressed && styles.venueActionPressed,
                  ]}
                >
                  <Icon color={colors.surface} name="phone" size={15} />
                  <Text style={[styles.venueActionText, styles.venueActionTextPrimary]}>
                    {t("venue.callButton")}
                  </Text>
                </Pressable>
              ) : null}
            </View>

            {venueError ? <InlineError message={venueError} /> : null}
          </View>
        ) : null}

      </ScrollView>

      {business && businessPin && embeddedMapHtml ? (
        <Modal
          animationType="none"
          onRequestClose={dismissMapSheet}
          onShow={animateMapSheetOpen}
          statusBarTranslucent
          transparent
          visible={mapVisible}
        >
          <View style={styles.mapSheetBackdrop}>
            <Pressable
              accessibilityLabel={t("common.close")}
              onPress={dismissMapSheet}
              style={StyleSheet.absoluteFill}
            />
            <Animated.View
              style={[
                styles.mapSheet,
                { transform: [{ translateY: mapSheetTranslateY }] },
              ]}
            >
              <View
                style={styles.mapSheetDragArea}
                {...mapSheetPanResponder.panHandlers}
              >
                <View style={styles.mapSheetHandle} />
              </View>
              <SafeAreaView edges={["bottom"]} style={styles.mapSheetSafeArea}>
                <View style={styles.fullMapHeader}>
                  <View
                    style={styles.fullMapHeaderCopy}
                    {...mapSheetPanResponder.panHandlers}
                  >
                    <Text numberOfLines={1} style={styles.fullMapTitle}>
                      {business.name}
                    </Text>
                  </View>
                  <Pressable
                    accessibilityLabel={t("common.close")}
                    accessibilityRole="button"
                    hitSlop={10}
                    onPress={dismissMapSheet}
                    style={({ pressed }) => [
                      styles.fullMapClose,
                      pressed && styles.venueActionPressed,
                    ]}
                  >
                    <Icon color={colors.ink} name="x" size={21} />
                  </Pressable>
                </View>

                <View style={styles.fullMapBody}>
                  <WebView
                    cacheEnabled={false}
                    javaScriptEnabled
                    onShouldStartLoadWithRequest={() => false}
                    originWhitelist={["https://*"]}
                    source={{
                      baseUrl: "https://www.google.com",
                      html: embeddedMapHtml,
                    }}
                    style={styles.fullMap}
                  />
                </View>

                {business.address ? (
                  <View style={styles.fullMapAddressRow}>
                    <View style={styles.venueIcon}>
                      <Icon name="map-pin" size={17} />
                    </View>
                    <Text style={styles.fullMapAddress}>{business.address}</Text>
                  </View>
                ) : null}

                <View style={styles.fullMapFooter}>
                  <Pressable
                    accessibilityRole="button"
                    onPress={() => void openMaps()}
                    style={({ pressed }) => [
                      styles.fullMapDirections,
                      pressed && styles.venueActionPressed,
                    ]}
                  >
                    <Icon color={colors.surface} name="navigation" size={15} />
                    <Text style={styles.fullMapDirectionsText}>
                      {t("venue.directions")}
                    </Text>
                  </Pressable>
                </View>
              </SafeAreaView>
            </Animated.View>
          </View>
        </Modal>
      ) : null}
    </SafeAreaView>
  );
}

/** An icon column beside a single line of campaign-rule copy. */
function RuleRow({
  icon,
  last = false,
  text,
}: {
  icon: IconName;
  last?: boolean;
  text: string;
}) {
  return (
    <View style={[styles.ruleRow, last && styles.ruleRowLast]}>
      <View style={styles.ruleIcon}>
        <Icon name={icon} size={15} />
      </View>
      <Text style={styles.ruleText}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    backgroundColor: colors.page,
    flex: 1,
  },
  loader: {
    marginTop: 80,
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
    gap: spacing.lg,
    padding: 18,
    paddingBottom: spacing.xxl,
    paddingTop: 22,
  },
  landingCard: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 14,
    borderWidth: 1,
    overflow: "hidden",
  },
  landingBody: {
    gap: 6,
    padding: 18,
  },
  eyebrow: {
    color: colors.primary,
    fontFamily: fonts.extrabold,
    fontSize: 11,
    letterSpacing: 0.8,
  },
  campaignTitle: {
    color: colors.ink,
    fontFamily: fonts.extrabold,
    fontSize: 24,
    letterSpacing: -0.4,
    lineHeight: 28,
  },
  business: {
    color: colors.textMuted,
    fontFamily: fonts.semibold,
    fontSize: 14,
  },
  offer: {
    color: colors.ink,
    fontFamily: fonts.regular,
    fontSize: 14,
    lineHeight: 21,
    marginTop: spacing.sm,
  },
  venueCard: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: radius.md,
    borderWidth: 1,
    padding: spacing.lg,
    ...shadow.soft,
  },
  venueTitle: {
    color: colors.ink,
    fontFamily: fonts.bold,
    fontSize: 16,
  },
  venueBusiness: {
    color: colors.textMuted,
    fontFamily: fonts.regular,
    fontSize: 13,
    marginBottom: spacing.sm,
    marginTop: 2,
  },
  venueRow: {
    alignItems: "flex-start",
    borderTopColor: colors.borderSoft,
    borderTopWidth: 1,
    flexDirection: "row",
    gap: 10,
    paddingVertical: spacing.md,
  },
  venueIcon: {
    alignItems: "center",
    paddingTop: 1,
    width: 20,
  },
  venueRowCopy: {
    flex: 1,
    gap: 2,
  },
  mapPreview: {
    borderColor: colors.border,
    borderRadius: radius.sm,
    borderWidth: 1,
    height: 170,
    marginTop: spacing.sm,
    overflow: "hidden",
    position: "relative",
  },
  mapPreviewPressed: {
    opacity: 0.86,
  },
  map: {
    bottom: 0,
    left: 0,
    position: "absolute",
    right: 0,
    top: 0,
  },
  mapPreviewShield: {
    bottom: 0,
    left: 0,
    position: "absolute",
    right: 0,
    top: 0,
  },
  mapPreviewBadge: {
    alignItems: "center",
    backgroundColor: "rgba(255, 255, 255, 0.94)",
    borderColor: colors.border,
    borderRadius: radius.pill,
    borderWidth: 1,
    flexDirection: "row",
    gap: 6,
    paddingHorizontal: 11,
    paddingVertical: 7,
    position: "absolute",
    bottom: 10,
    right: 10,
    ...shadow.soft,
  },
  mapPreviewBadgeText: {
    color: colors.ink,
    fontFamily: fonts.semibold,
    fontSize: 11,
  },
  venueLabel: {
    color: colors.ink,
    fontFamily: fonts.semibold,
    fontSize: 11,
    letterSpacing: 0.4,
    textTransform: "uppercase",
  },
  venueValue: {
    color: colors.textMuted,
    fontFamily: fonts.semibold,
    fontSize: 14,
    lineHeight: 20,
  },
  venueActions: {
    flexDirection: "row",
    gap: spacing.sm,
    marginTop: spacing.xs,
    paddingTop: spacing.md,
  },
  venueAction: {
    alignItems: "center",
    borderColor: colors.border,
    borderRadius: radius.sm,
    borderWidth: 1,
    flex: 1,
    flexDirection: "row",
    gap: 6,
    justifyContent: "center",
    paddingVertical: 10,
  },
  venueActionPrimary: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  },
  venueActionPressed: {
    opacity: 0.7,
  },
  venueActionText: {
    color: colors.primary,
    fontFamily: fonts.semibold,
    fontSize: 14,
  },
  venueActionTextPrimary: {
    color: colors.surface,
  },
  metaRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: 8,
    marginTop: 6,
  },
  metaIcon: {
    alignItems: "center",
    width: 16,
  },
  metaText: {
    color: colors.textMuted,
    flex: 1,
    fontFamily: fonts.regular,
    fontSize: 13,
  },
  categoryChip: {
    alignSelf: "flex-start",
    backgroundColor: colors.primarySoft,
    borderRadius: radius.pill,
    marginTop: spacing.md,
    paddingHorizontal: 12,
    paddingVertical: 5,
  },
  categoryChipText: {
    color: colors.primary,
    fontFamily: fonts.bold,
    fontSize: 12,
  },
  actionIntro: {
    alignItems: "center",
    gap: 4,
  },
  actionTitle: {
    color: colors.ink,
    fontFamily: fonts.bold,
    fontSize: 19,
    textAlign: "center",
  },
  actionCopy: {
    color: colors.textMuted,
    fontFamily: fonts.regular,
    fontSize: 14,
    textAlign: "center",
  },
  huntSection: {
    gap: spacing.md,
    paddingVertical: spacing.sm,
  },
  ruleCard: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: radius.md,
    borderWidth: 1,
    paddingHorizontal: 16,
    ...shadow.soft,
  },
  ruleRow: {
    alignItems: "flex-start",
    borderBottomColor: colors.borderSoft,
    borderBottomWidth: 1,
    flexDirection: "row",
    gap: 10,
    paddingVertical: 12,
  },
  ruleRowLast: {
    borderBottomWidth: 0,
  },
  ruleIcon: {
    alignItems: "center",
    paddingTop: 2,
    width: 22,
  },
  ruleText: {
    color: colors.ink,
    flex: 1,
    fontFamily: fonts.regular,
    fontSize: 13,
    lineHeight: 19,
  },
  action: {
    marginTop: spacing.sm,
  },
  progressNote: {
    alignItems: "center",
    alignSelf: "center",
    backgroundColor: colors.primarySoft,
    borderRadius: radius.pill,
    flexDirection: "row",
    gap: 7,
    marginTop: spacing.md,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  // A filled dot rather than an icon: this is a status, and the row reads as
  // one line of text with a marker rather than as another control.
  progressDot: {
    backgroundColor: colors.primary,
    borderRadius: 4,
    height: 8,
    width: 8,
  },
  progressNoteText: {
    color: colors.primary,
    fontFamily: fonts.semibold,
    fontSize: 12,
    letterSpacing: 0.2,
  },
  notice: {
    alignItems: "flex-start",
    backgroundColor: colors.page,
    borderColor: colors.border,
    borderRadius: radius.sm,
    borderWidth: 1,
    flexDirection: "row",
    gap: 10,
    marginTop: spacing.md,
    padding: spacing.md,
  },
  noticeIcon: {
    alignItems: "center",
    paddingTop: 1,
    width: 20,
  },
  noticeText: {
    color: colors.textMuted,
    flex: 1,
    fontFamily: fonts.regular,
    fontSize: 13,
    lineHeight: 19,
  },
  mapSheetBackdrop: {
    backgroundColor: "rgba(7, 15, 31, 0.48)",
    flex: 1,
    justifyContent: "flex-end",
  },
  mapSheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    height: "90%",
    overflow: "hidden",
  },
  mapSheetSafeArea: {
    flex: 1,
  },
  mapSheetDragArea: {
    alignItems: "center",
    backgroundColor: colors.surface,
    minHeight: 30,
    paddingBottom: 8,
    paddingTop: 10,
  },
  mapSheetHandle: {
    backgroundColor: colors.border,
    borderRadius: radius.pill,
    height: 5,
    width: 44,
  },
  fullMapHeader: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.md,
  },
  fullMapHeaderCopy: {
    flex: 1,
  },
  fullMapTitle: {
    color: colors.ink,
    fontFamily: fonts.bold,
    fontSize: 17,
  },
  fullMapClose: {
    alignItems: "center",
    backgroundColor: colors.page,
    borderColor: colors.border,
    borderRadius: radius.pill,
    borderWidth: 1,
    height: 40,
    justifyContent: "center",
    width: 40,
  },
  fullMapBody: {
    flex: 1,
    marginHorizontal: spacing.lg,
    overflow: "hidden",
    borderColor: colors.border,
    borderRadius: radius.md,
    borderWidth: 1,
  },
  fullMap: {
    backgroundColor: "#eef1f4",
    flex: 1,
  },
  fullMapAddressRow: {
    alignItems: "flex-start",
    flexDirection: "row",
    gap: spacing.sm,
    marginHorizontal: spacing.lg,
    paddingTop: spacing.md,
  },
  fullMapAddress: {
    color: colors.textMuted,
    flex: 1,
    fontFamily: fonts.regular,
    fontSize: 13,
    lineHeight: 18,
  },
  fullMapFooter: {
    backgroundColor: colors.surface,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
  },
  fullMapDirections: {
    alignItems: "center",
    backgroundColor: colors.primary,
    borderRadius: radius.sm,
    flexDirection: "row",
    gap: 7,
    justifyContent: "center",
    paddingVertical: 11,
  },
  fullMapDirectionsText: {
    color: colors.surface,
    fontFamily: fonts.semibold,
    fontSize: 14,
  },
});
