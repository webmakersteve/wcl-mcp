/**
 * Minimal parser for the Lua table literals in MDT's dungeon data files
 * (`MDT.dungeonEnemies[dungeonIndex] = { ... }`). Handles exactly what those
 * files use: nested tables, `["key"] =` / `[1] =` / `key =` fields, positional
 * values, strings, numbers, booleans, nil, and `--` comments. Anything else
 * (function calls, locale lookups) throws, so a format change fails loudly.
 */

export type LuaValue = string | number | boolean | null | LuaTable;
export interface LuaTable {
  [key: string]: LuaValue;
}

class Parser {
  private pos = 0;

  constructor(private readonly src: string) {}

  parseValue(): LuaValue {
    this.skip();
    const c = this.src[this.pos];
    if (c === "{") return this.parseTable();
    if (c === '"' || c === "'") return this.parseString();
    if (c === "-" || c === "." || (c !== undefined && c >= "0" && c <= "9")) return this.parseNumber();
    const word = this.src.slice(this.pos).match(/^[A-Za-z_]\w*/)?.[0];
    if (word === "true" || word === "false" || word === "nil") {
      this.pos += word.length;
      return word === "nil" ? null : word === "true";
    }
    throw this.error("unsupported value");
  }

  private parseTable(): LuaTable {
    this.expect("{");
    const out: LuaTable = {};
    let nextIndex = 1;
    for (;;) {
      this.skip();
      if (this.src[this.pos] === "}") {
        this.pos++;
        return out;
      }
      let key: string | undefined;
      if (this.src[this.pos] === "[") {
        this.pos++;
        const k = this.parseValue();
        if (typeof k !== "string" && typeof k !== "number") throw this.error("bad table key");
        key = String(k);
        this.skip();
        this.expect("]");
        this.skip();
        this.expect("=");
      } else {
        const ident = this.src.slice(this.pos).match(/^([A-Za-z_]\w*)\s*=(?!=)/);
        if (ident && ident[1] !== "true" && ident[1] !== "false" && ident[1] !== "nil") {
          key = ident[1];
          this.pos += ident[0].length;
        }
      }
      const value = this.parseValue();
      if (key === undefined) key = String(nextIndex++);
      if (value !== null) out[key] = value;
      this.skip();
      const sep = this.src[this.pos];
      if (sep === "," || sep === ";") this.pos++;
      else if (sep !== "}") throw this.error("expected ',' or '}'");
    }
  }

  private parseString(): string {
    const quote = this.src[this.pos++];
    let out = "";
    while (this.pos < this.src.length) {
      const c = this.src[this.pos++];
      if (c === quote) return out;
      if (c === "\\") {
        const e = this.src[this.pos++];
        out += e === "n" ? "\n" : e === "t" ? "\t" : e;
      } else {
        out += c;
      }
    }
    throw this.error("unterminated string");
  }

  private parseNumber(): number {
    const m = this.src.slice(this.pos).match(/^-?(0x[0-9a-fA-F]+|\d*\.?\d+(?:[eE][-+]?\d+)?)/);
    if (!m) throw this.error("bad number");
    this.pos += m[0].length;
    return Number(m[0]);
  }

  /** Skip whitespace and `--` line comments (MDT data has no block comments). */
  skip(): void {
    for (;;) {
      const ws = this.src.slice(this.pos).match(/^\s+/);
      if (ws) this.pos += ws[0].length;
      if (this.src.startsWith("--", this.pos)) {
        const nl = this.src.indexOf("\n", this.pos);
        this.pos = nl === -1 ? this.src.length : nl + 1;
        continue;
      }
      return;
    }
  }

  private expect(c: string): void {
    if (this.src[this.pos] !== c) throw this.error(`expected '${c}'`);
    this.pos++;
  }

  private error(msg: string): Error {
    const line = this.src.slice(0, this.pos).split("\n").length;
    return new Error(`Lua parse error at line ${line}: ${msg}`);
  }
}

/**
 * Parse the table literal assigned by the first `<lhs> =` in `source`, or
 * undefined if there's no such assignment.
 */
export function parseAssignedTable(source: string, lhs: string): LuaTable | undefined {
  const at = source.indexOf(lhs);
  if (at === -1) return undefined;
  const eq = source.indexOf("=", at + lhs.length);
  const value = new Parser(source.slice(eq + 1)).parseValue();
  if (value === null || typeof value !== "object") {
    throw new Error(`${lhs} is not a table.`);
  }
  return value;
}
