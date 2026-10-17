/**
 * DuckDB persistence for imported combat logs: per-report seed tables (same layout as WCL
 * downloads) plus shared ingest state in the `local_logs` schema.
 *
 * Several wcl-mcp processes (one per session) can watch the same directory. Each commit runs
 * under the write lock and only applies if the stored offset is still the one the import
 * started from, so two processes never both append the same fights.
 */
import { basename } from "node:path";
import type { DuckDBConnection } from "@duckdb/node-api";
import { appendNullableBigInt, appendNullableInt } from "../db/append.js";
import { big, queryRows, readRows, write } from "../db/duck.js";
import { quotedSchema, schemaExists, schemaName, SCHEMA_VERSION } from "../db/schema.js";
import { createSeedTables } from "../db/seeds.js";
import type { ActorRow, LogParser, Segment } from "./parser.js";

export const LOCAL_SCHEMA = "local_logs";

/** Lifecycle of an imported file. */
export type IngestStatus = "active" | "complete" | "ignored";

export interface IngestRow {
  report_code: string;
  path: string;
  file_size: number;
  byte_offset: number;
  schema_version: number;
  status: IngestStatus;
  updated_at: number;
}

let ensured: Promise<void> | undefined;

/** Create the shared ingest-state tables (once per process; skips the write lock if present). */
export function ensureLocalTables(): Promise<void> {
  ensured ??= (async () => {
    const existing = await queryRows(
      "SELECT count(*) AS n FROM information_schema.tables WHERE table_schema = $schema",
      { schema: LOCAL_SCHEMA },
    );
    if (Number(existing[0]?.n) >= 2) return;
    await write(async (conn) => {
      await conn.run(`CREATE SCHEMA IF NOT EXISTS ${LOCAL_SCHEMA}`);
      await conn.run(
        `CREATE TABLE IF NOT EXISTS ${LOCAL_SCHEMA}.watched_dirs (
           path VARCHAR PRIMARY KEY, added_at BIGINT NOT NULL, enabled BOOLEAN NOT NULL)`,
      );
      await conn.run(
        `CREATE TABLE IF NOT EXISTS ${LOCAL_SCHEMA}.ingest_files (
           report_code VARCHAR PRIMARY KEY, path VARCHAR NOT NULL, file_size BIGINT NOT NULL,
           byte_offset BIGINT NOT NULL, schema_version INTEGER NOT NULL, status VARCHAR NOT NULL,
           updated_at BIGINT NOT NULL)`,
      );
    });
  })().catch((err) => {
    ensured = undefined;
    throw err;
  });
  return ensured;
}

export async function getIngest(code: string): Promise<IngestRow | null> {
  await ensureLocalTables();
  const rows = await queryRows(`SELECT * FROM ${LOCAL_SCHEMA}.ingest_files WHERE report_code = $code`, { code });
  const r = rows[0];
  return r ? toIngestRow(r) : null;
}

export async function listIngests(): Promise<IngestRow[]> {
  await ensureLocalTables();
  const rows = await queryRows(`SELECT * FROM ${LOCAL_SCHEMA}.ingest_files ORDER BY path`);
  return rows.map(toIngestRow);
}

function toIngestRow(r: Record<string, unknown>): IngestRow {
  return {
    report_code: String(r.report_code),
    path: String(r.path),
    file_size: Number(r.file_size),
    byte_offset: Number(r.byte_offset),
    schema_version: Number(r.schema_version),
    status: String(r.status) as IngestStatus,
    updated_at: Number(r.updated_at),
  };
}

/** Upsert an ingest row: on `conn` (inside a write), or under its own write lock. */
export async function setIngest(conn: DuckDBConnection | null, row: IngestRow): Promise<void> {
  await ensureLocalTables();
  const sql =
    `INSERT OR REPLACE INTO ${LOCAL_SCHEMA}.ingest_files VALUES ` +
    "($report_code, $path, $file_size, $byte_offset, $schema_version, $status, $updated_at)";
  const values = {
    ...row,
    file_size: big(row.file_size),
    byte_offset: big(row.byte_offset),
    updated_at: big(row.updated_at),
  };
  if (conn) await conn.run(sql, values);
  else await write((c) => c.run(sql, values));
}

/** Saved parser state for resuming a report: its start time, next fight id and actors. */
export async function loadReportState(code: string): Promise<{ reportStart: number | null; nextFightId: number; actors: ActorRow[] }> {
  if (!(await schemaExists(code))) return { reportStart: null, nextFightId: 1, actors: [] };
  const s = quotedSchema(code);
  const details = await queryRows(`SELECT start_time FROM ${s}.report_details`);
  const fights = await queryRows(`SELECT coalesce(max(fight_id), 0) + 1 AS next FROM ${s}.fights`);
  const actors = await queryRows(`SELECT * FROM ${s}.actors`);
  return {
    reportStart: details[0] ? Number(details[0].start_time) : null,
    nextFightId: Number(fights[0]?.next ?? 1),
    actors: actors.map((a) => ({
      actor_id: Number(a.actor_id),
      game_id: Number(a.game_id),
      pet_owner: a.pet_owner === null ? null : Number(a.pet_owner),
      name: String(a.name ?? ""),
      type: String(a.type),
      sub_type: String(a.sub_type),
      server: a.server === null ? null : String(a.server),
      guid: a.guid === null ? null : String(a.guid),
      player_key: a.player_key === null ? null : String(a.player_key),
    })),
  };
}

/**
 * Write finished fights, changed actors, the report_details row and the new ingest offset
 * in one transaction under the write lock. Applies only if the stored offset still equals
 * `fromOffset` (where this import started); returns false if another process got there first.
 */
