/**
 * Watch WoW Logs directories and import combat logs as they're written.
 *
 * Runs inside each MCP server process, so nothing imports while no session is open. Watched
 * directories persist in local_logs.watched_dirs; on server start each resumes and catches up
 * on everything appended since the last run (the importer resumes from its saved offsets).
 * When several sessions watch the same directory they all parse, but each commit is a
 * compare-and-set on the stored offset, so only one applies each fight.
 *
 * WoW starts a new WoWCombatLog-<date>_<time>.txt each time logging is enabled, so every file
 * but the newest in a directory is finished (imported with final=true); the newest is live
 * and its open fight is committed once the fight's end marker arrives.
 */
import { watch, type FSWatcher } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { big, queryRows, write } from "../db/duck.js";
import { importLogFile, type ImportResult } from "./importer.js";
import { ensureLocalTables, LOCAL_SCHEMA } from "./store.js";

const LOG_FILE_RE = /^WoWCombatLog.*\.txt$/i;
/** Wait for writes to settle before importing after a change event. */
const DEBOUNCE_MS = 2_000;
/** Fallback rescan, for filesystems where fs.watch misses events. */
const POLL_MS = 30_000;

interface DirWatch {
  dir: string;
  watcher: FSWatcher | null;
  poll: NodeJS.Timeout;
  timers: Map<string, NodeJS.Timeout>;
  lastError: string | null;
  lastImport: { file: string; at: number; result: ImportResult } | null;
}

const watches = new Map<string, DirWatch>();

/** Imports run one at a time across all directories to keep DB writes orderly. */
let queue: Promise<unknown> = Promise.resolve();
const queued = new Set<string>();
let busy: string | null = null;

/** The usual retail Logs locations for this OS, most likely first. */
export function defaultLogDirs(): string[] {
  const home = homedir();
  switch (process.platform) {
    case "win32":
      return [
        "C:\\Program Files (x86)\\World of Warcraft\\_retail_\\Logs",
        "C:\\Program Files\\World of Warcraft\\_retail_\\Logs",
        "D:\\World of Warcraft\\_retail_\\Logs",
      ];
    case "darwin":
      return [
        "/Applications/World of Warcraft/_retail_/Logs",
        join(home, "Applications", "World of Warcraft", "_retail_", "Logs"),
      ];
    default:
      return [
        join(home, "Games", "world-of-warcraft", "drive_c", "Program Files (x86)", "World of Warcraft", "_retail_", "Logs"),
        join(home, ".wine", "drive_c", "Program Files (x86)", "World of Warcraft", "_retail_", "Logs"),
      ];
  }
}

async function isDir(path: string): Promise<boolean> {
  return stat(path).then((s) => s.isDirectory(), () => false);
}

/** Resolve the directory to watch: the given one, or the first default that exists. */
export async function resolveLogDir(dir?: string): Promise<string> {
  if (dir) {
    const abs = resolve(dir);
    if (!(await isDir(abs))) throw new Error(`Not a directory: ${abs}`);
    return abs;
  }
  for (const candidate of defaultLogDirs()) if (await isDir(candidate)) return candidate;
  throw new Error(
    `No WoW Logs directory found. Tried:\n  ${defaultLogDirs().join("\n  ")}\n` +
      "Pass dir explicitly (World of Warcraft/_retail_/Logs).",
  );
}

/** Start watching `dir` (persisted), and catch up in the background. */
export async function watchDir(dir: string): Promise<{ dir: string; files: number; already_watching: boolean }> {
  await ensureLocalTables();
  await write((conn) =>
    conn.run(`INSERT OR REPLACE INTO ${LOCAL_SCHEMA}.watched_dirs VALUES ($path, $added_at, true)`, {
      path: dir,
      added_at: big(Date.now()),
    }),
  );
  const already = watches.has(dir);
  if (!already) startWatch(dir);
  const files = (await listLogFiles(dir)).length;
  void catchUp(dir);
  return { dir, files, already_watching: already };
}

/** Stop watching `dir` (or every directory) and forget it. Imported reports are kept. */
export async function unwatchDir(dir?: string): Promise<string[]> {
  await ensureLocalTables();
  const targets = dir ? [resolve(dir)] : [...new Set([...watches.keys(), ...(await savedDirs())])];
  for (const d of targets) {
    stopWatch(d);
    await write((conn) => conn.run(`DELETE FROM ${LOCAL_SCHEMA}.watched_dirs WHERE path = $path`, { path: d }));
  }
  return targets;
}

