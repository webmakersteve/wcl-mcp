import { quotedIdentifier, type DuckDBConnection } from "@duckdb/node-api";
import type { TableSpec } from "../db/seeds.js";
import { quotedSchema, schemaName } from "../db/schema.js";

/**
 * Per-report tables written by import_mdt_route. Created on first import and
 * keyed by fight_id; re-importing a route for a fight replaces its rows.
 * Column order is authoritative (rows are inserted positionally).
 */
export const ROUTE_TABLES: Record<string, TableSpec> = {
  route_imports: {
    description:
      "One row per fight with an imported MDT route: the route's identity and the overall plan.",
    columns: {
      fight_id: { type: "INTEGER", description: "The Mythic+ run (fights.fight_id) the route was matched against." },
      route_name: { type: "VARCHAR", description: "Route title from MDT." },
      route_uid: { type: "VARCHAR", description: "MDT's route uid." },
      mdt_dungeon_idx: { type: "INTEGER", description: "MDT dungeon index.", usage: "Join to mdt.dungeons.dungeon_idx." },
      dungeon_name: { type: "VARCHAR", description: "Dungeon name per MDT." },
      planned_pulls: { type: "INTEGER", description: "Number of pulls in the route." },
      planned_forces: { type: "INTEGER", description: "Enemy forces the route plans to kill." },
      total_forces: { type: "INTEGER", description: "Enemy forces needed for 100%." },
      wipes: { type: "INTEGER", description: "Group wipes (every player dead at once) during the run." },
      mdt_commit: { type: "VARCHAR", description: "MDT data commit the route was resolved against." },
      mdt_string: { type: "VARCHAR", description: "The original MDT import string." },
      imported_at: { type: "BIGINT", description: "Import time, Unix epoch ms." },
    },
  },

  route_pulls: {
    description:
      "One row per planned route pull, with how it actually went. The route-faithful replacement " +
      "for WCL's time-sliced pulls: damage counts only damage done to this pull's own mobs (and " +
      "their adds), so chained pulls don't bleed into each other.",
    columns: {
      fight_id: { type: "INTEGER", description: "Join to route_imports.fight_id / fights.fight_id." },
      pull_index: { type: "INTEGER", description: "1-based pull number in the route." },
      planned_units: { type: "INTEGER", description: "Mobs the route planned for this pull." },
      planned_forces: { type: "INTEGER", description: "Enemy forces planned for this pull." },
      matched_units: { type: "INTEGER", description: "Planned mobs that were found and fought." },
      matched_forces: { type: "INTEGER", description: "Forces of the matched planned mobs." },
      add_units: { type: "INTEGER", description: "Summons/adds MDT doesn't list, attributed to this pull." },
      engagements: { type: "VARCHAR", description: "Comma-separated engagement numbers (route_units.engagement) this pull's mobs came from. Several = the pull was taken in pieces; one shared with another pull = pulls merged." },
      attempts: { type: "INTEGER", description: "Number of attempts: 1 plus one per wipe the pull was in progress for. Later attempts only include the mobs still alive.", usage: "Per-attempt detail is in route_pull_attempts." },
      outcome: { type: "VARCHAR", description: "Outcome of the last attempt: 'kill', 'wipe' (never cleared), or 'incomplete' (run ended mid-pull)." },
      start_time: { type: "BIGINT", description: "First player hit on any of this pull's mobs, ms relative to report start.", usage: "Subtract fights.start_time for run-relative time. Null if the pull never happened." },
      end_time: { type: "BIGINT", description: "Last of this pull's mobs dying (or last hit on mobs that never die), report-relative ms." },
      span_ms: { type: "BIGINT", description: "Wall-clock end_time - start_time, including wipes and time spent on other pulls in between. Not the DPS denominator." },
      active_ms: { type: "BIGINT", description: "Time this pull's mobs were actually being fought: per attempt, the union of each mob's first-hit-to-death interval, summed over attempts.", usage: "The DPS denominator. For per-player DPS: player damage to this pull's units / (active_ms / 1000)." },
      damage: { type: "BIGINT", description: "Player + pet damage (incl. absorbed) to this pull's mobs and adds, all attempts." },
      dps: { type: "DOUBLE", description: "Group DPS on this pull's own targets: damage / active_ms. Comparable across pulls regardless of chaining." },
      actual_order: { type: "INTEGER", description: "1-based order the pull was actually started in. Compare with pull_index for route order deviations." },
      chained_from: { type: "INTEGER", description: "For the last attempt: route pull still in combat when it started (latest-started such pull); null if started clean.", usage: "Non-null = chained pull." },
      overlap_ms: { type: "BIGINT", description: "How long the last attempt overlapped chained_from." },
    },
  },

  route_pull_attempts: {
    description:
      "One row per attempt at a route pull. A wipe ends an attempt; the next attempt at that pull " +
      "covers only the mobs still alive, so it can be partial.",
    columns: {
      fight_id: { type: "INTEGER", description: "Join to route_pulls.fight_id." },
      pull_index: { type: "INTEGER", description: "Join to route_pulls.pull_index." },
      attempt: { type: "INTEGER", description: "1-based attempt number for this pull." },
      outcome: { type: "VARCHAR", description: "'kill', 'wipe', or 'incomplete' (run ended with the pull unfinished)." },
      start_time: { type: "BIGINT", description: "First hit on this attempt's mobs, report-relative ms." },
      end_time: { type: "BIGINT", description: "Last mob death, or last hit for wipes/unkilled mobs, report-relative ms.", usage: "Damage to the pull's route_units with fight_events.timestamp BETWEEN start_time AND end_time is exactly this attempt's damage." },
      active_ms: { type: "BIGINT", description: "Union of this attempt's mobs' first-hit-to-end intervals." },
      damage: { type: "BIGINT", description: "Player + pet damage to the pull's mobs and adds in this attempt." },
      dps: { type: "DOUBLE", description: "damage / active_ms." },
      units_fought: { type: "INTEGER", description: "Route mobs fought in this attempt." },
      units_killed: { type: "INTEGER", description: "Of those, how many died in this attempt." },
      chained_from: { type: "INTEGER", description: "Route pull still in combat when this attempt started; null if started clean." },
      overlap_ms: { type: "BIGINT", description: "How long this attempt overlapped chained_from." },
    },
  },

  route_planned_units: {
    description:
      "One row per mob the route planned (MDT spawn), and the log unit matched to it, if any.",
    columns: {
      fight_id: { type: "INTEGER", description: "Join to route_pulls.fight_id." },
      pull_index: { type: "INTEGER", description: "Planned route pull." },
      enemy_idx: { type: "INTEGER", description: "MDT enemy index.", usage: "With clone_idx, joins mdt.spawns." },
      clone_idx: { type: "INTEGER", description: "MDT spawn index." },
      npc_id: { type: "INTEGER", description: "Creature id." },
      name: { type: "VARCHAR", description: "Mob name." },
      forces: { type: "INTEGER", description: "Enemy forces for this mob." },
      is_boss: { type: "BOOLEAN", description: "Boss unit." },
      pack: { type: "INTEGER", description: "MDT pack (group) number." },
      matched_actor_id: { type: "INTEGER", description: "Matched log unit's actor id; null = planned but not found (skipped or killed elsewhere)." },
      matched_instance: { type: "INTEGER", description: "Matched log unit's instance." },
    },
  },

  route_units: {
    description:
      "One row per enemy unit the group damaged in the run, and which route pull it was assigned to.",
    columns: {
      fight_id: { type: "INTEGER", description: "The run." },
      actor_id: { type: "INTEGER", description: "Actor id.", usage: "Join fight_events ON target_id = actor_id AND coalesce(target_instance, 1) = instance for damage to this mob." },
      instance: { type: "INTEGER", description: "Instance of the actor (which individual mob)." },
      npc_id: { type: "BIGINT", description: "Creature id (actors.game_id)." },
      name: { type: "VARCHAR", description: "Mob name." },
      first_hit: { type: "BIGINT", description: "First player/pet damage to this mob, report-relative ms." },
      end_time: { type: "BIGINT", description: "Death, or last damage taken if it never died, report-relative ms." },
      died: { type: "BOOLEAN", description: "Whether a death event was logged." },
      damage_taken: { type: "BIGINT", description: "Player + pet damage to this mob (incl. absorbed)." },
      engagement: { type: "INTEGER", description: "Engagement number: route mobs first hit within 5s of each other share one. Null for adds." },
      pull_index: { type: "INTEGER", description: "Route pull this mob counts toward; null if none." },
      assignment: { type: "VARCHAR", description: "'route' = matched to a planned spawn; 'off_route' = an MDT mob the route had no room for (extra kill); 'add' = a summon/add MDT doesn't list, attributed by summoner or time." },
      forces: { type: "INTEGER", description: "Enemy forces this kill was worth (0 for adds)." },
      attempts: { type: "INTEGER", description: "Number of attempts (epochs between wipes) this mob was fought in; >1 means it survived a wipe." },
    },
  },
};

