import type { WipefestInsight } from "./client.js";

/** Rows kept per player breakdown / timeline; Wipefest already sorts worst-first. */
const MAX_ROWS = 5;
const MAX_TIMELINE_EVENTS = 8;

/** Spell id Wipefest uses for auto-attacks ("Melee"); not a real spell to look up. */
const MELEE_SPELL_ID = 1;

/** Consumable / readiness insights: useful context, but not mechanics. */
const PREP_TITLE_RE = /^(Used \d+(\/\d+)? |Healed with )/;

const TAG_RE = /\{\[([^\]]*)\] ([^}]*)\}/g;
const SPELL_URL_RE = /spell=(\d+)/;

export interface Mechanic {
  /** Whole-fight summary, e.g. "Hit by Dread Breath (1232585) 22 times, taking additional damage...". */
  summary: string;
  spell_ids: number[];
  /** The same insight over the window ending at the first death; omitted when identical. */
  by_first_death?: string;
  /** Worst-offending players (or other rows) for the whole fight. */
  rows?: Record<string, string>[];
  /** Notable timestamped events (fight-relative m:ss). */
  timeline?: string[];
}

export interface PullInsights {
  duration_s: number;
  first_death_s: number | null;
  deaths: {
    whole_fight?: { summary: string; players?: Record<string, string>[] };
    by_first_death?: { summary: string; players?: Record<string, string>[] };
  };
  mechanics: Mechanic[];
  preparation: string[];
}

/**
 * Render Wipefest markup to plain text. Ability icons become "Name (spellId)"; the styled
 * text tag that usually repeats the name right after an icon is dropped; adjacent abilities
 * are comma-separated.
 */
