import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { getConfig } from "../config.js";
import { clearStoredAuth, loadStoredAuth, type StoredAuth } from "../wcl/auth.js";
import {
  LOGIN_TIMEOUT_MS,
  getPendingLogin,
  openBrowser,
  startLogin,
  type PendingLogin,
} from "../wcl/login.js";
import { guard, ok } from "./result.js";

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

/** How long the login tool blocks for the user's approval before returning "pending". */
const LOGIN_WAIT_MS = 90_000;
const PROGRESS_INTERVAL_MS = 5_000;
/**
 * A decline or cancel faster than this can't have come from the user: the client advertised
 * URL elicitation but answered without showing the prompt (seen with the Claude desktop app).
 * Treat it like a client without URL elicitation and open the browser instead.
 */
const INSTANT_ANSWER_MS = 1_000;

export const loginShape = {};

/** What's reachable without a login: client credentials need WCL_CLIENT_SECRET. */
function loggedOutAccess(): string {
  return getConfig().clientSecret
    ? "public reports only (/api/v2/client)"
    : "none — WCL API calls need a login (no WCL_CLIENT_SECRET for public access)";
}
export const logoutShape = {};
export const authStatusShape = {};

function describeUser(auth: StoredAuth) {
  return {
    user_id: auth.userId ?? null,
    user_name: auth.userName ?? null,
    token_expires_at: new Date(auth.expiresAt).toISOString(),
  };
}

/**
 * Wait for the login to finish, up to LOGIN_WAIT_MS. Sends progress notifications (when the
 * client asked for them) so clients that reset their timeout on progress keep waiting.
 * Resolves undefined if it's still pending; rejects if the login failed.
 */
async function waitForLogin(attempt: PendingLogin, extra: Extra): Promise<StoredAuth | undefined> {
  const progressToken = extra._meta?.progressToken;
  let elapsed = 0;
  const ticker = setInterval(() => {
    elapsed += PROGRESS_INTERVAL_MS;
    if (progressToken === undefined) return;
    extra
      .sendNotification({
        method: "notifications/progress",
        params: {
          progressToken,
          progress: elapsed,
          total: LOGIN_WAIT_MS,
          message: "Waiting for you to approve access in the browser…",
        },
      })
      .catch(() => {});
  }, PROGRESS_INTERVAL_MS);
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      attempt.done,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), LOGIN_WAIT_MS);
        extra.signal.addEventListener("abort", () => resolve(undefined), { once: true });
      }),
    ]);
  } finally {
    clearInterval(ticker);
    clearTimeout(timer);
  }
}

/**
 * Ask the client to send the user to the WCL authorize URL (URL-mode elicitation).
 * Returns the user's answer, or undefined if the client can't do URL elicitation.
 */
async function elicitLogin(
  server: McpServer,
  attempt: PendingLogin,
  extra: Extra,
): Promise<"accept" | "decline" | "cancel" | undefined> {
  if (!server.server.getClientCapabilities()?.elicitation?.url) return undefined;
  try {
    const result = await server.server.elicitInput(
      {
        mode: "url",
        elicitationId: attempt.id,
        url: attempt.url,
        message:
          "Log in to Warcraft Logs so this server can read your private reports " +
          "(read-only access to your profile and private logs).",
      },
      { signal: extra.signal, timeout: LOGIN_TIMEOUT_MS },
    );
    return result.action;
  } catch {
    return undefined; // advertised but failed — fall back to opening the browser ourselves
  }
}

export async function login(server: McpServer, extra: Extra) {
  return guard(async () => {
    const existing = loadStoredAuth();
    if (existing) {
      return ok({
        status: "already_logged_in",
        ...describeUser(existing),
        hint: "Call logout first to switch accounts.",
      });
    }

    const attempt = startLogin();
    const client = server.server.getClientVersion()?.name ?? null;
    const asked = Date.now();
    const answer = await elicitLogin(server, attempt, extra);
    const refused = answer === "decline" || answer === "cancel";
    if (refused && Date.now() - asked >= INSTANT_ANSWER_MS) {
      // The user may have refused, or the client may not have shown the prompt at all. Keep the
      // attempt open (it times out on its own) and hand back the URL, so the login can still be
      // finished by opening it directly; auth_status confirms once it's done.
      return ok({
        status: answer === "decline" ? "declined" : "cancelled",
        client,
        login_url: attempt.url,
        message:
          "The client reported the login prompt as " + (answer === "decline" ? "declined" : "cancelled") +
          ". If the user didn't mean to refuse (or never saw a prompt), give them login_url to open " +
          "and approve; then call auth_status to confirm. Call logout to abandon the attempt.",
        access: loggedOutAccess(),
      });
    }
    const method = answer === "accept" ? "elicitation" : "browser";
    if (method === "elicitation") {
      // Tell the client the out-of-band step is over, whenever it finishes.
      const notifyComplete = server.server.createElicitationCompletionNotifier(attempt.id);
      attempt.done.then(() => notifyComplete()).catch(() => {});
    } else {
      openBrowser(attempt.url);
    }

    const auth = await waitForLogin(attempt, extra);
    if (!auth) {
      return ok({
        status: "pending",
        method,
        client,
        login_url: attempt.url,
        message:
          "Still waiting for approval. Ask the user to finish logging in at login_url (it should " +
          "already be open in their browser), then call auth_status to confirm.",
      });
    }
    return ok({
      status: "logged_in",
      method,
      ...describeUser(auth),
      message:
        "Logged in. Tools now see this user's private reports; find_reports defaults to their uploads.",
    });
  });
}

export async function logout() {
  return guard(async () => {
    getPendingLogin()?.cancel("Logged out.");
    const wasLoggedIn = clearStoredAuth();
    return ok({
      status: wasLoggedIn ? "logged_out" : "not_logged_in",
      access: loggedOutAccess(),
    });
  });
}

export async function authStatus() {
  return guard(async () => {
    const auth = loadStoredAuth();
    const pending = getPendingLogin();
    if (auth) {
      return ok({
        logged_in: true,
        ...describeUser(auth),
        access: "public + this user's private reports (/api/v2/user)",
      });
    }
    return ok({
      logged_in: false,
      access: loggedOutAccess(),
      login_in_progress: pending !== undefined,
      ...(pending && { login_url: pending.url }),
      hint: pending
        ? "Waiting for the user to approve at login_url."
        : "Call login to let the user sign in and reach their private reports.",
    });
  });
}
