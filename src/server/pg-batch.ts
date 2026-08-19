/**
 * Collapses a run of identical single-row inserts into one multi-row insert.
 *
 * Seeding is the motivating case and the reason this exists at all. `resetDb()`
 * empties every table and re-seeds, `init()` calls it on a fresh database, and
 * the seed is ~200 inserts — against SQLite that was a local write each and
 * effectively free, but every one is now a network round trip. At ~40ms from
 * Manila to Singapore that is eight seconds of latency before a single
 * assertion runs, and it is paid again by every test file and by a production
 * cold start against an empty database.
 *
 * Merging is deliberately conservative. It only touches consecutive statements
 * that are textually identical, whose VALUES tuple uses each placeholder once
 * in ascending order, and whose argument count matches that tuple. Anything
 * else — a reused placeholder, a SELECT-driven insert, a different statement
 * mixed in — passes through untouched, because a wrong merge would write the
 * right values into the wrong columns and no test would necessarily notice.
 */

export type BoundStatement = { text: string; values: unknown[] };

/**
 * Postgres refuses a statement carrying more than 65535 parameters. Stay well
 * under it: a merged insert is a latency optimisation, not a size contest, and
 * the gain is almost entirely in the first few hundred rows.
 */
const MAX_PARAMETERS = 20_000;

/** Splits an insert into the part before VALUES, its tuple, and what follows. */
function parseInsert(text: string): { head: string; tuple: string; tail: string } | null {
  const match = /^(\s*INSERT\s+INTO\s+[\s\S]*?VALUES\s*)\(([\s\S]*)\)(\s*ON\s+CONFLICT[\s\S]*)?$/i.exec(
    text.trim(),
  );
  if (!match) return null;
  return { head: match[1], tuple: match[2], tail: match[3] ?? "" };
}

/**
 * True when the tuple's placeholders are exactly $1..$n, each used once, in
 * order — the only shape whose rows can be renumbered by a fixed offset.
 */
function isSimpleTuple(tuple: string, parameterCount: number): boolean {
  const found = tuple.match(/\$\d+/g);
  if (!found || found.length !== parameterCount) return false;
  return found.every((token, index) => token === `$${index + 1}`);
}

/** Renumbers a tuple's placeholders by `offset`, so row two starts at $k+1. */
function shiftTuple(tuple: string, offset: number): string {
  return tuple.replace(/\$(\d+)/g, (_, digits: string) => `$${Number(digits) + offset}`);
}

export function mergeInserts(statements: BoundStatement[]): BoundStatement[] {
  const merged: BoundStatement[] = [];
  let index = 0;

  while (index < statements.length) {
    const current = statements[index];
    const parsed = parseInsert(current.text);

    if (!parsed || !isSimpleTuple(parsed.tuple, current.values.length)) {
      merged.push(current);
      index += 1;
      continue;
    }

    const width = current.values.length;
    // A parameterless insert cannot be renumbered into distinct rows, and
    // merging it would collapse several rows into one.
    if (width === 0) {
      merged.push(current);
      index += 1;
      continue;
    }

    const tuples = [`(${parsed.tuple})`];
    const values = [...current.values];
    let next = index + 1;

    while (
      next < statements.length &&
      statements[next].text === current.text &&
      statements[next].values.length === width &&
      values.length + width <= MAX_PARAMETERS
    ) {
      tuples.push(`(${shiftTuple(parsed.tuple, values.length)})`);
      values.push(...statements[next].values);
      next += 1;
    }

    merged.push(
      tuples.length === 1
        ? current
        : { text: `${parsed.head}${tuples.join(", ")}${parsed.tail}`, values },
    );
    index = next;
  }

  return merged;
}