/**
 * Create any missing route tables and clear rows for `fightId`. A table from an
 * older layout is rebuilt, dropping its other fights' imports (re-import them).
 */
export async function resetRouteTables(conn: DuckDBConnection, code: string, fightId: number): Promise<void> {
  const schema = quotedSchema(code);
  for (const [table, spec] of Object.entries(ROUTE_TABLES)) {
    const existing = await conn.runAndReadAll(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = $schema AND table_name = $table ORDER BY ordinal_position`,
      { schema: schemaName(code), table },
    );
    const have = existing.getRowObjects().map((r) => String(r.column_name)).join(",");
    if (have && have !== Object.keys(spec.columns).join(",")) {
      await conn.run(`DROP TABLE ${schema}.${quotedIdentifier(table)}`);
    }
    const cols = Object.entries(spec.columns)
      .map(([name, c]) => `${quotedIdentifier(name)} ${c.type}`)
      .join(", ");
    await conn.run(`CREATE TABLE IF NOT EXISTS ${schema}.${quotedIdentifier(table)} (${cols})`);
    await conn.run(`DELETE FROM ${schema}.${quotedIdentifier(table)} WHERE fight_id = $fight`, {
      fight: fightId,
    });
  }
}

/** Insert rows positionally (values in ROUTE_TABLES column order). */
export async function insertRows(
  conn: DuckDBConnection,
  code: string,
  table: keyof typeof ROUTE_TABLES,
  rows: unknown[][],
): Promise<void> {
  if (!rows.length) return;
  const appender = await conn.createAppender(table, schemaName(code));
  const types = Object.values(ROUTE_TABLES[table]!.columns).map((c) => c.type);
  try {
    for (const row of rows) {
      row.forEach((v, i) => {
        if (v === null || v === undefined) appender.appendNull();
        else if (types[i] === "VARCHAR") appender.appendVarchar(String(v));
        else if (types[i] === "BOOLEAN") appender.appendBoolean(Boolean(v));
        else if (types[i] === "DOUBLE") appender.appendDouble(Number(v));
        else if (types[i] === "BIGINT") appender.appendBigInt(BigInt(Math.trunc(Number(v))));
        else appender.appendInteger(Math.trunc(Number(v)));
      });
      appender.endRow();
    }
    appender.flushSync();
  } finally {
    appender.closeSync();
  }
}

