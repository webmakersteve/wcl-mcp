import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { DuckDBConnection, DuckDBInstance } from "@duckdb/node-api";
import { getConfig } from "../config.js";

// Locking model. DuckDB locks the file per process: any number of processes can hold it
// read-only, or one process can hold it read-write, never both. Several MCP servers (one per
// Claude Code session) share the file, so this process holds the lock only while it needs it:
//
// - Reads use a READ_ONLY instance, closed as soon as no read is in flight (reopening costs
//   ~5 ms), so a steady stream of queries leaves gaps for another process to take the write lock.
// - Writes open a READ_WRITE instance, run, and close it. Slow work (network fetches) is staged
//   into a private scratch file first (stageThenWrite), so the write lock covers only the copy.
// - Opening waits out another process's conflicting lock, up to lockTimeoutMs.
//
// Within this process, writes are serialized and a write waits for in-flight reads to finish;
// reads started meanwhile wait for the write. Don't call read/queryRows inside a write
// callback (it deadlocks); use the write connection.

const RETRY_MIN_MS = 50;
const RETRY_MAX_MS = 1_000;
/** Attach name of the scratch database inside a stageThenWrite apply callback. */
export const STAGING_DB = "staging";
const STAGING_PREFIX = ".staging-";

let readInstance: Promise<DuckDBInstance> | undefined;
let activeReads = 0;
let readsDrained: (() => void) | undefined;
/** The last queued write; reads wait for it. */
let writing: Promise<unknown> | undefined;
let writeQueue: Promise<unknown> = Promise.resolve();

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function isLockConflict(err: unknown): boolean {
  return err instanceof Error && err.message.includes("Could not set lock on file");
}

/** Open the database file, retrying while another process holds a conflicting lock. */
async function openInstance(options: Record<string, string>): Promise<DuckDBInstance> {
  const { dbPath, lockTimeoutMs } = getConfig();
  const deadline = Date.now() + lockTimeoutMs;
  let delay = RETRY_MIN_MS;
  for (;;) {
    try {
      return await DuckDBInstance.create(dbPath, options);
    } catch (err) {
      if (!isLockConflict(err)) throw err;
      if (Date.now() >= deadline) {
        throw new Error(
          `Timed out after ${Math.round(lockTimeoutMs / 1000)}s waiting for the database lock ` +
            `(another wcl-mcp process is using ${dbPath}; raise WCL_DB_LOCK_TIMEOUT_SECONDS ` +
            `to wait longer): ${(err as Error).message}`,
        );
      }
      await sleep(delay);
      delay = Math.min(delay * 2, RETRY_MAX_MS);
    }
  }
}

async function closeReadInstance(): Promise<void> {
  const instance = readInstance;
  readInstance = undefined;
  (await instance?.catch(() => undefined))?.closeSync();
}

/** A READ_ONLY open fails on a missing file, so create it first. */
async function ensureDbFile(): Promise<void> {
  if (!existsSync(getConfig().dbPath)) await write(async () => {});
}

/** Run a query on `conn` and return rows as JSON-friendly objects keyed by column name. */
export async function readRows(
  conn: DuckDBConnection,
  sql: string,
  values?: Record<string, unknown>,
): Promise<Record<string, unknown>[]> {
  const reader = await conn.runAndReadAll(sql, values as never);
  return reader.getRowObjectsJson() as Record<string, unknown>[];
}

/**
 * Run `fn` on a dedicated read-only connection (closed afterwards), so it can hold
 * connection-local state like a search_path. External access is disabled so SQL can't touch
 * the filesystem or network (read_text, read_csv, glob, ATTACH, INSTALL, ...); the json
 * extension used for fight_events.raw is built into the node bindings.
 */
export async function read<T>(fn: (conn: DuckDBConnection) => Promise<T>): Promise<T> {
  await ensureDbFile();
  while (writing) await writing.catch(() => {});
  activeReads++;
  try {
    if (!readInstance) {
      const opening = openInstance({ access_mode: "READ_ONLY", enable_external_access: "false" });
      readInstance = opening;
      // Don't cache a failed open (e.g. a lock wait that timed out); the next read retries.
      opening.catch(() => {
        if (readInstance === opening) readInstance = undefined;
      });
    }
    const conn = await (await readInstance).connect();
    try {
      return await fn(conn);
    } finally {
      conn.closeSync();
    }
  } finally {
    if (--activeReads === 0) {
      readsDrained?.();
      readsDrained = undefined;
      await closeReadInstance();
    }
  }
}

