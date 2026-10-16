import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Minimal .env loader. We avoid a runtime dependency: read .env once at startup
 * and populate any keys that aren't already set in the real environment.
 * (Real env vars always win over the file.)
 */
function loadDotEnv(): void {
  const path = resolve(process.cwd(), ".env");
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return; // no .env file — fine, rely on the process environment
  }
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadDotEnv();

export interface Config {
  clientId: string;
  clientSecret: string;
  /** Numeric WCL user id, used to scope find_reports to your own uploads. Optional. */
  userId: number | undefined;
  dbPath: string;
}

let cached: Config | undefined;

/**
 * Read and validate configuration. Throws if required credentials are missing,
 * so the failure surfaces clearly on the first tool call rather than as an opaque
 * auth error later.
 */
export function getConfig(): Config {
  if (cached) return cached;

  const clientId = process.env.WCL_CLIENT_ID?.trim();
  const clientSecret = process.env.WCL_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) {
    throw new Error(
      "Missing WCL credentials. Set WCL_CLIENT_ID and WCL_CLIENT_SECRET " +
        "(create a v2 API client at https://www.warcraftlogs.com/api/clients/).",
    );
  }

  const userIdRaw = process.env.WCL_USER_ID?.trim();
  let userId: number | undefined;
  if (userIdRaw) {
    const parsed = Number(userIdRaw);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new Error(`WCL_USER_ID must be a positive integer, got: ${userIdRaw}`);
    }
    userId = parsed;
  }

  const dbPath = process.env.WCL_DB_PATH?.trim() || "./data/wcl.duckdb";

  cached = { clientId, clientSecret, userId, dbPath };
  return cached;
}
