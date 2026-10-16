/**
 * Best-effort renderer for WoW spell description templates.
 *
 * Templates reference spell data with `$` tokens — `$s1` (effect 1 value),
 * `$d` (duration), `$157644s1` (another spell's value), `$@spelldesc123`
 * (another spell's description), `$?a123[if][else]` (talent/aura
 * conditionals), `${$s1*2}` (arithmetic), `$<name>` (named variables).
 *
 * Values that depend on the player's character (spell power, level, talents)
 * can't be known here, so they're rendered as readable text instead —
 * "(388% of Spell Power)", "[with Pyrotechnics: ...]". Unknown tokens are left
 * as-is rather than guessed.
 */

export interface EffectInfo {
  /** Effect type code (2 = school damage, 6 = apply aura, 10 = heal, ...). */
  effect: number;
  /** Aura type code when the effect applies an aura. */
  aura: number;
  basePoints: number;
  spCoefficient: number;
  apCoefficient: number;
  periodMs: number;
  amplitude: number;
  chainTargets: number;
  radiusYd: number | null;
}

export interface SpellInfo {
  id: number;
  name: string;
  description: string;
  auraDescription: string;
  /** Keyed by 1-based effect number, as used in tokens ($s1 = effect 1). */
  effects: Map<number, EffectInfo>;
  durationMs: number | null;
  rangeYd: number | null;
  procChance: number | null;
  procCharges: number | null;
  maxStacks: number | null;
  /** Raw `$name=expr` lines from SpellDescriptionVariables. */
  variables: string | null;
}

export type SpellLookup = (id: number) => SpellInfo | undefined;

const MAX_INCLUDE_DEPTH = 4;

/** Spell ids a template references, so callers can preload them. */
export function referencedSpellIds(text: string): number[] {
  const ids = new Set<number>();
  // $@spelldesc123, $123s1, a123/s123 in conditions, and bare ?123 (seen in client data).
  for (const m of text.matchAll(/\$@[a-z]+(\d+)|\$(\d+)[a-zA-Z]|[as](\d{3,})|\?!?(\d{3,})/g)) {
    const id = Number(m[1] ?? m[2] ?? m[3] ?? m[4]);
    if (id > 0) ids.add(id);
  }
  return [...ids];
}

/** Render a spell's description (or aura tooltip) to plain text. */
export function renderSpellText(
  spellId: number,
  which: "description" | "aura",
  lookup: SpellLookup,
): string {
  const spell = lookup(spellId);
  if (!spell) return "";
  const text = which === "aura" ? spell.auraDescription : spell.description;
  const r = new Renderer(lookup);
  return cleanup(r.text(text, spellId, new Set([spellId])));
}

/** Strip UI escape codes (colors, textures, links) and tidy whitespace. */
function cleanup(s: string): string {
  return s
    .replace(/\|c[0-9a-f]{8}/gi, "")
    .replace(/\|r/gi, "")
    .replace(/\|T[^|]*\|t/g, "")
    .replace(/\|H[^|]*\|h(.*?)\|h/g, "$1")
    .replace(/\|n/g, "\n")
    .replace(/\r\n?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const PLAYER_STATS: Record<string, string> = {
  sp: "Spell Power",
  sps: "Spell Power",
  ap: "Attack Power",
  rap: "Ranged Attack Power",
  pl: "player level",
  mhp: "maximum health",
  mws: "weapon speed",
};

function fmtNumber(n: number, decimals?: number): string {
  if (decimals !== undefined) return n.toFixed(decimals);
  if (Math.abs(n - Math.round(n)) < 1e-6) return String(Math.round(n));
  return String(Number(n.toFixed(2)));
}

function fmtDuration(ms: number | null): string {
  if (ms === null) return "?";
  if (ms <= 0) return "until cancelled";
  const sec = ms / 1000;
  if (sec < 60) return `${fmtNumber(sec)} sec`;
  if (sec < 3600) return `${fmtNumber(sec / 60)} min`;
  return `${fmtNumber(sec / 3600)} hr`;
}

/** Index of the bracket closing the one at `open`, or -1. */
function matchBracket(s: string, open: number, o: string, c: string): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === o) depth++;
    else if (s[i] === c && --depth === 0) return i;
  }
  return -1;
}

const MAX_VARIABLE_DEPTH = 8;

/** Effects whose bonus coefficient means "% of Spell/Attack Power": school damage, heal. */
const STAT_SCALED_EFFECTS = new Set([2, 10]);
/** Aura types whose coefficient is stat scaling: periodic damage/heal/leech, absorb. */
const STAT_SCALED_AURAS = new Set([3, 8, 53, 69]);

