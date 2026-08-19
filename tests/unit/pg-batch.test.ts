import { describe, expect, it } from "vitest";

import { mergeInserts } from "@/server/pg-batch";

/**
 * Seeding sends ~200 single-row inserts, and every one is a network round trip
 * now that the database is Postgres. Merging them is worth several seconds per
 * test file — but a wrong merge writes the right values into the wrong columns,
 * which no assertion elsewhere would necessarily catch. Hence these.
 */
describe("insert merging", () => {
  const insert = (values: unknown[]) => ({
    text: "INSERT INTO businesses (id, name) VALUES ($1, $2)",
    values,
  });

  it("merges consecutive identical inserts and renumbers each row", () => {
    const merged = mergeInserts([insert(["b1", "One"]), insert(["b2", "Two"])]);
    expect(merged).toHaveLength(1);
    expect(merged[0].text).toBe(
      "INSERT INTO businesses (id, name) VALUES ($1, $2), ($3, $4)",
    );
    expect(merged[0].values).toEqual(["b1", "One", "b2", "Two"]);
  });

  it("keeps a trailing ON CONFLICT clause after the merged rows", () => {
    const withConflict = (values: unknown[]) => ({
      text: "INSERT INTO t (a, b) VALUES ($1, $2) ON CONFLICT DO NOTHING",
      values,
    });
    const merged = mergeInserts([withConflict([1, 2]), withConflict([3, 4])]);
    expect(merged[0].text).toBe(
      "INSERT INTO t (a, b) VALUES ($1, $2), ($3, $4) ON CONFLICT DO NOTHING",
    );
    expect(merged[0].values).toEqual([1, 2, 3, 4]);
  });

  it("does not merge across different statements", () => {
    const other = { text: "INSERT INTO slots (id) VALUES ($1)", values: ["s1"] };
    const merged = mergeInserts([insert(["b1", "One"]), other, insert(["b2", "Two"])]);
    expect(merged).toHaveLength(3);
    expect(merged.map((m) => m.values)).toEqual([["b1", "One"], ["s1"], ["b2", "Two"]]);
  });

  it("refuses to merge when a placeholder is reused", () => {
    // Named binding emits $1 twice when one argument fills two columns. Such a
    // tuple cannot be renumbered by a fixed offset without changing meaning.
    const reused = { text: "INSERT INTO t (a, b) VALUES ($1, $1)", values: ["x"] };
    const merged = mergeInserts([reused, { ...reused, values: ["y"] }]);
    expect(merged).toHaveLength(2);
  });

  it("leaves statements that are not simple inserts alone", () => {
    const select = { text: "SELECT * FROM t WHERE id = $1", values: ["x"] };
    const fromSelect = {
      text: "INSERT INTO t (a) SELECT a FROM other WHERE id = $1",
      values: ["y"],
    };
    const merged = mergeInserts([select, select, fromSelect, fromSelect]);
    expect(merged).toHaveLength(4);
  });

  it("merges a long run into one statement, values in order", () => {
    const rows = Array.from({ length: 50 }, (_, i) => insert([`b${i}`, `Name ${i}`]));
    const merged = mergeInserts(rows);
    expect(merged).toHaveLength(1);
    expect(merged[0].values).toHaveLength(100);
    expect(merged[0].values[0]).toBe("b0");
    expect(merged[0].values[99]).toBe("Name 49");
    // Last row's placeholders continue the numbering rather than restarting.
    expect(merged[0].text.endsWith("($99, $100)")).toBe(true);
  });
});
