import { z } from "zod";
import { queryRows } from "../db/duck.js";
import {
  assertValidReportCode,
  quotedSchema,
  schemaExists,
  schemaName,
  SCHEMA_VERSION,
} from "../db/schema.js";
import { SEED_TABLES } from "../db/seeds.js";
import { getGameDataStatus } from "../gamedata/sync.js";
import { gameDataTableDocs } from "../gamedata/tables.js";
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
      return fail(
        `Report '${report_code}' is not downloaded. Call download_report('${report_code}') first.`,
      );
    }

    const schema = quotedSchema(report_code);
    const tables = [];

    for (const [table, spec] of Object.entries(SEED_TABLES)) {
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
    });
  });
}

function qIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}