export function commitSegments(
  code: string,
  path: string,
  parser: LogParser,
  segments: Segment[],
  ingest: IngestRow,
  fromOffset: number,
): Promise<boolean> {
  return write(async (conn) => {
    const current = await readRows(
      conn,
      `SELECT byte_offset FROM ${LOCAL_SCHEMA}.ingest_files WHERE report_code = $code`,
      { code },
    );
    if ((current[0] ? Number(current[0].byte_offset) : 0) !== fromOffset) return false;

    const schema = schemaName(code);
    const s = quotedSchema(code);
    const schemaRows = await readRows(conn, "SELECT 1 FROM information_schema.schemata WHERE schema_name = $name", {
      name: schema,
    });
    if (segments.length === 0 && schemaRows.length === 0) {
      // Nothing imported yet: just record progress, without creating an empty report.
      await setIngest(conn, ingest);
      return true;
    }
    // Create the tables before (not inside) the transaction: recreating a schema that an
    // earlier instance wrote to disk and that was since dropped fails to commit inside a
    // transaction (DuckDB: "Could not commit creation of dependency"). An empty schema left by
    // a failed commit is harmless: the next commit fills it.
    await conn.run(`CREATE SCHEMA IF NOT EXISTS ${s}`);
    await createSeedTables(conn, code, { ifNotExists: true });
    await conn.run("BEGIN TRANSACTION");
    try {
      await writeSegments(conn, schema, s, segments);
      await writeActors(conn, s, parser.takeChangedActors());

      // report_details: one row, rewritten with fresh totals; keep earlier values the parser
      // no longer knows after a resume (first zone, region).
      const prev = (await readRows(conn, `SELECT zone_id, zone_name, region FROM ${s}.report_details`))[0];
      await conn.run(`DELETE FROM ${s}.report_details`);
      await conn.run(
        `INSERT INTO ${s}.report_details SELECT $code, $title, NULL, $zone_id, $zone_name, $region, $start_time, ` +
          `$end_time, (SELECT count(*) FROM ${s}.fights), (SELECT count(*) FROM ${s}.fight_events), ` +
          `$schema_version, $downloaded_at, 'local', $log_path`,
        {
          code,
          title: basename(path),
          zone_id: (prev?.zone_id as number | null | undefined) ?? parser.firstZone?.id ?? null,
          zone_name: (prev?.zone_name as string | null | undefined) ?? parser.firstZone?.name ?? null,
          region: (prev?.region as string | null | undefined) ?? parser.region,
          start_time: big(parser.start),
          end_time: big(parser.lastTime),
          schema_version: SCHEMA_VERSION,
          downloaded_at: big(Date.now()),
          log_path: path,
        } as never,
      );

      await setIngest(conn, ingest);
      await conn.run("COMMIT");
      return true;
    } catch (err) {
      await conn.run("ROLLBACK").catch(() => {
        /* transaction may already be aborted */
      });
      throw err;
    }
  });
}

async function writeSegments(conn: DuckDBConnection, schema: string, s: string, segments: Segment[]): Promise<void> {
  for (const seg of segments) {
    const f = seg.fight;
    await conn.run(
      `INSERT INTO ${s}.fights VALUES ($fight_id, $name, $encounter_id, $difficulty, $keystone_level, ` +
        "$kill, $fight_percentage, $start_time, $end_time, $game_zone_id, $challenge_mode_id)",
      { ...f, start_time: big(f.start_time), end_time: big(f.end_time) } as never,
    );
  }
  if (segments.some((seg) => seg.events.length > 0)) {
    const appender = await conn.createAppender("fight_events", schema);
    try {
      for (const seg of segments) {
        for (const e of seg.events) {
          appender.appendInteger(e.fight_id);
          appender.appendBigInt(BigInt(e.timestamp));
          appender.appendVarchar(e.type);
          appendNullableInt(appender, e.source_id);
          appendNullableInt(appender, e.target_id);
          appendNullableInt(appender, e.source_instance);
          appendNullableInt(appender, e.target_instance);
          appendNullableBigInt(appender, e.ability_game_id);
          appendNullableBigInt(appender, e.amount);
          appendNullableInt(appender, e.hit_type);
          appender.appendVarchar(e.raw);
          appender.endRow();
        }
      }
      appender.flushSync();
    } finally {
      appender.closeSync();
    }
  }
  if (segments.some((seg) => seg.health.length > 0)) {
    const appender = await conn.createAppender("fight_health", schema);
    try {
      for (const seg of segments) {
        for (const h of seg.health) {
          appender.appendInteger(h.fight_id);
          appender.appendVarchar(h.hostility);
          appender.appendInteger(h.actor_id);
          appender.appendBigInt(BigInt(h.timestamp));
          appender.appendBigInt(BigInt(h.hit_points));
          appender.appendBigInt(BigInt(h.max_hit_points));
          appender.appendDouble(h.health_percent);
          appender.endRow();
        }
      }
      appender.flushSync();
    } finally {
      appender.closeSync();
    }
  }
}

async function writeActors(conn: DuckDBConnection, s: string, actors: ActorRow[]): Promise<void> {
  if (actors.length === 0) return;
  await conn.run(`DELETE FROM ${s}.actors WHERE actor_id IN (${actors.map((a) => a.actor_id).join(",")})`);
  for (const a of actors) {
    await conn.run(
      `INSERT INTO ${s}.actors VALUES ($actor_id, $game_id, $pet_owner, $name, $type, $sub_type, $server, $guid, $player_key)`,
      { ...a, game_id: big(a.game_id) } as never,
    );
  }
}
