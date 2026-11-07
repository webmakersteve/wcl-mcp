/**
 * Client for WoW Log Server (https://github.com/webmakersteve/wow-log-server), which serves a
 * gaming PC's WoW Logs folders over HTTP. Lets the local-log tools import combat logs from
 * another machine on the network instead of from disk.
 *
 * The server indexes each file by line: it serves complete lines only (never a line WoW is
 * still writing), addresses them by 0-based line number with [start, end) ranges, and gives each
 * file a `fileId` (a hash of its first line) that changes if the file is replaced. So a remote
 * import's resume position is a line count, not a byte offset.
 *
 * Locations:
 *   http://host:5180                  every flavor's logs (a sync "directory")
 *   http://host:5180/retail           one flavor's logs
 *   http://host:5180/retail/<file>    one log file
 */
import { getConfig } from "../config.js";

/** Lines per /logs request. ~300 bytes per line in a combat log, so a few MB per response. */
const WINDOW_LINES = 20_000;
const REQUEST_TIMEOUT_MS = 120_000;

export function isRemoteLocation(location: string): boolean {
  return /^https?:\/\//i.test(location.trim());
}

export interface RemoteDir {
  /** Server origin, e.g. http://gaming-pc:5180. */
  base: string;
  /** Flavor id (retail, classic, ...), or null for all of them. */
  version: string | null;
  /** Normalized location, as saved. */
  location: string;
}

export interface RemoteFileRef {
  base: string;
  version: string;
  filename: string;
  location: string;
}

