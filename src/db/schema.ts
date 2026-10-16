import { quotedIdentifier } from "@duckdb/node-api";
import { getConfig } from "../config.js";
import { queryRows, run } from "./duck.js";

/**
 * Schema-evolution version. Bump when the seed table layout changes; old reports
 * keep their `_v<N>` schema and can be re-downloaded under the new version.
 */
export const SCHEMA_VERSION = 3;

/** WCL report codes are alphanumeric (a–z, A–Z, 0–9), typically 16 chars. */
const REPORT_CODE_RE = /^[A-Za-z0-9]{1,32}$/;

export function assertValidReportCode(code: string): void {
  if (!REPORT_CODE_RE.test(code)) {
    throw new Error(
      `Invalid report code: ${JSON.stringify(code)}. ` +
        "Expected an alphanumeric Warcraft Logs code (e.g. aBcD1234WxYz5678).",
    );
  }
}

/** Derive the per-report schema name, e.g. `r_aBcD1234_v1`. */
export function schemaName(code: string, version = SCHEMA_VERSION): string {
  assertValidReportCode(code);
  return `r_${code}_v${version}`;
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
export async function dropSchema(
  code: string,
  version = SCHEMA_VERSION,
): Promise<boolean> {
  const existed = await schemaExists(code, version);
  if (existed) {
    await run(`DROP SCHEMA ${quotedSchema(code, version)} CASCADE`);
  }
  return existed;
}

/** Matches a per-report schema name, capturing the report code and version. */
const REPORT_SCHEMA_RE = /^r_([A-Za-z0-9]{1,32})_v(\d+)$/;

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

/**
 * Drop every report schema (any version) downloaded longer ago than the TTL. Schemas
 * without a report_details row are incomplete or unreadable leftovers and are dropped too.
 * Shared schemas (gamedata, mdt) never match the report naming pattern. Returns dropped names.
 */
export async function expireReports(now = Date.now()): Promise<string[]> {
  const { reportTtlDays } = getConfig();
  if (reportTtlDays <= 0) return [];
  const cutoff = now - reportTtlDays * 86_400_000;

  const schemas = await queryRows("SELECT schema_name FROM information_schema.schemata");
  const dropped: string[] = [];
  for (const { schema_name } of schemas) {
    const name = String(schema_name);
    if (!REPORT_SCHEMA_RE.test(name)) continue;
    const ident = quotedIdentifier(name);
    const rows = await queryRows(
      `SELECT max(downloaded_at) AS downloaded_at FROM ${ident}.report_details`,
    ).catch(() => []);
    const downloadedAt = rows[0]?.downloaded_at;
    if (downloadedAt !== null && downloadedAt !== undefined && Number(downloadedAt) >= cutoff) {
      continue;
    }
    await run(`DROP SCHEMA ${ident} CASCADE`);
    dropped.push(name);
  }
  return dropped;
}
