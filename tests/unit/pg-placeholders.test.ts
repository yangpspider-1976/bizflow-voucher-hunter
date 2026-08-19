import { describe, expect, it } from "vitest";

import { toNamed, toPositional, toPostgresDialect } from "@/server/pg-driver";

/**
 * SQLite takes `?`; Postgres takes `$1`. Every one of the app's ~300 statements
 * is written in the first dialect and runs through this translation, so a fault
 * here is not a crash — it is arguments silently bound to the wrong columns.
 */
describe("placeholder translation", () => {
  it("numbers placeholders in order", () => {
    expect(
      toPositional("SELECT * FROM attempts WHERE campaign_id = ? AND user_id = ?"),
    ).toBe("SELECT * FROM attempts WHERE campaign_id = $1 AND user_id = $2");
  });

  it("leaves a statement with no placeholders alone", () => {
    expect(toPositional("SELECT 1")).toBe("SELECT 1");
  });

  it("does not touch a question mark inside a string literal", () => {
    // The regression this guards: a naive replace rewrites the literal, and the
    // count drifts, so every later argument binds one column to the left.
    expect(
      toPositional("SELECT * FROM sms_logs WHERE body LIKE '%?%' AND id = ?"),
    ).toBe("SELECT * FROM sms_logs WHERE body LIKE '%?%' AND id = $1");
  });

  it("handles escaped quotes inside a literal", () => {
    expect(toPositional("SELECT 'it''s ok?' , ?")).toBe("SELECT 'it''s ok?' , $1");
  });

  it("does not touch a question mark inside a quoted identifier", () => {
    expect(toPositional('SELECT "odd?column" FROM t WHERE id = ?')).toBe(
      'SELECT "odd?column" FROM t WHERE id = $1',
    );
  });

  it("keeps counting across many placeholders", () => {
    const sql = "INSERT INTO users VALUES (?, ?, ?, ?, ?, ?, ?)";
    expect(toPositional(sql)).toBe(
      "INSERT INTO users VALUES ($1, $2, $3, $4, $5, $6, $7)",
    );
  });
});

/**
 * The regression these exist for: an earlier edit lost the escapes in this
 * function's pattern, so it matched nothing and every `INSERT OR IGNORE` went
 * to Postgres verbatim. Nothing caught it until the database rejected the
 * statement, which is exactly the wrong place to find out.
 */
describe("dialect translation", () => {
  it("moves OR IGNORE to a conflict clause", () => {
    expect(toPostgresDialect("INSERT OR IGNORE INTO businesses (id) VALUES (?)")).toBe(
      "INSERT INTO businesses (id) VALUES (?) ON CONFLICT DO NOTHING",
    );
  });

  it("handles the indented multi-line form the app actually writes", () => {
    const sql = `
      INSERT OR IGNORE INTO reward_business_balances (id, wallet_id)
      VALUES (?, ?)`;
    const out = toPostgresDialect(sql);
    expect(out).toContain("INSERT INTO reward_business_balances");
    expect(out).not.toContain("OR IGNORE");
    expect(out.endsWith("ON CONFLICT DO NOTHING")).toBe(true);
  });

  it("puts the clause after a trailing semicolon rather than beyond it", () => {
    expect(toPostgresDialect("INSERT OR IGNORE INTO t (a) VALUES (?);")).toBe(
      "INSERT INTO t (a) VALUES (?) ON CONFLICT DO NOTHING",
    );
  });

  it("leaves every other statement untouched", () => {
    expect(toPostgresDialect("SELECT * FROM t WHERE a = ?")).toBe(
      "SELECT * FROM t WHERE a = ?",
    );
    // Not an upsert: the words appear, but not as the statement's verb.
    expect(toPostgresDialect("SELECT 'INSERT OR IGNORE INTO' AS s")).toBe(
      "SELECT 'INSERT OR IGNORE INTO' AS s",
    );
  });
});

describe("named parameter binding", () => {
  it("binds @name against an object in first-use order", () => {
    const { text, values } = toNamed(
      "INSERT INTO t (id, name) VALUES (@id, @name)",
      { id: "u1", name: "Jane" },
    );
    expect(text).toBe("INSERT INTO t (id, name) VALUES ($1, $2)");
    expect(values).toEqual(["u1", "Jane"]);
  });

  it("reuses a placeholder when a name appears twice", () => {
    const { text, values } = toNamed(
      "UPDATE t SET a = @v, b = @v WHERE id = @id",
      { v: 7, id: "x" },
    );
    expect(text).toBe("UPDATE t SET a = $1, b = $1 WHERE id = $2");
    expect(values).toEqual([7, "x"]);
  });

  it("does not rewrite an email address inside a string literal", () => {
    // The one that would silently bind a value into a WHERE clause: seeded
    // admin rows are matched by literal address in more than one statement.
    const { text, values } = toNamed(
      "SELECT * FROM admin_users WHERE email = 'admin@bizflow.local' AND id = @id",
      { id: "a1" },
    );
    expect(text).toBe(
      "SELECT * FROM admin_users WHERE email = 'admin@bizflow.local' AND id = $1",
    );
    expect(values).toEqual(["a1"]);
  });
});