export function renderMarkup(markup: string): string {
  // Drop the "{[style=..] Name}" echo that follows an icon tag of the same name.
  const deduped = markup.replace(
    /(\{\[[^\]]*spell=\d+[^\]]*\] ([^}]*)\})\s*\{\[style="[^"]*"\] \2\}/g,
    "$1",
  );
  const rendered = deduped.replace(TAG_RE, (_m, attrs: string, text: string) => {
    const spell = SPELL_URL_RE.exec(attrs);
    if (!spell) return text;
    const id = Number(spell[1]);
    return id === MELEE_SPELL_ID ? `\u0001${text}\u0002` : `\u0001${text} (${id})\u0002`;
  });
  return rendered
    .replace(/\u0002\s*\u0001/g, ", ")
    .replace(/[\u0001\u0002]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function spellIds(markup: string): number[] {
  const ids = [...markup.matchAll(/spell=(\d+)/g)].map((m) => Number(m[1]));
  return [...new Set(ids)].filter((id) => id !== MELEE_SPELL_ID);
}

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function stripHtml(s: string): string {
  return decodeHtmlEntities(s.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

/** Parse the JSON in a `data-component-data` attribute ({ and } are escaped as @@@ / |||). */
function componentData(details: string): { type: string; data: any } | undefined {
  const m = /data-component-type='(\w+)' data-component-data='([\s\S]*?)'>/.exec(details);
  if (!m) return undefined;
  try {
    const json = decodeHtmlEntities(m[2]!).replace(/@@@/g, "{").replace(/\|\|\|/g, "}");
    return { type: m[1]!, data: JSON.parse(json) };
  } catch {
    return undefined;
  }
}

function cellText(value: unknown): string {
  const raw =
    value && typeof value === "object" && "markup" in value
      ? String((value as { markup: unknown }).markup)
      : String(value ?? "");
  return renderMarkup(raw);
}

function formatTime(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** BarChartTable → [{ player: "X", Damage: "252k", Hits: "2" }, ...] */
function barChartRows(data: any): Record<string, string>[] {
  const columns: { id: string; title: string; type: string }[] = data?.columnDatas ?? [];
  const rows: Record<string, unknown>[] = data?.rowDatas ?? [];
  return rows.slice(0, MAX_ROWS).map((row) => {
    const out: Record<string, string> = {};
    for (const col of columns) {
      if (col.type === "bar") continue;
      const text = cellText(row[col.id]);
      if (!text) continue;
      const key = col.type === "actor" ? "player" : col.title || (col.id === "frequency" ? "count" : col.id);
      out[key] = text;
    }
    return out;
  });
}

/** FramesOfTimelines → ["0:20 Raid damaged by Nullzone (220k) from Vaelgor", ...] */
function timelineEvents(data: any): string[] {
  const events: { timestamp: number; title: string }[] = [];
  for (const frame of data?.frames ?? []) {
    for (const ev of frame?.timeline?.events ?? []) events.push(ev);
  }
  events.sort((a, b) => a.timestamp - b.timestamp);
  return events
    .slice(0, MAX_TIMELINE_EVENTS)
    .map((ev) => `${formatTime(ev.timestamp)} ${cellText(ev.title)}`);
}

/** Plain <table> → [{ Header: cell, ... }, ...] */
function htmlTableRows(html: string): Record<string, string>[] {
  const headerHtml = /<thead>([\s\S]*?)<\/thead>/.exec(html)?.[1] ?? "";
  const headers = [...headerHtml.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map((m) =>
    stripHtml(m[1]!),
  );
  const bodyHtml = /<tbody>([\s\S]*?)<\/tbody>/.exec(html)?.[1] ?? "";
  const rows = [...bodyHtml.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].slice(0, MAX_ROWS);
  return rows.map((row) => {
    const cells = [...row[1]!.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) =>
      renderMarkup(stripHtml(m[1]!)),
    );
    const out: Record<string, string> = {};
    cells.forEach((cell, i) => {
      if (cell) out[headers[i] || `col${i + 1}`] = cell;
    });
    return out;
  });
}

function details(insight: WipefestInsight): Pick<Mechanic, "rows" | "timeline"> {
  const html = insight.details ?? "";
  if (!html) return {};
  const component = componentData(html);
  if (component?.type === "BarChartTable") return { rows: barChartRows(component.data) };
  if (component?.type === "FramesOfTimelines") return { timeline: timelineEvents(component.data) };
  if (html.includes("<table")) return { rows: htmlTableRows(html) };
  const text = stripHtml(html);
  return text ? { rows: [{ details: text.slice(0, 300) }] } : {};
}

/** Identify the same insight across time windows (numbers and ability lists vary). */
function insightKey(insight: WipefestInsight): string {
  if (insight.title.startsWith("Died to")) return "deaths";
  const firstWords = insight.title.split(" ").slice(0, 2).join(" ");
  const firstSpell = SPELL_URL_RE.exec(insight.title)?.[1];
  return firstSpell
    ? `${firstWords}|${firstSpell}`
    : renderMarkup(insight.title).replace(/[\d.,]+[kmb%s]?/g, "#");
}

/**
 * Condense Wipefest's ~500KB insight payload into a compact summary: whole-fight mechanic
 * failures with player breakdowns, compared against the window ending at the first death.
 */
export function condenseInsights(insights: WipefestInsight[]): PullInsights {
  // Wipefest computes every insight once per window; each "Death" window ends at an early death.
  const whole = insights.filter((i) => i.interval.unit === "EntireFight");
  const deathEnds = insights
    .filter((i) => i.interval.unit === "Death")
    .map((i) => i.interval.endTimestamp);
  const firstDeathEnd = deathEnds.length ? Math.min(...deathEnds) : undefined;
  const early =
    firstDeathEnd === undefined
      ? []
      : insights.filter(
          (i) => i.interval.unit === "Death" && i.interval.endTimestamp === firstDeathEnd,
        );
  const earlyByKey = new Map(early.map((i) => [insightKey(i), i]));

  const result: PullInsights = {
    duration_s: Math.round((whole[0]?.interval.endTimestamp ?? 0) / 1000),
    first_death_s: firstDeathEnd === undefined ? null : Math.round(firstDeathEnd / 1000),
    deaths: {},
    mechanics: [],
    preparation: [],
  };

  for (const insight of whole) {
    const summary = renderMarkup(insight.title);
    const key = insightKey(insight);
    const earlyInsight = earlyByKey.get(key);

    if (key === "deaths") {
      result.deaths.whole_fight = { summary, players: details(insight).rows };
      if (earlyInsight) {
        result.deaths.by_first_death = {
          summary: renderMarkup(earlyInsight.title),
          players: details(earlyInsight).rows,
        };
      }
      continue;
    }
    if (PREP_TITLE_RE.test(summary)) {
      result.preparation.push(summary);
      continue;
    }

    const mechanic: Mechanic = { summary, spell_ids: spellIds(insight.title), ...details(insight) };
    if (earlyInsight) {
      const earlySummary = renderMarkup(earlyInsight.title);
      if (earlySummary !== summary) mechanic.by_first_death = earlySummary;
    } else if (firstDeathEnd !== undefined) {
      // Wipefest omits insights with nothing to report in a window.
      mechanic.by_first_death = "Nothing recorded before the first death.";
    }
    result.mechanics.push(mechanic);
  }

  return result;
}
