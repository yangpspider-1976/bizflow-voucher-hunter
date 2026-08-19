/**
 * SQLite-dialect SQL, rewritten for PostgreSQL.
 *
 * The app writes every statement in SQLite's dialect and binds with `?` or
 * `@name`; this turns both into what `pg` accepts. It is the one part of the
 * migration where a mistake is silent rather than loud — a misnumbered
 * placeholder binds the right value to the wrong column and the database
 * accepts it happily — so the scanner below is deliberately literal-minded
 * about what it may rewrite.
 *
 * Three regions are off limits, and each one has bitten during this migration:
 *  - string literals: `LIKE '%?%'` is a pattern, not a parameter
 *  - quoted identifiers: `"odd?column"` is a name
 *  - comments: a `--` line containing an apostrophe ("the branch's integer")
 *    would otherwise open a string that never closes, and every placeholder
 *    after it silently stops being rewritten
 */

/** What a handler returns when it claims characters at a position. */
type Claim = { text: string; length: number };

/**
 * Walks SQL, copying it verbatim except where `onCode` claims characters.
 *
 * `onCode` is only ever called on executable code — never inside a string, a
 * quoted identifier, or a comment.
 */
function scan(sql: string, onCode: (index: number) => Claim | null): string {
  let out = "";
  let i = 0;

  while (i < sql.length) {
    const char = sql[i];
    const next = sql[i + 1];

    // Line comment: everything to the newline is prose.
    if (char === "-" && next === "-") {
      const stop = sql.indexOf("\n", i);
      const end = stop === -1 ? sql.length : stop;
      out += sql.slice(i, end);
      i = end;
      continue;
    }

    // Block comment. Postgres nests these and SQLite does not; nothing here
    // relies on nesting, so the first close wins.
    if (char === "/" && next === "*") {
      const stop = sql.indexOf("*/", i + 2);
      const end = stop === -1 ? sql.length : stop + 2;
      out += sql.slice(i, end);
      i = end;
      continue;
    }

    // String literal or quoted identifier. A doubled quote inside one is an
    // escaped quote, not the end of it.
    if (char === "'" || char === '"') {
      out += char;
      i += 1;
      while (i < sql.length) {
        out += sql[i];
        if (sql[i] === char) {
          if (sql[i + 1] === char) {
            out += sql[i + 1];
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }

    const claim = onCode(i);
    if (claim) {
      out += claim.text;
      i += claim.length;
      continue;
    }

    out += char;
    i += 1;
  }

  return out;
}

/** SQLite's `?` becomes PostgreSQL's `$1`, `$2`, … in order of appearance. */
export function toPositional(sql: string): string {
  let index = 0;
  return scan(sql, (at) => {
    if (sql[at] !== "?") return null;
    index += 1;
    return { text: "$" + index, length: 1 };
  });
}

/**
 * Binds `@name` parameters against an object — the other half of libSQL's
 * argument API, and the form every multi-column insert in the app uses.
 *
 * A name used twice reuses its placeholder rather than duplicating the value:
 * Postgres is happy for `$1` to appear as often as it likes.
 */
export function toNamed(
  sql: string,
  args: Record<string, unknown>,
): { text: string; values: unknown[] } {
  const order: string[] = [];

  const text = scan(sql, (at) => {
    if (sql[at] !== "@") return null;
    const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(sql.slice(at + 1))?.[0];
    if (!name || !Object.prototype.hasOwnProperty.call(args, name)) return null;

    let index = order.indexOf(name);
    if (index === -1) {
      order.push(name);
      index = order.length - 1;
    }
    return { text: "$" + (index + 1), length: 1 + name.length };
  });

  return { text, values: order.map((name) => args[name]) };
}

/**
 * Translates the SQLite upsert forms the app uses.
 *
 * `INSERT OR IGNORE` appears 19 times — seeding, backfills, anything that must
 * not double-apply on a retry. Postgres spells it as a clause at the end rather
 * than a verb at the front, so the rewrite is mechanical and lives here instead
 * of being copied into 19 call sites.
 *
 * `INSERT OR REPLACE` is deliberately not translated: it needs a conflict
 * target, which depends on the table, and guessing one upserts against the
 * wrong key. All five uses are on `meta(key, value)` and are written out in
 * full at their call sites.
 */
export function toPostgresDialect(sql: string): string {
  const prefix = "INSERT OR IGNORE INTO";
  const lead = sql.length - sql.trimStart().length;
  if (sql.slice(lead, lead + prefix.length).toUpperCase() !== prefix) return sql;

  const rewritten =
    sql.slice(0, lead) + "INSERT INTO" + sql.slice(lead + prefix.length);
  // A trailing semicolon or whitespace would strand the clause past the end of
  // the statement.
  const trimmed = rewritten.trimEnd();
  const body = trimmed.endsWith(";") ? trimmed.slice(0, -1).trimEnd() : trimmed;
  return body + " ON CONFLICT DO NOTHING";
}
