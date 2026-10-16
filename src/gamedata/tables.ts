import { quotedIdentifier } from "@duckdb/node-api";

/** Shared (not per-report) schema holding WoW client spell data. */
export const GAMEDATA_SCHEMA = "gamedata";

export type GameColumnType = "INTEGER" | "BIGINT" | "DOUBLE" | "VARCHAR";

export interface GameColumnSpec {
  type: GameColumnType;
  /** Column name in the wago.tools CSV export (WoWDBDefs naming). */
  source: string;
  description: string;
}

export interface GameTableSpec {
  /** DB2 table name, as used in the wago.tools URL: /db2/<source>/csv. */
  source: string;
  description: string;
  /** Column order here is authoritative — the Appender writes positionally. */
  columns: Record<string, GameColumnSpec>;
  /** Loaded only to build another table; dropped after sync and not documented. */
  staging?: boolean;
}

const col = (type: GameColumnType, source: string, description: string): GameColumnSpec => ({
  type,
  source,
  description,
});

/**
 * Tables loaded from wago.tools DB2 CSV exports. Only the columns the lookup and
 * description renderer need (plus a few useful for analysis) are kept; the raw
 * DB2s have many more. Most per-spell tables can have several rows per spell,
 * one per difficulty — DifficultyID 0 is the default/base row.
 */
