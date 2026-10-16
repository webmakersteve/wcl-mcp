import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DuckDBConnection, DuckDBInstance } from "@duckdb/node-api";
import { getConfig } from "../config.js";

let instancePromise: Promise<DuckDBInstance> | undefined;
let connectionPromise: Promise<DuckDBConnection> | undefined;

/**
 * Lazily open (once) the single persistent DuckDB file. The parent directory is
 * created if needed. External access is disabled so SQL can't touch the
 * filesystem or network (read_text, read_csv, glob, ATTACH, INSTALL, ...); the
 * json extension used for fight_events.raw is built into the node bindings.
 */
function getInstance(): Promise<DuckDBInstance> {
  if (!instancePromise) {
    instancePromise = (async () => {
      const { dbPath } = getConfig();
      mkdirSync(dirname(dbPath), { recursive: true });
      return DuckDBInstance.create(dbPath, { enable_external_access: "false" });
    })();
  }
  return instancePromise;
}

/** Shared connection for short, stateless statements. */
export function getConnection(): Promise<DuckDBConnection> {
  if (!connectionPromise) {
    connectionPromise = getInstance().then((instance) => instance.connect());
  }
  return connectionPromise;
}

/**
 * Open a dedicated connection for work that holds connection-local state
 * (a transaction, a search_path). Caller must closeSync() it when done.
 */
export async function openConnection(): Promise<DuckDBConnection> {
  const instance = await getInstance();
  return instance.connect();
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
