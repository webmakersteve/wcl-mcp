# wcl-mcp

A **local** [MCP](https://modelcontextprotocol.io) server that gives an agent rich context about a
World of Warcraft dungeon or raid run from [Warcraft Logs](https://www.warcraftlogs.com).

It downloads a report's full combat-log event stream into a local [DuckDB](https://duckdb.org)
database, then lets the agent inspect the data and run read-only SQL against it — fast, offline, and
without hammering the WCL API.

## How it works

1. **find** a report (or you hand the agent a report code).
2. **download** it — the server pages the WCL v2 GraphQL API and materializes the run into a DuckDB
   schema named `r_<reportCode>_v1` with four seed tables:
   - `report_details` — one row of high-level metadata
   - `fights` — one row per pull/encounter
   - `actors` — players/pets/NPCs (resolves event source/target ids to names)
   - `fight_events` — the raw event stream (`dataType: All`), with a `raw` JSON column
3. **inspect** the schema via `get_report_details` (tables, row counts, column stats, and a semantic
   guide describing every column and how to query it).
4. **analyze** with `execute_readonly_query` — arbitrary read-only DuckDB SQL.

It runs locally because it uses your Warcraft Logs API credentials.

## Tools

| Tool | Purpose |
| --- | --- |
| `find_reports` | Search your uploaded reports by zone + date range → report codes. |
| `download_report` | Fetch a report into a local DuckDB schema (idempotent; `force` to rebuild). |
| `get_report_details` | Describe a downloaded report: tables, schemas, stats, semantic guide. |
| `execute_readonly_query` | Run a single read-only SQL statement scoped to one report. |
| `delete_local_report` | Drop a report's local schema/tables. |
| `lookup_spells` | Spell names, rendered descriptions, and mechanics (cooldown, charges, cost, duration...) by id or name. |
| `sync_game_data` | Download spell data for the latest live build (automatic on first `lookup_spells`). |

## Spell data

Spell ids in logs (`fight_events.ability_game_id`) are resolved locally from WoW client data
rather than per-spell web APIs. `sync_game_data` downloads ~15 DB2 tables (SpellName, Spell,
SpellEffect, SpellMisc, cooldowns, charges, costs, ...) as CSV from
[wago.tools](https://wago.tools) for the current live build — one request per table, ~150 MB,
about 25 s — into a shared `gamedata` schema in the same DuckDB file (~55 MB). It's a no-op until
the next game patch.

- `lookup_spells` renders description templates (`$s1`, `$d`, `$@spelldesc…`, `${…}`
  expressions, `$?a123[…][…]` conditionals). Character-dependent values are shown as
  `(388% of Spell Power)`; talent-dependent text as `[with Pyrotechnics: …]`; values only known at
  runtime as `(varies)`.
- `execute_readonly_query` can join `gamedata.<table>` alongside the report's tables, e.g.
  `JOIN gamedata.spell s ON s.spell_id = e.ability_game_id`. `get_report_details` documents them.
- Data is the client build's DB2s as exported by wago.tools; server-side hotfixes may not be
  reflected.

## Setup

```bash
npm install
npm run build
```

Create a **v2 API client** at https://www.warcraftlogs.com/api/clients/ and copy `.env.example` to
`.env`:

```
WCL_CLIENT_ID=...
WCL_CLIENT_SECRET=...
WCL_USER_ID=...          # numeric id from your profile URL; required only for find_reports
WCL_DB_PATH=./data/wcl.duckdb   # optional; this is the default
```

> Note: Warcraft Logs has no long-lived personal access token. Auth uses OAuth client-credentials —
> the server exchanges your client id/secret for a short-lived bearer token automatically. Because
> client-credentials has no "current user", `find_reports` needs your numeric `WCL_USER_ID`.

## Run / debug

Smoke-test with the MCP Inspector:

```bash
npx @modelcontextprotocol/inspector node dist/index.js
```

## Use from an MCP client

```json
{
  "mcpServers": {
    "wcl": {
      "command": "node",
      "args": ["/absolute/path/to/wcl-mcp/dist/index.js"],
      "env": {
        "WCL_CLIENT_ID": "...",
        "WCL_CLIENT_SECRET": "...",
        "WCL_USER_ID": "..."
      }
    }
  }
}
```

## Example analysis query

After downloading a report, top damage sources for a fight:

```sql
SELECT a.name, a.sub_type AS class, SUM(e.amount) AS damage
FROM fight_events e
JOIN actors a ON a.actor_id = e.source_id
WHERE e.type = 'damage' AND e.fight_id = 1
GROUP BY 1, 2
ORDER BY damage DESC
LIMIT 10;
```

(Table names are unqualified — `execute_readonly_query` scopes `search_path` to the report.)

## Notes & limits

- `fight_events.raw` holds the complete event JSON; query fields not promoted to columns with
  `json_extract(raw, '$.field')` / `json_extract_string(...)`.
- DuckDB runs with `enable_external_access=false`, so queries can't read local files or the network
  (`read_csv`, `read_text`, `glob`, `ATTACH`, ...). Only the downloaded reports are reachable.
- Player-name search isn't supported by the WCL API; download a report and filter via SQL instead.
- Schema version is `v1`; the `_v<N>` suffix on each report schema allows future layout changes.

See `PLAN.md` for the full design.
