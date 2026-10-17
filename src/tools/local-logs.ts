import { z } from "zod";
import { queryRows } from "../db/duck.js";
import { quotedSchema, schemaExists, schemaName } from "../db/schema.js";
import { importLogFile } from "../local/importer.js";
import { listIngests } from "../local/store.js";
import { resolveLogDir, unwatchDir, watchDir, watchStatus } from "../local/watcher.js";
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
    return ok({
      ...result,
      schema: result.report_code ? schemaName(result.report_code) : null,
      hint:
        "Use report_code with get_report_details / execute_readonly_query, like a WCL report code. " +
        "For a log that's still being written, use watch_logs instead.",
    });
  });
}

export const watchLogsShape = {
  dir: z
    .string()
    .optional()
    .describe("WoW Logs directory (World of Warcraft/_retail_/Logs). Defaults to the usual install location."),
};

export async function watchLogs(args: unknown) {
  return guard(async () => {
    const { dir } = z.object(watchLogsShape).parse(args);
    const resolved = await resolveLogDir(dir);
    const res = await watchDir(resolved);
    return ok({
      ...res,
      status: "watching",
      hint:
        "Saved: this directory is watched whenever the server runs, catching up on anything new. " +
        "Existing logs import in the background; check progress and report codes with watch_status.",
    });
  });
}

export const unwatchLogsShape = {
  dir: z.string().optional().describe("Directory to stop watching; omit to stop all."),
};

export async function unwatchLogs(args: unknown) {
  return guard(async () => {
    const { dir } = z.object(unwatchLogsShape).parse(args);
    const removed = await unwatchDir(dir);
    return ok({ stopped: removed, note: "Imported reports are kept; delete them with delete_local_report." });
  });
}

export const watchStatusShape = {};

export async function getWatchStatus() {
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
    return ok({ ...watchStatus(), imported_logs: files });
  });
}
