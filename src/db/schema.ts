import { quotedIdentifier, type DuckDBConnection } from "@duckdb/node-api";
import { getConfig } from "../config.js";
import { queryRows, readRows, write } from "./duck.js";

/**
 * Schema-evolution version. Bump when the seed table layout changes; old reports
 * keep their `_v<N>` schema and can be re-downloaded under the new version.
 */
export const SCHEMA_VERSION = 4;

/**
 * Version of the per-report route schema written by import_mdt_route, kept separate from
 * SCHEMA_VERSION so a log schema change doesn't strand imported routes (and vice versa).
 * Bump when the route table layout changes.
 */
export const ROUTE_SCHEMA_VERSION = 1;

/** WCL report codes are alphanumeric (a–z, A–Z, 0–9), typically 16 chars. */
const REPORT_CODE_RE = /^[A-Za-z0-9]{1,32}$/;

/**
 * Codes for imported local combat logs: `local_` + 12 hex chars. The underscore can't
 * appear in a WCL code, so the two never collide.
 */
const LOCAL_CODE_RE = /^local_([0-9a-f]{12})$/;

export function isLocalReportCode(code: string): boolean {
  return LOCAL_CODE_RE.test(code);
}

export function assertValidReportCode(code: string): void {
  if (!REPORT_CODE_RE.test(code) && !LOCAL_CODE_RE.test(code)) {
    throw new Error(
      `Invalid report code: ${JSON.stringify(code)}. Expected an alphanumeric Warcraft Logs ` +
        "code (e.g. aBcD1234WxYz5678) or a local log code (e.g. local_0123456789ab).",
    );
  }
}

/** Like assertValidReportCode, but rejects local log codes (for calls that go to WCL). */
export function assertWclReportCode(code: string): void {
  if (!REPORT_CODE_RE.test(code)) {
    throw new Error(
      `${JSON.stringify(code)} is not a Warcraft Logs report code` +
        (isLocalReportCode(code) ? " (it's an imported local combat log)." : "."),
    );
  }
}

/**
 * Derive the per-report schema name: `r_<code>_v<N>` for WCL reports, `l_<hex>_v<N>` for
 * imported local logs.
 */
export function schemaName(code: string, version = SCHEMA_VERSION): string {
  assertValidReportCode(code);
  const local = LOCAL_CODE_RE.exec(code);
  return local ? `l_${local[1]}_v${version}` : `r_${code}_v${version}`;
}

/** SQL-safe quoted identifier for the schema (handles case-sensitivity of codes). */
export function quotedSchema(code: string, version = SCHEMA_VERSION): string {
  return quotedIdentifier(schemaName(code, version));
}

export async function schemaExists(
  code: string,
  version = SCHEMA_VERSION,
): Promise<boolean> {
  const rows = await queryRows(
    "SELECT 1 FROM information_schema.schemata WHERE schema_name = $name LIMIT 1",
    { name: schemaName(code, version) },
  );
  return rows.length > 0;
}

/**
 * True when the report's download finished: the schema exists and its
 * report_details row (written last, in the same transaction) is present.
 */
export async function isDownloadComplete(
  code: string,
  version = SCHEMA_VERSION,
): Promise<boolean> {
  if (!(await schemaExists(code, version))) return false;
  const rows = await queryRows(
    `SELECT 1 FROM ${quotedSchema(code, version)}.report_details LIMIT 1`,
  ).catch(() => []);
  return rows.length > 0;
}

/** Drop the schema and all its tables. Returns false if it didn't exist. */
export function dropSchema(code: string, version = SCHEMA_VERSION): Promise<boolean> {
  return write((conn) => dropSchemaIfExists(conn, schemaName(code, version)));
}

async function dropSchemaIfExists(conn: DuckDBConnection, name: string): Promise<boolean> {
  const rows = await readRows(
    conn,
    "SELECT 1 FROM information_schema.schemata WHERE schema_name = $name LIMIT 1",
    { name },
  );
  if (rows.length > 0) await conn.run(`DROP SCHEMA ${quotedIdentifier(name)} CASCADE`);
  return rows.length > 0;
}

/** Matches a per-report log schema name, capturing the report code and version. */
export const REPORT_SCHEMA_RE = /^r_([A-Za-z0-9]{1,32})_v(\d+)$/;

/** Matches a per-report route schema name, capturing the report code and version. */
const ROUTE_SCHEMA_RE = /^route_([A-Za-z0-9]{1,32})_v(\d+)$/;

