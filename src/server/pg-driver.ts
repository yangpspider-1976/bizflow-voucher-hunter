import { Pool, types, type PoolClient } from "pg";

import { mergeInserts, type BoundStatement } from "@/server/pg-batch";
import { toNamed, toPositional, toPostgresDialect } from "@/server/pg-sql";

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

/** Positional (`?` + array) or named (`@name` + object), as libSQL accepted. */
export type InArgs = unknown[] | Record<string, unknown>;
export type InStatement = string | { sql: string; args?: InArgs };
export type Row = Record<string, unknown>;

export type ResultSet = {
  rows: Row[];
  /** Named for libSQL's field so `run()` keeps returning what callers expect. */
  rowsAffected: number;
};

function split(statement: InStatement): { sql: string; args: InArgs } {
  return typeof statement === "string"
    ? { sql: statement, args: [] }
    : { sql: statement.sql, args: statement.args ?? [] };
}

function bind(statement: InStatement): BoundStatement {
  const { sql, args } = split(statement);
  const dialect = toPostgresDialect(sql);
  return Array.isArray(args)
    ? { text: toPositional(dialect), values: args }
    : toNamed(dialect, args);
}

async function runOn(
  runner: Pool | PoolClient,
  statement: InStatement,
): Promise<ResultSet> {
  const bound = bind(statement);
  const result = await runner.query(bound.text, bound.values);
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
  /**
   * Postgres schema to work in, if not the connection's default.
   *
   * Set per connection rather than per query, because the pool hands out a
   * different backend each time and a `SET` issued once would apply to whichever
   * one happened to run it.
   */
  schema?: string;
  /** Accepted for call-compatibility with libSQL; Postgres auth is in the URL. */
  authToken?: string;
  max?: number;
};

export function createClient(config: PgClientConfig): Client {
  // Interpolated, not bound: an identifier cannot be a parameter. Constrained
  // to a plain identifier so it cannot carry anything else into the statement.
  const schema = config.schema?.trim();
  if (schema && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(schema)) {
    throw new Error(`Invalid database schema name: ${schema}`);
  }

  // A test run is one process importing the database module once per file, so
  // the pools accumulate: 48 files holding three idle sockets each exhausted the
  // connection limit and 16 tests failed on acquisition rather than on anything
  // they asserted. Tests therefore keep one connection and drop it quickly.
  const testing = Boolean(process.env.VITEST);

  const pool = new Pool({
    connectionString: config.url,
    // Serverless invocations are short and numerous, and a pooler (or Postgres
    // itself) refuses connections long before the app notices. Keep each
    // instance's footprint small and let idle sockets go.
    max: config.max ?? (testing ? 1 : 3),
    idleTimeoutMillis: testing ? 1_000 : 10_000,
    // Generous on purpose: a database that scales to zero answers its first
    // connection with a cold start, and failing that is worse than waiting.
    connectionTimeoutMillis: 30_000,
  });

  // An idle client erroring (a pooler recycling it, a network blip) emits on the
  // pool. Unhandled, that is an uncaught exception that takes the process down.
  if (schema) {
    // Queries on a given client are serialised, so this lands before anything
    // the caller sends on the same connection.
    pool.on("connect", (client) => {
      void client.query(`SET search_path TO ${schema}`);
    });
  }

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
        // Merging is confined to write batches, and that is a correctness
        // boundary rather than a heuristic: merging returns one result per
        // merged group instead of one per statement. Every write caller in the
        // app discards the return; `batchAll` is the only consumer and it reads,
        // destructuring the array positionally — misaligning that would hand a
        // dashboard one rollup's rows under another's name.
        const prepared = statements.map(bind);
        const sending = mode === "write" ? mergeInserts(prepared) : prepared;
        for (const bound of sending) {
          const result = await client.query(bound.text, bound.values);
          results.push({
            rows: (result.rows ?? []) as Row[],
            rowsAffected: result.rowCount ?? 0,
          });
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
