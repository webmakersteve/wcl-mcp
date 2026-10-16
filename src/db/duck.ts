import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DuckDBConnection, DuckDBInstance } from "@duckdb/node-api";
import { getConfig } from "../config.js";

let connectionPromise: Promise<DuckDBConnection> | undefined;

/**
 * Lazily open (once) the single persistent DuckDB file and return a shared connection.
 * The parent directory is created if needed. The `json` extension is loaded so the
 * fight_events.raw text column can be queried with JSON functions.
 */
export function getConnection(): Promise<DuckDBConnection> {
  if (!connectionPromise) {
    connectionPromise = (async () => {
      const { dbPath } = getConfig();
      const absPath = resolve(process.cwd(), dbPath);
      mkdirSync(dirname(absPath), { recursive: true });
      const instance = await DuckDBInstance.create(absPath);
      const connection = await instance.connect();
      await connection.run("INSTALL json; LOAD json;").catch(() => {
        /* json is built-in on most builds; ignore if already present */
      });
      return connection;
    })();
  }
  return connectionPromise;
}

/** Run a statement with no result handling. */
export async function run(
  sql: string,
  values?: Record<string, unknown>,
): Promise<void> {
  const conn = await getConnection();
  await conn.run(sql, values as never);
}

/**
 * Run a query and return rows as JSON-friendly objects keyed by column name.
 * Uses getRowObjectsJson so non-primitive DuckDB types (DECIMAL, dates, etc.)
 * render as clean JSON values rather than internal representations.
 */
export async function queryRows(
  sql: string,
  values?: Record<string, unknown>,
): Promise<Record<string, unknown>[]> {
  const conn = await getConnection();
  const reader = await conn.runAndReadAll(sql, values as never);
  return reader.getRowObjectsJson() as Record<string, unknown>[];
}
