import { createReadStream } from "node:fs";

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
