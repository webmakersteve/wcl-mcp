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

const server = new McpServer({
  name: "wcl-mcp",
  version: "0.1.0",
});

server.registerTool(
  "find_reports",
  {
    title: "Find reports",
    description:
      "Search your uploaded Warcraft Logs reports by zone (instance) and date range. " +
      "Returns matching report codes you can pass to download_report. Requires WCL_USER_ID.",
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
      "a local DuckDB schema for analysis. Idempotent: re-running is a no-op unless force=true.",
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
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr is safe for logs; stdout is reserved for the MCP protocol.
  console.error("wcl-mcp server running on stdio");
}

main().catch((err) => {
  console.error("Fatal error starting wcl-mcp:", err);
  process.exit(1);
});
