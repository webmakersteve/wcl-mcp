import { queryRows } from "../db/duck.js";
import {
  referencedSpellIds,
  renderSpellText,
  type EffectInfo,
  type SpellInfo,
} from "./describe.js";
import { GAMEDATA_SCHEMA, q } from "./tables.js";

/** How many rounds of "load the spells these templates reference" to follow. */
const MAX_REFERENCE_ROUNDS = 3;
/** Cap on spells loaded for one lookup, including referenced ones. */
const MAX_LOADED_SPELLS = 600;

const SCHOOLS: Array<[number, string]> = [
  [1, "Physical"],
  [2, "Holy"],
  [4, "Fire"],
  [8, "Nature"],
  [16, "Frost"],
  [32, "Shadow"],
  [64, "Arcane"],
];

const POWER_TYPES: Record<number, string> = {
  0: "Mana",
  1: "Rage",
  2: "Focus",
  3: "Energy",
  4: "Combo Points",
  5: "Runes",
  6: "Runic Power",
  7: "Soul Shards",
  8: "Astral Power",
  9: "Holy Power",
  11: "Maelstrom",
  12: "Chi",
  13: "Insanity",
  16: "Arcane Charges",
  17: "Fury",
  18: "Pain",
  19: "Essence",
};
/** SpellClassOptions.SpellClassSet -> class. */
const CLASS_FAMILIES: Record<number, string> = {
  3: "Mage",
  4: "Warrior",
  5: "Warlock",
  6: "Priest",
  7: "Druid",
  8: "Rogue",
  9: "Hunter",
  10: "Paladin",
  11: "Shaman",
  15: "Death Knight",
  53: "Monk",
  107: "Demon Hunter",
  224: "Evoker",
};
const CLASS_FAMILY_IDS = Object.keys(CLASS_FAMILIES).join(",");

/** Resources stored x10 in the client data. */
const TENTHS_POWER_TYPES = new Set([1, 6, 17, 18]);

/** Extra (non-template) facts gathered alongside SpellInfo. */
interface SpellExtras {
  subtext: string;
  classFamily: number | null;
  schoolMask: number | null;
  castTimeMs: number | null;
  rangeName: string | null;
  cooldownMs: number | null;
  gcdMs: number | null;
  maxCharges: number | null;
  chargeRecoveryMs: number | null;
  procIcdMs: number | null;
  costs: Array<{ powerType: number; cost: number; costPct: number; requiredAura: number }>;
  triggerSpellIds: number[];
}

const S = q(GAMEDATA_SCHEMA);
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const idList = (ids: number[]) => ids.map((id) => Math.trunc(id)).join(",");

/**
 * Load spells plus everything their templates reference ($@spelldesc, $123s1,
 * talent conditionals), so rendering is a pure in-memory pass.
 */
async function loadSpells(rootIds: number[]): Promise<{
  spells: Map<number, SpellInfo>;
  extras: Map<number, SpellExtras>;
}> {
  const spells = new Map<number, SpellInfo>();
  const extras = new Map<number, SpellExtras>();
  let pending = [...new Set(rootIds)];

  for (let round = 0; round <= MAX_REFERENCE_ROUNDS && pending.length > 0; round++) {
    await loadBatch(pending, spells, extras);
    const next = new Set<number>();
    for (const id of pending) {
      const s = spells.get(id);
      if (!s) continue;
      const refs = [s.description, s.auraDescription, s.variables ?? ""].flatMap(referencedSpellIds);
      // Spec/aura-gated costs are labelled with the gating spell's name.
      refs.push(...(extras.get(id)?.costs.map((c) => c.requiredAura) ?? []));
      for (const ref of refs) {
        if (ref > 0 && !spells.has(ref) && spells.size + next.size < MAX_LOADED_SPELLS) next.add(ref);
      }
    }
    pending = [...next];
  }
  return { spells, extras };
}

