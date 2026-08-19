import { describe, expect, it } from "vitest";

import { toPositional } from "@/server/pg-driver";

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
