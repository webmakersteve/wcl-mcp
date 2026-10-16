/**
 * Defense-in-depth guard for execute_readonly_query. DuckDB has no per-statement
 * read-only mode on a read-write connection, so we validate the SQL ourselves:
 *  1. exactly one statement (reject stacked statements),
 *  2. leading keyword must be in the read-only allowlist,
 *  3. reject any token from the mutating/side-effecting denylist.
 * Filesystem/network access (read_text, read_csv, glob, ...) is blocked separately
 * by opening DuckDB with enable_external_access=false (see db/duck.ts), and
 * assertWithinSchema keeps a query from reading other reports' schemas.
 */

import type { DuckDBConnection } from "@duckdb/node-api";

const ALLOWED_LEADING = new Set([
  "SELECT",
  "WITH",
  "FROM", // DuckDB's FROM-first syntax: `FROM tbl SELECT ...`
  "DESCRIBE",
  "SUMMARIZE",
  "EXPLAIN",
  "SHOW",
  "VALUES",
  "TABLE", // `TABLE foo;` is shorthand for `SELECT * FROM foo`
]);

const DENY_TOKENS = new Set([
  "INSERT",
  "UPDATE",
  "DELETE",
  "MERGE",
  "UPSERT",
  "CREATE",
  "DROP",
  "ALTER",
  "TRUNCATE",
  "ATTACH",
  "DETACH",
  "COPY",
  "INSTALL",
  "LOAD",
  "SET",
  "RESET",
  "CALL",
  "PRAGMA",
  "EXPORT",
  "IMPORT",
  "USE",
  "CHECKPOINT",
  "VACUUM",
  "BEGIN",
  "COMMIT",
  "ROLLBACK",
]);

export class ReadOnlyViolation extends Error {}

/** Strip line (`--`) and block (`/* *​/`) comments so they can't hide keywords. */
function stripComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ");
}

/**
 * Validate and return the single trimmed statement, or throw ReadOnlyViolation.
 */
export function assertReadOnly(sqlInput: string): string {
  const stripped = stripComments(sqlInput).trim();
  if (!stripped) {
    throw new ReadOnlyViolation("Empty query.");
  }

  // Allow a single optional trailing semicolon; reject anything after it.
  const withoutTrailing = stripped.replace(/;\s*$/, "");
  if (withoutTrailing.includes(";")) {
    throw new ReadOnlyViolation(
      "Only a single statement is allowed (no ';' separators).",
    );
  }

  const leading = withoutTrailing.match(/^[A-Za-z]+/)?.[0]?.toUpperCase();
  if (!leading || !ALLOWED_LEADING.has(leading)) {
    throw new ReadOnlyViolation(
      `Query must start with one of: ${[...ALLOWED_LEADING].join(", ")}. Got: ${leading ?? "?"}.`,
    );
  }

  // Token-level denylist (word-boundaried, case-insensitive).
  const upper = withoutTrailing.toUpperCase();
  for (const bad of DENY_TOKENS) {
    if (new RegExp(`\\b${bad}\\b`).test(upper)) {
      throw new ReadOnlyViolation(`Disallowed keyword in read-only query: ${bad}.`);
    }
  }

  return withoutTrailing;
}

/** Table functions that take SQL or a table name as a string, hiding it from the AST check. */
const DENY_TABLE_FUNCTIONS = new Set(["query", "query_table"]);

/**
 * Reject table references outside `allowedSchemas`. search_path only sets the
 * default schema, so a qualified name like "r_other_v1".fight_events would
 * otherwise reach another report. Parses with json_serialize_sql and walks the AST.
 * Matching is case-insensitive, as DuckDB's own identifier resolution is.
 */
export async function assertWithinSchemas(
  conn: DuckDBConnection,
  statement: string,
  allowedSchemas: string[],
): Promise<void> {
  const allowed = new Set(allowedSchemas.map((s) => s.toLowerCase()));
  // json_serialize_sql only handles SELECT-shaped statements; check what EXPLAIN wraps.
  const inner = statement.replace(/^\s*EXPLAIN(\s+ANALYZE)?\s+/i, "");
  const reader = await conn.runAndReadAll("SELECT json_serialize_sql($sql::VARCHAR) AS ast", {
    sql: inner,
  });
  const ast = JSON.parse(String(reader.getRowObjects()[0]?.ast)) as {
    error?: boolean;
    error_message?: string;
  };
  if (ast.error) {
    throw new ReadOnlyViolation(`Could not parse query: ${ast.error_message ?? "unknown error"}`);
  }

  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (!node || typeof node !== "object") return;
    const n = node as Record<string, unknown>;
    if (n.type === "BASE_TABLE") {
      const catalog = String(n.catalog_name ?? "");
      const tableSchema = String(n.schema_name ?? "");
      if (catalog !== "" || (tableSchema !== "" && !allowed.has(tableSchema.toLowerCase()))) {
        const ref = [catalog, tableSchema, n.table_name].filter(Boolean).join(".");
        throw new ReadOnlyViolation(
          `Table ${ref} is outside this report. Reference report tables unqualified ` +
            `(e.g. fight_events) and game data as gamedata.<table>.`,
        );
      }
    }
    if (n.type === "TABLE_FUNCTION") {
      const fn = (n.function as { function_name?: string } | undefined)?.function_name;
      if (fn && DENY_TABLE_FUNCTIONS.has(fn.toLowerCase())) {
        throw new ReadOnlyViolation(`Table function ${fn}() is not allowed.`);
      }
    }
    Object.values(n).forEach(visit);
  };
  visit(ast);
}
