import type { DuckDBAppender, DuckDBConnection } from "@duckdb/node-api";
import { openConnection, queryRows } from "../db/duck.js";
import { parseCsv } from "./csv.js";
import {
  createGameTableSql,
  GAME_TABLES,
  GAMEDATA_META_TABLE,
  GAMEDATA_SCHEMA,
  q,
  type GameTableSpec,
} from "./tables.js";
import { downloadTableCsv, getLatestBuild } from "./wago.js";

export interface GameDataStatus {
  build: string;
  synced_at: string;
}

/** The synced build, or null if game data has never been synced. */
export async function getGameDataStatus(): Promise<GameDataStatus | null> {
  const rows = await queryRows(
    `SELECT build, synced_at FROM ${q(GAMEDATA_SCHEMA)}.${q(GAMEDATA_META_TABLE)} LIMIT 1`,
  ).catch(() => []);
  const row = rows[0];
  return row ? { build: String(row.build), synced_at: String(row.synced_at) } : null;
}

export interface SyncResult {
  status: "up_to_date" | "synced";
  build: string;
  previous_build: string | null;
  tables?: Record<string, number>;
  seconds?: number;
}

let inFlight: Promise<SyncResult> | undefined;

/**
 * Bring the local gamedata schema up to the latest live build. No-op if already
 * on it (unless force). Concurrent callers share one sync.
 */
export function syncGameData(force = false): Promise<SyncResult> {
  if (!inFlight) {
    inFlight = runSync(force).finally(() => {
      inFlight = undefined;
    });
  }
  return inFlight;
}

async function runSync(force: boolean): Promise<SyncResult> {
  const started = Date.now();
  const [build, current] = await Promise.all([getLatestBuild(), getGameDataStatus()]);
  const previous = current?.build ?? null;
  if (!force && previous === build) {
    return { status: "up_to_date", build, previous_build: previous };
  }

  // One transaction on a dedicated connection: a failed download leaves the
  // previous build's data in place. Tables are downloaded and loaded one at a
  // time so only one CSV is held in memory.
  const conn = await openConnection();
  const counts: Record<string, number> = {};
  try {
    await conn.run("BEGIN TRANSACTION");
    await conn.run(`DROP SCHEMA IF EXISTS ${q(GAMEDATA_SCHEMA)} CASCADE`);
    await conn.run(`CREATE SCHEMA ${q(GAMEDATA_SCHEMA)}`);

    for (const [table, spec] of Object.entries(GAME_TABLES)) {
      await conn.run(createGameTableSql(table, spec));
      const csv = await downloadTableCsv(spec.source, build);
      counts[table] = await loadCsv(conn, table, spec, csv);
    }

    // Merge name + text into the single documented `spell` table.
    await conn.run(
      `CREATE TABLE ${q(GAMEDATA_SCHEMA)}.spell AS
       SELECT n.spell_id, n.name, t.subtext, t.description, t.aura_description
       FROM ${q(GAMEDATA_SCHEMA)}.spell_name n
       LEFT JOIN ${q(GAMEDATA_SCHEMA)}.spell_text t USING (spell_id)
       ORDER BY n.spell_id`,
    );
    for (const [table, spec] of Object.entries(GAME_TABLES)) {
      if (spec.staging) {
        await conn.run(`DROP TABLE ${q(GAMEDATA_SCHEMA)}.${q(table)}`);
        delete counts[table];
      }
    }
    const spellCount = await conn.runAndReadAll(
      `SELECT count(*)::INTEGER AS n FROM ${q(GAMEDATA_SCHEMA)}.spell`,
    );
    counts.spell = Number(spellCount.getRowObjects()[0]?.n ?? 0);

    await conn.run(
      `CREATE TABLE ${q(GAMEDATA_SCHEMA)}.${q(GAMEDATA_META_TABLE)} AS
       SELECT $build::VARCHAR AS build, now()::VARCHAR AS synced_at, 'wago.tools'::VARCHAR AS source`,
      { build },
    );
    await conn.run("COMMIT");
  } catch (err) {
    await conn.run("ROLLBACK").catch(() => {
      /* transaction may already be aborted */
    });
    throw err;
  } finally {
    conn.closeSync();
  }

  return {
    status: "synced",
    build,
    previous_build: previous,
    tables: counts,
    seconds: Math.round((Date.now() - started) / 1000),
  };
}

/** Parse a CSV export and append the spec's columns. Returns the row count. */
async function loadCsv(
  conn: DuckDBConnection,
  table: string,
  spec: GameTableSpec,
  csv: string,
): Promise<number> {
  const records = parseCsv(csv);
  const header = records.next().value;
  if (!header) throw new Error(`${spec.source}: empty CSV export.`);

  // Map each spec column to its CSV position by source name.
  const columns = Object.entries(spec.columns).map(([name, c]) => {
    const index = header.indexOf(c.source);
    if (index === -1) {
      throw new Error(
        `${spec.source}: column '${c.source}' (for ${table}.${name}) not in export. ` +
          "The DB2 layout may have changed; update src/gamedata/tables.ts.",
      );
    }
    return { name, type: c.type, index };
  });

  const appender = await conn.createAppender(table, GAMEDATA_SCHEMA);
  let rows = 0;
  try {
    for (const record of records) {
      if (record.length === 1 && record[0] === "") continue; // blank line
      for (const c of columns) appendValue(appender, c.type, record[c.index], spec.source, c.name);
      appender.endRow();
      rows++;
    }
    appender.flushSync();
  } finally {
    appender.closeSync();
  }
  return rows;
}

const INT32_MIN = -(2 ** 31);
const INT32_MAX = 2 ** 31 - 1;

function appendValue(
  appender: DuckDBAppender,
  type: GameTableSpec["columns"][string]["type"],
  raw: string | undefined,
  source: string,
  column: string,
): void {
  if (raw === undefined || raw === "") {
    appender.appendNull();
    return;
  }
  switch (type) {
    case "VARCHAR":
      appender.appendVarchar(raw);
      return;
    case "DOUBLE":
      appender.appendDouble(Number(raw));
      return;
    case "BIGINT":
      appender.appendBigInt(BigInt(raw));
      return;
    case "INTEGER": {
      const n = Number(raw);
      if (!Number.isInteger(n) || n < INT32_MIN || n > INT32_MAX) {
        throw new Error(`${source}.${column}: value ${raw} doesn't fit INTEGER; widen it in tables.ts.`);
      }
      appender.appendInteger(n);
      return;
    }
  }
}
