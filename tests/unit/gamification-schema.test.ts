import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Structural checks on the schema DDL in `src/server/db.ts`.
 *
 * That template literal is executed with `executeMultiple` on the first request
 * a cold process serves, before anything else runs. A statement that does not
 * parse does not fail one feature — it fails boot, for the whole app, on the
 * deploy that introduced it. Nothing between writing it and shipping it looks
 * at it, because the integration suite needs a Postgres this repo does not have
 * locally.
 *
 * So this reads the source as text and checks the shape: balanced parentheses,
 * one statement per `;`, no table declared twice, every foreign key pointing at
 * a table that exists, and every table present in the wipe list that the schema
 * reset walks. It is not a SQL parser and does not pretend to be. It catches
 * the class of mistake that has actually happened — a missing bracket, a
 * duplicated name, a new table nobody added to `DATA_TABLES`.
 */

const source = readFileSync(
  path.join(process.cwd(), "src", "server", "db.ts"),
  "utf8",
);

/** The DDL exactly as `executeMultiple` receives it. */
function schemaSql() {
  const start = source.indexOf("const SCHEMA = `");
  expect(start).toBeGreaterThan(-1);
  const from = start + "const SCHEMA = `".length;
  const end = source.indexOf("\n`;", from);
  expect(end).toBeGreaterThan(from);
  return source.slice(from, end);
}

/** The tables the schema reset empties, in the order it empties them. */
function dataTables() {
  const start = source.indexOf("const DATA_TABLES = [");
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf("\n];", start);
  const body = source.slice(start, end);
  return [...body.matchAll(/"([a-z_]+)"/g)].map((match) => match[1]!);
}

/** Comments and string literals removed, so structure can be counted. */
function stripped(sql: string) {
  return sql
    .replace(/--[^\n]*/g, "")
    .replace(/'(?:[^']|'')*'/g, "''");
}

/** Statements, split on the semicolons that are not inside a literal. */
function statements(sql: string) {
  return stripped(sql)
    .split(";")
    .map((statement) => statement.trim())
    .filter(Boolean);
}

describe("schema DDL", () => {
  const sql = schemaSql();
  const parts = statements(sql);

  it("contains only CREATE statements", () => {
    for (const statement of parts) {
      expect(statement.startsWith("CREATE"), `not a CREATE: ${statement.slice(0, 60)}`).toBe(
        true,
      );
    }
  });

  it("balances parentheses in every statement", () => {
    for (const statement of parts) {
      const open = (statement.match(/\(/g) ?? []).length;
      const close = (statement.match(/\)/g) ?? []).length;
      expect(open, `unbalanced: ${statement.slice(0, 60)}`).toBe(close);
    }
  });

  it("has no trailing comma before a closing bracket", () => {
    // `foo TEXT,\n)` is the single most common way to break this file.
    for (const statement of parts) {
      expect(/,\s*\)/.test(statement), `trailing comma: ${statement.slice(0, 60)}`).toBe(false);
    }
  });

  it("declares no table twice", () => {
    const names = [...sql.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map(
      (match) => match[1]!,
    );
    expect(new Set(names).size).toBe(names.length);
  });

  it("declares no index twice", () => {
    const names = [...sql.matchAll(/CREATE (?:UNIQUE )?INDEX IF NOT EXISTS (\w+)/g)].map(
      (match) => match[1]!,
    );
    expect(new Set(names).size).toBe(names.length);
  });

  it("points every foreign key at a table the schema creates", () => {
    const tables = new Set(
      [...sql.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map((match) => match[1]!),
    );
    const references = [...stripped(sql).matchAll(/REFERENCES\s+(\w+)\s*\(/g)].map(
      (match) => match[1]!,
    );
    expect(references.length).toBeGreaterThan(0);
    for (const target of references) {
      expect(tables.has(target), `REFERENCES ${target}, which is not declared`).toBe(true);
    }
  });

  it("indexes only tables the schema creates", () => {
    const tables = new Set(
      [...sql.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map((match) => match[1]!),
    );
    const indexed = [
      ...sql.matchAll(/CREATE (?:UNIQUE )?INDEX IF NOT EXISTS \w+\s+ON (\w+)/g),
    ].map((match) => match[1]!);
    for (const table of indexed) {
      expect(tables.has(table), `index on ${table}, which is not declared`).toBe(true);
    }
  });

  it("empties every table it creates when the schema version is bumped", () => {
    // A table missing from DATA_TABLES survives a reset with stale rows in it,
    // and if it references one that does not, the reset fails on a foreign key.
    const tables = [...sql.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map(
      (match) => match[1]!,
    );
    const wiped = new Set(dataTables());
    // Two tables are kept on purpose and say so in the schema: `meta` holds the
    // schema version the reset is deciding on, and `admin_users` holds real
    // console credentials that a version bump has no business deleting.
    const kept = new Set(["meta", "admin_users"]);
    for (const table of tables) {
      if (kept.has(table)) continue;
      expect(wiped.has(table), `${table} is never emptied by the schema reset`).toBe(true);
    }
  });

  it("empties referencing tables before the ones they reference", () => {
    const order = dataTables();
    const position = new Map(order.map((table, index) => [table, index]));
    const bodies = [...sql.matchAll(/CREATE TABLE IF NOT EXISTS (\w+) \(([\s\S]*?)\n\);/g)];

    for (const [, table, body] of bodies) {
      const from = position.get(table!);
      if (from === undefined) continue;
      for (const match of stripped(body!).matchAll(/REFERENCES\s+(\w+)\s*\(/g)) {
        const target = match[1]!;
        if (target === table) continue; // Self-reference: order cannot help.
        const to = position.get(target);
        if (to === undefined) continue;
        expect(
          from,
          `${table} references ${target} but is emptied after it`,
        ).toBeLessThan(to);
      }
    }
  });

  it("still carries the tables Phase 2 and Phase 3 added", () => {
    // A guard against a bad merge quietly dropping them: nothing else in the
    // suite runs without a database, so their absence would only surface in
    // production.
    for (const table of ["mission_proofs", "mission_proof_files", "fraud_signals"]) {
      expect(sql).toContain(`CREATE TABLE IF NOT EXISTS ${table} (`);
    }
  });
});
