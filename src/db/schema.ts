import { quotedIdentifier } from "@duckdb/node-api";
import { queryRows, run } from "./duck.js";

/**
 * Schema-evolution version. Bump when the seed table layout changes; old reports
 * keep their `_v<N>` schema and can be re-downloaded under the new version.
 */
export const SCHEMA_VERSION = 1;

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
