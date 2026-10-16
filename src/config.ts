import { homedir } from "node:os";
import { join, resolve } from "node:path";

// Configuration comes only from the process environment (e.g. `env` in .mcp.json). There's
// deliberately no .env loader: as a plugin, the server runs in the user's project directory,
// and that project's .env isn't ours.

const APP_DIR = "wcl-mcp";

/**
 * The wcl-mcp Warcraft Logs API client. Client ids aren't secret (they appear in every
 * authorize URL), so it ships in the code; WCL_CLIENT_ID overrides it to use your own client.
 */
const DEFAULT_CLIENT_ID = "01a145bb-9826-70ca-b69c-d6d99f5f4974";

/** Downloaded reports are kept this long unless WCL_REPORT_TTL_DAYS overrides it. */
const DEFAULT_REPORT_TTL_DAYS = 7;

/** Expand a leading `~` so env overrides like `~/wcl.duckdb` work. */
function expandHome(path: string): string {
  return path === "~" || path.startsWith("~/") || path.startsWith("~\\")
    ? join(homedir(), path.slice(1))
    : path;
}

/**
 * Per-user directory for durable, machine-local data (the DuckDB file), so it survives
 * across projects/sessions regardless of the server's working directory.
 * Windows: %LOCALAPPDATA% (not roaming — the file is a large, re-downloadable cache);
 * macOS: ~/Library/Application Support; Linux: $XDG_DATA_HOME or ~/.local/share.
 */
function defaultDataDir(): string {
  const home = homedir();
  switch (process.platform) {
    case "win32":
      return join(process.env.LOCALAPPDATA || join(home, "AppData", "Local"), APP_DIR);
    case "darwin":
      return join(home, "Library", "Application Support", APP_DIR);
    default:
      return join(process.env.XDG_DATA_HOME || join(home, ".local", "share"), APP_DIR);
  }
}

/** Per-user config directory (login tokens). Windows: %APPDATA%; else $XDG_CONFIG_HOME or ~/.config. */
function defaultConfigDir(): string {
  const home = homedir();
  if (process.platform === "win32") {
    return join(process.env.APPDATA || join(home, "AppData", "Roaming"), APP_DIR);
  }
  return join(process.env.XDG_CONFIG_HOME || join(home, ".config"), APP_DIR);
}

export interface Config {
  clientId: string;
  /**
   * Required for client-credentials (public-only) access. Optional once logged in with
   * `wcl-mcp login` if the WCL client is a public (PKCE-only) client.
   */
  clientSecret: string | undefined;
  /** Numeric WCL user id, used to scope find_reports to your own uploads. Optional. */
  userId: number | undefined;
  dbPath: string;
  /** Must exactly match a redirect URL registered on the WCL API client. */
  redirectUri: string;
  /** Where `wcl-mcp login` stores the user's OAuth tokens. */
  authPath: string;
  /** Downloaded reports are dropped this many days after download; 0 keeps them forever. */
  reportTtlDays: number;
}

let cached: Config | undefined;

/**
 * Read and validate configuration. Throws if required credentials are missing,
 * so the failure surfaces clearly on the first tool call rather than as an opaque
 * auth error later.
 */
export function getConfig(): Config {
  if (cached) return cached;

  const clientId = process.env.WCL_CLIENT_ID?.trim() || DEFAULT_CLIENT_ID;
  const clientSecret = process.env.WCL_CLIENT_SECRET?.trim() || undefined;

  const userIdRaw = process.env.WCL_USER_ID?.trim();
  let userId: number | undefined;
  if (userIdRaw) {
    const parsed = Number(userIdRaw);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new Error(`WCL_USER_ID must be a positive integer, got: ${userIdRaw}`);
    }
    userId = parsed;
  }

  // Relative overrides resolve against the working directory; the default is absolute.
  const dbPathRaw = process.env.WCL_DB_PATH?.trim();
  const dbPath = dbPathRaw
    ? resolve(expandHome(dbPathRaw))
    : join(defaultDataDir(), "wcl.duckdb");
  const redirectUri =
    process.env.WCL_REDIRECT_URI?.trim() || "http://localhost:8888/redirect";
  const authPathRaw = process.env.WCL_AUTH_PATH?.trim();
  const authPath = authPathRaw
    ? resolve(expandHome(authPathRaw))
    : join(defaultConfigDir(), "auth.json");

  const ttlRaw = process.env.WCL_REPORT_TTL_DAYS?.trim();
  const reportTtlDays = ttlRaw ? Number(ttlRaw) : DEFAULT_REPORT_TTL_DAYS;
  if (!Number.isFinite(reportTtlDays) || reportTtlDays < 0) {
    throw new Error(`WCL_REPORT_TTL_DAYS must be a non-negative number, got: ${ttlRaw}`);
  }

  cached = { clientId, clientSecret, userId, dbPath, redirectUri, authPath, reportTtlDays };
  return cached;
}
