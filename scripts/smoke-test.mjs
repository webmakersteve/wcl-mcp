#!/usr/bin/env node
// Start the MCP server from a plugin root (e.g. the unpacked release zip) the way Claude Code
// would, and check it initializes and serves its tools. No network or database access.
//
//   node scripts/smoke-test.mjs <plugin-root>
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(process.argv[2] ?? ".");
const EXPECTED_TOOLS = ["login", "auth_status", "find_reports", "download_report", "execute_readonly_query"];
const TIMEOUT_MS = 30_000;

// Like a plugin install: no WCL_* config, run from an unrelated directory, no stored login.
const scratch = mkdtempSync(join(tmpdir(), "wcl-mcp-smoke-"));
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("WCL_")));
env.WCL_AUTH_PATH = join(scratch, "auth.json");
env.WCL_DB_PATH = join(scratch, "wcl.duckdb");

const child = spawn(process.execPath, [join(root, "dist", "index.js")], {
  cwd: scratch,
  env,
  stdio: ["pipe", "pipe", "inherit"],
});

const pending = new Map();
let buffer = "";
child.stdout.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    pending.get(message.id)?.(message);
  }
});

let nextId = 1;
function request(method, params = {}) {
  const id = nextId++;
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  return new Promise((resolve, reject) => {
    pending.set(id, (message) =>
      message.error ? reject(new Error(`${method}: ${message.error.message}`)) : resolve(message.result),
    );
  });
}

const timer = setTimeout(() => {
  console.error(`Smoke test timed out after ${TIMEOUT_MS / 1000}s`);
  child.kill();
  process.exit(1);
}, TIMEOUT_MS);

try {
  const init = await request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "smoke-test", version: "1" },
  });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  console.log(`server: ${init.serverInfo.name} ${init.serverInfo.version}`);

  const { tools } = await request("tools/list");
  const names = tools.map((t) => t.name);
  const missing = EXPECTED_TOOLS.filter((t) => !names.includes(t));
  if (missing.length) throw new Error(`missing tools: ${missing.join(", ")}`);
  console.log(`tools (${names.length}): ${names.join(", ")}`);

  const status = await request("tools/call", { name: "auth_status", arguments: {} });
  const parsed = JSON.parse(status.content[0].text);
  if (parsed.logged_in !== false) throw new Error("expected a fresh install to be logged out");
  console.log("auth_status: logged out, as expected");
  console.log("Smoke test passed.");
} catch (err) {
  console.error(`Smoke test failed: ${err.message}`);
  process.exitCode = 1;
} finally {
  clearTimeout(timer);
  child.kill();
}
