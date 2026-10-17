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
- **Validation:** `zod`. Env via `process.env` only (set by the MCP client; no `.env` loader, since as a plugin the server runs in the user's project).

## Project structure
```
wcl-mcp/
  package.json            # type: module, bin: wcl-mcp -> dist/index.js, scripts: build/dev/start
  tsconfig.json           # NodeNext, ES2022, strict, outDir dist
  .gitignore              # node_modules, dist, data/, .env
  README.md               # setup, env, MCP client config snippet
  PLAN.md                 # copy of this plan (created as step 0 — user asked to persist it)
  src/
    index.ts              # bootstrap McpServer, register 5 tools, connect stdio
    config.ts             # load+validate env (zod); WCL_DB_PATH default: per-user data dir
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

- **One persistent file**, default in the per-user data dir, e.g. `~/Library/Application Support/wcl-mcp/wcl.duckdb` (override `WCL_DB_PATH`).
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
- `src/index.ts`, `src/config.ts`, `package.json`, `tsconfig.json`, `README.md`, `PLAN.md`.

## Verification
1. `npm install` then `npm run build` (clean `tsc`).
2. Set any overrides (`WCL_*`) in the MCP client config's `env`; none are required.
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
- Player-name search in `find_reports`; additional seed tables
  (e.g. pre-aggregated damage/healing summary tables); schema migrations between versions; circuit breaker.

---

# Phase 2: Local combat logs (hybrid, unified schema)

## Context
Import raw `WoWCombatLog*.txt` files alongside WCL downloads, **into the same schema**, so local
and remote runs can be queried and compared with identical SQL. WCL stays the default source:
report discovery, other people's logs, title/owner and Wipefest insights only exist there.
WoWAnalyzer's CombatLogParser (2018 prototype, unlicensed) was reviewed and is not reused; we
write our own version-aware parser.

## Unified schema (SCHEMA_VERSION 3)
- **Local importer emits WCL-shaped events**: same `type` names, same `raw` JSON keys, same id
  semantics (actor ids, 1-based `*_instance`, ms relative to report start). Flags WCL derives
  that we can't (e.g. `cast.fake`) are omitted, never faked. Raw-only data (positions, HP from
  advanced logging) goes under `raw.local` so it can't collide with WCL keys.
- Fight layout mirrors WCL: one fight per M+ key (bosses as `dungeonencounterstart/end` events),
  one per raid boss pull, trash segments as `encounter_id = 0` fights.
- New nullable columns:
  - `report_details.source` (`'wcl' | 'local'`), `log_path`
  - `fights.game_zone_id`, `challenge_mode_id`: game-native ids. WCL's encounter ids for keys
    (e.g. Kings' Rest = `61762` on fights but `11762` on `dungeonstart`) aren't comparable across sources.
  - `actors.guid`, `actors.player_key` (`Name-Server`): the documented cross-report player key.
    Verify WCL player `game_id` == numeric part of the player GUID; if so, it's a second key.
- Local schemas: `l_<hash>_v<N>`, hash of the file's first two lines (stable as it grows or moves).
- No compare tool. `execute_readonly_query` accepts `reports: { alias: code, ... }` (any number,
  any source) in place of a single `report_code`. Per call, the server creates TEMP views on the
  call's connection and drops them after, so the user SQL guard is unchanged:
  - `<alias>_<table>` per report (DuckDB temp views can't live in a custom schema);
  - `all_fights` / `all_actors` / `all_events`: UNION ALL across reports with a `report` column.
    `all_events` adds stable keys, since actor ids are per-report: `source_key`/`target_key`
    (`player_key` for players, `npc:<game_id>[:instance]` otherwise), `source_owner_key` (pet
    owner) and `t_fight` (ms since the fight's start).
  Comparisons are then `GROUP BY report` or DuckDB `PIVOT ... ON report`.

## Parser (`src/local/`)
- Streaming line reader → tokenizer (nested `[]`/`()`/quoted strings) → per-`COMBAT_LOG_VERSION`
  field layouts for prefixes/suffixes → WCL-shaped event mapper.
- Stateful resolution: GUID → actor id (with NPC `game_id` + spawn UID → instance), pet ownership
  (`SPELL_SUMMON` + advanced-logging owner GUID), death killer (the last overkilling hit, as WCL does), `hitType`
  from crit/glancing flags, segmenter (ENCOUNTER_*, CHALLENGE_MODE_*, trash heuristics).
- Requires Advanced Combat Logging; detect when it's off and record that in `report_details`.

## Log directory sync (on request)
- Originally a background watcher (`fs.watch` + polling, resumed on server start). Dropped: with
  one server per session every open session parsed the same lines, for only slightly faster
  ingestion. Instead the user asks for a sync.
- Tools: `sync_local_logs(dir?)` / `forget_log_dir(dir?)` / `list_local_logs`. No env var: synced
  directories persist in DuckDB (`local_logs.log_dirs(path, added_at)`). `sync_local_logs` with
  no `dir` syncs the saved directories, else probes the per-OS default install paths
  (`…/World of Warcraft/_retail_/Logs`) and errors listing what it tried if none exist.
- A sync imports every `WoWCombatLog*.txt` in the directory (nothing else), oldest first. All
  but the newest file are finished (`final`); the newest may still be written, so a fight open at
  its end waits for the next sync. Reading stops at the last complete line (WoW flushes in chunks).
- Each commit runs under the write lock and is a compare-and-set on the stored offset, so two
  sessions syncing at once never both apply a fight (the loser reports `superseded`).
- Ingest state table `local_logs.ingest_files(report_code, path, file_size, byte_offset,
  schema_version, status, updated_at)`, keyed by report code (a hash of the file's first two
  lines, so a moved/renamed file resumes). A size shrink or schema version change → rescan from 0.
  `status` is active / complete / ignored (deleted by the user: syncs skip it).
- Commit granularity: one transaction per **completed segment** (key end, boss pull end, trash
  segment end), storing the byte offset just past the segment's last line, so a crash/restart
  re-parses only the open segment; parser state never needs checkpointing. Between fights the
  offset advances to the end of what was read. A first version won't show in-progress pulls.
  A later `live_*` staging table could expose the open segment for "what's happening now" queries.
- Idempotent: segment schema name is deterministic, so re-import replaces, never duplicates.

## Validation
Matched pair: WCL `fdL2G1c6Vr7H3NDb` (Kings' Rest +16, also fight 5 of `cq6nxBNF1P8hKAwQ`) +
the raw log of the same run. Diff per event type counts, per-player damage/healing totals, deaths
and killers, pet attribution, instance numbering (MDT `route_units` join must still match).
That diff becomes the regression test.

**Parity is approximate by design.** WCL runs a rules engine on top of the raw events: it drops or
reattributes damage to stop cheese, flags casts as `fake`, and so on. We don't replicate it. Match
WCL's *shape* (types, keys, id semantics, fight windows) and keep counts and totals close. The
regression test asserts tolerances (e.g. per-type counts and per-player damage/healing within a
few %), not equality. Deliberate differences are listed in the semantic layer so the agent
knows that a local-vs-WCL delta of that kind is expected, not a finding.

### Findings from the first matched pair (WCL `nNMJGp1ThaHdQ6By` vs `WoWCombatLog-101526_210808.txt`)
Log header: `COMBAT_LOG_VERSION,22,ADVANCED_LOG_ENABLED,1,BUILD_VERSION,12.1.5`; timestamps are
`M/D/YYYY HH:MM:SS.mmm±TZ`. Within WCL's fight windows (diff scripts kept outside the repo for now):
- Fight windows: start = `CHALLENGE_MODE_START` and end = `CHALLENGE_MODE_END`, both exact to the ms.
  WoW also writes a zeroed `CHALLENGE_MODE_END` right before each `CHALLENGE_MODE_START` (a
  reset); ignore it. An abandoned key has no end marker, and WCL ends the fight at the last
  combat event before leaving the zone (`kill=false`).
- Exact 1:1 mappings: `absorbed` = `SPELL_ABSORBED`; `heal` = `SPELL_HEAL` + `SPELL_PERIODIC_HEAL`
  (`tick` = periodic); `resourcechange` = `SPELL_ENERGIZE` + `SPELL_PERIODIC_ENERGIZE`; summon,
  death (`UNIT_DIED`), interrupt, dispel, aurabroken, extraattacks, combatantinfo, begincast.
- `damage` = SPELL/PERIODIC/SWING damage + their `_MISSED` + environmental (`tick` = periodic,
  exact). Swing ability = `1` when physical, `-school` otherwise (e.g. `-8` nature, `-32` shadow).
  Environmental = ability `3`. WCL has 118 more swing events than `SWING_DAMAGE`+`SWING_MISSED`
  (~0.06% of damage events) plus 3 single-event diffs. Within tolerance; not chased.
- `cast` = `SPELL_CAST_SUCCESS` + one `melee:true` cast per swing (`SWING_DAMAGE`+`SWING_MISSED`),
  exactly. 1,178 of those casts carry `fake:true` on WCL (proc/secondary casts per its own
  per-ability table, e.g. Mutilate off-hand, Charge, Skull Bash); local imports don't flag them.
- WCL M+ `fight_percentage` (100 on a timed key, 12.07 on the abandoned one) has an unknown meaning;
  left null for local keys.

### Results of the implementation (same matched pair)
- Import: 481k lines in ~3 s; re-import is a no-op; importing the file in 7 chunks split mid-line
  (live) gives exactly the one-shot result; so does syncing a directory as the file grows.
- Per fight: identical windows (to the ms) incl. the abandoned key; events 229,741 vs 229,767 and
  247,906 vs 247,995. Every event type matches exactly except `damage` (the 115 above).
- Per player: healing identical; damage 0.2–1.1% higher locally (WCL's rule engine).
- Deaths 339 = 339; killers 214 vs 230 (the overkill rule covers 214 of WCL's 230).
- Found along the way: the DuckDB node bindings bind JS numbers as 32-bit INTEGER, wrapping epoch
  ms / byte offsets / large GUID ids. All BIGINT params now go through `big()` (db/duck.ts); this
  also fixes WCL `report_details.start_time` and MDT's `synced_at_ms`, which were stored wrapped.
- Found along the way: recreating a schema that an earlier process wrote to disk fails to commit
  inside a transaction ("Could not commit creation of dependency"). Local imports create tables
  before their data transaction; download_report's drop+create in one transaction is unaffected.
