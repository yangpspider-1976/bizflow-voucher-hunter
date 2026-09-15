// FontAwesome rather than Feather here: the web fills its star via
// `.rarity-badge svg { fill: currentColor }`, and Feather only ships an outline.
import FontAwesome from "@expo/vector-icons/FontAwesome";
import { getVoucherPresentation, type VoucherPool } from "@bizflow/shared";
import { LinearGradient } from "expo-linear-gradient";
import { StyleSheet, Text, View } from "react-native";

import { CopyButton } from "@/components/CopyableCode";
import { useTranslation } from "@/i18n/LanguageContext";
import {
  voucherDisplayLabel,
  voucherRarityDescription,
  voucherRarityLabel,
} from "@/lib/format";
import { colors, fonts, radius, spacing } from "@/theme";
import { rarityStyles } from "@/theme";

type Benefit = Pick<
  VoucherPool,
  "benefitType" | "benefitValue" | "displayLabel" | "rarity"
>;

type VoucherTicketProps = {
  benefit: Benefit;
  detail: string;
  /** Renders the "Voucher code" block, as the confirmation screen does. */
  code?: string;
  /**
   * Adds a copy button beside the code. Off by default: in the wallet list the
   * whole ticket is a link to the voucher, and an inner tap target there would
   * compete with opening it.
   */
  copyable?: boolean;
  /** Draws the dashed→solid accent outline used for the picked candidate. */
  selected?: boolean;
  /** Fixed width for the roulette reel; omit to fill the parent. */
  width?: number;
  /** `min-height` override — the reel's tickets are shorter than the page ones. */
  minHeight?: number;
  /** Uses a lighter shadow while tickets are moving together in the roulette. */
  motionOptimized?: boolean;
  footnote?: string;
};

/**
 * Port of the web `VoucherCard` + `.candidate.voucher-*` rules. The ticket is a
 * gradient card with an accent-tinted rarity pill, notch cutouts on both edges and
 * a rarity-driven colour scheme that inverts to light-on-dark for epic/legendary.
 */
export function VoucherTicket({
  benefit,
  code,
  copyable = false,
  detail,
  footnote,
  minHeight = 152,
  motionOptimized = false,
  selected = false,
  width,
}: VoucherTicketProps) {
  const t = useTranslation();
  const presentation = getVoucherPresentation(benefit);
  const rarity = rarityStyles[presentation.rarity];

  return (
    <View
      style={[
        styles.shell,
        {
          borderColor:
            selected || motionOptimized
              ? withAlpha(rarity.accent, selected ? 0.9 : 0.58)
              : withAlpha(rarity.accent, 0.38),
          borderStyle: selected || motionOptimized ? "solid" : "dashed",
          minHeight,
          shadowColor: rarity.accent,
        },
        width === undefined ? styles.fluid : { width },
        motionOptimized && styles.motionOptimizedShell,
        selected && styles.selectedShell,
      ]}
    >
      <LinearGradient
        colors={[rarity.gradient[0], rarity.gradient[1]]}
        end={{ x: 1, y: 1 }}
        start={{ x: 0, y: 0 }}
        style={StyleSheet.absoluteFill}
      />
      {/* The web's `.voucher-glow` is a blurred accent bloom. RN has no blur in
          core, and an unblurred circle reads as a hard grey disc, so the bloom is
          approximated with a second gradient pass instead. */}
      <LinearGradient
        colors={[withAlpha(rarity.accent, 0.16), "transparent"]}
        end={{ x: 0.45, y: 0.6 }}
        pointerEvents="none"
        start={{ x: 1, y: 0 }}
        style={StyleSheet.absoluteFill}
      />
      <View style={styles.body}>
        <View
          style={[
            styles.badge,
            {
              backgroundColor: rarity.badgeBackground,
              borderColor: rarity.badgeBorder,
            },
          ]}
        >
          <FontAwesome color={rarity.badgeText} name="star" size={9} />
          <Text style={[styles.badgeText, { color: rarity.badgeText }]}>
            {voucherRarityLabel(t, presentation.rarity)} ·{" "}
            {voucherRarityDescription(t, presentation.rarity)}
          </Text>
        </View>
        <Text style={[styles.heading, { color: rarity.headingText }]}>
          {voucherDisplayLabel(t, benefit)}
        </Text>
        <Text style={[styles.detail, { color: rarity.text }]}>{detail}</Text>
        {code ? (
          <View style={styles.codeBlock}>
            <Text style={[styles.codeLabel, { color: rarity.text }]}>{t("voucher.code")}</Text>
            <View style={styles.codeRow}>
              <Text
                adjustsFontSizeToFit
                numberOfLines={1}
                style={[styles.code, { color: rarity.headingText }]}
              >
                {code}
              </Text>
              {copyable ? (
                <View style={styles.copyButton}>
                  <CopyButton
                    color={rarity.headingText}
                    label={t("voucher.code")}
                    size={18}
                    value={code}
                  />
                </View>
              ) : null}
            </View>
          </View>
        ) : null}
        {footnote ? (
          <Text style={[styles.footnote, { color: rarity.text }]}>{footnote}</Text>
        ) : null}
      </View>
      {/* `.voucher-cutout` — the punched notches that make it read as a ticket. */}
      <View
        pointerEvents="none"
        style={[styles.cutout, styles.cutoutLeft, { borderColor: rarity.cutoutRing }]}
      />
      <View
        pointerEvents="none"
        style={[styles.cutout, styles.cutoutRight, { borderColor: rarity.cutoutRing }]}
      />
    </View>
  );
}

