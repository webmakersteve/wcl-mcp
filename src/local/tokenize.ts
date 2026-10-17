/**
 * Low-level parsing of WoWCombatLog lines:
 *   `10/15/2026 21:08:08.802-4  SPELL_DAMAGE,Player-52-0E30DCFA,"Name-Realm-US",0x511,...`
 * A timestamp, two spaces, then a comma-separated list whose values can be quoted strings
 * or nested `[...]` / `(...)` lists (COMBATANT_INFO talents, gear, auras).
 */

/** A parsed field: a bare token or quoted string, or a nested list. */
export type Field = string | Field[];

const TIMESTAMP_RE = /^(\d+)\/(\d+)\/(\d+) (\d+):(\d+):(\d+)\.(\d+)([+-]\d+)?$/;

/**
 * Parse the line timestamp to Unix epoch ms. The trailing `±H` is the logger's UTC offset;
 * without one (older clients) the time is taken as UTC.
 */
export function parseTimestamp(text: string): number {
  const m = TIMESTAMP_RE.exec(text);
  if (!m) throw new Error(`Unrecognized combat log timestamp: ${JSON.stringify(text)}`);
  const [, mo, d, y, h, mi, s, ms, tz] = m;
  return Date.UTC(+y!, +mo! - 1, +d!, +h! - Number(tz ?? 0), +mi!, +s!, +ms!.padEnd(3, "0").slice(0, 3));
}

export interface RawLine {
  /** Unix epoch ms. */
  time: number;
  /** Event name, e.g. SPELL_DAMAGE. */
  event: string;
  /** Fields after the event name. */
  fields: Field[];
}

/**
 * Split a line into time, event and fields. Returns null for blank or malformed lines (a torn
 * write, or a file that isn't a combat log), so one bad line can't block an import.
 */
export function parseLine(line: string): RawLine | null {
  const sep = line.indexOf("  ");
  if (sep < 0) return null;
  const comma = line.indexOf(",", sep + 2);
  const event = comma < 0 ? line.slice(sep + 2) : line.slice(sep + 2, comma);
  if (!event) return null;
  const time = TIMESTAMP_RE.test(line.slice(0, sep)) ? parseTimestamp(line.slice(0, sep)) : NaN;
  if (Number.isNaN(time)) return null;
  return {
    time,
    event,
    fields: comma < 0 ? [] : parseFields(line, comma + 1),
  };
}

/** Parse a comma-separated field list starting at `start`, recursing into [] and (). */
export function parseFields(text: string, start = 0): Field[] {
  const pos = { i: start };
  return parseList(text, pos, "");
}

function parseList(text: string, pos: { i: number }, close: string): Field[] {
  const out: Field[] = [];
  if (close && text[pos.i] === close) {
    pos.i++;
    return out;
  }
  while (pos.i <= text.length) {
    out.push(parseValue(text, pos));
    const c = text[pos.i];
    pos.i++;
    if (c === ",") continue;
    // End of this list: the closing bracket, or end of line at the top level.
    break;
  }
  return out;
}

function parseValue(text: string, pos: { i: number }): Field {
  const c = text[pos.i];
  if (c === "[" || c === "(") {
    pos.i++;
    return parseList(text, pos, c === "[" ? "]" : ")");
  }
  if (c === '"') {
    let end = pos.i + 1;
    let value = "";
    for (;;) {
      const q = text.indexOf('"', end);
      if (q < 0) {
        value += text.slice(end);
        pos.i = text.length;
        return value;
      }
      // A backslash-escaped quote is part of the string.
      if (text[q - 1] === "\\") {
        value += text.slice(end, q - 1) + '"';
        end = q + 1;
        continue;
      }
      value += text.slice(end, q);
      pos.i = q + 1;
      return value;
    }
  }
  let end = pos.i;
  while (end < text.length && text[end] !== "," && text[end] !== "]" && text[end] !== ")") end++;
  const token = text.slice(pos.i, end);
  pos.i = end;
  return token;
}

/** A field as a string ("" for lists). */
export function str(f: Field | undefined): string {
  return typeof f === "string" ? f : "";
}

/** A numeric field; NaN-safe (returns 0 for nil, empty or non-numeric). */
export function num(f: Field | undefined): number {
  if (typeof f !== "string" || f === "" || f === "nil") return 0;
  const n = f.startsWith("0x") ? parseInt(f, 16) : Number(f);
  return Number.isFinite(n) ? n : 0;
}

/** A 1/nil/0 flag field. */
export function flag(f: Field | undefined): boolean {
  return f === "1";
}

/** A nested list field (empty for bare tokens). */
export function list(f: Field | undefined): Field[] {
  return Array.isArray(f) ? f : [];
}
