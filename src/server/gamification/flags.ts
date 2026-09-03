/**
 * Feature flags and gradual rollout.
 *
 * §17's last question asks whether each feature can be stopped immediately and
 * rolled out gradually. The switches live in the economy configuration, which
 * is already versioned, already published from the Admin CMS without a deploy,
 * and already recorded on every transaction — so turning missions off is an
 * operator action with an audit trail rather than a release.
 *
 * Two rules shape everything here.
 *
 * **A flag gates earning and exposure, never a payout already earned.** If a
 * player finished a mission this morning and missions are switched off this
 * afternoon, the claim still pays. Swallowing an owed reward would turn a
 * routine operational lever into a support incident, and the whole point of
 * being able to stop a feature is that stopping it is cheap.
 *
 * **A player inside a rollout stays inside it.** Membership is a hash of the
 * wallet id against the percentage, not a sample, so raising 10 to 20 adds
 * people and removes nobody. A cohort that reshuffled on every read would be
 * worse than no rollout at all: half the testers would lose the feature between
 * one screen and the next.
 */
import type { EconomyConfig, GamificationFeature } from "./config";
import { AppError } from "@/server/errors";

/**
 * A stable bucket in [0, 100) for one subject and one feature.
 *
 * FNV-1a rather than a cryptographic digest: this decides which players see a
 * feature first, not anything an attacker gains from predicting, and a pure
 * integer hash keeps the function testable and identical on every runtime.
 *
 * The feature name is mixed in so two features at 10% do not pick the same
 * tenth of the userbase — otherwise the same unlucky players would be the
 * guinea pigs for everything, and one bad cohort would look like a bad build.
 */
export function rolloutBucket(feature: string, subjectId: string): number {
  let hash = 0x811c9dc5;
  const input = `${feature}:${subjectId}`;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    // The FNV prime, as shifts, so the arithmetic stays inside 32 bits.
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash % 100;
}

/**
 * Whether one feature is live for one player.
 *
 * `subjectId` is the wallet id wherever there is one. A caller with no player
 * in hand — a cron sweep, an admin screen — passes null and gets the switch on
 * its own, because a scheduled job is not a member of a rollout cohort.
 */
export function featureEnabledFor(
  economy: EconomyConfig,
  feature: GamificationFeature,
  subjectId: string | null,
): boolean {
  const flag = economy.features?.[feature];
  // An unknown flag reads as on. Configuration written before a feature existed
  // described a world where it ran, and a missing key must not be an outage.
  if (!flag) return true;
  if (!flag.enabled) return false;
  if (flag.rolloutPercent >= 100) return true;
  if (flag.rolloutPercent <= 0) return false;
  // Without a subject there is no cohort to be in. A partial rollout is a
  // statement about players, so anything that is not a player waits for 100%.
  if (!subjectId) return false;
  return rolloutBucket(feature, subjectId) < flag.rolloutPercent;
}

/**
 * The refusal a customer-facing endpoint gives when a feature is switched off.
 *
 * 503 rather than 403: nothing is wrong with the request or the player, the
 * thing they asked for is temporarily not running, and the app should say so
 * and offer to come back rather than telling them they are not allowed.
 */
export function assertFeatureEnabled(
  economy: EconomyConfig,
  feature: GamificationFeature,
  subjectId: string | null,
  message: string,
): void {
  if (!featureEnabledFor(economy, feature, subjectId)) {
    throw new AppError("E-FEATURE-DISABLED", message, 503);
  }
}
