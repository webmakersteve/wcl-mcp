import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { getConfig } from "../config.js";

export const AUTHORIZE_URL = "https://www.warcraftlogs.com/oauth/authorize";
export const TOKEN_URL = "https://www.warcraftlogs.com/oauth/token";
/** Public reports only; authed with a client-credentials token. */
export const CLIENT_API_URL = "https://www.warcraftlogs.com/api/v2/client";
/** Everything the logged-in user can see, private reports included; needs a user token. */
export const USER_API_URL = "https://www.warcraftlogs.com/api/v2/user";
export const USER_SCOPES = ["view-user-profile", "view-private-reports"];

type AuthListener = (auth: StoredAuth | undefined) => void;
const listeners = new Set<AuthListener>();

/** Called whenever this process logs in, refreshes, or logs out. */
export function onAuthChange(listener: AuthListener): void {
  listeners.add(listener);
}

function emitAuthChange(auth: StoredAuth | undefined): void {
  for (const listener of listeners) listener(auth);
}

/** Refresh slightly early to avoid using a token that expires mid-flight. */
const TOKEN_EXPIRY_SKEW_MS = 60_000;

/** A user's OAuth tokens, persisted by `wcl-mcp login`. */
export interface StoredAuth {
  accessToken: string;
  refreshToken: string | undefined;
  /** Epoch ms, already adjusted for clock skew. */
  expiresAt: number;
  userId: number | undefined;
  userName: string | undefined;
}

export interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
}

export function loadStoredAuth(): StoredAuth | undefined {
  try {
    return JSON.parse(readFileSync(getConfig().authPath, "utf8")) as StoredAuth;
  } catch {
    return undefined; // not logged in (or unreadable) — fall back to client credentials
  }
}

export function saveStoredAuth(auth: StoredAuth): void {
  const { authPath } = getConfig();
  mkdirSync(dirname(authPath), { recursive: true, mode: 0o700 });
  // 0600: the refresh token grants access to the user's private reports.
  writeFileSync(authPath, JSON.stringify(auth, null, 2), { mode: 0o600 });
  emitAuthChange(auth);
}

export function clearStoredAuth(): boolean {
  const { authPath } = getConfig();
  const existed = loadStoredAuth() !== undefined;
  rmSync(authPath, { force: true });
  emitAuthChange(undefined);
  return existed;
}

export function isExpired(auth: StoredAuth): boolean {
  return Date.now() >= auth.expiresAt;
}

/**
 * POST to the token endpoint. Sends the client secret when configured, so this works for
 * both confidential clients (secret + PKCE) and public PKCE-only clients.
 */
export async function requestToken(params: Record<string, string>): Promise<TokenResponse> {
  const { clientId, clientSecret } = getConfig();
  const body = new URLSearchParams({ client_id: clientId, ...params });
  if (clientSecret) body.set("client_secret", clientSecret);

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`OAuth token request failed (${res.status}): ${text.slice(0, 300)}`);
  }
  const data = (await res.json()) as TokenResponse;
  if (!data.access_token) throw new Error("OAuth response missing access_token");
  return data;
}

/** Build a StoredAuth from a token response, carrying over fields the response omits. */
export function toStoredAuth(data: TokenResponse, previous?: StoredAuth): StoredAuth {
  const expiresInMs = (data.expires_in ?? 3600) * 1000;
  return {
    accessToken: data.access_token!,
    refreshToken: data.refresh_token ?? previous?.refreshToken,
    expiresAt: Date.now() + expiresInMs - TOKEN_EXPIRY_SKEW_MS,
    userId: previous?.userId,
    userName: previous?.userName,
  };
}

/**
 * Exchange the stored refresh token for a new access token and persist it.
 * Throws a login prompt if there's no refresh token or WCL rejects it.
 */
export async function refreshStoredAuth(auth: StoredAuth): Promise<StoredAuth> {
  // Another server process may already have refreshed (and rotated) the token.
  const onDisk = loadStoredAuth();
  if (onDisk && onDisk.accessToken !== auth.accessToken && !isExpired(onDisk)) return onDisk;

  const refreshToken = onDisk?.refreshToken ?? auth.refreshToken;
  // A dead login is cleared so the server falls back to public access and offers `login` again.
  if (!refreshToken) {
    clearStoredAuth();
    throw new Error("Warcraft Logs login has expired. Use the login tool to sign in again.");
  }
  let data: TokenResponse;
  try {
    data = await requestToken({ grant_type: "refresh_token", refresh_token: refreshToken });
  } catch (err) {
    clearStoredAuth();
    throw new Error(
      `Warcraft Logs login could not be refreshed (${err instanceof Error ? err.message : err}). ` +
        "Use the login tool to sign in again.",
    );
  }
  const next = toStoredAuth(data, onDisk ?? auth);
  saveStoredAuth(next);
  return next;
}
