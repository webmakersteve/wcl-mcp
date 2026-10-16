import { z } from "zod";
import type { DuckDBAppender } from "@duckdb/node-api";
import { openConnection, queryRows } from "../db/duck.js";
import {
  assertValidReportCode,
  isDownloadComplete,
  quotedSchema,
  schemaName,
  SCHEMA_VERSION,
} from "../db/schema.js";
import { createSeedTables } from "../db/seeds.js";
import { getWclClient } from "../wcl/client.js";
import { FIGHT_EVENTS_QUERY, FIGHT_HEALTH_QUERY, REPORT_META_QUERY } from "../wcl/queries.js";
import type {
  FightEventsResponse,
  FightHealthResponse,
  ReportMetaResponse,
  WclEvent,
  WclHealthSeries,
} from "../wcl/types.js";
import { guard, ok, fail } from "./result.js";

/** Max events requested per page; pagination via nextPageTimestamp handles the rest. */
const EVENTS_PAGE_LIMIT = 10_000;

export const downloadReportShape = {
  report_code: z
    .string()
    .describe("Warcraft Logs report code (the alphanumeric run identifier)."),
  force: z
    .boolean()
    .optional()
    .describe("Re-download even if the report already exists locally (drops and rebuilds it)."),
};

const inputSchema = z.object(downloadReportShape);

function appendNullableInt(appender: DuckDBAppender, value: number | undefined | null): void {
  if (value === undefined || value === null) appender.appendNull();
  else appender.appendInteger(value);
}

function appendNullableBigInt(appender: DuckDBAppender, value: number | undefined | null): void {
  if (value === undefined || value === null) appender.appendNull();
  else appender.appendBigInt(BigInt(Math.trunc(value)));
}

/** Append one event row in SEED_TABLES.fight_events column order. */
function appendEvent(appender: DuckDBAppender, fightId: number, ev: WclEvent): void {
  appender.appendInteger(fightId);
  appender.appendBigInt(BigInt(Math.trunc(ev.timestamp)));
  appender.appendVarchar(String(ev.type));
  appendNullableInt(appender, ev.sourceID);
  appendNullableInt(appender, ev.targetID);
  appendNullableInt(appender, ev.sourceInstance);
  appendNullableInt(appender, ev.targetInstance);
  appendNullableBigInt(appender, ev.abilityGameID);
  appendNullableBigInt(appender, ev.amount);
  appendNullableInt(appender, ev.hitType);
  appender.appendVarchar(JSON.stringify(ev));
  appender.endRow();
}

/** WCL HostilityType → fight_health.hostility. */
const HEALTH_HOSTILITIES = [
  ["Friendlies", "friendly"],
  ["Enemies", "enemy"],
] as const;

/** Append every reading of one health series in SEED_TABLES.fight_health column order. */
function appendHealthSeries(
  appender: DuckDBAppender,
  fightId: number,
  hostility: string,
  series: WclHealthSeries,
): void {
  const points = series.data ?? [];
  for (let i = 0; i < points.length; i++) {
    const [timestamp, percent] = points[i];
    appender.appendInteger(fightId);
    appender.appendVarchar(hostility);
    appender.appendInteger(series.id);
    appender.appendBigInt(BigInt(Math.trunc(timestamp)));
    appendNullableBigInt(appender, series.currentValues?.[i]);
    appendNullableBigInt(appender, series.maxValues?.[i]);
    if (percent === undefined || percent === null) appender.appendNull();
    else appender.appendDouble(percent);
    appender.endRow();
  }
}