/**
 * The client reuses EffectBonusCoefficient for other scalings (notably mastery
 * coefficients on mastery auras), so only attribute it to Spell/Attack Power
 * for damage, healing, and absorb effects.
 */
function isStatScaled(fx: EffectInfo): boolean {
  return STAT_SCALED_EFFECTS.has(fx.effect) || (fx.aura !== 0 && STAT_SCALED_AURAS.has(fx.aura));
}

class Renderer {
  /** Nesting depth of $<name> evaluation; variables may reference each other. */
  private variableDepth = 0;

  constructor(private readonly lookup: SpellLookup) {}

  private effect(spellId: number, n: number): EffectInfo | undefined {
    return this.lookup(spellId)?.effects.get(n);
  }

  /**
   * Units of stat-scaled tokens seen while rendering the current ${...}
   * expression. Such tokens evaluate to their coefficient as a percentage, so a
   * linear expression like ${$s1*2} still yields "(N% of Spell Power)".
   */
  private scaledUnits = new Set<string>();

  /** An effect's value: flat base points, or a stat coefficient as a percentage. */
  private effectValue(fx: EffectInfo): { n: number; unit: string | null } | null {
    if (fx.basePoints !== 0) return { n: Math.abs(fx.basePoints), unit: null };
    if (!isStatScaled(fx)) return null;
    if (fx.spCoefficient > 0 && !(fx.apCoefficient > 0)) return { n: fx.spCoefficient * 100, unit: "Spell Power" };
    if (fx.apCoefficient > 0 && !(fx.spCoefficient > 0)) return { n: fx.apCoefficient * 100, unit: "Attack Power" };
    // Base 0 and no single coefficient: the value is set at runtime (talents, damage done, ...).
    return null;
  }

  /**
   * Numeric value for a letter token, or null when it isn't knowable. With
   * `scaled`, stat-scaled values return their percentage and record the unit.
   */
  private value(letter: string, spellId: number, n: number, scaled = false): number | null {
    const spell = this.lookup(spellId);
    const fx = this.effect(spellId, n);
    switch (letter.toLowerCase()) {
      case "s":
      case "m":
      case "w":
      case "b":
      case "o": {
        if (!fx) return null;
        const v = this.effectValue(fx);
        if (!v || (v.unit && !scaled)) return null;
        if (v.unit) this.scaledUnits.add(v.unit);
        if (letter.toLowerCase() !== "o") return v.n;
        // $o: total over the aura's duration.
        if (!spell?.durationMs || spell.durationMs <= 0 || !fx.periodMs) return null;
        return v.n * Math.floor(spell.durationMs / fx.periodMs);
      }
      case "t":
        return fx && fx.periodMs ? fx.periodMs / 1000 : null;
      case "d":
        return spell?.durationMs && spell.durationMs > 0 ? spell.durationMs / 1000 : null;
      case "a":
        return fx?.radiusYd ?? null;
      case "r":
        return spell?.rangeYd ?? null;
      case "h":
        return spell?.procChance ?? null;
      case "n":
        return spell?.procCharges ?? null;
      case "u":
        return spell?.maxStacks ?? null;
      case "x":
        return fx ? fx.chainTargets : null;
      case "e":
        return fx ? fx.amplitude : null;
      default:
        return null;
    }
  }

  /** Text for a letter token, falling back to a readable description of the scaling. */
  private tokenText(letter: string, spellId: number, n: number): string | null {
    const l = letter.toLowerCase();
    if (l === "d") return fmtDuration(this.lookup(spellId)?.durationMs ?? null);
    const v = this.value(letter, spellId, n);
    if (v !== null) return fmtNumber(v);
    const fx = this.effect(spellId, n);
    if (fx && "smwbo".includes(l)) {
      const parts = [];
      if (!isStatScaled(fx)) return "(varies)";
      if (fx.spCoefficient > 0) parts.push(`${fmtNumber(fx.spCoefficient * 100)}% of Spell Power`);
      if (fx.apCoefficient > 0) parts.push(`${fmtNumber(fx.apCoefficient * 100)}% of Attack Power`);
      if (parts.length) return `(${parts.join(" + ")}${l === "o" ? " over the duration" : ""})`;
      return "(varies)";
    }
    return null; // unknown: caller keeps the raw token
  }

  private conditionText(cond: string): string {
    return cond
      .replace(/(!)?([as]?)(\d{3,})/g, (_m, not: string | undefined, _k, id: string) => {
        const name = this.lookup(Number(id))?.name ?? `spell ${id}`;
        return `${not ? "not " : ""}${name}`;
      })
      .replace(/\bc(\d)\b/g, "specialization $1")
      .replace(/\|/g, " or ")
      .replace(/&/g, " and ");
  }

