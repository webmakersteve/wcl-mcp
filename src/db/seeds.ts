import { quotedIdentifier } from "@duckdb/node-api";
import { run } from "./duck.js";
import { quotedSchema } from "./schema.js";

export interface ColumnSpec {
  /** DuckDB SQL type. */
  type: string;
  /** What the column means. */
  description: string;
  /** How to use it in queries (joins, filters, units). */
  usage?: string;
}

export interface TableSpec {
  description: string;
  /** Column order here is authoritative — the Appender writes positionally. */
  columns: Record<string, ColumnSpec>;
}

/**
 * The semantic layer: the single source of truth for both the CREATE TABLE DDL
 * and the human-readable guidance returned by get_report_details. Keep column
 * order stable; download_report appends rows in this order.
 */
export const SEED_TABLES: Record<string, TableSpec> = {
  report_details: {
    description:
      "One row of high-level metadata about the whole report (the run). Start here to orient yourself.",
    columns: {
      report_code: { type: "VARCHAR", description: "Warcraft Logs report code (the run identifier)." },
      title: { type: "VARCHAR", description: "User-provided title of the report." },
      owner: { type: "VARCHAR", description: "WCL username that uploaded the report." },
      zone_id: { type: "INTEGER", description: "WCL zone (instance) id.", usage: "Identifies the raid/dungeon zone." },
      zone_name: { type: "VARCHAR", description: "Human-readable instance name, e.g. 'Liberation of Undermine'." },
      region: { type: "VARCHAR", description: "Region slug (us, eu, kr, tw, cn)." },
      start_time: { type: "BIGINT", description: "Report start, Unix epoch milliseconds (UTC)." },
      end_time: { type: "BIGINT", description: "Report end, Unix epoch milliseconds (UTC)." },
      num_fights: { type: "INTEGER", description: "Number of fights (pulls/encounters) in the report." },
      total_events: { type: "BIGINT", description: "Total rows materialized into fight_events." },
      schema_version: { type: "INTEGER", description: "Seed-schema version used for this download." },
      downloaded_at: { type: "BIGINT", description: "When this report was downloaded locally, Unix epoch milliseconds." },
    },
  },

  fights: {
    description:
      "One row per fight (pull) in the report. A 'fight' is a single encounter attempt. Join fight_events.fight_id to fights.fight_id.",
    columns: {
      fight_id: { type: "INTEGER", description: "Fight id, unique within the report.", usage: "Join target for fight_events.fight_id." },
      name: { type: "VARCHAR", description: "Encounter/boss or trash segment name." },
      encounter_id: { type: "INTEGER", description: "WCL encounter id (0 for trash / non-boss segments)." },
      difficulty: { type: "INTEGER", description: "Difficulty id (e.g. 3=Normal, 4=Heroic, 5=Mythic for raids; null for M+)." },
      keystone_level: { type: "INTEGER", description: "Mythic+ keystone level, null for raid fights." },
      kill: { type: "BOOLEAN", description: "Whether the encounter was a kill (true) or a wipe (false)." },
      fight_percentage: { type: "DOUBLE", description: "Boss health remaining at end of a wipe, as a percentage (0 = kill)." },
      start_time: { type: "BIGINT", description: "Fight start, milliseconds relative to report start_time." },
      end_time: { type: "BIGINT", description: "Fight end, milliseconds relative to report start_time." },
    },
  },

  actors: {
    description:
      "One row per actor (player, pet, NPC) seen in the report's master data. Resolve event source/target ids to names here.",
    columns: {
      actor_id: { type: "INTEGER", description: "Actor id, unique within the report.", usage: "Join target for fight_events.source_id and target_id." },
      name: { type: "VARCHAR", description: "Actor name (character, pet, or NPC name)." },
      type: { type: "VARCHAR", description: "High-level type: 'Player', 'Pet', 'NPC', 'Boss'." },
      sub_type: { type: "VARCHAR", description: "For players, the class (e.g. 'Mage'); otherwise a finer type." },
      server: { type: "VARCHAR", description: "Server/realm name for player actors, null otherwise." },
    },
  },

  fight_events: {
    description:
      "The raw combat-log event stream for every fight (dataType: All). The large fact table. " +
      "Common fields are promoted to columns; the full event JSON is kept in `raw` for anything else.",
    columns: {
      fight_id: { type: "INTEGER", description: "Fight this event belongs to.", usage: "Join to fights.fight_id." },
      timestamp: { type: "BIGINT", description: "Event time, milliseconds relative to report start_time.", usage: "Order events; compute durations." },
      type: { type: "VARCHAR", description: "Event type, e.g. 'damage', 'heal', 'cast', 'begincast', 'applybuff', 'death', 'resourcechange'.", usage: "Filter by event kind. Damage events are type='damage'." },
      source_id: { type: "INTEGER", description: "Actor id that caused the event.", usage: "Join to actors.actor_id to get the source name/class." },
      target_id: { type: "INTEGER", description: "Actor id the event targeted.", usage: "Join to actors.actor_id to get the target name." },
      ability_game_id: { type: "BIGINT", description: "Game spell/ability id involved in the event (null for some events)." },
      amount: { type: "BIGINT", description: "Effect magnitude: damage dealt, healing done, resource gained, etc. (null when not applicable)." },
      hit_type: { type: "INTEGER", description: "Hit classification code (e.g. crit, hit, miss); event-type dependent." },
      raw: { type: "VARCHAR", description: "Full event object as a JSON string.", usage: "Query with json_extract(raw, '$.field') / json_extract_string(...) for fields not promoted to columns (e.g. overkill, resourceChange, abilityName)." },
    },
  },
};

export type SeedTableName = keyof typeof SEED_TABLES;

/** The fight_events column order — used by the Appender during download. */
export const FIGHT_EVENTS_COLUMNS = Object.keys(
  SEED_TABLES.fight_events.columns,
) as Array<keyof typeof SEED_TABLES.fight_events.columns>;

function createTableSql(code: string, table: string, spec: TableSpec): string {
  const cols = Object.entries(spec.columns)
    .map(([name, c]) => `  ${quotedIdentifier(name)} ${c.type}`)
    .join(",\n");
  return `CREATE TABLE ${quotedSchema(code)}.${quotedIdentifier(table)} (\n${cols}\n)`;
}

/** Create all seed tables for a report (schema must already exist). */
export async function createSeedTables(code: string): Promise<void> {
  for (const [table, spec] of Object.entries(SEED_TABLES)) {
    await run(createTableSql(code, table, spec));
  }
}
