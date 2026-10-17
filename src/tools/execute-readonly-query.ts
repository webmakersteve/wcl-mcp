import { z } from "zod";
import type { DuckDBConnection } from "@duckdb/node-api";
import { read } from "../db/duck.js";
import {
  assertValidReportCode,
  notDownloadedMessage,
  routeSchemaExists,
  routeSchemaName,
  schemaExists,
  schemaName,
} from "../db/schema.js";
import { assertReadOnly, assertWithinSchemas, ReadOnlyViolation } from "../db/readonly.js";
import { SEED_TABLES } from "../db/seeds.js";
import { GAMEDATA_SCHEMA } from "../gamedata/tables.js";
import { MDT_SCHEMA } from "../mdt/data.js";
import { guard, ok, fail } from "./result.js";

/** Cap returned rows so a missing LIMIT can't flood the context window. */
const MAX_ROWS = 1000;

const ALIAS_RE = /^[A-Za-z][A-Za-z0-9]{0,23}$/;

export const executeReadonlyQueryShape = {
  report_code: z
    .string()
    .optional()
    .describe("Report to query: a downloaded WCL code or an imported local log (local_...). Use this or reports."),
  reports: z
    .record(z.string())
    .optional()
    .describe(
      "Query several reports at once, e.g. {\"mine\": \"local_63028f1d62c0\", \"wcl\": \"nNMJGp1ThaHdQ6By\"} " +
        "(aliases are letters/digits). Exposes <alias>_fight_events / <alias>_fights / <alias>_actors / " +
        "... per report, and all_events / all_fights / all_actors stacking every report with a `report` " +
        "column (the alias). all_events adds stable cross-report keys, since actor ids differ per " +
        "report: source_key/target_key (player 'Name-Server', 'npc:<game_id>', or 'pet:<game_id>@<owner>'), " +
        "source_owner_key (pets credited to their owner) and t_fight (ms since the fight's start). " +
        "Compare with GROUP BY report. Unqualified seed table names resolve to the first report.",
    ),
  sql: z
    .string()
    .describe(
      "A single read-only DuckDB SQL statement (SELECT/WITH/FROM/DESCRIBE/SUMMARIZE/...). " +
        "Reference the seed tables unqualified (fight_events, fight_health, fights, actors, report_details) — " +
        "search_path is scoped to this report. Read fight_health's limitations in get_report_details " +
        "before aggregating it. Spell data (once synced) is in the shared gamedata " +
        "schema, e.g. JOIN gamedata.spell s ON s.spell_id = fight_events.ability_game_id. After " +
        "import_mdt_route, route_* tables are here too, and MDT dungeon data is in mdt.<table>.",
    ),
};

const inputSchema = z.object(executeReadonlyQueryShape);

export async function executeReadonlyQuery(args: unknown) {
  return guard(async () => {
    const { report_code, reports, sql } = inputSchema.parse(args);
    const entries: Array<[string, string]> = reports
      ? Object.entries(reports)
      : report_code
        ? [["", report_code]]
        : [];
    if (entries.length === 0) return fail("Pass report_code, or reports for several reports.");
    for (const [alias, code] of entries) {
      assertValidReportCode(code);
      if (reports && (!ALIAS_RE.test(alias) || alias.toLowerCase() === "all")) {
        return fail(`Invalid alias ${JSON.stringify(alias)}: use letters and digits (not "all").`);
      }
      if (!(await schemaExists(code))) {
        return fail(await notDownloadedMessage(code));
      }
    }

    let statement: string;
    try {
      statement = assertReadOnly(sql);
    } catch (err) {
      if (err instanceof ReadOnlyViolation) {
        return fail(`Rejected (read-only guard): ${err.message}`);
      }
      throw err;
    }

    // Each report's log schema, plus its route schema once a route has been imported
    // (search_path rejects a schema that doesn't exist). The first report is the default.
    const schemas: string[] = [];
    let searchPath: string[] = [];
    for (const [i, [, code]] of entries.entries()) {
      const own = [schemaName(code)];
      if (await routeSchemaExists(code)) own.push(routeSchemaName(code));
      if (i === 0) searchPath = own;
      schemas.push(...own);
    }
    // A per-call connection keeps search_path and temp views from leaking between calls.
    return read(async (conn) => {
      // Scope unqualified table names to the (first) report's schemas.
      await conn.run(`SET search_path = '${searchPath.join(",")}'`);
      if (reports) await createCompareViews(conn, entries);
      try {
        await assertWithinSchemas(conn, statement, [...schemas, GAMEDATA_SCHEMA, MDT_SCHEMA]);
      } catch (err) {
        if (err instanceof ReadOnlyViolation) {
          return fail(`Rejected (read-only guard): ${err.message}`);
        }
        throw err;
      }
      const reader = await conn.runAndReadUntil(statement, MAX_ROWS + 1);
      const allRows = reader.getRowObjectsJson() as Record<string, unknown>[];
      const truncated = allRows.length > MAX_ROWS;
      const rows = truncated ? allRows.slice(0, MAX_ROWS) : allRows;
      const columns = reader.columnNames();

      return ok({
        ...(reports ? { reports } : { report_code }),
        row_count: rows.length,
        truncated,
        columns,
        rows,
        ...(truncated
          ? {
              note: `Result truncated to ${MAX_ROWS} rows. Add a LIMIT or aggregate to narrow it.`,
            }
          : {}),
      });
    });
  });
}

