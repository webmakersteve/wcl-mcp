/**
 * Saved WoW Logs directories, synced on request (sync_local_logs): each sync imports whatever
 * was appended to the directory's combat logs since the last one. There's no background
 * watching; the importer resumes from saved offsets, so a sync only parses what's new.
 *
 * A "directory" can also be a WoW Log Server URL (http://host:port, or http://host:port/retail
 * for one flavor): the combat logs of a WoW install on another machine, read over the network.
 *
 * WoW starts a new WoWCombatLog-<date>_<time>.txt each time logging is enabled, so every file
 * but the newest in a directory is finished (imported with final=true); the newest may still
 * be written to, so a fight still open at its end waits for the next sync.
 */
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { big, queryRows, write } from "../db/duck.js";
import { importLogFile, type ImportResult } from "./importer.js";
import { fileSource, remoteSource, type LogSource } from "./reader.js";
import {
  checkRemote,
  isRemoteLocation,
  listRemoteFiles,
  parseRemoteDir,
  remoteFileLocation,
  type RemoteFileInfo,
} from "./remote.js";
import { ensureLocalTables, LOCAL_SCHEMA } from "./store.js";

const LOG_FILE_RE = /^WoWCombatLog.*\.txt$/i;

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

export async function savedDirs(): Promise<string[]> {
  await ensureLocalTables();
  const rows = await queryRows(`SELECT path FROM ${LOCAL_SCHEMA}.log_dirs ORDER BY path`);
  return rows.map((r) => String(r.path));
}

async function saveDir(dir: string): Promise<void> {
  await ensureLocalTables();
  await write((conn) =>
    conn.run(`INSERT OR IGNORE INTO ${LOCAL_SCHEMA}.log_dirs VALUES ($path, $added_at)`, {
      path: dir,
      added_at: big(Date.now()),
    }),
  );
}

/** Forget a saved directory (or all of them). Imported reports are kept. */
export async function forgetDirs(dir?: string): Promise<string[]> {
  const targets = dir ? [normalizeDir(dir)] : await savedDirs();
  for (const d of targets) {
    await write((conn) => conn.run(`DELETE FROM ${LOCAL_SCHEMA}.log_dirs WHERE path = $path`, { path: d }));
  }
  return targets;
}

/**
 * The directories to sync: `dir` (saved for next time), else every saved directory, else the
 * first default install location that exists (also saved).
 */
function normalizeDir(dir: string): string {
  return isRemoteLocation(dir) ? parseRemoteDir(dir).location : resolve(dir);
}

async function dirsToSync(dir?: string): Promise<string[]> {
  if (dir && isRemoteLocation(dir)) {
    const remote = parseRemoteDir(dir);
    await checkRemote(remote.base, remote.version);
    await saveDir(remote.location);
    return [remote.location];
  }
  if (dir) {
    const abs = resolve(dir);
    if (!(await isDir(abs))) throw new Error(`Not a directory: ${abs}`);
    await saveDir(abs);
    return [abs];
  }
  const saved = await savedDirs();
  if (saved.length > 0) return saved;
  for (const candidate of defaultLogDirs()) {
    if (await isDir(candidate)) {
      await saveDir(candidate);
      return [candidate];
    }
  }
  throw new Error(
    `No saved log directory and no WoW Logs directory found. Tried:\n  ${defaultLogDirs().join("\n  ")}\n` +
      "Pass dir explicitly (World of Warcraft/_retail_/Logs), or a WoW Log Server URL " +
      "(http://<gaming-pc>:5180) to read the logs from another machine.",
  );
}

/** A directory's combat logs, in groups each oldest first (a group's last file may still be written). */
async function listLogFiles(dir: string): Promise<LogSource[][]> {
  if (isRemoteLocation(dir)) return listRemoteLogFiles(dir);
  return [(await listDiskLogFiles(dir)).map((f) => fileSource(f.path))];
}

async function listDiskLogFiles(dir: string): Promise<Array<{ path: string; mtime: number }>> {
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

/**
 * Sort key for WoWCombatLog-MMDDYY_HHMMSS.txt (the time logging started), so a server's files
 * order by age without trusting its timestamps. Names without that pattern sort first.
 */
function logNameKey(name: string): string {
  const m = /-(\d\d)(\d\d)(\d\d)_(\d{6})/.exec(name);
  return m ? `1${m[3]}${m[1]}${m[2]}${m[4]}` : `0${name.toLowerCase()}`;
}

/** A WoW Log Server's combat logs, one group per flavor (each has its own newest file). */
async function listRemoteLogFiles(dir: string): Promise<LogSource[][]> {
  const remote = parseRemoteDir(dir);
  const byVersion = new Map<string, RemoteFileInfo[]>();
  for (const f of await listRemoteFiles(remote.base, remote.version)) {
    if (!LOG_FILE_RE.test(f.filename)) continue;
    byVersion.set(f.version, [...(byVersion.get(f.version) ?? []), f]);
  }
  return [...byVersion.entries()].map(([version, files]) =>
    files
      .sort((a, b) => logNameKey(a.filename).localeCompare(logNameKey(b.filename)))
      .map((f) =>
        remoteSource(
          {
            base: remote.base,
            version,
            filename: f.filename,
            location: remoteFileLocation(remote.base, version, f.filename),
          },
          f,
        ),
      ),
  );
}

export interface DirSync {
  dir: string;
  files: Array<{ file: string } & ImportResult>;
  errors: Array<{ file: string; error: string }>;
}

/** Import what's new in every log file of the directories to sync, oldest file first. */
export async function syncDirs(dir?: string): Promise<DirSync[]> {
  const out: DirSync[] = [];
  for (const d of await dirsToSync(dir)) {
    const result: DirSync = { dir: d, files: [], errors: [] };
    let groups: LogSource[][];
    try {
      groups = await listLogFiles(d);
    } catch (err) {
      // An unreachable server mustn't stop the other saved directories from syncing.
      result.errors.push({ file: d, error: (err as Error).message });
      out.push(result);
      continue;
    }
    for (const files of groups) {
      for (const [i, f] of files.entries()) {
        try {
          const r = await importLogFile(f, { final: i < files.length - 1, respectIgnored: true });
          result.files.push({ file: f.location, ...r });
        } catch (err) {
          result.errors.push({ file: f.location, error: (err as Error).message });
        }
      }
    }
    out.push(result);
  }
  return out;
}
