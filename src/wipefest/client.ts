import { assertValidReportCode } from "../db/schema.js";

/**
 * Wipefest (wipefest.gg) has no documented public API; this is the backend its web app uses.
 * The insights endpoint needs no auth for public reports.
 */
const WIPEFEST_API = "https://api.wipefest.gg";
const REQUEST_TIMEOUT_MS = 60_000;

export interface WipefestInterval {
  startTimestamp: number;
  endTimestamp: number;
  /** "EntireFight", "WipeCalled", or "Death" (one window per early death). */
  unit: string;
}

export interface WipefestInsight {
  interval: WipefestInterval;
  /** Wipefest markup: `{[url="...spell=N" style="icon"] Name}`, `{[style="info"] 24}`, ... */
  title: string;
  /** HTML: a data-component div (BarChartTable / FramesOfTimelines), a <table>, or plain text. */
  details?: string | null;
  major?: boolean;
}

/** Fetch Wipefest's mechanic insights for one fight (pull) of a Warcraft Logs report. */
export async function fetchFightInsights(
  reportCode: string,
  fightId: number,
): Promise<WipefestInsight[]> {
  assertValidReportCode(reportCode);
  const url =
    `${WIPEFEST_API}/report/${reportCode}/fight/${fightId}` +
    "?insightsOnly=true&markupFormat=markdown";

  const res = await fetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    let message = body.slice(0, 300);
    try {
      const parsed = JSON.parse(body) as { message?: string; error?: string };
      message = parsed.message ?? parsed.error ?? message;
    } catch {
      // non-JSON error body; use the raw text
    }
    throw new Error(`Wipefest returned HTTP ${res.status}: ${message}`);
  }

  const data = (await res.json()) as { insights?: WipefestInsight[] };
  return data.insights ?? [];
}
