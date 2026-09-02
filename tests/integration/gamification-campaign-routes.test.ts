/**
 * Stage 2 of the manual gamification plan, automated: urgent campaigns as they
 * are actually reached — through the admin API a partner writes them in, and
 * through the public API the app reads and joins them with.
 *
 * gamification-urgent-missions.test.ts already covers the engine underneath
 * this in depth: both quota modes, the release on expiry, the whole evidence
 * lifecycle, the pre-flight bounds. What it cannot cover is the layer that
 * decides *who may do what* — the partner-versus-operations split lives in the
 * route's `scopeFor`, not in the engine, and a partner publishing straight to
 * Active would pass every engine test ever written.
 *
 * Case numbers refer to the manual plan.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const cookieValues = vi.hoisted(() => new Map<string, string>());

vi.mock("next/headers", () => ({
  cookies: () => ({
    get: (name: string) => {
      const value = cookieValues.get(name);
      return value === undefined ? undefined : { name, value };
    },
    set: (name: string, value: string) => {
      if (value) cookieValues.set(name, value);
      else cookieValues.delete(name);
    },
  }),
}));

import {
  PATCH as decideMission,
  POST as publishMission,
} from "@/app/api/admin/gamification/missions/route";
import { POST as joinMissionRoute } from "@/app/api/public/gamification/missions/[missionKey]/join/route";
import { POST as submitProofRoute } from "@/app/api/public/gamification/missions/[missionKey]/proof/route";
import { GET as readMissionBoard } from "@/app/api/public/gamification/missions/route";
import { POST as verifyOtpRoute } from "@/app/api/public/signin/verify-otp/route";
import { ADMIN_SESSION_COOKIE, createAdminSession } from "@/lib/admin-session";
import { all, getDb, resetDb, run } from "@/server/db";
import { requestSignInOtp } from "@/server/otp";

const phone = "+639171110204";
const partner = "biz_demo_restaurant";

/** A one-by-one PNG: a valid attachment that costs nothing to carry around. */
const PIXEL_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

type ApiResponse<T> =
  | { success: true; data: T }
  | { success: false; error: { code: string; message: string } };

async function unwrap<T>(response: Response): Promise<T> {
  const body = (await response.json()) as ApiResponse<T>;
  if (!body.success) {
    throw new Error(`${response.status} ${body.error.code}: ${body.error.message}`);
  }
  return body.data;
}

async function errorOf(response: Response) {
  const body = (await response.json()) as ApiResponse<unknown>;
  if (body.success) throw new Error("expected a failure, got a success");
  return body.error;
}

/* Callers -------------------------------------------------------------------- */

