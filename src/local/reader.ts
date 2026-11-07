import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { getRemoteFile, readRemoteLines, type RemoteFileInfo, type RemoteFileRef } from "./remote.js";

/**
 * Read complete lines from `path` starting at byte `offset`, with the byte offset just past
 * each line (for resuming). A trailing partial line (WoW flushes the log in chunks) is not
 * yielded; the caller resumes from the last yielded `end` and picks it up once it's complete.
 */
export async function* readLines(
  path: string,
  offset: number,
): AsyncGenerator<{ line: string; end: number }> {
  let pos = offset;
  let carry: Buffer | null = null;
  for await (const chunk of createReadStream(path, { start: offset, highWaterMark: 1 << 20 })) {
    const buf: Buffer = carry ? Buffer.concat([carry, chunk as Buffer]) : (chunk as Buffer);
    let start = 0;
    for (;;) {
      const nl = buf.indexOf(0x0a, start);
      if (nl < 0) break;
      const lineEnd = nl > start && buf[nl - 1] === 0x0d ? nl - 1 : nl;
      pos += nl + 1 - start;
      yield { line: buf.toString("utf8", start, lineEnd), end: pos };
      start = nl + 1;
    }
    carry = start < buf.length ? buf.subarray(start) : null;
  }
}

/**
 * Where a log's lines come from: a file on disk, or a WoW Log Server on the network. Positions
 * (`size`, `end`, resume offsets) are in the source's own units: bytes for a file, complete
 * lines for a server (which indexes files by line). They're only ever compared within one kind
 * of source; the importer starts over if a log's stored position came from the other kind.
 */
export interface LogSource {
  /** Absolute path or normalized URL; stored as the ingest row's path. */
  location: string;
  remote: boolean;
  /** Current length: file size in bytes, or the server's readable line count. */
  size(): Promise<number>;
  /** Complete lines from `offset`, each with the position just past it; at most `maxLines`. */
  lines(offset: number, maxLines?: number): AsyncGenerator<{ line: string; end: number }>;
}

export function fileSource(path: string): LogSource {
  return {
    location: path,
    remote: false,
    size: () => stat(path).then((s) => s.size),
    async *lines(offset, maxLines = Infinity) {
      let n = 0;
      for await (const l of readLines(path, offset)) {
        if (n++ >= maxLines) return;
        yield l;
      }
    },
  };
}

/**
 * A log on a WoW Log Server. `info` (from /files) pins the source to one version of the file:
 * reads are checked against its fileId, so a file replaced on the server is detected.
 */
export function remoteSource(ref: RemoteFileRef, info?: RemoteFileInfo): LogSource {
  let pinned = info;
  const current = async () => (pinned ??= await getRemoteFile(ref));
  return {
    location: ref.location,
    remote: true,
    size: async () => (await current()).lines,
    async *lines(offset, maxLines) {
      yield* readRemoteLines(ref, (await current()).fileId, offset, maxLines);
    },
  };
}
