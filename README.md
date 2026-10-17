# wcl-mcp

A **local** [MCP](https://modelcontextprotocol.io) server that gives an agent rich context about a
World of Warcraft dungeon or raid run from [Warcraft Logs](https://www.warcraftlogs.com).

It downloads a report's full combat-log event stream into a local [DuckDB](https://duckdb.org)
database, then lets the agent inspect the data and run read-only SQL against it — fast, offline, and
without hammering the WCL API.

## How it works

1. **find** a report (or you hand the agent a report code).
2. **download** it — the server pages the WCL v2 GraphQL API and materializes the run into a DuckDB
   schema named `r_<reportCode>_v3` with five seed tables:
   - `report_details` — one row of high-level metadata
   - `fights` — one row per pull/encounter
   - `actors` — players/pets/NPCs (resolves event source/target ids to names)
   - `fight_events` — the raw event stream (`dataType: All`), with a `raw` JSON column
   - `fight_health` — health over time (absolute HP, max HP, %) for every friendly and enemy
     actor per fight, from WCL's Resources → Health graph; good for health/DPS trend analysis
3. **inspect** the schema via `get_report_details` (tables, row counts, column stats, and a semantic
   guide describing every column and how to query it).
4. **analyze** with `execute_readonly_query` — arbitrary read-only DuckDB SQL.

It runs locally because it uses your Warcraft Logs API credentials. Ask the agent to log you in
with your Warcraft Logs account to also reach your private reports.

## Tools

| Tool | Purpose |
| --- | --- |
| `login` | Sign in with your Warcraft Logs account so tools can see your private reports. |
| `logout` | Forget the stored login; back to public reports only. |
| `auth_status` | Whether you're logged in (and as whom), or a login is waiting on you. |
| `find_reports` | Search your uploaded reports by zone + date range → report codes. |
| `download_report` | Fetch a report into a local DuckDB schema (idempotent; `force` to rebuild). |
| `get_report_details` | Describe a downloaded report: tables, schemas, stats, semantic guide. |
| `execute_readonly_query` | Run a single read-only SQL statement scoped to one report. |
| `delete_local_report` | Drop a report's local schema/tables. |
| `lookup_spells` | Spell names, rendered descriptions, and mechanics (cooldown, charges, cost, duration...) by id or name. |
| `sync_game_data` | Download spell data for the latest live build (automatic on first `lookup_spells`). |
| `import_mdt_route` | Match a Mythic Dungeon Tools route string against a downloaded M+ run: re-slice it into the route's pulls (damage/DPS per planned pull, immune to pull chaining) and report how faithfully it was followed. |
| `get_pull_insights` | What went wrong on a raid pull, via Wipefest's per-boss mechanic analysis: deaths, avoidable damage, failed mechanics, worst offenders, spell ids — whole fight vs. up to the first death. |

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

## MDT routes

WCL splits a Mythic+ key into pulls by time, so chained pulls blur together. `import_mdt_route`
takes an MDT export string (`!~MDT2~…`: base64 → raw deflate → CBOR) and assigns every enemy the
group fought to a planned route pull, by npc id and engagement timing. A pull's damage is then the
damage done to *its own* mobs, however it overlapped with its neighbours, and its DPS divides that by
the time those mobs were being fought (the union of each mob's first-hit-to-death interval).

- Wipes (every player dead, or all but one with combat then stopping) split the run into attempts.
  Mobs reset by a wipe keep their log identity, so a pull's later attempt covers only the mobs still
  alive. Per-attempt outcome, damage and DPS are in `route_pull_attempts`.

- MDT routes reference enemies by their index in MDT's per-dungeon data, so the server syncs that
  data from the [MDT repo](https://github.com/Nnoggie/MythicDungeonTools) into a shared `mdt`
  schema (pinned to a commit, re-checked daily).
- Results land in the report's schema as `route_imports`, `route_pulls`, `route_pull_attempts`,
  `route_planned_units` and `route_units`. The tool also returns a faithfulness summary: planned vs. fought mobs and forces,
  off-route kills, and skipped, out-of-order, chained, merged and split pulls.
- Logs carry no positions, so same-npc mobs in neighbouring pulls can be swapped. Summons and boss
  adds that MDT doesn't list are attributed to their summoner's pull, or else the active pull.

## Install as a Claude Code plugin

```
/plugin install wcl-mcp --marketplace webmakersteve/wcl-mcp
```

(Or in two steps: `/plugin marketplace add webmakersteve/wcl-mcp`, then
`/plugin install wcl-mcp@wcl-mcp`.) No configuration is needed: ask Claude to log you in to
Warcraft Logs, and the database lives in the per-user data directory described below. Requires
Node.js 20+ on your PATH; Claude Code installs the npm dependencies (~120 MB, mostly DuckDB's
native binary) when it installs the plugin.

### Releases

Releases are automated with [release-please](https://github.com/googleapis/release-please), so
**commit messages must follow [Conventional Commits](https://www.conventionalcommits.org)**
(`feat:`, `fix:`, `chore:`, `feat!:` for breaking changes, ...):

1. Every push to `main` updates a release PR that bumps the version in `package.json`,
   `package-lock.json`, `.claude-plugin/plugin.json` and `src/index.ts`, and updates `CHANGELOG.md`.
   `feat` and `fix` commits make a release; `chore`, `docs` and the like don't.
2. Merging the release PR tags `vX.Y.Z` and publishes the GitHub release.
3. The publish job then builds `dist/`, packages the plugin zip (`scripts/package-plugin.sh`),
   installs and smoke-tests it the way Claude Code would (`scripts/smoke-test.mjs`), attaches it to
   the release, and commits its URL and `sha256` to `.claude-plugin/marketplace.json`.

The repo is the marketplace; the plugin itself is the release zip (an `archive` source), so
`dist/` is never committed. Users get an update when the plugin's `version` changes. Pull
requests run the same build, packaging and smoke test (`.github/workflows/ci.yml`).

To test a package locally: `npm run build && scripts/package-plugin.sh /tmp/wcl-release`.

## Setup (from source)

```bash
npm install
npm run build
```

Nothing needs configuring. Every setting is an optional environment variable, read only from the
server's process environment (there is no `.env` loader), so set them in your MCP client's
config, e.g. `env` in `.mcp.json`. This repo's `.mcp.json` sets `WCL_DB_PATH` for development.

| Variable | Default | Purpose |
| --- | --- | --- |
| `WCL_CLIENT_ID` | built-in wcl-mcp client | Use your own [v2 API client](https://www.warcraftlogs.com/api/clients/) |
| `WCL_CLIENT_SECRET` | unset | Public-report access without logging in (client credentials) |
| `WCL_REDIRECT_URI` | `http://localhost:8888/redirect` | Login redirect; must match one registered on the client |
| `WCL_USER_ID` | the logged-in user | Numeric id from your profile URL, for `find_reports` without login |
| `WCL_DB_PATH` | per-user data dir (below) | DuckDB file location |
| `WCL_AUTH_PATH` | `~/.config/wcl-mcp/auth.json` | Where login tokens are stored |
| `WCL_REPORT_TTL_DAYS` | `7` | Days a downloaded report is kept before it's deleted; `0` keeps reports forever |
| `WCL_DB_LOCK_TIMEOUT_SECONDS` | `300` | How long to wait for another wcl-mcp process (e.g. another Claude Code session) to release the DuckDB file before a tool call fails |

The DuckDB file defaults to a per-user data directory, so downloaded reports and game data persist
across projects and sessions whatever directory the server is launched from:

| OS | Default `WCL_DB_PATH` |
| --- | --- |
| macOS | `~/Library/Application Support/wcl-mcp/wcl.duckdb` |
| Windows | `%LOCALAPPDATA%\wcl-mcp\wcl.duckdb` |
| Linux | `$XDG_DATA_HOME/wcl-mcp/wcl.duckdb` (default `~/.local/share/...`) |

`WCL_DB_PATH` overrides it (relative paths resolve against the working directory; `~` expands).

### Private reports: log in

Without a login the server uses OAuth client-credentials against `/api/v2/client`, which only sees
**public** reports. To include your private ones, add the redirect URI above to your API client on
https://www.warcraftlogs.com/api/clients/, then ask the agent to log you in (the `login` tool).

`login` runs the authorization-code + PKCE flow (scopes `view-user-profile`,
`view-private-reports`):

- If the MCP client supports **URL-mode elicitation**, the server asks the client to show you the
  Warcraft Logs approval page, and sends `notifications/elicitation/complete` when you're done.
- Otherwise the server opens the page in your default browser itself; the URL is also in the
  tool result.

Either way a temporary listener on the redirect URI catches the approval. The tool waits up to
90 s (with progress notifications); if you're slower it returns `pending` and the login still
completes in the background (the listener gives up after 10 minutes) — `auth_status` confirms.

Tokens are saved to `~/.config/wcl-mcp/auth.json` (Windows: `%APPDATA%\wcl-mcp\auth.json`;
mode 0600; override with `WCL_AUTH_PATH`). Requests then go to
`/api/v2/user`, tokens are refreshed as they expire (a dead refresh token logs you out), and
`find_reports` defaults to your uploads. On every login/logout the server swaps the `login` and
`logout` tools and sends `notifications/tools/list_changed`, so clients refresh their tool list.

For setup or debugging outside an agent, the same flow is available as a CLI:
`node dist/index.js login | logout | whoami` (or `npm run login`).

Private report data is cached in the local DuckDB file like any other report. Wipefest
(`get_pull_insights`) can only see public reports.

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
        "WCL_CLIENT_SECRET": "..."
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

Total enemy health remaining per 5 s bucket (a DPS trend — the drop between buckets is damage
done), taking each actor's last reading per bucket:

```sql
WITH last_reading AS (
  SELECT (h.timestamp - f.start_time) // 5000 AS bucket, h.actor_id,
         arg_max(h.hit_points, h.timestamp) AS hp
  FROM fight_health h JOIN fights f USING (fight_id)
  WHERE h.fight_id = 1 AND h.hostility = 'enemy'
  GROUP BY 1, 2
)
SELECT bucket * 5 AS second, SUM(hp) AS enemy_hp
FROM last_reading
GROUP BY 1
ORDER BY 1;
```

(Table names are unqualified — `execute_readonly_query` scopes `search_path` to the report.)

## Notes & limits

- `fight_events.raw` holds the complete event JSON; query fields not promoted to columns with
  `json_extract(raw, '$.field')` / `json_extract_string(...)`.
- `fight_health` limitations (inherent to WCL's health graph):
  - Readings aren't bucketed; they land at each actor's own event times. Bucket in SQL and take
    each actor's last reading per bucket.
  - Individual mobs aren't identified: every instance of an NPC type shares one `actor_id`, and
    their readings are interleaved in one series. Bosses and single mobs are exact; packs of the
    same mob type are approximate, and per-mob health can't be tracked (use
    `fight_events.target_instance` for per-mob damage).
  - A per-bucket total only includes actors with a reading in that bucket, i.e. enemies in combat
    then, not everything left in the fight. A jump up means new enemies were pulled, not healing.
- DuckDB runs with `enable_external_access=false`, so queries can't read local files or the network
  (`read_csv`, `read_text`, `glob`, `ATTACH`, ...). Only the downloaded reports are reachable.
- Player-name search isn't supported by the WCL API; download a report and filter via SQL instead.
- `get_pull_insights` calls `api.wipefest.gg`, the undocumented backend of wipefest.gg (no auth
  needed for public reports). It only covers raid bosses Wipefest has mechanic configs for, and
  may break if Wipefest changes its API. The report need not be downloaded locally.
- Downloaded reports are deleted `WCL_REPORT_TTL_DAYS` (default 7) days after download, checked
  at server startup and on each `download_report`; the agent just downloads them again. Shared game
  data (`gamedata`) and MDT data never expire.
- Schema version is `v3`; the `_v<N>` suffix on each report schema allows future layout changes.
  Reports downloaded under an older version must be downloaded again (tools say so), and the old
  copies are cleaned up by the TTL.
- Imported MDT routes live in their own schema, `route_<reportCode>_v1`, versioned separately
  from the log schema, so re-downloading a report (including after a log schema change) keeps its
  routes. Queries see both schemas' tables unqualified. Routes expire `WCL_REPORT_TTL_DAYS` after
  their last import; `delete_local_report` removes them along with the log.

See `PLAN.md` for the full design.