/** Temp views for comparing reports: per-alias copies and all_* stacks with stable keys. */
async function createCompareViews(conn: DuckDBConnection, entries: Array<[string, string]>): Promise<void> {
  const q = (s: string) => `"${s}"`;
  const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;
  for (const [alias, code] of entries) {
    for (const table of Object.keys(SEED_TABLES)) {
      await conn.run(`CREATE TEMP VIEW ${q(`${alias}_${table}`)} AS SELECT * FROM ${q(schemaName(code))}.${q(table)}`);
    }
  }
  const union = (select: (alias: string, schema: string) => string) =>
    entries.map(([alias, code]) => select(lit(alias), q(schemaName(code)))).join("\nUNION ALL BY NAME\n");

  // An actor's cross-report key: players by Name-Server, NPCs by creature id, pets by
  // creature id + owner. Expects actors `a` and its owner `o` in scope.
  const key = "CASE WHEN a.type = 'Player' THEN coalesce(a.player_key, a.name) " +
    "WHEN a.type = 'Pet' THEN 'pet:' || a.game_id || '@' || coalesce(o.player_key, o.name, '?') " +
    "ELSE 'npc:' || a.game_id END";
  const ownerKey = "CASE WHEN a.type = 'Pet' THEN coalesce(o.player_key, o.name) ELSE " + key + " END";
  const keyed = (s: string) =>
    `SELECT a.actor_id, ${key} AS actor_key, ${ownerKey} AS owner_key
     FROM ${s}.actors a LEFT JOIN ${s}.actors o ON o.actor_id = a.pet_owner`;

  await conn.run(`CREATE TEMP VIEW all_fights AS ${union((alias, s) => `SELECT ${alias} AS report, * FROM ${s}.fights`)}`);
  await conn.run(
    `CREATE TEMP VIEW all_actors AS ${union(
      (alias, s) => `SELECT ${alias} AS report, a.*, ${key} AS actor_key, ${ownerKey} AS owner_key
        FROM ${s}.actors a LEFT JOIN ${s}.actors o ON o.actor_id = a.pet_owner`,
    )}`,
  );
  await conn.run(
    `CREATE TEMP VIEW all_events AS ${union(
      (alias, s) => `SELECT ${alias} AS report, e.*, e.timestamp - f.start_time AS t_fight,
          sa.actor_key AS source_key, sa.owner_key AS source_owner_key, ta.actor_key AS target_key
        FROM ${s}.fight_events e
        JOIN ${s}.fights f ON f.fight_id = e.fight_id
        LEFT JOIN (${keyed(s)}) sa ON sa.actor_id = e.source_id
        LEFT JOIN (${keyed(s)}) ta ON ta.actor_id = e.target_id`,
    )}`,
  );
}
