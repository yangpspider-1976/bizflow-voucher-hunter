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

  it("takes the whole snapshot from one read transaction", async () => {
    await startHunt({ campaignSlug, phone, sessionId });
    await generateCandidate({ campaignSlug, phone, sessionId });

    const db = await getDb();
    const transaction = vi.spyOn(db, "transaction");
    const execute = vi.spyOn(db, "execute");

    const snapshot = await getHuntSnapshot({ campaignSlug, phone });
    expect(snapshot.attempts).toHaveLength(1);

    // A read transaction, never a write one: the write lock on a path this hot
    // is what took production down when this was first attempted.
    expect(transaction).toHaveBeenCalledWith("read");
    expect(transaction).not.toHaveBeenCalledWith("write");

    // The identity and the rows it scopes must not be read off the plain
    // client, where they can disagree with the write path and with each other.
    const plain = plainSql(execute.mock.calls);
    expect(plain.some((sql) => /FROM users/i.test(sql))).toBe(false);
    expect(plain.some((sql) => /FROM attempts/i.test(sql))).toBe(false);
    expect(plain.some((sql) => /FROM vouchers/i.test(sql))).toBe(false);
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

    expect(transaction).toHaveBeenCalledWith("read");
    const plain = plainSql(execute.mock.calls);
    expect(plain.some((sql) => /FROM users/i.test(sql))).toBe(false);
    expect(plain.some((sql) => /FROM attempts/i.test(sql))).toBe(false);
  });

  it("hands back a freshly started hunt through the same view", async () => {
    const state = await startHunt({ campaignSlug, phone, sessionId });
    expect(state.user.phone).toBe(phone);

    const db = await getDb();
    const transaction = vi.spyOn(db, "transaction");
    await startHunt({ campaignSlug, phone, sessionId });
    // The write commits first, then the snapshot is read back — a plain read
    // there is what returned a user the client had just created and could not
    // then find.
    expect(transaction).toHaveBeenCalledWith("read");
  });
});