async function loadBatch(
  ids: number[],
  spells: Map<number, SpellInfo>,
  extras: Map<number, SpellExtras>,
): Promise<void> {
  const list = idList(ids);
  // Several tables have one row per difficulty; prefer the default (0) row.
  const firstByDifficulty = "QUALIFY row_number() OVER (PARTITION BY spell_id ORDER BY difficulty_id) = 1";

  const [base, effects, misc, aura, cooldowns, charges, power, vars, classes] = await Promise.all([
    queryRows(
      `SELECT spell_id, name, subtext, description, aura_description FROM ${S}.spell WHERE spell_id IN (${list})`,
    ),
    queryRows(
      `SELECT e.spell_id, e.effect_index, e.effect, e.effect_aura, e.base_points, e.sp_coefficient, e.ap_coefficient,
              e.aura_period_ms, e.amplitude, e.chain_targets, e.trigger_spell_id, r.radius_yd
       FROM ${S}.spell_effect e LEFT JOIN ${S}.spell_radius r ON r.id = e.radius_index
       WHERE e.spell_id IN (${list})
       QUALIFY row_number() OVER (PARTITION BY e.spell_id, e.effect_index ORDER BY e.difficulty_id) = 1`,
    ),
    queryRows(
      `SELECT m.spell_id, m.school_mask, d.duration_ms, rg.max_yd, rg.name AS range_name, ct.cast_time_ms
       FROM ${S}.spell_misc m
       LEFT JOIN ${S}.spell_duration d ON d.id = m.duration_index
       LEFT JOIN ${S}.spell_range rg ON rg.id = m.range_index
       LEFT JOIN ${S}.spell_cast_time ct ON ct.id = m.cast_time_index
       WHERE m.spell_id IN (${list}) ${firstByDifficulty}`,
    ),
    queryRows(
      `SELECT spell_id, max_stacks, proc_chance, proc_charges, proc_icd_ms
       FROM ${S}.spell_aura_options WHERE spell_id IN (${list}) ${firstByDifficulty}`,
    ),
    queryRows(
      `SELECT spell_id, cooldown_ms, category_cooldown_ms, gcd_ms
       FROM ${S}.spell_cooldown WHERE spell_id IN (${list}) ${firstByDifficulty}`,
    ),
    queryRows(
      `SELECT c.spell_id, k.max_charges, k.charge_recovery_ms
       FROM ${S}.spell_categories c JOIN ${S}.spell_category k ON k.id = c.charge_category
       WHERE c.spell_id IN (${list}) AND (k.max_charges > 1 OR k.charge_recovery_ms > 0)
       QUALIFY row_number() OVER (PARTITION BY c.spell_id ORDER BY c.difficulty_id) = 1`,
    ),
    queryRows(
      `SELECT spell_id, power_type, cost, cost_pct, required_aura_spell_id
       FROM ${S}.spell_power WHERE spell_id IN (${list})`,
    ),
    queryRows(
      `SELECT x.spell_id, v.variables
       FROM ${S}.spell_x_description_variables x
       JOIN ${S}.spell_description_variables v ON v.id = x.variables_id
       WHERE x.spell_id IN (${list})`,
    ),
    queryRows(
      `SELECT spell_id, class_family FROM ${S}.spell_class_options WHERE spell_id IN (${list})`,
    ),
  ]);

  const byId = <T extends Record<string, unknown>>(rows: T[]) =>
    new Map(rows.map((r) => [Number(r.spell_id), r]));
  const miscBy = byId(misc);
  const auraBy = byId(aura);
  const cdBy = byId(cooldowns);
  const chargesBy = byId(charges);
  const varsBy = byId(vars);
  const classBy = byId(classes);

  for (const row of base) {
    const id = Number(row.spell_id);
    const m = miscBy.get(id);
    const a = auraBy.get(id);
    const effectMap = new Map<number, EffectInfo>();
    const triggers: number[] = [];
    for (const e of effects) {
      if (Number(e.spell_id) !== id) continue;
      effectMap.set(Number(e.effect_index) + 1, {
        effect: num(e.effect) ?? 0,
        aura: num(e.effect_aura) ?? 0,
        basePoints: num(e.base_points) ?? 0,
        spCoefficient: num(e.sp_coefficient) ?? 0,
        apCoefficient: num(e.ap_coefficient) ?? 0,
        periodMs: num(e.aura_period_ms) ?? 0,
        amplitude: num(e.amplitude) ?? 0,
        chainTargets: num(e.chain_targets) ?? 0,
        radiusYd: num(e.radius_yd),
      });
      const trig = num(e.trigger_spell_id);
      if (trig) triggers.push(trig);
    }

    spells.set(id, {
      id,
      name: String(row.name ?? ""),
      description: String(row.description ?? ""),
      auraDescription: String(row.aura_description ?? ""),
      effects: effectMap,
      durationMs: num(m?.duration_ms),
      rangeYd: num(m?.max_yd),
      procChance: num(a?.proc_chance),
      procCharges: num(a?.proc_charges),
      maxStacks: num(a?.max_stacks),
      variables: varsBy.has(id) ? String(varsBy.get(id)?.variables) : null,
    });

    const cd = cdBy.get(id);
    const ch = chargesBy.get(id);
    extras.set(id, {
      subtext: String(row.subtext ?? ""),
      classFamily: num(classBy.get(id)?.class_family),
      schoolMask: num(m?.school_mask),
      castTimeMs: num(m?.cast_time_ms),
      rangeName: m?.range_name ? String(m.range_name) : null,
      cooldownMs: Math.max(num(cd?.cooldown_ms) ?? 0, num(cd?.category_cooldown_ms) ?? 0) || null,
      gcdMs: num(cd?.gcd_ms),
      maxCharges: num(ch?.max_charges),
      chargeRecoveryMs: num(ch?.charge_recovery_ms),
      procIcdMs: num(a?.proc_icd_ms),
      costs: power
        .filter((p) => Number(p.spell_id) === id)
        .map((p) => ({
          powerType: Number(p.power_type),
          cost: Number(p.cost ?? 0),
          costPct: Number(p.cost_pct ?? 0),
          requiredAura: Number(p.required_aura_spell_id ?? 0),
        })),
      triggerSpellIds: [...new Set(triggers)],
    });
  }
}