/** Derive the per-report route schema name, e.g. `route_aBcD1234_v1`. */
export function routeSchemaName(code: string, version = ROUTE_SCHEMA_VERSION): string {
  assertValidReportCode(code);
  return `route_${code}_v${version}`;
}

export function quotedRouteSchema(code: string, version = ROUTE_SCHEMA_VERSION): string {
  return quotedIdentifier(routeSchemaName(code, version));
}

export async function routeSchemaExists(code: string): Promise<boolean> {
  const rows = await queryRows(
    "SELECT 1 FROM information_schema.schemata WHERE schema_name = $name LIMIT 1",
    { name: routeSchemaName(code) },
  );
  return rows.length > 0;
}

/** Drop the report's route schema (imported MDT routes). Returns false if it didn't exist. */
export function dropRouteSchema(code: string): Promise<boolean> {
  return write((conn) => dropSchemaIfExists(conn, routeSchemaName(code)));
}

/** Versions (other than the current one) this report is still stored under locally. */
async function olderVersions(code: string): Promise<number[]> {
  const rows = await queryRows(
    "SELECT schema_name FROM information_schema.schemata WHERE schema_name LIKE $pattern",
    { pattern: `r_${code}_v%` },
  );
  return rows
    .map((r) => REPORT_SCHEMA_RE.exec(String(r.schema_name)))
    .filter((m): m is RegExpExecArray => m !== null && m[1] === code)
    .map((m) => Number(m[2]))
    .filter((v) => v !== SCHEMA_VERSION);
}

/**
 * Error text for a report missing from the current schema version: tells the agent whether it
 * was never downloaded, or was downloaded with an older layout and needs downloading again.
 */
export async function notDownloadedMessage(code: string): Promise<string> {
  if (isLocalReportCode(code)) {
    return `Local log '${code}' is not imported. Use import_local_log or sync_local_logs.`;
  }
  const older = await olderVersions(code);
  if (older.length > 0) {
    return (
      `Report '${code}' was downloaded with an older local schema (v${Math.max(...older)}; ` +
      `current is v${SCHEMA_VERSION}) and must be downloaded again. ` +
      `Call download_report('${code}') to upgrade it.`
    );
  }
  return `Report '${code}' is not downloaded. Call download_report('${code}') first.`;
}

/** When a downloaded report expires under the configured TTL (epoch ms), or null if never. */
export function expiresAt(downloadedAt: number): number | null {
  const { reportTtlDays } = getConfig();
  return reportTtlDays > 0 ? downloadedAt + reportTtlDays * 86_400_000 : null;
}

/** Per-report schema kinds the TTL applies to, and the time each was last written. */
const EXPIRING_SCHEMAS = [
  { re: REPORT_SCHEMA_RE, writtenAt: "SELECT max(downloaded_at) AS t FROM %s.report_details" },
  { re: ROUTE_SCHEMA_RE, writtenAt: "SELECT max(imported_at) AS t FROM %s.route_imports" },
];

/**
 * Drop every log schema downloaded, and every route schema last imported into, longer ago
 * than the TTL (any version). Schemas missing that timestamp are incomplete or unreadable
 * leftovers and are dropped too. Shared schemas (gamedata, mdt) never match the per-report
 * naming patterns. Only takes the write lock when something has expired. Returns dropped names.
 */
export async function expireReports(now = Date.now()): Promise<string[]> {
  const { reportTtlDays } = getConfig();
  if (reportTtlDays <= 0) return [];
  const cutoff = now - reportTtlDays * 86_400_000;

  if ((await expiredSchemas(queryRows, cutoff)).length === 0) return [];
  // Re-check under the write lock: another process may have re-downloaded meanwhile.
  return write(async (conn) => {
    const expired = await expiredSchemas((sql) => readRows(conn, sql), cutoff);
    for (const name of expired) await conn.run(`DROP SCHEMA ${quotedIdentifier(name)} CASCADE`);
    return expired;
  });
}

async function expiredSchemas(
  query: (sql: string) => Promise<Record<string, unknown>[]>,
  cutoff: number,
): Promise<string[]> {
  const schemas = await query("SELECT schema_name FROM information_schema.schemata");
  const expired: string[] = [];
  for (const { schema_name } of schemas) {
    const name = String(schema_name);
    const kind = EXPIRING_SCHEMAS.find((k) => k.re.test(name));
    if (!kind) continue;
    const rows = await query(kind.writtenAt.replace("%s", quotedIdentifier(name))).catch(() => []);
    const writtenAt = rows[0]?.t;
    if (writtenAt === null || writtenAt === undefined || Number(writtenAt) < cutoff) {
      expired.push(name);
    }
  }
  return expired;
}
