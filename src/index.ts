#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { downloadReport, downloadReportShape } from "./tools/download-report.js";
import {
  deleteLocalReport,
  deleteLocalReportShape,
} from "./tools/delete-local-report.js";
import {
  getReportDetails,
  getReportDetailsShape,
} from "./tools/get-report-details.js";
import { findReports, findReportsShape } from "./tools/find-reports.js";
import {
  executeReadonlyQuery,
  executeReadonlyQueryShape,
} from "./tools/execute-readonly-query.js";
import { lookupSpells, lookupSpellsShape } from "./tools/lookup-spells.js";
import { syncGameDataTool, syncGameDataShape } from "./tools/sync-game-data.js";
import { getPullInsights, getPullInsightsShape } from "./tools/get-pull-insights.js";
import { importMdtRoute, importMdtRouteShape } from "./tools/import-mdt-route.js";
import { authStatus, authStatusShape, login, loginShape, logout, logoutShape } from "./tools/auth.js";
import {
  forgetLogDir,
  forgetLogDirShape,
  importLocalLog,
  importLocalLogShape,
  listLocalLogs,
  listLocalLogsShape,
  syncLocalLogs,
  syncLocalLogsShape,
} from "./tools/local-logs.js";
import { runCli } from "./cli.js";
import { loadStoredAuth, onAuthChange } from "./wcl/auth.js";
import { expireReports } from "./db/schema.js";
import { removeStaleStagingFiles, write } from "./db/duck.js";
import { hasRouteTablesToMigrate, migrateRouteTables } from "./mdt/route-tables.js";

const server = new McpServer({
  name: "wcl-mcp",
  version: "0.1.0", // x-release-please-version
});

const loginTool = server.registerTool(
  "login",
  {
    title: "Log in to Warcraft Logs",
    description:
      "Sign the user in with their Warcraft Logs account so the other tools can see their " +
      "private reports (and find_reports defaults to their uploads). Opens the WCL approval page " +
      "via the client or the user's browser and waits for them to approve. Call it when the user " +
      "asks to log in, or when a report they expect to see comes back not found.",
    inputSchema: loginShape,
  },
  (_args, extra) => login(server, extra),
);

const logoutTool = server.registerTool(
  "logout",
  {
    title: "Log out of Warcraft Logs",
    description:
      "Forget the user's Warcraft Logs login (deletes the stored tokens). Tools fall back to " +
      "public reports only. Already-downloaded reports stay in the local database.",
    inputSchema: logoutShape,
  },
  () => logout(),
);

server.registerTool(
  "auth_status",
  {
    title: "Warcraft Logs auth status",
    description:
      "Whether the user is logged in to Warcraft Logs (and as whom), i.e. whether private " +
      "reports are reachable, and whether a login is waiting on the user.",
    inputSchema: authStatusShape,
  },
  () => {
    syncAuthTools(); // picks up a login/logout made outside this process (CLI)
    return authStatus();
  },
);

/** Offer login or logout to match the current state; the SDK notifies clients on each change. */
let loggedIn: boolean | undefined;
function syncAuthTools(): void {
  const now = loadStoredAuth() !== undefined;
  if (now === loggedIn) return;
  loggedIn = now;
  if (now) {
    loginTool.disable();
    logoutTool.enable();
  } else {
    logoutTool.disable();
    loginTool.enable();
  }
}
syncAuthTools();
onAuthChange(syncAuthTools);

server.registerTool(
  "find_reports",
  {
    title: "Find reports",
    description:
      "Search your uploaded Warcraft Logs reports by zone (instance) and date range. " +
      "Returns matching report codes you can pass to download_report. Includes private reports " +
      "when logged in (see login); otherwise needs WCL_USER_ID and sees public ones only.",
    inputSchema: findReportsShape,
  },
  (args) => findReports(args),
);

server.registerTool(
  "download_report",
  {
    title: "Download report",
    description:
      "Fetch a Warcraft Logs report (full event stream + fights + actors) and materialize it into " +
      "a local DuckDB schema for analysis. Idempotent: re-running is a no-op unless force=true. " +
      "Local copies expire (are deleted) a set time after download — 7 days by default, see " +
      "expires_at in the result — after which this tool must be called again.",
    inputSchema: downloadReportShape,
  },
  (args) => downloadReport(args),
);

server.registerTool(
  "get_report_details",
  {
    title: "Get report details",
    description:
      "Describe a downloaded WCL report or imported local log: tables, row counts, column schemas " +
      "with a semantic guide (what each column means and how to use it), column statistics for " +
      "filtering, and how local logs differ from WCL data.",
    inputSchema: getReportDetailsShape,
  },
  (args) => getReportDetails(args),
);

server.registerTool(
  "execute_readonly_query",
  {
    title: "Execute read-only query",
    description:
      "Run a single read-only DuckDB SQL statement against a downloaded report's or imported " +
      "local log's tables. Table names resolve to that report automatically (search_path is " +
      "scoped). Pass `reports` instead to query several at once (e.g. a local log against a WCL " +
      "report) through all_events/all_fights/all_actors views with stable cross-report keys. " +
      "Spell names/data can be joined from the shared gamedata schema (see get_report_details).",
    inputSchema: executeReadonlyQueryShape,
  },
  (args) => executeReadonlyQuery(args),
);

server.registerTool(
  "delete_local_report",
  {
    title: "Delete local report",
    description:
      "Remove a report's local DuckDB schema and all its tables. Does not affect Warcraft Logs " +
      "or the log file. A deleted local log isn't re-imported by sync_local_logs; import_local_log " +
      "brings it back.",
    inputSchema: deleteLocalReportShape,
  },
  (args) => deleteLocalReport(args),
);

