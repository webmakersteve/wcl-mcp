import type { DuckDBAppender } from "@duckdb/node-api";

export function appendNullableInt(appender: DuckDBAppender, value: number | undefined | null): void {
  if (value === undefined || value === null) appender.appendNull();
  else appender.appendInteger(value);
}

export function appendNullableBigInt(appender: DuckDBAppender, value: number | undefined | null): void {
  if (value === undefined || value === null) appender.appendNull();
  else appender.appendBigInt(BigInt(Math.trunc(value)));
}
