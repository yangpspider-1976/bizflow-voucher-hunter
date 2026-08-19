import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDb, resetDb } from "@/server/db";
import {
  generateCandidate,
  getHuntSnapshot,
  listSlotsForAttempt,
  startHunt,
} from "@/server/voucher-engine";

/**
 * Pins the read path the customer's hunt depends on to a transaction.
 *
 * This is not a style rule. Plain reads of `users` and `attempts` have twice
 * been observed returning nothing in production while the rows were provably
 * present — see huntUserIn for the measurements. The failure is invisible to
 * every test that talks to a local file database, because a local read is
 * always consistent, which is exactly why the wrapper has twice been removed
 * again by someone reading the code and seeing a transaction with no writes in
 * it. So assert the mechanism rather than the outcome.
 */
describe("hunt snapshot reads", () => {
  const campaignSlug = "july-dinner";
  const phone = "+639181234571";
  const sessionId = "snapshot-consistency";

  beforeEach(async () => {
    await resetDb();
    vi.restoreAllMocks();
  });

  /**
   * The SQL that went through the plain client rather than a transaction.
   *
   * Takes the recorded calls rather than the spy: `execute` is overloaded
   * (string or statement object), and the spy's type does not narrow to either.
   */
  function plainSql(calls: unknown[][]) {
    return calls.map(([statement]) =>
      typeof statement === "string" ? statement : String((statement as { sql: string }).sql),
    );
  }

  it("takes the whole snapshot off the shared connection", async () => {
    await startHunt({ campaignSlug, phone, sessionId });
    await generateCandidate({ campaignSlug, phone, sessionId });

    const db = await getDb();
    const transaction = vi.spyOn(db, "transaction");
    const execute = vi.spyOn(db, "execute");

    const snapshot = await getHuntSnapshot({ campaignSlug, phone });
    expect(snapshot.attempts).toHaveLength(1);

    // Nothing the customer's hunt depends on may be read through this process's
    // long-lived client — neither plainly nor in a transaction on it. One of
    // those clients was measured serving a view that never caught up, for one
    // route, for over half an hour.
    const shared = plainSql(execute.mock.calls);
    expect(shared.some((sql) => /FROM users/i.test(sql))).toBe(false);
    expect(shared.some((sql) => /FROM attempts/i.test(sql))).toBe(false);
    expect(shared.some((sql) => /FROM vouchers/i.test(sql))).toBe(false);

    // And never by taking the write lock, which is what caused the outage the
    // first time this was fixed.
    expect(transaction).not.toHaveBeenCalledWith("write");
  });

  it("reads the slot picker's candidate the same way", async () => {
    await startHunt({ campaignSlug, phone, sessionId });
    const candidate = await generateCandidate({ campaignSlug, phone, sessionId });

    const db = await getDb();
    const transaction = vi.spyOn(db, "transaction");
    const execute = vi.spyOn(db, "execute");

    // The regression this guards: `huntState` listing an attempt that this call
    // then 404'd on, because the two read through different views.
    const { attempt } = await listSlotsForAttempt({
      campaignSlug,
      phone,
      attemptId: candidate.id,
    });
    expect(attempt.id).toBe(candidate.id);

    expect(transaction).not.toHaveBeenCalledWith("write");
    const shared = plainSql(execute.mock.calls);
    expect(shared.some((sql) => /FROM users/i.test(sql))).toBe(false);
    expect(shared.some((sql) => /FROM attempts/i.test(sql))).toBe(false);
  });

  it("hands back a freshly started hunt through the same view", async () => {
    const state = await startHunt({ campaignSlug, phone, sessionId });
    expect(state.user.phone).toBe(phone);

    const db = await getDb();
    const transaction = vi.spyOn(db, "transaction");
    await startHunt({ campaignSlug, phone, sessionId });
    // The one hunt read that stays on the shared client, and must: it follows
    // this request's own write, so that connection is the one whose view is
    // guaranteed to contain it.
    expect(transaction).toHaveBeenCalledWith("read");
  });
});
