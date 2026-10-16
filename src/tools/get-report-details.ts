import { z } from "zod";
import { queryRows } from "../db/duck.js";
import {
  assertValidReportCode,
  quotedRouteSchema,
  quotedSchema,
  notDownloadedMessage,
  ROUTE_SCHEMA_VERSION,
  routeSchemaName,
  schemaExists,
  schemaName,
  SCHEMA_VERSION,
} from "../db/schema.js";
import { SEED_TABLES } from "../db/seeds.js";
import { getGameDataStatus } from "../gamedata/sync.js";
import { gameDataTableDocs } from "../gamedata/tables.js";
import { MDT_SCHEMA, mdtTableDocs } from "../mdt/data.js";
import { ROUTE_TABLES } from "../mdt/route-tables.js";
import { guard, ok, fail } from "./result.js";

export const getReportDetailsShape = {
  report_code: z
    .string()
    .describe("Warcraft Logs report code that has been downloaded locally."),
};

const inputSchema = z.object(getReportDetailsShape);

interface ColumnStat {
  min: unknown;
  max: unknown;
  approx_unique: unknown;
  null_percentage: unknown;
}

export async function getReportDetails(args: unknown) {
  return guard(async () => {
    const { report_code } = inputSchema.parse(args);
    assertValidReportCode(report_code);

    if (!(await schemaExists(report_code))) {
      return fail(await notDownloadedMessage(report_code));
    }

    const tables = [];

    // Route tables live in their own schema, which exists once import_mdt_route has run.
    const existing = new Map(
      (
        await queryRows(
          "SELECT table_schema, table_name FROM information_schema.tables " +
            "WHERE table_schema IN ($log, $route)",
          { log: schemaName(report_code), route: routeSchemaName(report_code) },
        )
      ).map((r) => [String(r.table_name), String(r.table_schema)]),
    );
    const documented = [
      ...Object.entries(SEED_TABLES).map(([t, spec]) => [t, spec, quotedSchema(report_code)] as const),
      ...Object.entries(ROUTE_TABLES).map(([t, spec]) => [t, spec, quotedRouteSchema(report_code)] as const),
    ];

    for (const [table, spec, schema] of documented) {
      if (!existing.has(table)) continue;
      const ref = `${schema}.${qIdent(table)}`;

      const countRows = await queryRows(`SELECT count(*) AS n FROM ${ref}`);
      const rowCount = Number(countRows[0]?.n ?? 0);

      // SUMMARIZE gives per-column min/max/approx_unique/null_percentage.
      const stats = new Map<string, ColumnStat>();
      if (rowCount > 0) {
        const summary = await queryRows(`SUMMARIZE SELECT * FROM ${ref}`);
        for (const s of summary) {
          stats.set(String(s.column_name), {
            min: s.min ?? null,
            max: s.max ?? null,
            approx_unique: s.approx_unique ?? null,
            null_percentage: s.null_percentage ?? null,
          });
        }
      }

      const columns = Object.entries(spec.columns).map(([name, c]) => ({
        name,
        type: c.type,
        description: c.description,
        ...(c.usage ? { usage: c.usage } : {}),
        ...(stats.has(name) ? { stats: stats.get(name) } : {}),
      }));

      tables.push({ table, description: spec.description, row_count: rowCount, columns });
    }

    const gameData = await getGameDataStatus();

    return ok({
      report_code,
      schema: schemaName(report_code),
      schema_version: SCHEMA_VERSION,
      ...(existing.has("route_imports")
        ? { route_schema: routeSchemaName(report_code), route_schema_version: ROUTE_SCHEMA_VERSION }
        : {}),
      query_hint:
        "Use execute_readonly_query(report_code, sql) with these tables referenced unqualified " +
        "(search_path is set to this report's schema). Join fight_events.source_id/target_id to " +
        "actors.actor_id, and fight_events.fight_id to fights.fight_id.",
      tables,
      game_data: gameData
        ? {
            build: gameData.build,
            query_hint:
              "Shared WoW spell data, queryable alongside this report as gamedata.<table>. " +
              "Join fight_events.ability_game_id = gamedata.spell.spell_id for names. " +
              "Per-spell tables can have one row per difficulty; filter difficulty_id = 0 for the default.",
            tables: gameDataTableDocs(),
          }
        : {
            synced: false,
            hint: "Spell data isn't downloaded yet. lookup_spells fetches it on first use, or call sync_game_data.",
          },
      ...(existing.has("route_pulls")
        ? {
            mdt_data: {
              query_hint:
                `MDT dungeon data, queryable as ${MDT_SCHEMA}.<table>. route_planned_units ` +
                `(enemy_idx, clone_idx) joins ${MDT_SCHEMA}.spawns; actors.game_id joins ${MDT_SCHEMA}.enemies.npc_id.`,
              tables: mdtTableDocs(),
            },
          }
        : {}),
    });
  });
}

function qIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}