function parseUrl(location: string): { base: string; segments: string[] } {
  let url: URL;
  try {
    url = new URL(location.trim());
  } catch {
    throw new Error(`Not a valid WoW Log Server URL: ${location}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`WoW Log Server URLs must be http(s): ${location}`);
  }
  if (url.username || url.password) {
    throw new Error("Don't put credentials in the URL; set WOWLOG_API_KEY instead.");
  }
  // Accept a pasted API URL (http://host:5180/api/v1/...) by dropping the API path.
  const segments = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  const api = segments.indexOf("api");
  return { base: url.origin, segments: api >= 0 ? [] : segments };
}

export function parseRemoteDir(location: string): RemoteDir {
  const { base, segments } = parseUrl(location);
  if (segments.length > 1) {
    throw new Error(`Expected http://host:port or http://host:port/<version>, got: ${location}`);
  }
  const version = segments[0] ?? null;
  return { base, version, location: version ? `${base}/${encodeURIComponent(version)}` : base };
}

export function parseRemoteFile(location: string): RemoteFileRef {
  const { base, segments } = parseUrl(location);
  if (segments.length !== 2) {
    throw new Error(
      `Expected http://host:port/<version>/<filename> (e.g. http://gaming-pc:5180/retail/WoWCombatLog-110526_100931.txt), got: ${location}`,
    );
  }
  const [version, filename] = segments as [string, string];
  return { base, version, filename, location: remoteFileLocation(base, version, filename) };
}

export function remoteFileLocation(base: string, version: string, filename: string): string {
  return `${base}/${encodeURIComponent(version)}/${encodeURIComponent(filename)}`;
}

async function request(base: string, path: string, params: Record<string, string | number | undefined>): Promise<Response> {
  const url = new URL(path, base);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, String(v));
  const headers: Record<string, string> = {};
  const apiKey = getConfig().wowLogApiKey;
  if (apiKey) headers["X-Api-Key"] = apiKey;
  let res: Response;
  try {
    res = await fetch(url, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (err) {
    const cause = (err as { cause?: { message?: string } }).cause?.message ?? (err as Error).message;
    throw new Error(`Can't reach WoW Log Server at ${base} (${cause}). Is it running, and is its port allowed through the firewall?`);
  }
  if (res.status === 401) {
    throw new Error(`WoW Log Server at ${base} needs an API key: set WOWLOG_API_KEY to its WowLogServer:ApiKey.`);
  }
  return res;
}

async function errorText(res: Response): Promise<string> {
  const body = await res.text().catch(() => "");
  return `${res.status} ${res.statusText}${body ? `: ${body.slice(0, 300)}` : ""}`;
}

/** A log file as /api/v1/wow/files reports it. */
export interface RemoteFileInfo {
  version: string;
  filename: string;
  fileId: string;
  generation: number;
  /** Complete lines readable now. */
  lines: number;
  bytes: number;
  /** Being tailed (WoW is running in that flavor). */
  active: boolean;
}

export async function listRemoteFiles(base: string, version: string | null): Promise<RemoteFileInfo[]> {
  const res = await request(base, "/api/v1/wow/files", { version: version ?? undefined });
  if (!res.ok) throw new Error(`WoW Log Server ${base}: listing files failed: ${await errorText(res)}`);
  const body = (await res.json()) as { files?: unknown };
  if (!Array.isArray(body.files)) throw new Error(`WoW Log Server ${base}: unexpected /files response`);
  return body.files as RemoteFileInfo[];
}

export async function getRemoteFile(ref: RemoteFileRef): Promise<RemoteFileInfo> {
  const files = await listRemoteFiles(ref.base, ref.version);
  const file = files.find((f) => f.filename.toLowerCase() === ref.filename.toLowerCase());
  if (!file) throw new Error(`WoW Log Server ${ref.base} has no ${ref.version} log named ${ref.filename}`);
  return file;
}

/** The file was replaced on the server since its fileId was read (its line numbers changed). */
export class RemoteFileChanged extends Error {}

/**
 * Complete lines of a remote file from line `offset` (0-based) to the end, each with `end`: the
 * line number just past it (the position to resume from). Requests are pinned to `fileId`, so a
 * file replaced mid-read throws RemoteFileChanged instead of mixing two files' lines.
 * Each window is read fully before its lines are yielded, so slow consumers (database commits)
 * never stall the server's response stream.
 */
export async function* readRemoteLines(
  ref: RemoteFileRef,
  fileId: string,
  offset: number,
  maxLines = Infinity,
): AsyncGenerator<{ line: string; end: number }> {
  let pos = offset;
  let remaining = maxLines;
  while (remaining > 0) {
    const want = Math.min(WINDOW_LINES, remaining);
    const res = await request(ref.base, "/api/v1/wow/logs", {
      version: ref.version,
      filename: ref.filename,
      start: pos,
      end: pos + want,
      fileId,
    });
    if (res.status === 204) return; // caught up
    if (res.status === 409 || res.status === 416) {
      throw new RemoteFileChanged(`${ref.location} was replaced on the server (${await errorText(res)})`);
    }
    if (!res.ok) throw new Error(`WoW Log Server: reading ${ref.location} failed: ${await errorText(res)}`);

    const body = Buffer.from(await res.arrayBuffer());
    const data = splitBody(body, res.headers.get("content-type") ?? "");
    let got = 0;
    let start = 0;
    for (;;) {
      const nl = data.indexOf(0x0a, start);
      if (nl < 0) break;
      const lineEnd = nl > start && data[nl - 1] === 0x0d ? nl - 1 : nl;
      got++;
      yield { line: data.toString("utf8", start, lineEnd), end: pos + got };
      start = nl + 1;
    }
    if (got === 0) return;
    pos += got;
    remaining -= got;
    const total = Number(res.headers.get("x-total-lines"));
    if (Number.isFinite(total) && pos >= total) return;
  }
}

/**
 * The raw lines of a /logs response: the body for text/plain, the concatenated parts for
 * multipart/mixed (each part carries Content-Length; parts are contiguous and in order).
 */
function splitBody(body: Buffer, contentType: string): Buffer {
  const m = /^multipart\/[^;]+;.*boundary="?([^";]+)"?/i.exec(contentType);
  if (!m) return body;
  const delimiter = Buffer.from(`--${m[1]}`);
  const parts: Buffer[] = [];
  let pos = body.indexOf(delimiter);
  while (pos >= 0) {
    pos += delimiter.length;
    if (body[pos] === 0x2d && body[pos + 1] === 0x2d) break; // closing delimiter
    const headersEnd = body.indexOf("\r\n\r\n", pos);
    if (headersEnd < 0) break;
    const headers = body.toString("latin1", pos, headersEnd);
    const length = /^content-length:\s*(\d+)/im.exec(headers);
    const bodyStart = headersEnd + 4;
    if (length) {
      const bodyEnd = bodyStart + Number(length[1]);
      parts.push(body.subarray(bodyStart, bodyEnd));
      pos = body.indexOf(delimiter, bodyEnd);
    } else {
      const next = body.indexOf(Buffer.concat([Buffer.from("\r\n"), delimiter]), bodyStart);
      if (next < 0) break;
      parts.push(body.subarray(bodyStart, next));
      pos = next + 2;
    }
  }
  return Buffer.concat(parts);
}

/** Check a server is reachable before saving it as a sync location. */
export async function checkRemote(base: string, version: string | null): Promise<void> {
  const res = await request(base, "/api/v1/wow-versions", {});
  if (!res.ok) throw new Error(`${base} doesn't look like a WoW Log Server: ${await errorText(res)}`);
  if (version) {
    const versions = ((await res.json()) as { versions?: Array<{ id: string }> }).versions ?? [];
    if (!versions.some((v) => v.id === version)) {
      throw new Error(
        `WoW Log Server ${base} has no "${version}" install. Available: ${versions.map((v) => v.id).join(", ")}`,
      );
    }
  }
}