/** Expands a 6-digit hex to an `rgba()` string at the given alpha. */
function withAlpha(hex: string, alpha: number) {
  const value = hex.replace("#", "");
  const r = Number.parseInt(value.slice(0, 2), 16);
  const g = Number.parseInt(value.slice(2, 4), 16);
  const b = Number.parseInt(value.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

const styles = StyleSheet.create({
  shell: {
    borderRadius: radius.lg,
    borderWidth: 1,
    overflow: "hidden",
    position: "relative",
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.24,
    shadowRadius: 24,
    elevation: 4,
  },
  fluid: {
    width: "100%",
  },
  selectedShell: {
    elevation: 8,
    shadowOpacity: 0.3,
  },
  motionOptimizedShell: {
    elevation: 1,
    shadowOpacity: 0.1,
    shadowRadius: 10,
  },
  body: {
    padding: 18,
    paddingHorizontal: 20,
  },
  badge: {
    alignItems: "center",
    alignSelf: "flex-start",
    borderRadius: radius.pill,
    borderWidth: 1,
    flexDirection: "row",
    gap: 5,
    paddingHorizontal: 8,
    paddingVertical: 5,
  },
  badgeText: {
    fontFamily: fonts.black,
    fontSize: 10,
    letterSpacing: 0.8,
    lineHeight: 12,
    textTransform: "uppercase",
  },
  heading: {
    fontFamily: fonts.extrabold,
    fontSize: 28,
    letterSpacing: -0.4,
    lineHeight: 30,
    marginBottom: 4,
    marginTop: 12,
    maxWidth: "82%",
  },
  detail: {
    fontFamily: fonts.regular,
    fontSize: 14,
    lineHeight: 20,
    marginBottom: 5,
  },
  codeBlock: {
    marginTop: spacing.md,
  },
  codeRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: 10,
  },
  codeLabel: {
    fontFamily: fonts.semibold,
    fontSize: 11,
    letterSpacing: 0.4,
    opacity: 0.72,
    textTransform: "uppercase",
  },
  code: {
    flex: 1,
    minWidth: 0,
    fontFamily: fonts.bold,
    fontSize: 16,
    letterSpacing: 0.3,
    marginTop: 2,
  },
  copyButton: {
    flexShrink: 0,
  },
  footnote: {
    fontFamily: fonts.regular,
    fontSize: 12,
    marginTop: spacing.sm,
    opacity: 0.72,
  },
  cutout: {
    backgroundColor: colors.page,
    borderRadius: 9,
    borderWidth: 1,
    height: 18,
    marginTop: -9,
    position: "absolute",
    top: "50%",
    width: 18,
  },
  cutoutLeft: {
    left: -10,
  },
  cutoutRight: {
    right: -10,
  },
});