const sec = (ms: number | null | undefined) => (ms ? ms / 1000 : undefined);
/** Client floats are single precision (1.79999995232); round for display. */
const round2 = (n: number) => Number(n.toFixed(2));

/** Drop undefined/null/empty values so results stay compact for the model. */
function compact<T extends Record<string, unknown>>(o: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(o).filter(
      ([, v]) => v !== undefined && v !== null && v !== "" && !(Array.isArray(v) && v.length === 0),
    ),
  ) as Partial<T>;
}

export interface LookupOptions {
  includeRaw?: boolean;
}

/** Look up spells by id, returning rendered descriptions and key mechanics. */
export async function lookupSpellsById(ids: number[], opts: LookupOptions = {}) {
  const { spells, extras } = await loadSpells(ids);
  const lookup = (id: number) => spells.get(id);

  const found = [];
  const missing = [];
  for (const id of ids) {
    const s = spells.get(id);
    const x = extras.get(id);
    if (!s || !x) {
      missing.push(id);
      continue;
    }
    // Costs gated on an aura (usually a spec) are alternatives; show the unconditional ones if any.
    const paid = x.costs.filter((c) => c.cost > 0 || c.costPct > 0);
    const unconditional = paid.filter((c) => c.requiredAura === 0);
    const costs = unconditional.length ? unconditional : paid;
    // With charges, the recharge is the real limit; tiny RecoveryTimes are anti-spam.
    const cooldownMs =
      x.chargeRecoveryMs && (x.cooldownMs ?? 0) <= 1500 ? null : x.cooldownMs;
    const schools = SCHOOLS.filter(([bit]) => (x.schoolMask ?? 0) & bit).map(([, n]) => n);
    found.push(
      compact({
        spell_id: id,
        name: s.name,
        subtext: x.subtext,
        class: x.classFamily ? CLASS_FAMILIES[x.classFamily] : undefined,
        school: schools.join("/"),
        description: renderSpellText(id, "description", lookup),
        aura_description: renderSpellText(id, "aura", lookup),
        cast_time_sec: x.castTimeMs === null ? undefined : x.castTimeMs / 1000,
        cooldown_sec: sec(cooldownMs),
        charges: x.maxCharges && x.maxCharges > 1 ? x.maxCharges : undefined,
        charge_cooldown_sec: sec(x.chargeRecoveryMs),
        gcd_sec: x.gcdMs === null ? undefined : x.gcdMs / 1000,
        duration_sec: s.durationMs && s.durationMs > 0 ? s.durationMs / 1000 : undefined,
        // Ranges past ~100 yd are the client's "unlimited" sentinel (e.g. 50000).
        range_yd: s.rangeYd && s.rangeYd <= 100 ? s.rangeYd : undefined,
        max_stacks: s.maxStacks || undefined,
        proc_chance_pct: s.procChance && s.procChance < 100 ? s.procChance : undefined,
        proc_internal_cooldown_sec: sec(x.procIcdMs),
        costs: costs.map((c) => ({
            resource: POWER_TYPES[c.powerType] ?? `power ${c.powerType}`,
            ...(c.cost > 0 ? { amount: TENTHS_POWER_TYPES.has(c.powerType) ? c.cost / 10 : c.cost } : {}),
            ...(c.costPct > 0 ? { pct_of_base_mana: round2(c.costPct) } : {}),
            ...(c.requiredAura
              ? { only_with: spells.get(c.requiredAura)?.name ?? `spell ${c.requiredAura}` }
              : {}),
          })),
        triggers_spell_ids: x.triggerSpellIds,
        ...(opts.includeRaw
          ? { raw_description: s.description, raw_aura_description: s.auraDescription }
          : {}),
      }),
    );
  }
  return { spells: found, not_found: missing };
}

/**
 * Find spell ids by (partial) name. Names are reused by NPC and legacy spells,
 * so rank exact matches, then class spells, then spells with a description and
 * a resource cost (player abilities).
 */
export async function findSpellIdsByName(name: string, limit: number): Promise<number[]> {
  const rows = await queryRows(
    `SELECT s.spell_id FROM ${S}.spell s
     WHERE s.name ILIKE '%' || $name || '%'
     ORDER BY lower(s.name) = lower($name) DESC,
              EXISTS (SELECT 1 FROM ${S}.spell_class_options c
                      WHERE c.spell_id = s.spell_id AND c.class_family IN (${CLASS_FAMILY_IDS})) DESC,
              coalesce(s.description, '') <> '' DESC,
              EXISTS (SELECT 1 FROM ${S}.spell_power p WHERE p.spell_id = s.spell_id) DESC,
              s.spell_id
     LIMIT ${Math.trunc(limit)}`,
    { name },
  );
  return rows.map((r) => Number(r.spell_id));
}
