import { getConfig } from "./config.js";
import { clearStoredAuth, loadStoredAuth } from "./wcl/auth.js";
import { openBrowser, startLogin } from "./wcl/login.js";

/** Same flow as the login tool, for setup/debugging from a terminal. */
async function login(): Promise<void> {
  const { url, done } = startLogin();
  console.log(`Opening your browser to log in to Warcraft Logs. If it doesn't open, visit:\n\n  ${url}\n`);
  openBrowser(url);
  const auth = await done;
  console.log(`Logged in as ${auth.userName ?? "unknown user"} (id ${auth.userId ?? "?"}).`);
  console.log(`Tokens saved to ${getConfig().authPath}.`);
}

function logout(): void {
  console.log(clearStoredAuth() ? "Logged out." : "Not logged in.");
}

function whoami(): void {
  const auth = loadStoredAuth();
  if (!auth) {
    console.log("Not logged in (public reports only). Run `wcl-mcp login`.");
    return;
  }
  const expiry = new Date(auth.expiresAt).toISOString();
  console.log(`Logged in as ${auth.userName ?? "unknown"} (id ${auth.userId ?? "?"}); token expires ${expiry}.`);
}

const COMMANDS: Record<string, () => void | Promise<void>> = { login, logout, whoami };

/** Run a CLI subcommand if argv names one. Returns false to start the MCP server instead. */
export async function runCli(argv: string[]): Promise<boolean> {
  const command = argv[0];
  if (!command) return false;
  const run = COMMANDS[command];
  if (!run) {
    console.error(`Unknown command: ${command}. Commands: ${Object.keys(COMMANDS).join(", ")}.`);
    process.exit(1);
  }
  try {
    await run();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
  return true;
}
