# Plan: Warcraft Logs MCP Server (TypeScript + DuckDB)

## Context

Brand-new, empty project. We're building a **local** MCP server that gives an agent rich context
about a World of Warcraft dungeon/raid run from [Warcraft Logs](https://warcraftlogs.com).

The flow we're enabling:
1. The agent **finds** a report (or the user names one).
2. The agent **downloads** it: hit the WCL v2 GraphQL API, paginate the full event stream, and
   materialize it into a **local DuckDB** schema dedicated to that report.
3. The agent **inspects** the local schema (tables, row counts, column stats, and a semantic layer
   describing what each column means and how to use it).
4. The agent runs **read-only SQL** directly against the local data to investigate the run.

DuckDB is used so everything runs locally and offline after download — no repeated API hits, fast
analytical SQL. The server runs locally (not remote) because it needs the user's WCL credentials.

The reference repo (`vinylflamingo/wcl-mcp`) is used **only** as a source for *how to talk to the
WCL API* (OAuth token flow, GraphQL queries, pagination, retry/429 handling). We are not adopting
its architecture — our tool surface is deliberately minimal and DuckDB-centric.

### Decisions locked in (from clarifying questions)
- **Auth:** OAuth **client-credentials** — `WCL_CLIENT_ID` + `WCL_CLIENT_SECRET` exchanged for a
  short-lived bearer token against `https://www.warcraftlogs.com/api/v2/client`. (WCL has no classic PAT.)
- **find_reports scope:** the authenticated user's own uploads. NOTE: client-credentials has no
  "current user", so this requires the numeric `WCL_USER_ID` in env; we query
  `reportData.reports(userID: $userID, ...)`.
- **Event scope:** download the **full** event stream (`dataType: All`) for every fight.

## Tech choices (verified current via Context7)
- **Runtime:** Node 25, ESM, TypeScript. Build with `tsc` → `dist/`, expose a `bin` entry.
- **MCP:** `@modelcontextprotocol/sdk` (v1.x) — `McpServer` + `StdioServerTransport`, tools via
  `server.registerTool(...)`. *Verify the exact `inputSchema` shape (ZodRawShape vs `z.object`) against
  the installed SDK version before wiring — it differs across versions.*
- **DuckDB:** `@duckdb/node-api` (DuckDB Node "Neo"). `DuckDBInstance.create(path)` →
  `instance.connect()`. Bulk-load events with the **Appender** API; read with
  `connection.runAndReadAll(sql)` → `reader.getRowObjects()`.
- **Validation:** `zod`. Env via `process.env` (+ a tiny `.env` loader; Node 25 supports `--env-file`,
  but we'll load explicitly for robustness).

## Project structure
```
wcl-mcp/
  package.json            # type: module, bin: wcl-mcp -> dist/index.js, scripts: build/dev/start
  tsconfig.json           # NodeNext, ES2022, strict, outDir dist
  .env.example            # WCL_CLIENT_ID, WCL_CLIENT_SECRET, WCL_USER_ID, WCL_DB_PATH
  .gitignore              # node_modules, dist, data/, .env
  README.md               # setup, env, MCP client config snippet
  PLAN.md                 # copy of this plan (created as step 0 — user asked to persist it)
  src/
    index.ts              # bootstrap McpServer, register 5 tools, connect stdio
    config.ts             # load+validate env (zod); WCL_DB_PATH default ./data/wcl.duckdb
    wcl/
      client.ts           # token cache + GraphQL POST + retry/backoff + 429 (Retry-After)
      queries.ts          # GraphQL query strings
      types.ts            # response types for queries
    db/
      duck.ts             # singleton DuckDBInstance/connection; ensure data dir exists
      schema.ts           # schema name derivation, SCHEMA_VERSION, exists/create/drop helpers
      seeds.ts            # seed-table DDL + SEMANTIC REGISTRY (per-column descriptions)
      readonly.ts         # read-only SQL guard
    tools/
      download-report.ts
      delete-local-report.ts
      get-report-details.ts
      find-reports.ts
      execute-readonly-query.ts
```

## DuckDB data model

- **One persistent file**, default `./data/wcl.duckdb` (override `WCL_DB_PATH`).
- **One DuckDB schema per report**, named `r_<reportCode>_v1` (report codes are `[A-Za-z0-9]`, safe;
  always quote the identifier since codes are case-sensitive). The `_v1` suffix is the
  **schema-evolution version** (`SCHEMA_VERSION = 1`).
- **Download is idempotent:** existence of `r_<code>_v<SCHEMA_VERSION>` ⇒ already downloaded at the
  current version; skip re-fetch (unless a `force` flag is passed). Older-version schemas are left in
  place / can be re-downloaded under the new version.

### Seed tables (v1)
`report_details` and `fight_events` are the headline tables the user named; `fights` and `actors` are
small lookup tables needed to make `fight_events` analyzable (resolve fight → encounter, actor id →
name). All four are created on download.

- **`report_details`** (1 row): `report_code, title, owner, zone_id, zone_name, region, start_time,
  end_time, num_fights, total_events, schema_version, downloaded_at`.
- **`fights`** (1 row per fight): `fight_id, name, encounter_id, difficulty, keystone_level, kill,
  fight_percentage, start_time, end_time`.
- **`actors`** (1 row per actor): `actor_id, name, type, sub_type, server` — from `masterData.actors`.
- **`fight_events`** (raw, large): `fight_id, timestamp (ms), type, source_id, target_id,
  ability_game_id, amount, hit_type, raw (JSON)`. The `raw` JSON column holds the complete event so
  any field not promoted to a column is still queryable via DuckDB JSON functions.

### Semantic layer
`db/seeds.ts` exports a static registry mapping each table → `{ description, columns: { col:
{ type, description, usage } } }`. This is the source of truth for both DDL generation and the
human-readable docs returned by `get_report_details`. Example: document that `timestamp` is ms
relative to report start, that `source_id`/`target_id` join to `actors.actor_id`, and that `fight_id`
joins to `fights.fight_id`.

## WCL API layer (`src/wcl/`)
Port a slimmed version of the reference client:
- `getToken()`: POST `oauth/token` with `grant_type=client_credentials`, cache token in memory,
  refresh ~60s early.
- `query<T>(query, variables)`: POST to `/api/v2/client` with `Authorization: Bearer`; throw on
  GraphQL `errors`/missing `data`.
- Retry with exponential backoff + jitter; honor `Retry-After` on 429. (Circuit breaker omitted in v1
  — keep it lean.)

Queries needed (`queries.ts`):
- **Report meta + master data:** `reportData.report(code)` → `title, startTime, endTime, zone{id,name},
  region{slug}, owner{name}, fights{ id,name,encounterID,difficulty,keystoneLevel,kill,
  fightPercentage,startTime,endTime }, masterData.actors{ id,name,type,subType,server }`.
- **Events:** `reportData.report(code).events(fightIDs:[$id], startTime, endTime, dataType: All,
  limit: 10000)` → `{ data, nextPageTimestamp }`. Paginate per fight: loop advancing `startTime` to
  `nextPageTimestamp` until null.
- **Find reports:** `reportData.reports(userID:$userID, zoneID:$zoneID, startTime, endTime, limit,
  page)` → `{ data { code, title, zone{name}, startTime, endTime }, has_more_pages }`.

## Tool implementations (`src/tools/`)

All tools validate input with zod, return `content: [{ type: 'text', text }]` (JSON-stringified
payload), and use `isError: true` on failure.

1. **`download_report(report_code, force?)`** — if schema exists and not `force`, return
   "already downloaded" summary. Else: fetch report meta+masterData; create schema + 4 seed tables;
   insert `report_details`/`fights`/`actors`; for each fight paginate full events and bulk-append into
   `fight_events`; update `total_events`/`num_fights`. Return a summary (schema name, table row counts).
2. **`delete_local_report(report_code)`** — `DROP SCHEMA "r_<code>_v1" CASCADE` if it exists; report
   what was removed.
3. **`get_report_details(report_code)`** — error if not downloaded. For each table: row count +
   `SUMMARIZE <table>` (min/max/approx_unique/null%) merged with the semantic registry descriptions.
   Returns tables, schemas, stats, and the semantic guide for writing queries.
4. **`find_reports({ zone_id?, start_date?, end_date?, limit?, page? })`** — query
   `reportData.reports(userID: WCL_USER_ID, ...)`; map ISO dates → epoch ms; return matching report
   codes + light metadata (title, zone, date). Player-name filtering is documented as not
   server-supported (deferred). Errors clearly if `WCL_USER_ID` is unset.
5. **`execute_readonly_query(report_code, sql)`** — error if not downloaded. Guard the SQL via
   `db/readonly.ts`, scope to the report schema (set `search_path` to `r_<code>_v1` so the agent can
   reference seed tables unqualified), run with `runAndReadAll`, return rows (capped, e.g. 1000) +
   row/column counts. Reset search_path after.

### Read-only guard (`db/readonly.ts`)
Defense in depth: (a) reject anything but a single statement (no extra `;`); (b) require the
leading keyword ∈ {SELECT, WITH, FROM, DESCRIBE, SUMMARIZE, EXPLAIN, SHOW, PRAGMA(table_info/show...)};
(c) reject a denylist of mutating keywords (INSERT/UPDATE/DELETE/MERGE/CREATE/DROP/ALTER/ATTACH/COPY/
INSTALL/LOAD/SET/CALL/EXPORT). The per-report `search_path` scoping also limits blast radius.

## Critical files to create
- `src/wcl/client.ts`, `src/wcl/queries.ts` — port API behavior from the reference (auth, pagination, 429).
- `src/db/seeds.ts` — seed DDL + semantic registry (the heart of the "context" value).
- `src/db/schema.ts`, `src/db/readonly.ts` — schema versioning + SQL safety.
- `src/tools/*.ts` — the 5 tools (download is the most substantial).
- `src/index.ts`, `src/config.ts`, `package.json`, `tsconfig.json`, `.env.example`, `README.md`, `PLAN.md`.

## Verification
1. `npm install` then `npm run build` (clean `tsc`).
2. Create `.env` from `.env.example` with real `WCL_CLIENT_ID`/`WCL_CLIENT_SECRET` (+ `WCL_USER_ID`).
3. Smoke-test with the MCP Inspector: `npx @modelcontextprotocol/inspector node dist/index.js`.
   - `find_reports` (your uploads) → returns report codes.
   - `download_report` with a real code → creates `r_<code>_v1`, reports row counts.
   - `get_report_details` → shows 4 tables, stats, semantic guide.
   - `execute_readonly_query` → e.g. top damage by actor:
     `SELECT a.name, SUM(e.amount) dmg FROM fight_events e JOIN actors a ON a.actor_id=e.source_id
      WHERE e.type='damage' GROUP BY 1 ORDER BY 2 DESC LIMIT 10`.
   - Confirm a mutating query (e.g. `DROP TABLE ...`) is rejected by the guard.
   - `delete_local_report` → schema gone; `get_report_details` then errors.
4. Verify idempotency: second `download_report` of same code returns "already downloaded" without refetch.

## Out of scope for v1 (noted for later)
- Player-name search in `find_reports`; user-OAuth (`/api/v2/user`) flow; additional seed tables
  (e.g. pre-aggregated damage/healing summary tables); schema migrations between versions; circuit breaker.
