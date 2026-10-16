/**
 * wago.tools client: per-table DB2 exports as CSV, pinned to a client build.
 * One request per table per build — callers cache by build, so this stays far
 * below any rate limit.
 */

const BASE_URL = "https://wago.tools";
const USER_AGENT = "wcl-mcp (local Warcraft Logs MCP server)";
/** Retail live. */
const PRODUCT = "wow";
const MAX_ATTEMPTS = 3;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function get(url: string): Promise<Response> {
  let lastError: Error | undefined;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (attempt > 1) await sleep(2000 * (attempt - 1));
    let res: Response;
    try {
      res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
    } catch (err) {
      lastError = new Error(`Network error fetching ${url}: ${String(err)}`);
      continue;
    }
    if (res.ok) return res;
    lastError = new Error(`wago.tools returned ${res.status} for ${url}`);
    // Retry only rate limiting and server errors; other 4xx won't change.
    if (res.status !== 429 && res.status < 500) throw lastError;
  }
  throw lastError ?? new Error(`Failed to fetch ${url}`);
}

interface WagoBuild {
  product: string;
  version: string;
  created_at: string;
}

/** Latest retail live build, e.g. "12.1.5.70391". */
export async function getLatestBuild(): Promise<string> {
  const res = await get(`${BASE_URL}/api/builds`);
  const all = (await res.json()) as Record<string, WagoBuild[]>;
  const builds = all[PRODUCT] ?? [];
  const latest = [...builds].sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
  if (!latest) throw new Error(`wago.tools returned no builds for product '${PRODUCT}'.`);
  return latest.version;
}

/** Download one DB2 table as CSV text for an exact build. */
export async function downloadTableCsv(table: string, build: string): Promise<string> {
  const url = `${BASE_URL}/db2/${encodeURIComponent(table)}/csv?build=${encodeURIComponent(build)}`;
  const res = await get(url);
  // The attachment name embeds the build actually served: "SpellName.12.1.5.70391.csv".
  const disposition = res.headers.get("content-disposition") ?? "";
  if (disposition && !disposition.includes(`${table}.${build}.csv`)) {
    throw new Error(`wago.tools served a different build for ${table}: ${disposition}`);
  }
  return res.text();
}
