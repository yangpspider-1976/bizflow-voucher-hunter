import { beforeEach, describe, expect, it } from "vitest";
import { getDb, one, resetDb, run } from "@/server/db";
import { DEFAULT_ECONOMY, loadEconomy, publishEconomy } from "@/server/gamification/config";
import { ingestEvent, requeueDeferredEvents } from "@/server/gamification/events";
import { convertPointsToXp } from "@/server/gamification/levels";
import { gamificationProfile } from "@/server/gamification/profile";
import { ensureRewardWallet } from "@/server/rewards-network";
import {
  generateCandidate,
  listPublicCampaignCards,
  startHunt,
} from "@/server/voucher-engine";

/**
 * §6 and §10 of the developer checklist: the server's own enforcement of a
 * campaign's level rules, and the feature switches above them.
 *
 * These need a real database because the gate reads a published ladder and a
 * player's XP; the decision itself is unit-tested in `gamification-offers`.
 */

const phone = "+639171112222";
const slug = "july-dinner";
const campaignId = "camp_july_dinner";

async function walletFor(target = phone) {
  const db = await getDb();
  return ensureRewardWallet(db, { phone: target });
}

/** Puts a player on a level by writing the XP its threshold needs. */
async function setLifetimeXp(xp: number) {
  const db = await getDb();
  const wallet = await walletFor();
  const now = new Date().toISOString();
  await run(
    db,
    `INSERT INTO user_levels (wallet_id, lifetime_xp, current_level, announced_level, created_at, updated_at)
     VALUES (?, ?, 1, 1, ?, ?)
     ON CONFLICT (wallet_id) DO UPDATE SET lifetime_xp = EXCLUDED.lifetime_xp`,
    [wallet.id, xp, now, now],
  );
  return wallet;
}

async function setCampaignRules(rules: {
  minUserLevel?: number;
  levelExclusive?: boolean;
  levelQuota?: number;
  earlyAccessAt?: string | null;
}) {
  const db = await getDb();
  await run(
    db,
    `UPDATE campaigns
     SET min_user_level = ?, level_exclusive = ?, level_quota = ?, early_access_at = ?
     WHERE id = ?`,
    [
      rules.minUserLevel ?? 1,
      rules.levelExclusive ? 1 : 0,
      rules.levelQuota ?? 0,
      rules.earlyAccessAt ?? null,
      campaignId,
    ],
  );
}

/** Publishes an economy that differs from the live one in the named ways only. */
async function publish(overrides: Partial<typeof DEFAULT_ECONOMY>) {
  const db = await getDb();
  const { economy } = await loadEconomy(db);
  return publishEconomy(db, {
    economy: { ...economy, ...overrides },
    actor: "ops@test",
    note: "test",
  });
}

const hunt = () => startHunt({ campaignSlug: slug, phone, sessionId: `sess_${phone}` });

describe("level-gated offers", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("lets anybody hunt a campaign with no level rules", async () => {
    await expect(hunt()).resolves.toBeTruthy();
  });

  it("refuses a hunt below the campaign's minimum level", async () => {
    await setCampaignRules({ minUserLevel: 3 });
    await setLifetimeXp(0);

    await expect(hunt()).rejects.toMatchObject({ code: "E-LEVEL-REQUIRED" });
  });

  it("refuses the draw too, not only the door", async () => {
    // The card is a courtesy; the attempt is what costs stock and capacity.
    await setCampaignRules({ minUserLevel: 3 });
    await setLifetimeXp(0);

    await expect(
      generateCandidate({ campaignSlug: slug, phone, sessionId: `sess_${phone}` }),
    ).rejects.toMatchObject({ code: "E-LEVEL-REQUIRED" });
  });

  it("admits a player who has reached the level", async () => {
    await setCampaignRules({ minUserLevel: 3 });
    await setLifetimeXp(1_500);

    await expect(hunt()).resolves.toBeTruthy();
  });

  it("says how much XP is missing on the card rather than only refusing", async () => {
    await setCampaignRules({ minUserLevel: 3 });
    await setLifetimeXp(900);

    const cards = await listPublicCampaignCards(phone);
    const card = cards.find((entry) => entry.campaign.slug === slug);
    expect(card?.levelGate?.locked).toBe(true);
    expect(card?.levelGate?.requiredLevel).toBe(3);
    expect(card?.levelGate?.missingXp).toBe(600);
  });

  it("keeps an exclusive campaign out of the directory of somebody below it", async () => {
    await setCampaignRules({ minUserLevel: 5, levelExclusive: true });
    await setLifetimeXp(0);

    const cards = await listPublicCampaignCards(phone);
    expect(cards.some((entry) => entry.campaign.slug === slug)).toBe(false);
  });

  it("shows an exclusive campaign to somebody who qualifies", async () => {
    await setCampaignRules({ minUserLevel: 5, levelExclusive: true });
    await setLifetimeXp(7_000);

    const cards = await listPublicCampaignCards(phone);
    expect(cards.some((entry) => entry.campaign.slug === slug)).toBe(true);
  });

  it("refuses a hunt before the campaign opens", async () => {
    await setCampaignRules({
      earlyAccessAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    });

    await expect(hunt()).rejects.toMatchObject({ code: "E-OFFER-NOT-OPEN" });
  });

  it("lets a level with a head start in before the opening", async () => {
    // Level 4 carries 30 minutes; the offer opens in 10.
    await setLifetimeXp(3_500);
    await setCampaignRules({
      earlyAccessAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    });

    await expect(hunt()).resolves.toBeTruthy();
  });

  it("does not gate anything while the levels feature is switched off", async () => {
    await setCampaignRules({ minUserLevel: 5 });
    await setLifetimeXp(0);
    await publish({
      features: {
        ...DEFAULT_ECONOMY.features,
        levels: { enabled: false, rolloutPercent: 100 },
      },
    });

    // A lock nobody can earn past is worse than no lock at all.
    await expect(hunt()).resolves.toBeTruthy();
  });
});