export const GAME_TABLES: Record<string, GameTableSpec> = {
  spell_name: {
    source: "SpellName",
    staging: true,
    description: "Spell id -> name (merged into `spell`).",
    columns: {
      spell_id: col("INTEGER", "ID", "Spell id."),
      name: col("VARCHAR", "Name_lang", "Spell name (enUS)."),
    },
  },
  spell_text: {
    source: "Spell",
    staging: true,
    description: "Spell text (merged into `spell`).",
    columns: {
      spell_id: col("INTEGER", "ID", "Spell id."),
      subtext: col("VARCHAR", "NameSubtext_lang", "Rank / subtext."),
      description: col("VARCHAR", "Description_lang", "Description template."),
      aura_description: col("VARCHAR", "AuraDescription_lang", "Aura tooltip template."),
    },
  },
  spell_effect: {
    source: "SpellEffect",
    description:
      "One row per spell effect (a spell has 1+ effects, indexed from 0). Description tokens like $s1 refer to effect_index 0.",
    columns: {
      id: col("INTEGER", "ID", "Effect row id."),
      spell_id: col("INTEGER", "SpellID", "Owning spell. Join to spell.spell_id."),
      difficulty_id: col("INTEGER", "DifficultyID", "Difficulty override (0 = default)."),
      effect_index: col("INTEGER", "EffectIndex", "Effect slot, 0-based ($s1 = index 0)."),
      effect: col("INTEGER", "Effect", "Effect type code (e.g. 2 = school damage, 6 = apply aura, 10 = heal)."),
      effect_aura: col("INTEGER", "EffectAura", "Aura type code when effect applies an aura."),
      base_points: col("DOUBLE", "EffectBasePointsF", "Base value. 0 for many stat-scaled damage/heal effects."),
      sp_coefficient: col("DOUBLE", "EffectBonusCoefficient", "Spell power coefficient (1.0 = 100% of Spell Power)."),
      ap_coefficient: col("DOUBLE", "BonusCoefficientFromAP", "Attack power coefficient."),
      aura_period_ms: col("INTEGER", "EffectAuraPeriod", "Tick interval in ms for periodic auras."),
      amplitude: col("DOUBLE", "EffectAmplitude", "Effect amplitude/multiplier ($e tokens)."),
      chain_targets: col("INTEGER", "EffectChainTargets", "Max chain/jump targets."),
      trigger_spell_id: col("INTEGER", "EffectTriggerSpell", "Spell triggered by this effect, if any."),
      misc_value: col("BIGINT", "EffectMiscValue_0", "Effect-specific value (e.g. power type, stat)."),
      radius_index: col("INTEGER", "EffectRadiusIndex_0", "Join to spell_radius.id."),
    },
  },
  spell_misc: {
    source: "SpellMisc",
    description: "Per-spell cast/duration/range/school links.",
    columns: {
      spell_id: col("INTEGER", "SpellID", "Spell id."),
      difficulty_id: col("INTEGER", "DifficultyID", "Difficulty override (0 = default)."),
      cast_time_index: col("INTEGER", "CastingTimeIndex", "Join to spell_cast_time.id."),
      duration_index: col("INTEGER", "DurationIndex", "Join to spell_duration.id."),
      range_index: col("INTEGER", "RangeIndex", "Join to spell_range.id."),
      school_mask: col("INTEGER", "SchoolMask", "Bitmask: 1 Physical, 2 Holy, 4 Fire, 8 Nature, 16 Frost, 32 Shadow, 64 Arcane."),
      icon_file_id: col("INTEGER", "SpellIconFileDataID", "Icon file data id."),
    },
  },
  spell_duration: {
    source: "SpellDuration",
    description: "Duration lookup.",
    columns: {
      id: col("INTEGER", "ID", "Duration id."),
      duration_ms: col("INTEGER", "Duration", "Duration in ms (-1 = until cancelled)."),
      max_duration_ms: col("INTEGER", "MaxDuration", "Max duration in ms (e.g. with pandemic/extension)."),
    },
  },
  spell_cast_time: {
    source: "SpellCastTimes",
    description: "Cast time lookup.",
    columns: {
      id: col("INTEGER", "ID", "Cast time id."),
      cast_time_ms: col("INTEGER", "Base", "Base cast time in ms (0 = instant)."),
    },
  },
  spell_range: {
    source: "SpellRange",
    description: "Range lookup.",
    columns: {
      id: col("INTEGER", "ID", "Range id."),
      name: col("VARCHAR", "DisplayName_lang", "Range label, e.g. 'Long Range'."),
      min_yd: col("DOUBLE", "RangeMin_0", "Min range in yards (hostile)."),
      max_yd: col("DOUBLE", "RangeMax_0", "Max range in yards (hostile)."),
    },
  },
  spell_radius: {
    source: "SpellRadius",
    description: "Area-of-effect radius lookup.",
    columns: {
      id: col("INTEGER", "ID", "Radius id."),
      radius_yd: col("DOUBLE", "Radius", "Radius in yards."),
      radius_max_yd: col("DOUBLE", "RadiusMax", "Max radius in yards."),
    },
  },
  spell_cooldown: {
    source: "SpellCooldowns",
    description: "Cooldowns and GCD per spell.",
    columns: {
      spell_id: col("INTEGER", "SpellID", "Spell id."),
      difficulty_id: col("INTEGER", "DifficultyID", "Difficulty override (0 = default)."),
      cooldown_ms: col("INTEGER", "RecoveryTime", "Spell cooldown in ms."),
      category_cooldown_ms: col("INTEGER", "CategoryRecoveryTime", "Shared category cooldown in ms."),
      gcd_ms: col("INTEGER", "StartRecoveryTime", "Global cooldown triggered, in ms."),
    },
  },
  spell_categories: {
    source: "SpellCategories",
    description: "Per-spell category links (charges, dispel, mechanic).",
    columns: {
      spell_id: col("INTEGER", "SpellID", "Spell id."),
      difficulty_id: col("INTEGER", "DifficultyID", "Difficulty override (0 = default)."),
      category: col("INTEGER", "Category", "Cooldown category. Join to spell_category.id."),
      charge_category: col("INTEGER", "ChargeCategory", "Charge category. Join to spell_category.id."),
      dispel_type: col("INTEGER", "DispelType", "Dispel type (1 Magic, 2 Curse, 3 Disease, 4 Poison, 9 Enrage)."),
      mechanic: col("INTEGER", "Mechanic", "Mechanic id (stun, root, ...)."),
    },
  },
  spell_category: {
    source: "SpellCategory",
    description: "Category definitions: charge counts and recharge times.",
    columns: {
      id: col("INTEGER", "ID", "Category id."),
      name: col("VARCHAR", "Name_lang", "Category name."),
      max_charges: col("INTEGER", "MaxCharges", "Base charges (talents can add more)."),
      charge_recovery_ms: col("INTEGER", "ChargeRecoveryTime", "Recharge time per charge in ms."),
    },
  },
  spell_aura_options: {
    source: "SpellAuraOptions",
    description: "Stacking and proc behaviour.",
    columns: {
      spell_id: col("INTEGER", "SpellID", "Spell id."),
      difficulty_id: col("INTEGER", "DifficultyID", "Difficulty override (0 = default)."),
      max_stacks: col("INTEGER", "CumulativeAura", "Max stacks (0 = does not stack)."),
      proc_chance: col("INTEGER", "ProcChance", "Proc chance percent."),
      proc_charges: col("INTEGER", "ProcCharges", "Charges consumed before the aura fades."),
      proc_icd_ms: col("INTEGER", "ProcCategoryRecovery", "Internal cooldown between procs in ms."),
    },
  },
  spell_power: {
    source: "SpellPower",
    description: "Resource costs.",
    columns: {
      spell_id: col("INTEGER", "SpellID", "Spell id."),
      power_type: col("INTEGER", "PowerType", "Resource (0 Mana, 1 Rage, 2 Focus, 3 Energy, 4 Combo Points, 6 Runic Power, 8 Astral Power, 9 Holy Power, 11 Maelstrom, 12 Chi, 13 Insanity, 17 Fury, 18 Pain, 19 Essence)."),
      cost: col("INTEGER", "ManaCost", "Flat cost (rage/runic power are x10)."),
      cost_pct: col("DOUBLE", "PowerCostPct", "Cost as % of base mana."),
      required_aura_spell_id: col("INTEGER", "RequiredAuraSpellID", "Cost only applies with this aura (often a spec aura); 0 = always."),
    },
  },
  spell_class_options: {
    source: "SpellClassOptions",
    description: "Player class family of class spells (absent for NPC/item spells).",
    columns: {
      spell_id: col("INTEGER", "SpellID", "Spell id."),
      class_family: col("INTEGER", "SpellClassSet", "Class family: 3 Mage, 4 Warrior, 5 Warlock, 6 Priest, 7 Druid, 8 Rogue, 9 Hunter, 10 Paladin, 11 Shaman, 15 Death Knight, 53 Monk, 107 Demon Hunter, 224 Evoker."),
    },
  },
  spell_x_description_variables: {
    source: "SpellXDescriptionVariables",
    description: "Links spells to named description variables.",
    columns: {
      spell_id: col("INTEGER", "SpellID", "Spell id."),
      variables_id: col("INTEGER", "SpellDescriptionVariablesID", "Join to spell_description_variables.id."),
    },
  },
  spell_description_variables: {
    source: "SpellDescriptionVariables",
    description: "Named variables ($<name>) used by description templates.",
    columns: {
      id: col("INTEGER", "ID", "Variables id."),
      variables: col("VARCHAR", "Variables", "Lines of `$name=expression`."),
    },
  },
};

