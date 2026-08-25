import { resolveCampaignImage, type Campaign } from "@bizflow/shared";
import { Image } from "expo-image";
import { StyleSheet, Text, View } from "react-native";

import { resolveAssetUrl } from "@/api/client";
import { useTranslation } from "@/i18n/LanguageContext";
import { campaignModeLabel } from "@/lib/format";
import { colors, fonts, radius } from "@/theme";

/** `.campaign-landing-category.mode-*` — the pill overlaid on the landing artwork. */
const CATEGORY_TINTS: Record<string, { color: string; border: string }> = {
  restaurant: { color: "#c2410c", border: "#fed7aa" },
  online_shop: { color: "#1d4ed8", border: "#bfdbfe" },
  beauty: { color: "#be185d", border: "#fbcfe8" },
  pet: { color: "#0f766e", border: "#99f6e4" },
  retail: { color: "#6d28d9", border: "#ddd6fe" },
  other: { color: "#475569", border: "#e2e8f0" },
};

type CampaignImageProps = {
  campaign: Pick<Campaign, "heroImage" | "slug" | "title">;
  /**
   * Business industry. Passing it draws the category pill over the artwork, as
   * the campaign landing does. This is deliberately not `campaign.mode`: mode is
   * the booking mechanic, so a pet clinic taking appointments runs in restaurant
   * mode and would otherwise be labelled "Restaurant".
   */
  category?: string;
  /** Corner radius; the directory card rounds its media, the landing does not. */
  borderRadius?: number;
  style?: object;
};

/**
 * Campaign artwork, resolved with the same rules as the web (`resolveCampaignImage`
 * from `@bizflow/shared`): an uploaded `data:` URI wins, otherwise the seeded sample
 * for the slug. Renders nothing when a campaign has no artwork, matching the web,
 * which omits the media block entirely rather than showing a placeholder.
 */
export function CampaignImage({
  borderRadius = 0,
  campaign,
  category,
  style,
}: CampaignImageProps) {
  const t = useTranslation();
  const image = resolveCampaignImage(campaign);
  if (!image) return null;

  const tint = CATEGORY_TINTS[category ?? "other"] ?? CATEGORY_TINTS.other;

  return (
    <View style={[styles.media, { borderRadius }, style]}>
      <Image
        alt={image.alt}
        contentFit="cover"
        source={{ uri: resolveAssetUrl(image.src) }}
        style={styles.image}
        transition={160}
      />
      {category ? (
        <View style={[styles.category, { borderColor: tint.border }]}>
          <Text style={[styles.categoryText, { color: tint.color }]}>
            {campaignModeLabel(t, category)}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  media: {
    aspectRatio: 2,
    backgroundColor: colors.page,
    overflow: "hidden",
    position: "relative",
    width: "100%",
  },
  image: {
    height: "100%",
    width: "100%",
  },
  category: {
    backgroundColor: "rgba(255, 255, 255, 0.94)",
    borderRadius: radius.pill,
    borderWidth: 1,
    paddingHorizontal: 11,
    paddingVertical: 5,
    position: "absolute",
    right: 12,
    shadowColor: "#0b1d3a",
    shadowOffset: { width: 0, height: 5 },
    shadowOpacity: 0.12,
    shadowRadius: 14,
    elevation: 3,
    top: 12,
  },
  categoryText: {
    fontFamily: fonts.bold,
    fontSize: 12,
  },
});
