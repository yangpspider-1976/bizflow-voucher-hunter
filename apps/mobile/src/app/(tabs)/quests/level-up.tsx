import { useRouter } from "expo-router";
import { useCallback, useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { ConvertibleWallet } from "@bizflow/shared";

import { convertPointsToXp } from "@/api/client";
import { useAuth } from "@/auth/AuthContext";
import { Button, Field } from "@/components/FormControls";
import { Icon } from "@/components/Icon";
import { Screen } from "@/components/Screen";
import {
  useGamification,
  useGamificationFocusRefresh,
} from "@/gamification/GamificationContext";
import { LevelCard } from "@/gamification/LevelCard";
import { useTranslation } from "@/i18n/LanguageContext";
import { colors, fonts, radius, spacing } from "@/theme";

/**
 * Spending Loyalty Points on a level.
 *
 * Two steps on purpose. The first picks a pot and an amount; the second states
 * plainly what leaves, what arrives, that it cannot be undone and that XP has
 * no cash value — the requirements ask for exactly that confirmation, and this
 * is the one screen in the app where a tap destroys a spendable balance.
 */
export default function LevelUpScreen() {
  const t = useTranslation();
  const router = useRouter();
  const { token } = useAuth();
  const { profile, refresh } = useGamification();

  const [walletId, setWalletId] = useState<string | null | undefined>(undefined);
  const [amount, setAmount] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Minted once per confirmation, so a retry after a timeout is the same tap
  // rather than a second conversion.
  const [idempotencyKey, setIdempotencyKey] = useState("");

  // The balance here decides what the customer may convert, and LP moves
  // elsewhere in the app - earned at a till, spent in the shop, transferred
  // between pots. Re-read it on every arrival rather than trusting whatever was
  // true when the app opened.
  useGamificationFocusRefresh();

  const wallets = profile?.convertibleLp ?? [];
  const selected: ConvertibleWallet | undefined = useMemo(() => {
    if (walletId === undefined) return wallets[0];
    return wallets.find((entry) => entry.businessId === walletId);
  }, [walletId, wallets]);

  const conversion = profile?.conversion;
  const lp = Number(amount.replace(/[^\d.]/g, ""));
  const centavos = Math.round((Number.isFinite(lp) ? lp : 0) * 100);
  const xp = conversion ? Math.floor(lp * conversion.xpPerLp) : 0;

  const tooSmall = !!conversion && centavos > 0 && centavos < conversion.minLpCentavos;
  const tooLarge = !!selected && centavos > selected.balanceCentavos;
  const notWhole = centavos % 100 !== 0;
  const canConvert = centavos > 0 && !tooSmall && !tooLarge && !notWhole;

  const expectedLevel = useMemo(() => {
    if (!profile) return null;
    const total = profile.level.lifetimeXp + xp;
    const ladder = [...profile.levels].sort((a, b) => a.minXp - b.minXp);
    // Preview only. The server recomputes and its answer is the one that counts,
    // which is why this is never written anywhere or trusted after the call.
    let candidate = ladder[0];
    for (const entry of ladder) if (total >= entry.minXp) candidate = entry;
    return candidate ?? null;
  }, [profile, xp]);

  const startConfirm = useCallback(() => {
    setIdempotencyKey(
      `convert-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
    );
    setError(null);
    setConfirming(true);
  }, []);

  const submit = useCallback(async () => {
    if (!token || !selected) return;
    setSubmitting(true);
    setError(null);
    try {
      await convertPointsToXp(
        { businessId: selected.businessId, amount: lp, idempotencyKey },
        token,
      );
      await refresh();
      router.back();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("level.convertFailed"));
      setConfirming(false);
    } finally {
      setSubmitting(false);
    }
  }, [idempotencyKey, lp, refresh, router, selected, t, token]);

  if (!profile || !conversion) return null;

  if (confirming && selected) {
    return (
      <Screen title={t("level.confirmTitle")}>
        <View style={styles.stack}>
          <View style={styles.summary}>
            <Row label={t("level.confirmFrom")} value={selected.businessName} />
            <Row label={t("level.confirmSpend")} value={`${lp.toLocaleString()} LP`} />
            <Row label={t("level.confirmEarn")} value={`${xp.toLocaleString()} XP`} />
            <Row
              label={t("level.confirmLevel")}
              value={
                expectedLevel && expectedLevel.level > profile.level.level
                  ? `${expectedLevel.name} (${t("level.promotion")})`
                  : profile.level.name
              }
            />
          </View>

          <View style={styles.warning}>
            <Icon color={colors.alertText} name="alert-triangle" size={16} />
            <Text style={styles.warningText}>{t("level.irreversible")}</Text>
          </View>

          {error ? <Text style={styles.error}>{error}</Text> : null}

          <Button
            loading={submitting}
            loadingLabel={t("level.converting")}
            onPress={submit}
          >
            {t("level.confirmButton")}
          </Button>
          <Button
            disabled={submitting}
            onPress={() => setConfirming(false)}
            variant="secondary"
          >
            {t("common.back")}
          </Button>
        </View>
      </Screen>
    );
  }

  return (
    <Screen subtitle={t("level.convertLead")} title={t("level.upTitle")}>
      <View style={styles.stack}>
        <LevelCard level={profile.level} />

        <Text style={styles.label}>{t("level.choosePot")}</Text>
        {wallets.map((entry) => {
          const active = selected?.businessId === entry.businessId;
          return (
            <Pressable
              accessibilityRole="button"
              key={entry.businessId ?? "global"}
              onPress={() => setWalletId(entry.businessId)}
              style={[styles.pot, active && styles.potActive]}
            >
              <View style={styles.potBody}>
                <Text style={styles.potName}>{entry.businessName}</Text>
                <Text style={styles.potBalance}>{entry.balance}</Text>
              </View>
              {active ? <Icon name="check-circle" size={19} /> : null}
            </Pressable>
          );
        })}

        <Text style={styles.label}>{t("level.chooseAmount")}</Text>
        <View style={styles.presets}>
          {conversion.presetsCentavos.map((preset) => (
            <Pressable
              accessibilityRole="button"
              key={preset}
              onPress={() => setAmount(String(preset / 100))}
              style={[
                styles.preset,
                centavos === preset && styles.presetActive,
                (selected?.balanceCentavos ?? 0) < preset && styles.presetDisabled,
              ]}
            >
              <Text
                style={[styles.presetText, centavos === preset && styles.presetTextActive]}
              >
                {preset / 100} LP
              </Text>
            </Pressable>
          ))}
        </View>

        <Field
          keyboardType="number-pad"
          label={t("level.customAmount")}
          hint={t("level.minimum", { min: conversion.minLp })}
          onChangeText={setAmount}
          placeholder="500"
          value={amount}
        />

        {centavos > 0 ? (
          <View style={styles.preview}>
            <Text style={styles.previewText}>
              {t("level.previewXp", { xp: xp.toLocaleString() })}
            </Text>
            {tooSmall ? (
              <Text style={styles.error}>
                {t("level.belowMinimum", { min: conversion.minLp })}
              </Text>
            ) : null}
            {tooLarge ? (
              <Text style={styles.error}>
                {t("level.aboveBalance", { balance: selected?.balance ?? "0 LP" })}
              </Text>
            ) : null}
            {notWhole ? <Text style={styles.error}>{t("level.wholePointsOnly")}</Text> : null}
          </View>
        ) : null}

        <Button disabled={!canConvert} onPress={startConfirm}>
          {t("level.review")}
        </Button>
      </View>
    </Screen>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  stack: {
    gap: spacing.md,
  },
  label: {
    color: colors.ink,
    fontFamily: fonts.bold,
    fontSize: 14,
    marginTop: spacing.sm,
  },
  pot: {
    alignItems: "center",
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: radius.md,
    borderWidth: 1,
    flexDirection: "row",
    padding: spacing.lg,
  },
  potActive: {
    borderColor: colors.primary,
    backgroundColor: colors.primarySoft,
  },
  potBody: {
    flex: 1,
    gap: 2,
  },
  potName: {
    color: colors.ink,
    fontFamily: fonts.semibold,
    fontSize: 15,
  },
  potBalance: {
    color: colors.textMuted,
    fontFamily: fonts.regular,
    fontSize: 13,
  },
  presets: {
    flexDirection: "row",
    gap: spacing.sm,
  },
  preset: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: radius.pill,
    borderWidth: 1,
    flex: 1,
    paddingVertical: spacing.md,
  },
  presetActive: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  },
  presetDisabled: {
    opacity: 0.5,
  },
  presetText: {
    color: colors.ink,
    fontFamily: fonts.semibold,
    fontSize: 13,
    textAlign: "center",
  },
  presetTextActive: {
    color: colors.surface,
  },
  preview: {
    backgroundColor: colors.primarySoft,
    borderRadius: radius.md,
    gap: spacing.xs,
    padding: spacing.lg,
  },
  previewText: {
    color: colors.primary,
    fontFamily: fonts.bold,
    fontSize: 15,
  },
  summary: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: radius.md,
    borderWidth: 1,
    padding: spacing.lg,
  },
  row: {
    borderBottomColor: colors.borderSoft,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: spacing.md,
  },
  rowLabel: {
    color: colors.textMuted,
    fontFamily: fonts.regular,
    fontSize: 14,
  },
  rowValue: {
    color: colors.ink,
    fontFamily: fonts.bold,
    fontSize: 14,
  },
  warning: {
    alignItems: "flex-start",
    backgroundColor: colors.warningSoft,
    borderColor: colors.alertBorder,
    borderRadius: radius.md,
    borderWidth: 1,
    flexDirection: "row",
    gap: spacing.sm,
    padding: spacing.lg,
  },
  warningText: {
    color: colors.alertText,
    flex: 1,
    fontFamily: fonts.regular,
    fontSize: 13,
    lineHeight: 19,
  },
  error: {
    color: colors.danger,
    fontFamily: fonts.semibold,
    fontSize: 13,
  },
});
