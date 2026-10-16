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
import { runCli } from "./cli.js";
import { loadStoredAuth, onAuthChange } from "./wcl/auth.js";
import { expireReports } from "./db/schema.js";

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
      "Describe a locally-downloaded report: tables, row counts, column schemas with a semantic " +
      "guide (what each column means and how to use it), and column statistics for filtering.",
    inputSchema: getReportDetailsShape,
  },
  (args) => getReportDetails(args),
);

server.registerTool(
  "execute_readonly_query",
  {
    title: "Execute read-only query",
    description:
      "Run a single read-only DuckDB SQL statement against a downloaded report's tables. " +
      "Table names resolve to that report automatically (search_path is scoped). " +
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
      "Remove a report's local DuckDB schema and all its tables. Does not affect Warcraft Logs.",
    inputSchema: deleteLocalReportShape,
  },
  (args) => deleteLocalReport(args),
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
  // Drop reports past their TTL; a failure here must not take the server down.
  expireReports()
    .then((dropped) => {
      if (dropped.length > 0) console.error(`wcl-mcp: expired ${dropped.length} local report(s)`);
    })
    .catch((err) => console.error("wcl-mcp: report expiry failed:", err));
}

main().catch((err) => {
  console.error("Fatal error starting wcl-mcp:", err);
  process.exit(1);
});