describe("feature switches", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("refuses a conversion while conversion is switched off", async () => {
    const wallet = await walletFor();
    const db = await getDb();
    await run(db, "UPDATE reward_wallets SET balance_centavos = ? WHERE id = ?", [
      600_00,
      wallet.id,
    ]);
    await publish({
      features: {
        ...DEFAULT_ECONOMY.features,
        conversion: { enabled: false, rolloutPercent: 100 },
      },
    });

    await expect(
      convertPointsToXp({
        phone,
        businessId: null,
        amount: 500,
        idempotencyKey: "flagged-off-1",
      }),
    ).rejects.toMatchObject({ code: "E-FEATURE-DISABLED" });
  });

  it("empties the mission board rather than showing a dead tab", async () => {
    await publish({
      features: {
        ...DEFAULT_ECONOMY.features,
        missions: { enabled: false, rolloutPercent: 100 },
      },
    });

    const profile = await gamificationProfile({ phone });
    expect(profile.features.missions).toBe(false);
    expect(profile.missions).toHaveLength(0);
    // Levels are a separate switch and are still running.
    expect(profile.features.levels).toBe(true);
    expect(profile.level.level).toBe(1);
  });

  it("keeps events that arrive while the engine is off, and replays them after", async () => {
    await publish({
      features: {
        ...DEFAULT_ECONOMY.features,
        missions: { enabled: false, rolloutPercent: 100 },
        achievements: { enabled: false, rolloutPercent: 100 },
      },
    });

    await ingestEvent({
      eventName: "hunt_complete",
      phone,
      source: "test",
      objectType: "attempt",
      objectId: "att_deferred_1",
      idempotencyKey: "hunt_complete:att_deferred_1",
    });

    const db = await getDb();
    const row = await one(
      db,
      "SELECT status FROM gamification_events WHERE idempotency_key = ?",
      ["hunt_complete:att_deferred_1"],
    );
    expect(String(row?.status)).toBe("Deferred");

    // Turning it back on requeues what was set aside; nothing was destroyed.
    await publish({ features: DEFAULT_ECONOMY.features });
    const { requeued } = await requeueDeferredEvents(await getDb());
    expect(requeued).toBeGreaterThanOrEqual(1);

    const after = await one(
      db,
      "SELECT status FROM gamification_events WHERE idempotency_key = ?",
      ["hunt_complete:att_deferred_1"],
    );
    expect(String(after?.status)).toBe("Pending");
  });
});

describe("economy version guard", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("refuses a conversion quoted against a version that is no longer live", async () => {
    const wallet = await walletFor();
    const db = await getDb();
    await run(db, "UPDATE reward_wallets SET balance_centavos = ? WHERE id = ?", [
      600_00,
      wallet.id,
    ]);
    const { version } = await loadEconomy(db);
    await publish({ xpPerLp: 2 });

    await expect(
      convertPointsToXp({
        phone,
        businessId: null,
        amount: 500,
        idempotencyKey: "stale-terms-1",
        expectedConfigVersion: version,
      }),
    ).rejects.toMatchObject({ code: "E-CONFIG-VERSION-CHANGED" });
  });

  it("converts when the quoted version is still the live one", async () => {
    const wallet = await walletFor();
    const db = await getDb();
    await run(db, "UPDATE reward_wallets SET balance_centavos = ? WHERE id = ?", [
      600_00,
      wallet.id,
    ]);
    const { version } = await loadEconomy(db);

    const result = await convertPointsToXp({
      phone,
      businessId: null,
      amount: 500,
      idempotencyKey: "current-terms-1",
      expectedConfigVersion: version,
    });
    expect(result.xpGranted).toBe(500);
  });

  it("still replays a successful conversion after the terms move", async () => {
    // The retry describes a conversion that already happened under the old
    // terms. Refusing it would leave the client unable to learn the outcome.
    const wallet = await walletFor();
    const db = await getDb();
    await run(db, "UPDATE reward_wallets SET balance_centavos = ? WHERE id = ?", [
      600_00,
      wallet.id,
    ]);
    const { version } = await loadEconomy(db);
    await convertPointsToXp({
      phone,
      businessId: null,
      amount: 500,
      idempotencyKey: "replay-across-versions",
      expectedConfigVersion: version,
    });
    await publish({ xpPerLp: 2 });

    const replay = await convertPointsToXp({
      phone,
      businessId: null,
      amount: 500,
      idempotencyKey: "replay-across-versions",
      expectedConfigVersion: version,
    });
    expect(replay.xpGranted).toBe(500);
    expect(replay.lpDebitedCentavos).toBe(500_00);
  });
});
