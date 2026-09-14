import { beforeEach, describe, expect, it, vi } from "vitest";
import { all, one, run } from "@/server/db";
import { listSlotsForAttempt, selectFinalVoucher } from "@/server/voucher-engine";

// Exercise the real listing and booking rules without a database connection.
vi.mock("@/server/db", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/server/db")>(),
  getDb: vi.fn(async () => ({})),
  withFreshReadTx: vi.fn(async (work: (db: object) => unknown) => work({})),
  withTx: vi.fn(async (work: (db: object) => unknown) => work({})),
  one: vi.fn(),
  all: vi.fn(),
  run: vi.fn(),
  mapCampaign: (row: unknown) => row,
  mapUser: (row: unknown) => row,
  mapAttempt: (row: unknown) => row,
  mapSlot: (row: unknown) => row,
}));

const input = { campaignSlug: "test", phone: "+639171234567", attemptId: "attempt" };
const morning = {
  id: "morning", campaignId: "campaign", date: "2026-09-11",
  startTime: "10:00", endTime: "11:00", timezone: "Asia/Manila",
  status: "active", remainingCapacity: 3,
};
const afternoon = { ...morning, id: "afternoon", startTime: "14:00", endTime: "15:00" };

beforeEach(() => {
  vi.clearAllMocks();
  vi.setSystemTime(new Date("2026-09-11T13:30:00+08:00"));
  vi.mocked(one).mockImplementation(async (_db, sql) => {
    if (sql.includes("FROM campaigns")) return { id: "campaign", status: "active" };
    if (sql.includes("FROM users")) return { id: "user", phone: input.phone };
    if (sql.includes("FROM attempts")) return {
      id: "attempt", poolId: "pool", status: "Candidate", expiresAt: "2026-09-12T00:00:00Z",
    };
    if (sql.includes("FROM slots")) return morning;
    return undefined;
  });
  vi.mocked(all).mockImplementation(async (_db, sql) =>
    sql.includes("FROM slots") ? [morning, afternoon, { ...morning, id: "tomorrow", date: "2026-09-12" }] : [],
  );
});

describe("expired booking slots", () => {
  it("omits the expired morning option from the API response", async () => {
    const result = await listSlotsForAttempt(input);
    expect(result.slots.map((slot) => slot.id)).toEqual(["afternoon", "tomorrow"]);
  });

  it("keeps an ongoing slot and removes it on a later request at its end", async () => {
    vi.setSystemTime(new Date("2026-09-11T10:59:59+08:00"));
    expect((await listSlotsForAttempt(input)).slots.map((slot) => slot.id)).toContain("morning");
    vi.setSystemTime(new Date("2026-09-11T11:00:00+08:00"));
    expect((await listSlotsForAttempt(input)).slots.map((slot) => slot.id)).not.toContain("morning");
  });

  it("rejects a stale selection before consuming capacity or issuing a voucher", async () => {
    await expect(selectFinalVoucher({
      ...input, slotId: "morning", sessionId: "session", name: "Test Customer",
    })).rejects.toMatchObject({ code: "E-SLOT-EXPIRED", status: 409 });
    const writes = vi.mocked(run).mock.calls.map((call) => call[1]);
    expect(writes.some((sql) => /UPDATE slots|INSERT INTO vouchers|INSERT INTO reservations/.test(sql))).toBe(false);
  });
});