/** Resume every saved directory; called once on server start. Errors are kept per directory. */
export async function resumeWatches(): Promise<void> {
  for (const dir of await savedDirs()) {
    if (watches.has(dir)) continue;
    startWatch(dir);
    void catchUp(dir);
  }
}

async function savedDirs(): Promise<string[]> {
  await ensureLocalTables();
  const rows = await queryRows(`SELECT path FROM ${LOCAL_SCHEMA}.watched_dirs WHERE enabled ORDER BY path`);
  return rows.map((r) => String(r.path));
}

export function watchStatus() {
  return {
    busy_importing: busy,
    queued: [...queued],
    dirs: [...watches.values()].map((w) => ({
      dir: w.dir,
      live_events: w.watcher !== null,
      last_error: w.lastError,
      last_import: w.lastImport
        ? { file: w.lastImport.file, at: new Date(w.lastImport.at).toISOString(), ...w.lastImport.result }
        : null,
    })),
  };
}

function startWatch(dir: string): void {
  const w: DirWatch = {
    dir,
    watcher: null,
    poll: setInterval(() => void catchUp(dir), POLL_MS),
    timers: new Map(),
    lastError: null,
    lastImport: null,
  };
  w.poll.unref();
  try {
    w.watcher = watch(dir, (_event, filename) => {
      const name = filename?.toString();
      if (name && LOG_FILE_RE.test(name)) schedule(w, join(dir, name));
    });
    w.watcher.on("error", (err) => {
      w.lastError = `fs.watch: ${err.message} (falling back to polling every ${POLL_MS / 1000}s)`;
      w.watcher?.close();
      w.watcher = null;
    });
  } catch (err) {
    w.lastError = `fs.watch unavailable: ${(err as Error).message} (polling every ${POLL_MS / 1000}s)`;
  }
  watches.set(dir, w);
}

function stopWatch(dir: string): void {
  const w = watches.get(dir);
  if (!w) return;
  w.watcher?.close();
  clearInterval(w.poll);
  for (const t of w.timers.values()) clearTimeout(t);
  watches.delete(dir);
}

function schedule(w: DirWatch, file: string): void {
  clearTimeout(w.timers.get(file));
  const t = setTimeout(() => {
    w.timers.delete(file);
    void catchUp(w.dir);
  }, DEBOUNCE_MS);
  t.unref();
  w.timers.set(file, t);
}

async function listLogFiles(dir: string): Promise<Array<{ path: string; mtime: number }>> {
  const names = await readdir(dir).catch(() => [] as string[]);
  const files = [];
  for (const name of names) {
    if (!LOG_FILE_RE.test(name)) continue;
    const path = join(dir, name);
    const s = await stat(path).catch(() => null);
    if (s?.isFile()) files.push({ path, mtime: s.mtimeMs });
  }
  return files.sort((a, b) => a.mtime - b.mtime);
}

/** Import every log in `dir`, oldest first; all but the newest are finished files. */
function catchUp(dir: string): Promise<void> {
  const w = watches.get(dir);
  if (!w) return Promise.resolve();
  return enqueue(`dir:${dir}`, async () => {
    if (!(await savedDirs()).includes(dir)) {
      stopWatch(dir);
      return;
    }
    const files = await listLogFiles(dir);
    for (const [i, f] of files.entries()) {
      if (!watches.has(dir)) return;
      busy = f.path;
      try {
        const result = await importLogFile(f.path, { final: i < files.length - 1, respectIgnored: true });
        if (result.fights_added > 0 || result.status === "waiting") {
          w.lastImport = { file: f.path, at: Date.now(), result };
        }
        w.lastError = null;
      } catch (err) {
        w.lastError = `${f.path}: ${(err as Error).message}`;
        console.error(`wcl-mcp: importing ${f.path} failed:`, err);
      } finally {
        busy = null;
      }
    }
  });
}

function enqueue(key: string, task: () => Promise<void>): Promise<void> {
  if (queued.has(key)) return Promise.resolve();
  queued.add(key);
  const next = queue.then(async () => {
    queued.delete(key);
    await task();
  });
  queue = next.catch(() => undefined);
  return next;
}