/** Built from the staging tables after load; documented alongside GAME_TABLES. */
export const SPELL_TABLE_DOC = {
  description:
    "One row per spell: name and raw description templates. Join fight_events.ability_game_id to spell.spell_id. " +
    "Use lookup_spells for rendered descriptions.",
  columns: {
    spell_id: "Spell id (= WCL ability gameID).",
    name: "Spell name (enUS).",
    subtext: "Rank / subtext, often empty.",
    description: "Description template ($s1, $d, ... tokens unrendered).",
    aura_description: "Buff/debuff tooltip template.",
  },
};

export const GAMEDATA_META_TABLE = "meta";

/** Compact per-table docs (description + column descriptions) for get_report_details. */
export function gameDataTableDocs() {
  const docs: Array<{ table: string; description: string; columns: Record<string, string> }> = [
    { table: `${GAMEDATA_SCHEMA}.spell`, description: SPELL_TABLE_DOC.description, columns: SPELL_TABLE_DOC.columns },
  ];
  for (const [table, spec] of Object.entries(GAME_TABLES)) {
    if (spec.staging) continue;
    docs.push({
      table: `${GAMEDATA_SCHEMA}.${table}`,
      description: spec.description,
      columns: Object.fromEntries(Object.entries(spec.columns).map(([n, c]) => [n, c.description])),
    });
  }
  return docs;
}

export function q(name: string): string {
  return quotedIdentifier(name);
}

export function createGameTableSql(table: string, spec: GameTableSpec): string {
  const cols = Object.entries(spec.columns)
    .map(([name, c]) => `  ${q(name)} ${c.type}`)
    .join(",\n");
  return `CREATE TABLE ${q(GAMEDATA_SCHEMA)}.${q(table)} (\n${cols}\n)`;
}
