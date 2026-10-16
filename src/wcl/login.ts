import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { getConfig } from "../config.js";
import {
  AUTHORIZE_URL,
  USER_SCOPES,
  loadStoredAuth,
  requestToken,
  saveStoredAuth,
  toStoredAuth,
  type StoredAuth,
} from "./auth.js";
import { WclClient } from "./client.js";
import { CURRENT_USER_QUERY } from "./queries.js";
import type { CurrentUserResponse } from "./types.js";

/** How long the redirect listener waits for the user to approve in the browser. */
export const LOGIN_TIMEOUT_MS = 10 * 60_000;

const base64url = (buf: Buffer) => buf.toString("base64url");

/** An in-flight authorization-code + PKCE login. */
export interface PendingLogin {
  /** Unique id; doubles as the MCP elicitationId. */
  id: string;
  /** The WCL authorize URL the user must open. */
  url: string;
  /** Resolves once the user has approved and the tokens are stored. */
  done: Promise<StoredAuth>;
  cancel(reason?: string): void;
}

let pending: PendingLogin | undefined;

/** The login currently waiting on the user, if any. */
export function getPendingLogin(): PendingLogin | undefined {
  return pending;
}

/** Best effort: launch the default browser on this machine. */
export function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  spawn(cmd, args, { stdio: "ignore", detached: true }).on("error", () => {}).unref();
}

/**
 * Start a login (or return the one already in progress — only one can own the redirect port).
 * Listens on WCL_REDIRECT_URI for the callback, exchanges the code, records who logged in,
 * and saves the tokens.
 */
export function startLogin(): PendingLogin {
  if (pending) return pending;

  const { clientId, redirectUri } = getConfig();
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  const state = base64url(randomBytes(16));

  const authorize = new URL(AUTHORIZE_URL);
  authorize.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: USER_SCOPES.join(" "),
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();

  let cancel: (reason?: string) => void = () => {};
  const code = new Promise<string>((resolve, reject) => {
    const redirect = new URL(redirectUri);
    let server: Server | undefined;
    const settle = (result: () => void) => {
      clearTimeout(timer);
      server?.close();
      result();
    };
    cancel = (reason = "Login cancelled.") => settle(() => reject(new Error(reason)));
    const timer = setTimeout(
      () => cancel("Timed out waiting for the Warcraft Logs login."),
      LOGIN_TIMEOUT_MS,
    );

    server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", redirect);
      if (url.pathname !== redirect.pathname) {
        res.writeHead(404).end();
        return;
      }
      const reply = (status: number, message: string) =>
        res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" }).end(message);
      const error = url.searchParams.get("error");
      const received = url.searchParams.get("code");
      if (error) {
        const detail = url.searchParams.get("error_description") ?? error;
        reply(400, `Login failed: ${detail}`);
        settle(() => reject(new Error(`Login failed: ${detail}`)));
      } else if (url.searchParams.get("state") !== state || !received) {
        // Not ours (stale tab, stray request): keep waiting for the real redirect.
        reply(400, "Login failed: invalid state. Start the login again from your agent.");
      } else {
        reply(200, "Logged in to Warcraft Logs. You can close this tab and return to your agent.");
        settle(() => resolve(received));
      }
    });
    server.on("error", (err) =>
      settle(() => reject(new Error(`Couldn't listen on ${redirectUri}: ${err.message}`))),
    );
    server.listen(Number(redirect.port || 80), redirect.hostname);
  });

  const done = (async () => {
    const tokens = await requestToken({
      grant_type: "authorization_code",
      code: await code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    });
    // Save first: the currentUser query below needs the user token.
    saveStoredAuth(toStoredAuth(tokens));
    const { userData } = await new WclClient().query<CurrentUserResponse>(CURRENT_USER_QUERY);
    const user = userData.currentUser;
    const auth = { ...loadStoredAuth()!, userId: user?.id, userName: user?.name };
    saveStoredAuth(auth);
    return auth;
  })().finally(() => {
    pending = undefined;
  });
  // Callers may stop awaiting (tool timeout); don't let a later failure go unhandled.
  done.catch(() => {});

  pending = { id: randomUUID(), url: authorize.toString(), done, cancel: (r) => cancel(r) };
  return pending;
}
