import { z } from "zod";
import { openConnection } from "../db/duck.js";
import {
  assertValidReportCode,
  notDownloadedMessage,
  routeSchemaExists,
  routeSchemaName,
  schemaExists,
  schemaName,
} from "../db/schema.js";
import { assertReadOnly, assertWithinSchemas, ReadOnlyViolation } from "../db/readonly.js";
import { GAMEDATA_SCHEMA } from "../gamedata/tables.js";
import { MDT_SCHEMA } from "../mdt/data.js";
import { guard, ok, fail } from "./result.js";

/** Cap returned rows so a missing LIMIT can't flood the context window. */
const MAX_ROWS = 1000;

export const executeReadonlyQueryShape = {
  report_code: z
    .string()
    .describe("Warcraft Logs report code that has been downloaded locally."),
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
    const { report_code, sql } = inputSchema.parse(args);
    assertValidReportCode(report_code);

    if (!(await schemaExists(report_code))) {
      return fail(await notDownloadedMessage(report_code));
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

    // The report's log schema, plus its route schema once a route has been imported
    // (search_path rejects a schema that doesn't exist).
    const schemas = [schemaName(report_code)];
    if (await routeSchemaExists(report_code)) schemas.push(routeSchemaName(report_code));
    // A per-call connection keeps search_path from leaking between concurrent calls.
    const conn = await openConnection();
    try {
      // Scope unqualified table names to this report's schemas.
      await conn.run(`SET search_path = '${schemas.join(",")}'`);
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
        report_code,
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
    } finally {
      conn.closeSync();
    }
  });
}
