import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/** JSON replacer: DuckDB returns BIGINT columns as JS bigint, which JSON.stringify can't handle. */
function jsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

/** Wrap a JSON-serializable payload as a successful text tool result. */
export function ok(payload: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, jsonReplacer, 2) }],
  };
}

/** Wrap an error as a tool result flagged with isError. */
export function fail(message: string): CallToolResult {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
  };
}

/** Run a tool body, converting thrown errors into a uniform error result. */
export async function guard(fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return fail(message);
  }
}
