import { z } from "zod";
import { queryRows } from "../db/duck.js";
import { quotedSchema, schemaExists, schemaName } from "../db/schema.js";
import { forgetDirs, savedDirs, syncDirs } from "../local/dirs.js";
import { importLogFile } from "../local/importer.js";
import { listIngests } from "../local/store.js";
import { guard, ok } from "./result.js";

export const importLocalLogShape = {
  path: z.string().describe("Path to a WoWCombatLog*.txt file."),
  force: z
    .boolean()
    .optional()
    .describe("Re-import from scratch, dropping any previous import of this file."),
};

export async function importLocalLog(args: unknown) {
  return guard(async () => {
    const { path, force } = z.object(importLocalLogShape).parse(args);
    const result = await importLogFile(path, { final: true, force });
    if (result.status === "waiting") {
      return ok({ ...result, hint: "The file doesn't have enough lines to identify it yet." });
    }
    if (result.status === "not_a_combat_log") {
      return ok({ ...result, hint: "The file doesn't start with a COMBAT_LOG_VERSION line, so it isn't a WoW combat log." });
    }
    return ok({
      ...result,
      schema: result.report_code ? schemaName(result.report_code) : null,
      hint:
        "Use report_code with get_report_details / execute_readonly_query, like a WCL report code. " +
        "For a log that's still being written, use sync_local_logs instead.",
    });
  });
}

export const syncLocalLogsShape = {
  dir: z
    .string()
    .optional()
    .describe(
      "WoW Logs directory (World of Warcraft/_retail_/Logs); saved for later syncs. Omit to sync " +
        "the saved directories (or, if none, the usual install location).",
    ),
};

export async function syncLocalLogs(args: unknown) {
  return guard(async () => {
    const { dir } = z.object(syncLocalLogsShape).parse(args);
    const dirs = await syncDirs(dir);
    return ok({
      dirs: dirs.map((d) => {
        // Files with nothing new are summarized, not listed.
        const unchanged = (f: (typeof d.files)[number]) =>
          f.status === "up_to_date" || (f.status === "imported" && f.fights_added === 0 && !f.in_progress);
        return {
          dir: d.dir,
          up_to_date: d.files.filter(unchanged).length,
          files: d.files.filter((f) => !unchanged(f)),
          ...(d.errors.length ? { errors: d.errors } : {}),
        };
      }),
      hint:
        "Each finished fight is now queryable by its log's report_code. A fight still in progress " +
        "in the newest log is picked up by the next sync.",
    });
  });
}

export const forgetLogDirShape = {
  dir: z.string().optional().describe("Saved directory to forget; omit to forget all."),
};

export async function forgetLogDir(args: unknown) {
  return guard(async () => {
    const { dir } = z.object(forgetLogDirShape).parse(args);
    const removed = await forgetDirs(dir);
    return ok({ forgotten: removed, note: "Imported reports are kept; delete them with delete_local_report." });
  });
}

export const listLocalLogsShape = {};

export async function listLocalLogs() {
  return guard(async () => {
    const files = [];
    for (const f of await listIngests()) {
      let fights: Record<string, unknown>[] = [];
      if (await schemaExists(f.report_code)) {
        fights = await queryRows(
          `SELECT fight_id, name, keystone_level, kill, (end_time - start_time) // 1000 AS duration_s
           FROM ${quotedSchema(f.report_code)}.fights ORDER BY fight_id`,
        );
      }
      files.push({
        report_code: f.report_code,
        path: f.path,
        status: f.status,
        imported_bytes: f.byte_offset,
        updated_at: new Date(f.updated_at).toISOString(),
        fights,
      });
    }
    return ok({ saved_dirs: await savedDirs(), imported_logs: files });
  });
}