/**
 * Run `fn` holding the write lock: opens the file read-write (waiting for other processes to
 * release it), runs, and closes it again. Keep `fn` short — other processes can't read meanwhile.
 * External access stays enabled here (only our own SQL runs on this connection) so
 * stageThenWrite can ATTACH its scratch file.
 */
export function write<T>(fn: (conn: DuckDBConnection) => Promise<T>): Promise<T> {
  const run = writeQueue.then(async () => {
    // Let this process's in-flight reads finish, then release its read lock.
    while (activeReads > 0) await new Promise<void>((resolve) => (readsDrained = resolve));
    await closeReadInstance();
    mkdirSync(dirname(getConfig().dbPath), { recursive: true });
    const instance = await openInstance({});
    try {
      const conn = await instance.connect();
      try {
        return await fn(conn);
      } finally {
        conn.closeSync();
      }
    } finally {
      instance.closeSync();
    }
  });
  writing = run;
  writeQueue = run.catch(() => {});
  const settled = () => {
    if (writing === run) writing = undefined;
  };
  run.then(settled, settled);
  return run;
}

/**
 * Build data in a private scratch database without any lock on the main file (so slow network
 * fetches don't block other processes), then run `apply` under the write lock with the scratch
 * database attached read-only as STAGING_DB. The scratch file is deleted afterwards.
 */
export async function stageThenWrite<T>(
  stage: (conn: DuckDBConnection) => Promise<void>,
  apply: (conn: DuckDBConnection) => Promise<T>,
): Promise<T> {
  const dir = dirname(getConfig().dbPath);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${STAGING_PREFIX}${process.pid}-${randomUUID()}.duckdb`);
  try {
    const instance = await DuckDBInstance.create(path);
    try {
      const conn = await instance.connect();
      try {
        await stage(conn);
      } finally {
        conn.closeSync();
      }
    } finally {
      instance.closeSync();
    }
    return await write(async (conn) => {
      await conn.run(`ATTACH '${path.replaceAll("'", "''")}' AS ${STAGING_DB} (READ_ONLY)`);
      try {
        return await apply(conn);
      } finally {
        await conn.run(`DETACH ${STAGING_DB}`);
      }
    });
  } finally {
    rmSync(path, { force: true });
    rmSync(`${path}.wal`, { force: true });
  }
}

/**
 * Within a stageThenWrite apply callback: replace `schema` in the main database with the staged
 * copy of it, every table, in one transaction.
 */
export async function replaceSchemaFromStaging(conn: DuckDBConnection, schema: string): Promise<void> {
  const ident = `"${schema.replaceAll('"', '""')}"`;
  const tables = await readRows(
    conn,
    "SELECT table_name FROM duckdb_tables() WHERE database_name = $db AND schema_name = $schema",
    { db: STAGING_DB, schema },
  );
  await conn.run("BEGIN TRANSACTION");
  try {
    await conn.run(`DROP SCHEMA IF EXISTS ${ident} CASCADE`);
    await conn.run(`CREATE SCHEMA ${ident}`);
    for (const { table_name } of tables) {
      const table = `"${String(table_name).replaceAll('"', '""')}"`;
      await conn.run(`CREATE TABLE ${ident}.${table} AS SELECT * FROM ${STAGING_DB}.${ident}.${table}`);
    }
    await conn.run("COMMIT");
  } catch (err) {
    await conn.run("ROLLBACK").catch(() => {
      /* transaction may already be aborted */
    });
    throw err;
  }
}

/** Delete scratch files left by processes that died mid-stage. */
export function removeStaleStagingFiles(): void {
  const dir = dirname(getConfig().dbPath);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const pid = Number(name.slice(STAGING_PREFIX.length).split("-")[0]);
    if (!name.startsWith(STAGING_PREFIX) || !Number.isInteger(pid) || isAlive(pid)) continue;
    rmSync(join(dir, name), { force: true });
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Run a read-only query and return rows as JSON-friendly objects keyed by column name.
 * Uses getRowObjectsJson so non-primitive DuckDB types (DECIMAL, dates, etc.)
 * render as clean JSON values rather than internal representations.
 */
export function queryRows(
  sql: string,
  values?: Record<string, unknown>,
): Promise<Record<string, unknown>[]> {
  return read((conn) => readRows(conn, sql, values));
}
