/**
 * Defense-in-depth guard for execute_readonly_query. DuckDB has no per-statement
 * read-only mode on a read-write connection, so we validate the SQL ourselves:
 *  1. exactly one statement (reject stacked statements),
 *  2. leading keyword must be in the read-only allowlist,
 *  3. reject any token from the mutating/side-effecting denylist.
 * Combined with per-report search_path scoping in the tool, this keeps queries
 * read-only and contained.
 */

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