server.registerTool(
  "import_local_log",
  {
    title: "Import local combat log",
    description:
      "Import a WoWCombatLog*.txt file (written by the game with /combatlog) into the same local " +
      "schema as WCL downloads, so it can be queried and compared with WCL reports. Fights are " +
      "split the way WCL does (M+ keys, boss pulls, trash). Returns a local_ report code usable " +
      "anywhere a report code is. Re-running only parses what's new. Works offline, including " +
      "for logs never uploaded to WCL. For the WoW Logs directory, use sync_local_logs.",
    inputSchema: importLocalLogShape,
  },
  (args) => importLocalLog(args),
);

server.registerTool(
  "sync_local_logs",
  {
    title: "Sync local combat logs",
    description:
      "Import whatever the game has written to the WoW Logs directory since the last sync: every " +
      "WoWCombatLog*.txt file there, including the one being written right now (fights that " +
      "have ended become queryable; one still in progress waits for the next sync). Only parses " +
      "what's new. Call it when the user asks for their latest local data. The directory is " +
      "saved for later syncs; defaults to the saved directories, else the usual install location.",
    inputSchema: syncLocalLogsShape,
  },
  (args) => syncLocalLogs(args),
);

server.registerTool(
  "forget_log_dir",
  {
    title: "Forget combat log directory",
    description: "Remove a saved combat log directory (or all of them) from sync_local_logs. Imported reports are kept.",
    inputSchema: forgetLogDirShape,
  },
  (args) => forgetLogDir(args),
);

server.registerTool(
  "list_local_logs",
  {
    title: "List local combat logs",
    description:
      "Saved combat log directories, and every imported local log with its report code, import " +
      "status and fights.",
    inputSchema: listLocalLogsShape,
  },
  () => listLocalLogs(),
);

server.registerTool(
  "lookup_spells",
  {
    title: "Look up spells",
    description:
      "Get WoW spell names, rendered descriptions, and mechanics (cooldown, charges, cast time, " +
      "duration, costs, proc chance) by spell id or name. Ids match WCL ability gameIDs. Use it to " +
      "understand what abilities in a log do before giving gameplay advice. Works offline from " +
      "locally cached client data; the first call downloads it (~1 min).",
    inputSchema: lookupSpellsShape,
  },
  (args) => lookupSpells(args),
);

server.registerTool(
  "get_pull_insights",
  {
    title: "Get pull insights",
    description:
      "Explain what went wrong on a raid boss pull using Wipefest's per-boss mechanic analysis: " +
      "deaths by ability, avoidable damage taken, failed soaks/interrupts/tank swaps, with the " +
      "worst-offending players and the spell ids involved. Also shows each mechanic as of the " +
      "first death, to separate the cause of a wipe from its fallout. Use it as the starting " +
      "point for reviewing a pull, then query the spell ids in the downloaded report to dig " +
      "deeper. Raid encounters only (not Mythic+); calls the public Wipefest site.",
    inputSchema: getPullInsightsShape,
  },
  (args) => getPullInsights(args),
);

server.registerTool(
  "import_mdt_route",
  {
    title: "Import MDT route",
    description:
      "Match a Mythic Dungeon Tools route (MDT export string) against a downloaded Mythic+ run. " +
      "Re-slices the run into the route's pulls by assigning each enemy fought to its planned " +
      "pull, so per-pull damage/DPS isn't distorted by chained pulls the way WCL's time-based " +
      "pulls are: DPS is damage to a pull's own mobs over the time they were being fought. Wipes " +
      "split pulls into attempts (retries cover only the mobs still alive). Returns a faithfulness " +
      "summary (planned vs fought mobs and forces, off-route kills, wipes, skipped/out-of-order/" +
      "chained/merged/split pulls) and writes route_* tables for SQL. Use " +
      "it to judge how closely a group followed its route and to compare pulls on equal terms.",
    inputSchema: importMdtRouteShape,
  },
  (args) => importMdtRoute(args),
);

server.registerTool(
  "sync_game_data",
  {
    title: "Sync game data",
    description:
      "Download WoW client spell data (from wago.tools DB2 exports) for the latest live build into " +
      "the local gamedata schema. No-op if already current. Run after a game patch.",
    inputSchema: syncGameDataShape,
  },
  (args) => syncGameDataTool(args),
);

async function main(): Promise<void> {
  // `wcl-mcp login | logout | whoami`; with no subcommand, serve MCP over stdio.
  if (await runCli(process.argv.slice(2))) return;
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr is safe for logs; stdout is reserved for the MCP protocol.
  console.error("wcl-mcp server running on stdio");
  // Move routes out of log schemas (pre-route-schema layout) before the TTL can drop those,
  // then drop reports past their TTL. A failure here must not take the server down.
  housekeeping().catch((err) => console.error("wcl-mcp: local report housekeeping failed:", err));
}

async function housekeeping(): Promise<void> {
  removeStaleStagingFiles();
  if (await hasRouteTablesToMigrate()) {
    const migrated = await write((conn) => migrateRouteTables(conn));
    if (migrated.length > 0) console.error(`wcl-mcp: moved routes out of ${migrated.length} log schema(s)`);
  }
  const dropped = await expireReports();
  if (dropped.length > 0) console.error(`wcl-mcp: expired ${dropped.length} local schema(s)`);
}

main().catch((err) => {
  console.error("Fatal error starting wcl-mcp:", err);
  process.exit(1);
});
