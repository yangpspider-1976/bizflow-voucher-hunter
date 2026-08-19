import { Pool, types, type PoolClient } from "pg";

/**
 * A libSQL-shaped client backed by PostgreSQL.
 *
 * The app has ~300 SQL statements across 15 server modules, and every one of
 * them goes through `all`/`one`/`run`/`withTx` in `db.ts` rather than touching a
 * client directly. That funnel is what makes swapping the engine a driver
 * change instead of a rewrite: this module presents the same `execute`/`batch`/
 * `transaction` surface libSQL did, so those helpers — and the call sites above
 * them — do not move.
 *
 * What genuinely differs between the two engines is handled here (placeholders)
 * or at the statement (`INSERT OR IGNORE`, `PRAGMA`), never at the call site.
 */

/** int8 arrives as a string by default, which would turn balances into "1200". */
types.setTypeParser(types.builtins.INT8, (value) => Number(value));
/** numeric likewise; every numeric column here is money in centavos or a count. */
types.setTypeParser(types.builtins.NUMERIC, (value) => Number(value));

export type InArgs = unknown[];
export type InStatement = string | { sql: string; args?: InArgs };
export type Row = Record<string, unknown>;

export type ResultSet = {
  rows: Row[];
  /** Named for libSQL's field so `run()` keeps returning what callers expect. */
  rowsAffected: number;
};

/**
 * Rewrites SQLite's positional `?` into PostgreSQL's `$1`, `$2`, …
 *
 * Quote-aware on purpose. A naive replace corrupts any statement holding a
 * literal question mark — `LIKE '%?%'`, a message template, a URL — and the
 * corruption is silent until that row is read back wrong.
 */
export function toPositional(sql: string): string {
  let out = "";
  let index = 0;
  let quote: string | null = null;

  for (let i = 0; i < sql.length; i += 1) {
    const char = sql[i];

    if (quote) {
      out += char;
      // '' and "" are escaped quotes inside a literal, not the end of one.
      if (char === quote) {
        if (sql[i + 1] === quote) {
          out += sql[i + 1];
          i += 1;
        } else {
          quote = null;
        }
      }
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      out += char;
      continue;
    }

    if (char === "?") {
      index += 1;
      out += `$${index}`;
      continue;
    }

    out += char;
  }

  return out;
}

function split(statement: InStatement): { sql: string; args: InArgs } {
  return typeof statement === "string"
    ? { sql: statement, args: [] }
    : { sql: statement.sql, args: statement.args ?? [] };
}

async function runOn(
  runner: Pool | PoolClient,
  statement: InStatement,
): Promise<ResultSet> {
  const { sql, args } = split(statement);
  const result = await runner.query(toPositional(sql), args as unknown[]);
  return {
    rows: (result.rows ?? []) as Row[],
    // Postgres reports null for statements that affect nothing measurable.
    rowsAffected: result.rowCount ?? 0,
  };
}

export interface Transaction {
  execute(statement: InStatement): Promise<ResultSet>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  /** Idempotent, so it is safe in a `finally` whether the body threw or not. */
  close(): void;
}

export interface Client {
  execute(statement: InStatement): Promise<ResultSet>;
  batch(statements: InStatement[], mode?: "read" | "write"): Promise<ResultSet[]>;
  executeMultiple(sql: string): Promise<void>;
  transaction(mode?: "read" | "write"): Promise<Transaction>;
  close(): Promise<void>;
}

export type PgClientConfig = {
  url: string;
  /** Accepted for call-compatibility with libSQL; Postgres auth is in the URL. */
  authToken?: string;
  max?: number;
};

export function createClient(config: PgClientConfig): Client {
  const pool = new Pool({
    connectionString: config.url,
    // Serverless invocations are short and numerous, and a pooler (or Postgres
    // itself) will refuse connections long before the app notices. Keep each
    // instance's footprint small and let idle sockets go.
    max: config.max ?? 3,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000,
  });

  // An idle client erroring (a pooler recycling it, a network blip) emits on the
  // pool. Unhandled, that is an uncaught exception that takes the process down.
  pool.on("error", () => {
    // Deliberately swallowed: the pool discards the socket and the next query
    // takes a fresh one. Nothing here is worth crashing a request for.
  });

  return {
    execute: (statement) => runOn(pool, statement),

    /**
     * Independent statements in one round trip. libSQL's version was one network
     * call; here each is a query on the same pooled connection, which keeps the
     * saving that matters (one connection checkout, no per-statement handshake)
     * without pretending to atomicity `batch` never had.
     */
    async batch(statements, mode = "read") {
      const client = await pool.connect();
      try {
        if (mode === "write") await client.query("BEGIN");
        const results: ResultSet[] = [];
        for (const statement of statements) {
          results.push(await runOn(client, statement));
        }
        if (mode === "write") await client.query("COMMIT");
        return results;
      } catch (error) {
        if (mode === "write") {
          try {
            await client.query("ROLLBACK");
          } catch {
            // The original error is the useful one.
          }
        }
        throw error;
      } finally {
        client.release();
      }
    },

    /** Multi-statement DDL. Postgres runs a simple query with several bodies. */
    async executeMultiple(sql) {
      const client = await pool.connect();
      try {
        await client.query(sql);
      } finally {
        client.release();
      }
    },

    async transaction(mode = "write") {
      const client = await pool.connect();
      let settled = false;
      const release = () => {
        if (settled) return;
        settled = true;
        client.release();
      };

      try {
        // READ ONLY is not a formality: it makes the read paths incapable of
        // taking row locks, which is what the hunt snapshot needs.
        await client.query(mode === "read" ? "BEGIN READ ONLY" : "BEGIN");
      } catch (error) {
        release();
        throw error;
      }

      return {
        execute: (statement) => runOn(client, statement),
        async commit() {
          try {
            await client.query("COMMIT");
          } finally {
            release();
          }
        },
        async rollback() {
          try {
            await client.query("ROLLBACK");
          } finally {
            release();
          }
        },
        close() {
          // Matches libSQL's `close()`: end the transaction without committing.
          if (settled) return;
          void client.query("ROLLBACK").catch(() => undefined).finally(release);
        },
      };
    },

    close: () => pool.end(),
  };
}
