import { useCallback, useEffect, useState } from "react";
import { StyleSheet, Switch, Text, View } from "react-native";

import { useAuth } from "@/auth/AuthContext";
import { Icon } from "@/components/Icon";
import {
  fetchPushPreferences,
  updatePushPreferences,
  type PushPreferences,
} from "@/notifications/push";
import { useTranslation } from "@/i18n/LanguageContext";
import type { TranslationKey } from "@/i18n/translations";
import { colors, fonts, radius, spacing } from "@/theme";

const ROWS: {
  key: keyof PushPreferences;
  labelKey: TranslationKey;
  copyKey: TranslationKey;
}[] = [
  {
    key: "daily",
    labelKey: "notifications.dailyLp",
    copyKey: "notifications.dailyCopy",
  },
  {
    key: "reservation",
    labelKey: "notifications.bookingReminders",
    copyKey: "notifications.bookingCopy",
  },
  {
    key: "rewards",
    labelKey: "notifications.rewards",
    copyKey: "notifications.pointsCopy",
  },
  {
    key: "missions",
    labelKey: "notifications.missions",
    copyKey: "notifications.missionsCopy",
  },
  {
    key: "marketing",
    labelKey: "notifications.marketing",
    copyKey: "notifications.marketingCopy",
  },
  {
    key: "quietHours",
    labelKey: "notifications.quietHours",
    copyKey: "notifications.quietHoursCopy",
  },
];

/**
 * Per-category notification opt-out.
 *
 * Renders nothing when the device has no push registration — on an emulator, in
 * Expo Go, or after the customer denied the OS permission. Showing toggles that
 * cannot take effect would be misleading.
 */
export function NotificationSettings() {
  const t = useTranslation();
  const { token } = useAuth();
  const [preferences, setPreferences] = useState<PushPreferences | null>(null);
  const [saving, setSaving] = useState<keyof PushPreferences | null>(null);

  useEffect(() => {
    if (!token) return;
    let active = true;
    void fetchPushPreferences(token).then((result) => {
      if (active) setPreferences(result);
    });
    return () => {
      active = false;
    };
  }, [token]);

  const toggle = useCallback(
    async (key: keyof PushPreferences, value: boolean) => {
      if (!token || !preferences) return;
      // Optimistic: the switch should track the finger, not the round trip.
      const previous = preferences;
      setPreferences({ ...preferences, [key]: value });
      setSaving(key);
      try {
        await updatePushPreferences({ [key]: value }, token);
      } catch {
        setPreferences(previous);
      } finally {
        setSaving(null);
      }
    },
    [preferences, token],
  );

  if (!preferences) return null;

  return (
    <View style={styles.card}>
      <View style={styles.heading}>
        <Icon name="bell" size={16} />
        <Text style={styles.headingText}>{t("notifications.title")}</Text>
      </View>
      {ROWS.map((row, index) => (
        <View
          key={row.key}
          style={[styles.row, index === ROWS.length - 1 && styles.rowLast]}
        >
          <View style={styles.rowCopy}>
            <Text style={styles.rowLabel}>{t(row.labelKey)}</Text>
            <Text style={styles.rowHint}>{t(row.copyKey)}</Text>
          </View>
          <Switch
            disabled={saving === row.key}
            onValueChange={(value) => void toggle(row.key, value)}
            thumbColor={colors.surface}
            trackColor={{ false: colors.border, true: colors.primary }}
            value={preferences[row.key]}
          />
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: radius.md,
    borderWidth: 1,
    marginBottom: spacing.lg,
    paddingHorizontal: 16,
  },
  heading: {
    alignItems: "center",
    borderBottomColor: colors.borderSoft,
    borderBottomWidth: 1,
    flexDirection: "row",
    gap: spacing.sm,
    paddingVertical: 14,
  },
  headingText: {
    color: colors.ink,
    fontFamily: fonts.extrabold,
    fontSize: 14,
  },
  row: {
    alignItems: "center",
    borderBottomColor: colors.borderSoft,
    borderBottomWidth: 1,
    flexDirection: "row",
    gap: spacing.md,
    paddingVertical: 14,
  },
  rowLast: {
    borderBottomWidth: 0,
  },
  rowCopy: {
    flex: 1,
    gap: 2,
  },
  rowLabel: {
    color: colors.ink,
    fontFamily: fonts.semibold,
    fontSize: 14,
  },
  rowHint: {
    color: colors.textMuted,
    fontFamily: fonts.regular,
    fontSize: 12,
    lineHeight: 17,
  },
});
