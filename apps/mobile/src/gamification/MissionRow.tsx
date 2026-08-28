import { Pressable, StyleSheet, Text, View } from "react-native";
import type { MissionCard } from "@bizflow/shared";

import { Icon, type IconName } from "@/components/Icon";
import { useTranslation } from "@/i18n/LanguageContext";
import { colors, fonts, radius, spacing } from "@/theme";

/** One icon per trigger, so a mission is recognisable before it is read. */
const ICON_FOR_TRIGGER: Record<string, IconName> = {
  ad_reward_verified: "play-circle",
  hunt_complete: "target",
  voucher_select: "tag",
  qr_redeem: "maximize",
  booking_complete: "calendar",
  purchase_verified: "shopping-bag",
  review_verified: "message-square",
  referral_verified: "user-plus",
  mission_completed: "award",
};

export function MissionRow({
  mission,
  onClaim,
  onJoin,
  onOpen,
  claiming,
  joining,
}: {
  mission: MissionCard;
  onClaim?: (mission: MissionCard) => void;
  /** Only ever passed for a campaign the player is not in yet. */
  onJoin?: (mission: MissionCard) => void;
  /** Opens the details screen, where evidence is sent. */
  onOpen?: (mission: MissionCard) => void;
  claiming?: boolean;
  joining?: boolean;
}) {
  const t = useTranslation();
  const done = mission.state === "CLAIMED";
  const claimable = mission.state === "CLAIMABLE";
  const verifying = mission.state === "VERIFYING";
  // A window mission outside its hours is not failed, just not now. Saying so
  // is the difference between "come back at lunch" and "this is broken".
  const asleep = !mission.windowOpen && !done && !claimable;

  // Why a campaign cannot be joined, in the player's words. The level case is
  // deliberately absent: it already has its own line with the XP still to go,
  // which is the version that reads as a goal rather than a wall.
  const reasonText =
    mission.ineligibleReason === "QUOTA_EXHAUSTED"
      ? t("mission.reason.quotaExhausted")
      : mission.ineligibleReason === "OUT_OF_AREA"
        ? t("mission.reason.outOfArea")
        : mission.ineligibleReason === "NOT_STARTED"
          ? t("mission.reason.notStarted")
          : mission.ineligibleReason === "NOT_ELIGIBLE"
            ? t("mission.reason.notEligible")
            : null;

  const reward = [
    mission.reward.xp > 0 ? `${mission.reward.xp} XP` : null,
    mission.reward.lp || null,
    mission.reward.huntTickets > 0
      ? t("mission.rewardHunts", { count: mission.reward.huntTickets })
      : null,
  ]
    .filter(Boolean)
    .join(" + ");

  return (
    <View style={[styles.row, done && styles.rowDone, mission.locked && styles.rowLocked]}>
      <View style={[styles.icon, done && styles.iconDone]}>
        <Icon
          color={done ? colors.success : mission.locked ? colors.textMuted : colors.primary}
          name={
            done ? "check" : mission.locked ? "lock" : ICON_FOR_TRIGGER[mission.triggerEvent] ?? "target"
          }
          size={18}
        />
      </View>

      <View style={styles.body}>
        <Text style={[styles.title, done && styles.titleDone]}>{mission.title}</Text>

        {mission.locked ? (
          <Text style={styles.meta}>
            {t("mission.lockedAt", {
              level: mission.minLevel,
              xp: mission.xpToUnlock.toLocaleString(),
            })}
          </Text>
        ) : (
          <Text style={styles.meta}>
            {mission.description}
            {mission.window
              ? ` · ${mission.window.startTime}-${mission.window.endTime}`
              : ""}
          </Text>
        )}

        {mission.target > 1 && !done ? (
          <View style={styles.track}>
            <View
              style={[
                styles.fill,
                { width: `${Math.min(100, (mission.progress / mission.target) * 100)}%` },
              ]}
            />
          </View>
        ) : null}

        <View style={styles.footer}>
          <Text style={styles.reward}>{reward}</Text>
          {mission.target > 1 ? (
            <Text style={styles.progress}>
              {mission.progress}/{mission.target}
            </Text>
          ) : null}
          {asleep ? <Text style={styles.asleep}>{t("mission.outsideWindow")}</Text> : null}
          {mission.quotaRemaining !== null && !done ? (
            <Text style={styles.progress}>
              {t("mission.placesLeft", { count: mission.quotaRemaining })}
            </Text>
          ) : null}
          {mission.distanceMeters !== null ? (
            <Text style={styles.progress}>
              {t("mission.distanceAway", { meters: mission.distanceMeters })}
            </Text>
          ) : null}
        </View>

        {verifying ? (
          <Text style={styles.asleep}>
            {mission.proof?.status === "Rejected"
              ? t("mission.evidenceRejected", {
                  reason: mission.proof.rejectReason ?? "",
                })
              : t("mission.verifying")}
          </Text>
        ) : null}
        {reasonText ? <Text style={styles.asleep}>{reasonText}</Text> : null}
      </View>

      {claimable && onClaim ? (
        <Pressable
          accessibilityRole="button"
          disabled={claiming}
          onPress={() => onClaim(mission)}
          style={({ pressed }) => [styles.claim, pressed && styles.claimPressed]}
        >
          <Text style={styles.claimText}>
            {claiming ? t("mission.claiming") : t("mission.claim")}
          </Text>
        </Pressable>
      ) : mission.joinable && onJoin ? (
        <Pressable
          accessibilityRole="button"
          disabled={joining}
          onPress={() => onJoin(mission)}
          style={({ pressed }) => [styles.claim, pressed && styles.claimPressed]}
        >
          <Text style={styles.claimText}>
            {joining ? t("mission.joining") : t("mission.join")}
          </Text>
        </Pressable>
      ) : mission.requiresProof && onOpen ? (
        <Pressable
          accessibilityRole="button"
          onPress={() => onOpen(mission)}
          style={({ pressed }) => [styles.secondary, pressed && styles.claimPressed]}
        >
          <Text style={styles.secondaryText}>
            {mission.proof?.status === "Rejected" ? t("proof.sendAgain") : t("proof.title")}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    alignItems: "flex-start",
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: radius.md,
    borderWidth: 1,
    flexDirection: "row",
    gap: spacing.md,
    padding: spacing.lg,
  },
  rowDone: {
    backgroundColor: colors.successSoft,
    borderColor: "rgba(34, 197, 94, 0.3)",
  },
  rowLocked: {
    opacity: 0.72,
  },
  icon: {
    alignItems: "center",
    backgroundColor: colors.primarySoft,
    borderRadius: radius.sm,
    height: 36,
    justifyContent: "center",
    width: 36,
  },
  iconDone: {
    backgroundColor: "rgba(34, 197, 94, 0.16)",
  },
  body: {
    flex: 1,
    gap: spacing.xs,
  },
  title: {
    color: colors.ink,
    fontFamily: fonts.bold,
    fontSize: 15,
  },
  titleDone: {
    color: "#166534",
  },
  meta: {
    color: colors.textMuted,
    fontFamily: fonts.regular,
    fontSize: 12,
    lineHeight: 17,
  },
  track: {
    backgroundColor: colors.borderSoft,
    borderRadius: radius.pill,
    height: 6,
    marginTop: spacing.xs,
    overflow: "hidden",
  },
  fill: {
    backgroundColor: colors.primary,
    borderRadius: radius.pill,
    height: 6,
  },
  footer: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing.sm,
    marginTop: 2,
  },
  reward: {
    color: colors.primary,
    fontFamily: fonts.bold,
    fontSize: 12,
  },
  progress: {
    color: colors.textMuted,
    fontFamily: fonts.semibold,
    fontSize: 12,
  },
  asleep: {
    color: colors.warning,
    fontFamily: fonts.semibold,
    fontSize: 12,
  },
  claim: {
    backgroundColor: colors.primary,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  claimPressed: {
    opacity: 0.85,
  },
  claimText: {
    color: colors.surface,
    fontFamily: fonts.bold,
    fontSize: 13,
  },
  secondary: {
    backgroundColor: colors.primarySoft,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  secondaryText: {
    color: colors.primary,
    fontFamily: fonts.bold,
    fontSize: 13,
  },
});