export async function downloadReport(args: unknown) {
  return guard(async () => {
    const { report_code, force } = inputSchema.parse(args);
    assertValidReportCode(report_code);

    if (!force && (await isDownloadComplete(report_code))) {
      const counts = await tableCounts(report_code);
      return ok({
        status: "already_downloaded",
        report_code,
        schema: schemaName(report_code),
        schema_version: SCHEMA_VERSION,
        tables: counts,
        hint: "Pass force=true to re-download. Use get_report_details to inspect, or execute_readonly_query to analyze.",
      });
    }

    // 1. Fetch report header, fights, and actor master data.
    const client = getWclClient();
    const meta = await client.query<ReportMetaResponse>(REPORT_META_QUERY, {
      code: report_code,
    });
    const report = meta.reportData.report;
    if (!report) {
      const hint = client.loggedInUser
        ? "it may be private to someone else, deleted, or the code is wrong"
        : "it may be private (call the login tool to access your private reports), deleted, " +
          "or the code is wrong";
      return fail(`Report '${report_code}' not found (${hint}).`);
    }

    // 2-6 run in one transaction on a dedicated connection: a failure part-way
    // (rate limit, network) rolls back and leaves any previous copy intact,
    // rather than a half-filled schema that would look "already downloaded".
    const schema = schemaName(report_code);
    const conn = await openConnection();
    let totalEvents = 0;
    const fights = report.fights ?? [];
    try {
      await conn.run("BEGIN TRANSACTION");

      // 2. (Re)create the schema and seed tables. Dropping covers both force=true
      // and a leftover incomplete download.
      await conn.run(`DROP SCHEMA IF EXISTS ${quotedSchema(report_code)} CASCADE`);
      await conn.run(`CREATE SCHEMA ${quotedSchema(report_code)}`);
      await createSeedTables(conn, report_code);

      // 3. Insert fights and actors.
      for (const f of fights) {
        await conn.run(
          `INSERT INTO ${q(schema)}.fights VALUES ` +
            `($fight_id, $name, $encounter_id, $difficulty, $keystone_level, $kill, $fight_percentage, $start_time, $end_time)`,
          {
            fight_id: f.id,
            name: f.name,
            encounter_id: f.encounterID,
            difficulty: f.difficulty,
            keystone_level: f.keystoneLevel,
            kill: f.kill,
            fight_percentage: f.fightPercentage,
            start_time: f.startTime,
            end_time: f.endTime,
          },
        );
      }

      const actors = report.masterData?.actors ?? [];
      for (const a of actors) {
        await conn.run(
          `INSERT INTO ${q(schema)}.actors VALUES ($actor_id, $game_id, $pet_owner, $name, $type, $sub_type, $server)`,
          {
            actor_id: a.id,
            game_id: a.gameID,
            pet_owner: a.petOwner,
            name: a.name,
            type: a.type,
            sub_type: a.subType,
            server: a.server,
          },
        );
      }

      // 4. Paginate the full event stream per fight, bulk-appending into fight_events.
      const appender = await conn.createAppender("fight_events", schema);
      try {
        for (const f of fights) {
          let startTime = f.startTime;
          const endTime = f.endTime;
          // eslint-disable-next-line no-constant-condition
          while (true) {
            const page = await client.query<FightEventsResponse>(FIGHT_EVENTS_QUERY, {
              code: report_code,
              fightID: f.id,
              startTime,
              endTime,
              limit: EVENTS_PAGE_LIMIT,
            });
            const events = page.reportData.report?.events;
            const data = events?.data ?? [];
            for (const ev of data) {
              appendEvent(appender, f.id, ev);
              totalEvents++;
            }
            const next = events?.nextPageTimestamp;
            if (next === null || next === undefined) break;
            startTime = next;
          }
          appender.flushSync();
        }
      } finally {
        appender.closeSync();
      }

      // 5. Health over time per fight, friendly and enemy (one graph request each).
      const healthAppender = await conn.createAppender("fight_health", schema);
      try {
        for (const f of fights) {
          for (const [hostilityType, hostility] of HEALTH_HOSTILITIES) {
            const res = await client.query<FightHealthResponse>(FIGHT_HEALTH_QUERY, {
              code: report_code,
              fightID: f.id,
              startTime: f.startTime,
              endTime: f.endTime,
              hostilityType,
            });
            for (const series of res.reportData.report?.graph?.data?.series ?? []) {
              appendHealthSeries(healthAppender, f.id, hostility, series);
            }
          }
          healthAppender.flushSync();
        }
      } finally {
        healthAppender.closeSync();
      }

      // 6. Insert the single report_details row now that totals are known.
      await conn.run(
        `INSERT INTO ${q(schema)}.report_details VALUES ` +
          `($report_code, $title, $owner, $zone_id, $zone_name, $region, $start_time, $end_time, $num_fights, $total_events, $schema_version, $downloaded_at)`,
        {
          report_code: report.code,
          title: report.title,
          owner: report.owner?.name ?? null,
          zone_id: report.zone?.id ?? null,
          zone_name: report.zone?.name ?? null,
          region: report.region?.slug ?? null,
          start_time: report.startTime,
          end_time: report.endTime,
          num_fights: fights.length,
          total_events: totalEvents,
          schema_version: SCHEMA_VERSION,
          downloaded_at: Date.now(),
        },
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

    const counts = await tableCounts(report_code);
    return ok({
      status: "downloaded",
      report_code,
      schema,
      schema_version: SCHEMA_VERSION,
      title: report.title,
      zone: report.zone?.name ?? null,
      num_fights: fights.length,
      tables: counts,
      hint: "Use get_report_details to see the schema + semantic guide, then execute_readonly_query to analyze.",
    });
  });
}

/** Quote a schema identifier already known to be safe (alphanumeric-derived). */
function q(schema: string): string {
  return `"${schema}"`;
}

async function tableCounts(code: string): Promise<Record<string, number>> {
  const schema = schemaName(code);
  const rows = await queryRows(
    `SELECT 'report_details' AS t, count(*) AS n FROM ${q(schema)}.report_details
     UNION ALL SELECT 'fights', count(*) FROM ${q(schema)}.fights
     UNION ALL SELECT 'actors', count(*) FROM ${q(schema)}.actors
     UNION ALL SELECT 'fight_events', count(*) FROM ${q(schema)}.fight_events
     UNION ALL SELECT 'fight_health', count(*) FROM ${q(schema)}.fight_health`,
  );
  const out: Record<string, number> = {};
  for (const r of rows) out[String(r.t)] = Number(r.n);
  return out;
}