  /**
   * Render template text. In `valueMode` (inside `${...}` and variables), tokens
   * become bare numbers or "NaN" so the result can be evaluated arithmetically.
   */
  text(src: string, spellId: number, stack: Set<number>, valueMode = false): string {
    let out = "";
    let i = 0;
    while (i < src.length) {
      const dollar = src.indexOf("$", i);
      if (dollar === -1) {
        out += src.slice(i);
        break;
      }
      out += src.slice(i, dollar);
      i = dollar;
      const rest = src.slice(i);
      let m: RegExpMatchArray | null;

      // $@spelldesc123 / $@spellaura123 / $@spellname123 / $@versadmg ...
      if ((m = rest.match(/^\$@([a-z]+)(\d*)/))) {
        const [, kind, idStr] = m;
        const id = Number(idStr);
        i += m[0].length;
        if (valueMode) {
          out += "0"; // player-dependent multipliers like $@versadmg
          continue;
        }
        const target = this.lookup(id);
        if (kind === "spellname") out += target?.name ?? m[0];
        else if (kind === "spelldesc" || kind === "spellaura" || kind === "spelltooltip") {
          if (!target || stack.has(id) || stack.size >= MAX_INCLUDE_DEPTH) continue;
          const inner = kind === "spellaura" ? target.auraDescription : target.description;
          out += this.text(inner, id, new Set([...stack, id]));
        }
        // spellicon and unknown includes render as nothing
        continue;
      }

      // $?cond[A]?cond[B][C]
      if (rest.startsWith("$?")) {
        const branches: Array<{ cond: string | null; body: string }> = [];
        let j = i + 1;
        while (src[j] === "?") {
          const open = src.indexOf("[", j);
          const close = open === -1 ? -1 : matchBracket(src, open, "[", "]");
          if (close === -1) break;
          branches.push({ cond: src.slice(j + 1, open), body: src.slice(open + 1, close) });
          j = close + 1;
        }
        if (src[j] === "[") {
          const close = matchBracket(src, j, "[", "]");
          if (close !== -1) {
            branches.push({ cond: null, body: src.slice(j + 1, close) });
            j = close + 1;
          }
        }
        if (branches.length === 0) {
          out += "$?";
          i += 2;
          continue;
        }
        i = j;
        if (valueMode) {
          // Can't know the player's talents; use the default (last) branch.
          out += this.text(branches[branches.length - 1].body, spellId, stack, true);
          continue;
        }
        const parts = branches
          .map((b) => ({ cond: b.cond, body: this.text(b.body, spellId, stack).trim() }))
          .filter((b) => b.body !== "")
          .map((b) => (b.cond === null ? `otherwise: ${b.body}` : `with ${this.conditionText(b.cond)}: ${b.body}`));
        if (parts.length) out += `[${parts.join(" | ")}]`;
        continue;
      }

      // ${expr} with optional .N precision
      if (rest.startsWith("${")) {
        const close = matchBracket(src, i + 1, "{", "}");
        if (close === -1) {
          out += "${";
          i += 2;
          continue;
        }
        const expr = src.slice(i + 2, close);
        i = close + 1;
        const prec = src.slice(i).match(/^\.(\d)/);
        if (prec) i += prec[0].length;
        if (valueMode) {
          // Nested inside another expression: units propagate to the outer one.
          const v = evaluate(this.text(expr, spellId, stack, true));
          out += v === null ? "NaN" : String(v);
          continue;
        }
        const outerUnits = this.scaledUnits;
        this.scaledUnits = new Set();
        const v = evaluate(this.text(expr, spellId, stack, true));
        const units = [...this.scaledUnits];
        this.scaledUnits = outerUnits;
        const decimals = prec ? Number(prec[1]) : undefined;
        if (v !== null && units.length === 0) out += fmtNumber(Math.abs(v), decimals);
        else if (v !== null && units.length === 1) out += `(${fmtNumber(Math.abs(v), decimals)}% of ${units[0]})`;
        else {
          const inner = this.text(expr, spellId, stack).replace(/\s+/g, " ").trim();
          out += /^\([^()]*\)$/.test(inner) ? inner : `(${inner})`;
        }
        continue;
      }

      // $<name> description variable
      if ((m = rest.match(/^\$<(\w+)>/))) {
        i += m[0].length;
        const v = this.variable(m[1], spellId, stack);
        if (valueMode) out += v === null ? "NaN" : String(v);
        else out += v === null ? `<${m[1]}>` : fmtNumber(Math.abs(v));
        continue;
      }

      // $gmale:female; / $lsingular:plural;
      if ((m = rest.match(/^\$([gGlL])([^:;]*):([^;]*);/))) {
        i += m[0].length;
        out += m[1].toLowerCase() === "g" ? m[2] : m[3];
        continue;
      }

      // Player stats: $SP, $AP, $pl, ...
      if ((m = rest.match(/^\$([a-zA-Z]{2,3})(?![a-zA-Z\d])/)) && PLAYER_STATS[m[1].toLowerCase()]) {
        i += m[0].length;
        out += valueMode ? "NaN" : PLAYER_STATS[m[1].toLowerCase()];
        continue;
      }

      // Functions inside expressions: $max(a,b), $min, $floor, $ceil, $abs, $cond
      if (valueMode && (m = rest.match(/^\$(max|min|floor|ceil|abs|cond)\(/i))) {
        i += m[0].length;
        out += `${m[1].toLowerCase()}(`;
        continue;
      }

      // Legacy $/N;S1 and $*N;S1 scaling forms
      if ((m = rest.match(/^\$([/*])(\d+);(\d+)?([a-zA-Z])(\d)?/))) {
        i += m[0].length;
        const v = this.value(m[4], m[3] ? Number(m[3]) : spellId, Number(m[5] ?? 1));
        const scaled = v === null ? null : m[1] === "/" ? v / Number(m[2]) : v * Number(m[2]);
        out += scaled === null ? (valueMode ? "NaN" : m[0]) : valueMode ? String(scaled) : fmtNumber(scaled);
        continue;
      }

      // $s1, $d, $157644s1, $t2, $A1, ...
      if ((m = rest.match(/^\$(\d+)?([a-zA-Z])(\d)?/))) {
        const target = m[1] ? Number(m[1]) : spellId;
        const n = Number(m[3] ?? 1);
        if (valueMode) {
          const v = this.value(m[2], target, n, true);
          out += v === null ? "NaN" : String(v);
          i += m[0].length;
          continue;
        }
        const t = this.tokenText(m[2], target, n);
        out += t ?? m[0];
        i += m[0].length;
        continue;
      }

      out += "$";
      i++;
    }
    return out;
  }

  private variable(name: string, spellId: number, stack: Set<number>): number | null {
    const defs = this.lookup(spellId)?.variables;
    if (!defs) return null;
    for (const line of defs.split(/\r?\n/)) {
      const m = line.match(/^\s*\$(\w+)\s*=(.*)$/);
      if (m && m[1] === name) {
        if (this.variableDepth >= MAX_VARIABLE_DEPTH) return null;
        this.variableDepth++;
        try {
          return evaluate(this.text(m[2], spellId, stack, true));
        } finally {
          this.variableDepth--;
        }
      }
    }
    return null;
  }
}

/**
 * Safe arithmetic evaluator: numbers, + - * /, parentheses, unary minus, and
 * max/min/floor/ceil/abs/cond. Returns null for anything else (never eval()).
 */
export function evaluate(expr: string): number | null {
  const tokens = expr.match(/\d+\.?\d*|\.\d+|[a-z]+|[-+*/(),<>=!]|\S/g);
  if (!tokens) return null;
  let pos = 0;
  const peek = () => tokens[pos];
  const fail = (): never => {
    throw new Error("bad expression");
  };

  const primary = (): number => {
    const t = tokens[pos++];
    if (t === undefined) return fail();
    if (t === "-") return -primary();
    if (t === "+") return primary();
    if (t === "(") {
      const v = additive();
      if (tokens[pos++] !== ")") fail();
      return v;
    }
    if (/^[a-z]+$/.test(t)) {
      if (tokens[pos++] !== "(") fail();
      const args = [additive()];
      while (peek() === ",") {
        pos++;
        args.push(additive());
      }
      if (tokens[pos++] !== ")") fail();
      switch (t) {
        case "max":
          return Math.max(...args);
        case "min":
          return Math.min(...args);
        case "floor":
          return Math.floor(args[0]);
        case "ceil":
          return Math.ceil(args[0]);
        case "abs":
          return Math.abs(args[0]);
        case "cond":
          return args[0] ? args[1] : (args[2] ?? 0);
        default:
          return fail();
      }
    }
    const n = Number(t);
    return Number.isFinite(n) ? n : fail();
  };
  const multiplicative = (): number => {
    let v = primary();
    while (peek() === "*" || peek() === "/") {
      const op = tokens[pos++];
      const r = primary();
      v = op === "*" ? v * r : v / r;
    }
    return v;
  };
  const additive = (): number => {
    let v = multiplicative();
    while (peek() === "+" || peek() === "-") {
      const op = tokens[pos++];
      const r = multiplicative();
      v = op === "+" ? v + r : v - r;
    }
    return v;
  };

  try {
    if (/NaN/.test(expr)) return null;
    const v = additive();
    if (pos !== tokens.length || !Number.isFinite(v)) return null;
    return v;
  } catch {
    return null;
  }
}
