import { getConfig } from "../config.js";

const TOKEN_URL = "https://www.warcraftlogs.com/oauth/token";
const GRAPHQL_URL = "https://www.warcraftlogs.com/api/v2/client";

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;
const MAX_JITTER_MS = 500;
const DEFAULT_RATE_LIMIT_WAIT_MS = 30_000;
/** Refresh the token slightly early to avoid using one that expires mid-flight. */
const TOKEN_EXPIRY_SKEW_MS = 60_000;

export type WclErrorCode =
  | "auth_failure"
  | "auth_expired"
  | "rate_limited"
  | "client_error"
  | "server_error"
  | "graphql_error"
  | "network_error";

export class WclError extends Error {
  constructor(
    message: string,
    readonly code: WclErrorCode,
    readonly status?: number,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "WclError";
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface CachedToken {
  accessToken: string;
  expiresAt: number;
}

/**
 * Thin Warcraft Logs v2 GraphQL client.
 * - OAuth client-credentials with an in-memory, proactively-refreshed token.
 * - Retries on 401 (token refresh), 429 (honoring Retry-After), and 5xx (backoff).
 */
export class WclClient {
  private token: CachedToken | undefined;

  private async getToken(forceRefresh = false): Promise<string> {
    const now = Date.now();
    if (!forceRefresh && this.token && now < this.token.expiresAt) {
      return this.token.accessToken;
    }

    const { clientId, clientSecret } = getConfig();
    const body = new URLSearchParams({ grant_type: "client_credentials" });
    const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

    let res: Response;
    try {
      res = await fetch(TOKEN_URL, {
        method: "POST",
        headers: {
          Authorization: `Basic ${basic}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body,
      });
    } catch (err) {
      throw new WclError(`Token request failed: ${String(err)}`, "network_error");
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new WclError(
        `OAuth token request failed (${res.status}): ${text.slice(0, 300)}`,
        "auth_failure",
        res.status,
      );
    }

    const data = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!data.access_token) {
      throw new WclError("OAuth response missing access_token", "auth_failure");
    }
    const expiresInMs = (data.expires_in ?? 3600) * 1000;
    this.token = {
      accessToken: data.access_token,
      expiresAt: Date.now() + expiresInMs - TOKEN_EXPIRY_SKEW_MS,
    };
    return this.token.accessToken;
  }

  /** Execute a GraphQL query, returning the `data` payload typed as T. */
  async query<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    let lastError: WclError | undefined;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const token = await this.getToken();
        return await this.execute<T>(query, variables, token);
      } catch (err) {
        if (!(err instanceof WclError)) throw err;
        lastError = err;

        switch (err.code) {
          case "auth_expired":
            // Token rejected server-side; force a refresh and retry once.
            await this.getToken(true);
            continue;
          case "rate_limited": {
            const wait = err.retryAfterMs ?? DEFAULT_RATE_LIMIT_WAIT_MS;
            await sleep(wait);
            continue;
          }
          case "server_error":
          case "network_error": {
            const backoff =
              BASE_DELAY_MS * 2 ** attempt + Math.random() * MAX_JITTER_MS;
            await sleep(backoff);
            continue;
          }
          // Non-retryable: surface immediately.
          case "auth_failure":
          case "client_error":
          case "graphql_error":
            throw err;
        }
      }
    }

    throw lastError ?? new WclError("Request failed after retries", "network_error");
  }

  private async execute<T>(
    query: string,
    variables: Record<string, unknown>,
    token: string,
  ): Promise<T> {
    let res: Response;
    try {
      res = await fetch(GRAPHQL_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query, variables }),
      });
    } catch (err) {
      throw new WclError(`Network error: ${String(err)}`, "network_error");
    }

    if (res.status === 401) {
      throw new WclError("Access token expired or invalid", "auth_expired", 401);
    }
    if (res.status === 429) {
      const retryAfter = res.headers.get("Retry-After");
      const retryAfterMs = retryAfter ? Number(retryAfter) * 1000 : undefined;
      throw new WclError("Rate limited", "rate_limited", 429, retryAfterMs);
    }
    if (res.status >= 500) {
      throw new WclError(`Server error (${res.status})`, "server_error", res.status);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new WclError(
        `Client error (${res.status}): ${text.slice(0, 300)}`,
        "client_error",
        res.status,
      );
    }

    const json = (await res.json()) as {
      data?: T;
      errors?: Array<{ message: string }>;
    };
    if (json.errors && json.errors.length > 0) {
      throw new WclError(
        `GraphQL error: ${json.errors.map((e) => e.message).join("; ")}`,
        "graphql_error",
      );
    }
    if (json.data === undefined || json.data === null) {
      throw new WclError("GraphQL response missing data", "graphql_error");
    }
    return json.data;
  }
}

/** Shared singleton — keeps the token cache warm across tool calls. */
let singleton: WclClient | undefined;
export function getWclClient(): WclClient {
  if (!singleton) singleton = new WclClient();
  return singleton;
}