async function adminRequest(
  role: "super_admin" | "admin" | "staff",
  businessIds: string[],
  url: string,
  body: unknown,
  method = "POST",
) {
  const token = await createAdminSession({
    email: `${role}-${businessIds.join("-")}@example.com`,
    name: "Console user",
    role,
    businessIds,
  });
  return new Request(url, {
    method,
    headers: {
      cookie: `${ADMIN_SESSION_COOKIE}=${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

/** Operations: sees and approves everything. */
const asOperations = (url: string, body: unknown, method?: string) =>
  adminRequest("super_admin", ["*"], url, body, method);

/**
 * A partner console account: `staff`, scoped to exactly one business, which is
 * the only shape `resolveBusinessIds` allows a partner login to take.
 */
const asPartner = (url: string, body: unknown, method?: string) =>
  adminRequest("staff", [partner], url, body, method);

async function playerToken() {
  const challenge = await requestSignInOtp({ phone });
  const response = await verifyOtpRoute(
    new Request("http://localhost/api/public/signin/verify-otp", {
      method: "POST",
      headers: { "content-type": "application/json", "x-client": "mobile" },
      body: JSON.stringify({ phone, code: challenge.devCode }),
    }),
  );
  return (await unwrap<{ token: string }>(response)).token;
}

function asPlayer(url: string, token: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  if (init.body) headers.set("content-type", "application/json");
  return new Request(url, { ...init, headers });
}

/* Drafts --------------------------------------------------------------------- */

function draft(overrides: Record<string, unknown> = {}) {
  return {
    missionKey: "urgent_route_lunch",
    type: "URGENT",
    title: "Off-peak lunch",
    description: "Visit on a weekday afternoon and scan your voucher.",
    triggerEvent: "qr_redeem",
    targetCount: 1,
    minLevel: 1,
    partnerId: partner,
    reward: [{ type: "XP", amount: 50 }],
    audience: { segment: "all" },
    autoClaim: true,
    requiresProof: false,
    quotaMode: "ON_COMPLETION",
    userQuota: 1,
    status: "Active",
    exposureChannel: "app",
    sortOrder: 100,
    ...overrides,
  };
}

const MISSIONS_URL = "http://localhost/api/admin/gamification/missions";

async function definitionRows(missionKey: string) {
  return all(
    await getDb(),
    "SELECT definition_version, status FROM mission_definitions WHERE mission_key = ? ORDER BY definition_version ASC",
    [missionKey],
  );
}

type PublishedMission = { missionKey: string; definitionVersion: number; status: string };
type MissionCardRow = {
  missionKey: string;
  state: string;
  joinable?: boolean;
  ineligibleReason?: string | null;
};

describe("authoring a campaign through the console", () => {
  beforeEach(async () => {
    cookieValues.clear();
    process.env.ADMIN_SESSION_SECRET =
      "test-only-admin-session-secret-with-more-than-32-characters";
    await resetDb();
  });

  // T8
  it("publishes live for operations", async () => {
    const published = await unwrap<PublishedMission>(
      await publishMission(await asOperations(MISSIONS_URL, draft())),
    );

    expect(published.status).toBe("Active");
    expect(published.definitionVersion).toBe(1);
  });

  // T8. The half no engine test can reach: a partner does not get to decide
  // that its own campaign is live.
  it("queues a partner's campaign for review however it labelled itself", async () => {
    const published = await unwrap<PublishedMission>(
      await publishMission(await asPartner(MISSIONS_URL, draft({ status: "Active" }))),
    );

    // Queued rather than refused — refusing would lose everything they typed.
    expect(published.status).toBe("Review");

    // And it is not on the board yet.
    const token = await playerToken();
    const cards = await unwrap<MissionCardRow[]>(
      await readMissionBoard(
        asPlayer("http://localhost/api/public/gamification/missions?type=URGENT", token),
      ),
    );
    expect(cards.map((card) => card.missionKey)).not.toContain(
      "urgent_route_lunch",
    );
  });

  // T8
  it("goes live once operations approve it, and only then", async () => {
    const submitted = await unwrap<PublishedMission>(
      await publishMission(await asPartner(MISSIONS_URL, draft())),
    );
    expect(submitted.status).toBe("Review");

    await unwrap<unknown>(
      await decideMission(
        await asOperations(
          MISSIONS_URL,
          {
            action: "review",
            missionKey: "urgent_route_lunch",
            definitionVersion: submitted.definitionVersion,
            decision: "Approved",
            activate: true,
            note: "Checked the numbers with the partner",
          },
          "PATCH",
        ),
      ),
    );

    const rows = await definitionRows("urgent_route_lunch");
    expect(rows).toHaveLength(1);
    expect(String(rows[0]!.status)).toBe("Active");

    const token = await playerToken();
    const board = await unwrap<MissionCardRow[]>(
      await readMissionBoard(
        asPlayer("http://localhost/api/public/gamification/missions?type=URGENT", token),
      ),
    );
    expect(board.map((card) => card.missionKey)).toContain(
      "urgent_route_lunch",
    );
  });

  // T8. The builder calls this on every keystroke of the operator's, so it
  // writing a definition would fill the table with drafts nobody published.
  it("simulates without writing a definition", async () => {
    const simulation = await unwrap<{
      audienceSize: number;
      maxCompletions: number;
      maxLpCostCentavos: number;
    }>(
      await publishMission(
        await asOperations(`${MISSIONS_URL}?simulate=1`, draft({
          reward: [{ type: "LP", amount: 10_00, fundingSource: "PLATFORM" }],
          globalQuota: 5,
        })),
      ),
    );

    expect(simulation.maxCompletions).toBeLessThanOrEqual(5);
    expect(simulation.maxLpCostCentavos).toBe(simulation.maxCompletions * 10_00);
    expect(await definitionRows("urgent_route_lunch")).toHaveLength(0);
  });

  // T8. Republishing supersedes rather than edits, so an in-flight instance
  // keeps the rules it started under.
  it("supersedes rather than edits when republished", async () => {
    await publishMission(await asOperations(MISSIONS_URL, draft()));
    const second = await unwrap<PublishedMission>(
      await publishMission(
        await asOperations(MISSIONS_URL, draft({ reward: [{ type: "XP", amount: 80 }] })),
      ),
    );

    expect(second.definitionVersion).toBe(2);
    const rows = await definitionRows("urgent_route_lunch");
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => String(row.status))).toEqual(["Archived", "Active"]);
  });
});

describe("reading and joining a campaign from the app", () => {
  beforeEach(async () => {
    cookieValues.clear();
    process.env.ADMIN_SESSION_SECRET =
      "test-only-admin-session-secret-with-more-than-32-characters";
    await resetDb();
  });

  // T9
  it("shows a live campaign before the player has any row for it", async () => {
    await publishMission(await asOperations(MISSIONS_URL, draft()));
    const token = await playerToken();

    const board = await unwrap<MissionCardRow[]>(
      await readMissionBoard(
        asPlayer("http://localhost/api/public/gamification/missions?type=URGENT", token),
      ),
    );

    const card = board.find(
      (entry) => entry.missionKey === "urgent_route_lunch",
    );
    expect(card).toBeDefined();
    expect(card?.joinable).toBe(true);
    // Nothing has been written for this player yet — the card is built from the
    // definition and a fresh eligibility check.
    expect(
      await all(
        await getDb(),
        "SELECT id FROM user_missions WHERE mission_key = ?",
        ["urgent_route_lunch"],
      ),
    ).toHaveLength(0);
  });

  // T9
  it("still shows a campaign the player cannot join, with the reason", async () => {
    await publishMission(
      await asOperations(MISSIONS_URL, draft({ minLevel: 3 })),
    );
    const token = await playerToken();

    const board = await unwrap<MissionCardRow[]>(
      await readMissionBoard(
        asPlayer("http://localhost/api/public/gamification/missions?type=URGENT", token),
      ),
    );

    const card = board.find(
      (entry) => entry.missionKey === "urgent_route_lunch",
    );
    expect(card).toBeDefined();
    expect(card?.joinable).toBe(false);
    expect(card?.ineligibleReason).toBe("LEVEL_REQUIRED");
  });

  // T10
  it("takes a reserved place on join and refuses a second one", async () => {
    await publishMission(
      await asOperations(
        MISSIONS_URL,
        draft({ quotaMode: "RESERVE_ON_JOIN", globalQuota: 1 }),
      ),
    );
    const token = await playerToken();
    const url =
      "http://localhost/api/public/gamification/missions/urgent_route_lunch/join";

    const joined = await unwrap<{ state: string }>(
      await joinMissionRoute(asPlayer(url, token, { method: "POST", body: "{}" }), {
        params: { missionKey: "urgent_route_lunch" },
      }),
    );
    expect(joined.state).toBe("IN_PROGRESS");

    const again = await joinMissionRoute(
      asPlayer(url, token, { method: "POST", body: "{}" }),
      { params: { missionKey: "urgent_route_lunch" } },
    );
    expect((await errorOf(again)).code).toMatch(/ALREADY|QUOTA/i);

    const seats = await all(
      await getDb(),
      "SELECT joined_count FROM mission_definitions WHERE mission_key = ?",
      ["urgent_route_lunch"],
    );
    expect(Number(seats[0]!.joined_count)).toBe(1);
  });

  // T13
  it("refuses a join from outside the area, and a mocked fix from inside it", async () => {
    await publishMission(
      await asOperations(
        MISSIONS_URL,
        draft({
          audience: {
            segment: "all",
            area: { latitude: 14.5547, longitude: 121.0244, radiusMeters: 500 },
          },
        }),
      ),
    );
    const token = await playerToken();
    const url =
      "http://localhost/api/public/gamification/missions/urgent_route_lunch/join";
    const join = (location: unknown) =>
      joinMissionRoute(
        asPlayer(url, token, { method: "POST", body: JSON.stringify({ location }) }),
        { params: { missionKey: "urgent_route_lunch" } },
      );

    // Quezon City, some 10km north of the pin.
    const faraway = await join({ latitude: 14.6488, longitude: 121.0509 });
    expect((await errorOf(faraway)).code).toMatch(/AREA|ELIGIB/i);

    // Standing on the pin, but the device says the fix is fabricated.
    const mocked = await join({
      latitude: 14.5547,
      longitude: 121.0244,
      mocked: true,
    });
    expect((await errorOf(mocked)).code).toMatch(/AREA|ELIGIB|LOCATION/i);

    // A real fix on the pin joins.
    const inside = await unwrap<{ state: string }>(
      await join({ latitude: 14.5547, longitude: 121.0244, accuracyMeters: 20 }),
    );
    expect(inside.state).toBe("IN_PROGRESS");
  });
});

describe("submitting evidence from the app", () => {
  beforeEach(async () => {
    cookieValues.clear();
    process.env.ADMIN_SESSION_SECRET =
      "test-only-admin-session-secret-with-more-than-32-characters";
    await resetDb();
  });

  /**
   * A campaign needing evidence, joined and then finished, so the instance is
   * sitting in VERIFYING with a person yet to look at it. An urgent mission has
   * no row until somebody joins, so the join is part of the flow rather than
   * setup that could be skipped.
   */
  async function reachVerifying() {
    await publishMission(
      await asOperations(MISSIONS_URL, draft({ requiresProof: true })),
    );
    const token = await playerToken();
    await joinMissionRoute(
      asPlayer(
        "http://localhost/api/public/gamification/missions/urgent_route_lunch/join",
        token,
        { method: "POST", body: "{}" },
      ),
      { params: { missionKey: "urgent_route_lunch" } },
    );
    // The mission's own trigger, delivered the way the till delivers it.
    const { ingestEvent } = await import("@/server/gamification/events");
    await ingestEvent({
      eventName: "qr_redeem",
      phone,
      source: "test",
      partnerId: partner,
      objectId: "v_route_proof",
      idempotencyKey: "qr:route-proof",
    });
    return token;
  }

  const proofUrl =
    "http://localhost/api/public/gamification/missions/urgent_route_lunch/proof";

  // T12
  it("accepts a PNG and holds it for a person to look at", async () => {
    const token = await reachVerifying();

    const submitted = await unwrap<{ proof: { status: string } }>(
      await submitProofRoute(
        asPlayer(proofUrl, token, {
          method: "POST",
          body: JSON.stringify({
            kind: "receipt",
            note: "Table 4, 2:15 PM",
            file: { contentBase64: PIXEL_PNG, contentType: "image/png" },
          }),
        }),
        { params: { missionKey: "urgent_route_lunch" } },
      ),
    );

    expect(submitted.proof.status).toBe("Pending");
    // The picture lives apart from the decision, so a 90-day sweep can take the
    // image without taking the record of why a reward was paid.
    const files = await all(
      await getDb(),
      "SELECT content_type FROM mission_proof_files",
    );
    expect(files).toHaveLength(1);
    expect(String(files[0]!.content_type)).toBe("image/png");
  });

  // T12
  it("refuses a file type that is not on the allowlist", async () => {
    const token = await reachVerifying();

    const response = await submitProofRoute(
      asPlayer(proofUrl, token, {
        method: "POST",
        body: JSON.stringify({
          kind: "photo",
          file: { contentBase64: PIXEL_PNG, contentType: "image/gif" },
        }),
      }),
      { params: { missionKey: "urgent_route_lunch" } },
    );

    expect((await errorOf(response)).message).toMatch(/JPEG, PNG or WebP/i);
    expect(await all(await getDb(), "SELECT id FROM mission_proofs")).toHaveLength(0);
  });

  // T12. Refused before anything is written. The route's schema turns away a
  // string this far past the ceiling before the service ever decodes it, which
  // is the cheaper of the two rejections and the one a 4MB body should meet.
  it("refuses an image past the 2MB cap", async () => {
    const token = await reachVerifying();
    const oversized = "A".repeat(4 * 1024 * 1024);

    const response = await submitProofRoute(
      asPlayer(proofUrl, token, {
        method: "POST",
        body: JSON.stringify({
          kind: "photo",
          file: { contentBase64: oversized, contentType: "image/jpeg" },
        }),
      }),
      { params: { missionKey: "urgent_route_lunch" } },
    );

    expect(response.status).toBeGreaterThanOrEqual(400);
    await errorOf(response);
    expect(await all(await getDb(), "SELECT id FROM mission_proofs")).toHaveLength(0);
    expect(
      await all(await getDb(), "SELECT file_ref FROM mission_proof_files"),
    ).toHaveLength(0);
  });
});
