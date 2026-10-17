/**
 * Import a WoWCombatLog file into a local report schema, incrementally: each finished fight
 * is committed with the byte offset to resume from, so re-running it (as sync_local_logs does)
 * only parses what's new.
 */
import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { dropSchema, SCHEMA_VERSION } from "../db/schema.js";
import { LogParser, type Segment } from "./parser.js";
import { readLines } from "./reader.js";
import { commitSegments, getIngest, loadReportState, setIngest, type IngestRow } from "./store.js";
import { parseLine } from "./tokenize.js";

/** Lines identifying a log file: its first two (the version header and first event). */
const IDENTITY_LINES = 2;

export interface ImportOptions {
  /**
   * The log is finished (nothing more will be appended): close a fight still open at the end.
   * A live log keeps it open until its end marker arrives.
   */
  final: boolean;
  /** Drop any previous import of this file and start over (also un-ignores it). */
  force?: boolean;
  /** Skip files whose import was deleted by the user (sync_local_logs sets this). */
  respectIgnored?: boolean;
}

export interface ImportResult {
  report_code: string | null;
  /**
   * superseded: another wcl-mcp process committed this file's progress first.
   * not_a_combat_log: the file doesn't start with a COMBAT_LOG_VERSION header; nothing imported.
   */
  status: "imported" | "up_to_date" | "waiting" | "ignored" | "superseded" | "not_a_combat_log";
  fights_added: number;
  events_added: number;
  /** A fight is still open at the end of a live file (it'll be committed when it ends). */
  in_progress: boolean;
}

/**
 * Report code for a log file: `local_` + a hash of its first lines. Stable as the file grows
 * and if it's moved or renamed. Null until the file has those lines; "not_a_combat_log" when
 * it doesn't start with the COMBAT_LOG_VERSION header every combat log begins with.
 */
export async function reportCodeForFile(path: string): Promise<string | null | "not_a_combat_log"> {
  const lines: string[] = [];
  for await (const { line } of readLines(path, 0)) {
    if (lines.length === 0 && parseLine(line)?.event !== "COMBAT_LOG_VERSION") return "not_a_combat_log";
    lines.push(line);
    if (lines.length === IDENTITY_LINES) break;
  }
  if (lines.length < IDENTITY_LINES) return null;
  return `local_${createHash("sha256").update(lines.join("\n")).digest("hex").slice(0, 12)}`;
}

/**
 * One import at a time per report within this process, so a sync and the import tool
 * don't race each other; across processes, commits are compare-and-set on the stored offset.
 */
const locks = new Map<string, Promise<unknown>>();

export async function importLogFile(pathInput: string, options: ImportOptions): Promise<ImportResult> {
  const path = resolve(pathInput);
  const code = await reportCodeForFile(path);
  if (!code || code === "not_a_combat_log") {
    const status = code === "not_a_combat_log" ? "not_a_combat_log" : "waiting";
    return { report_code: null, status, fights_added: 0, events_added: 0, in_progress: false };
  }
  const prev = locks.get(code) ?? Promise.resolve();
  const run = prev.catch(() => undefined).then(() => importLocked(path, code, options));
  locks.set(code, run);
  try {
    return await run;
  } finally {
    if (locks.get(code) === run) locks.delete(code);
  }
}

async function importLocked(path: string, code: string, options: ImportOptions): Promise<ImportResult> {
  const size = (await stat(path)).size;
  let ingest = await getIngest(code);

  if (ingest?.status === "ignored" && options.respectIgnored && !options.force) {
    return { report_code: code, status: "ignored", fights_added: 0, events_added: 0, in_progress: false };
  }
  // Start over when asked, when the stored copy is from another schema version, or when the
  // file shrank (it was replaced; offsets no longer mean anything).
  const restart =
    options.force ||
    ingest?.status === "ignored" ||
    (ingest && (ingest.schema_version !== SCHEMA_VERSION || size < ingest.byte_offset));
  if (restart) {
    await dropSchema(code);
    await setIngest(null, {
      report_code: code, path, file_size: size, byte_offset: 0, schema_version: SCHEMA_VERSION,
      status: "active", updated_at: Date.now(),
    });
    ingest = null;
  }
  if (ingest?.status === "complete" && ingest.file_size === size) {
    return { report_code: code, status: "up_to_date", fights_added: 0, events_added: 0, in_progress: false };
  }

  const state = await loadReportState(code);
  const parser = new LogParser(state);
  const base: IngestRow = {
    report_code: code,
    path,
    file_size: size,
    byte_offset: ingest?.byte_offset ?? 0,
    schema_version: SCHEMA_VERSION,
    status: "active",
    updated_at: Date.now(),
  };

  let fightsAdded = 0;
  let eventsAdded = 0;
  let committedOffset = base.byte_offset;
  let readOffset = base.byte_offset;
  /** Commit under the write lock; false if another process advanced this file meanwhile. */
  const commit = async (segments: Segment[], offset: number, status: IngestRow["status"]) => {
    const row = { ...base, byte_offset: offset, status, updated_at: Date.now() };
    if (!(await commitSegments(code, path, parser, segments, row, committedOffset))) return false;
    committedOffset = offset;
    fightsAdded += segments.length;
    eventsAdded += segments.reduce((n, s) => n + s.events.length, 0);
    return true;
  };
  const superseded = (): ImportResult => ({
    report_code: code, status: "superseded", fights_added: fightsAdded, events_added: eventsAdded, in_progress: false,
  });

  for await (const { line, end } of readLines(path, base.byte_offset)) {
    readOffset = end;
    const raw = parseLine(line);
    if (!raw) continue;
    const closed = parser.feed(raw, end);
    if (closed.length > 0 && !(await commit(closed, closed[closed.length - 1]!.resumeOffset, "active"))) {
      return superseded();
    }
  }
  if (options.final) {
    if (!(await commit(parser.finish(), readOffset, "complete"))) return superseded();
  } else if (!parser.inFight && readOffset > committedOffset) {
    // Between fights: nothing to re-parse, so the next run can start here.
    if (!(await commit([], readOffset, "active"))) return superseded();
  }

  return {
    report_code: code,
    status: "imported",
    fights_added: fightsAdded,
    events_added: eventsAdded,
    in_progress: !options.final && parser.inFight,
  };
}
