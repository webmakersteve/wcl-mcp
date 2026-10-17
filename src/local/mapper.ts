/**
 * Map combat log subevents to Warcraft Logs-shaped events: the same `type` names and JSON
 * keys WCL's events API returns, so queries work on both sources. Unit references stay as
 * GUIDs here; the parser resolves them to actor ids when a fight closes.
 *
 * Deliberately not reproduced (see SOURCE_NOTES in parser.ts): WCL's rule engine (dropped or
 * reattributed damage), `fake` casts, prepull aura synthesis, support (Augmentation) damage.
 */
import { flag, list, num, str, type Field, type RawLine } from "./tokenize.js";

export interface UnitRef {
  guid: string;
  name: string;
  flags: number;
  raidFlags: number;
}

/** Advanced combat logging info for the unit an event describes (usually its target). */
export interface AdvancedInfo {
  guid: string;
  ownerGuid: string;
  hp: number;
  maxHp: number;
  x: number;
  y: number;
  mapId: number;
  facing: number;
  level: number;
}

/**
 * A WCL-shaped event whose unit fields still hold GUIDs. `units` maps a WCL id key
 * (sourceID, targetID, attackerID, healerID, killerID) to the unit it names.
 */
export interface PendingEvent {
  time: number;
  type: string;
  units: Partial<Record<UnitRole, UnitRef>>;
  fields: Record<string, unknown>;
  adv?: AdvancedInfo;
}

export type UnitRole = "source" | "target" | "attacker" | "healer" | "killer";

/** Per-file state the mapper needs: whether advanced logging is on, and its block length. */
export interface MapperContext {
  advanced: boolean;
  /** Fields in the advanced block; calibrated from the first SPELL_CAST_SUCCESS. */
  advancedLength: number;
}

const PREFIXES = [
  ["SPELL_PERIODIC_", 3],
  ["SPELL_BUILDING_", 3],
  ["SPELL_", 3],
  ["RANGE_", 3],
  ["SWING_", 0],
  ["ENVIRONMENTAL_", 0],
] as const;

/** Suffixes that carry the advanced logging block (when advanced logging is on). */
const ADVANCED_SUFFIXES = new Set(["DAMAGE", "DAMAGE_LANDED", "HEAL", "ENERGIZE", "DRAIN", "LEECH", "CAST_SUCCESS"]);

const MISS_HIT_TYPE: Record<string, number> = {
  MISS: 0, BLOCK: 4, DODGE: 7, PARRY: 8, DEFLECT: 9, IMMUNE: 10, REFLECT: 12, EVADE: 13, RESIST: 14,
};

/** WCL ability ids for environmental damage. */
const ENVIRONMENTAL_ABILITY: Record<string, number> = {
  Falling: 3, Drowning: 4, Fatigue: 5, Fire: 6, Lava: 7, Slime: 8,
};

function unitAt(f: Field[], i: number): UnitRef {
  return { guid: str(f[i]), name: str(f[i + 1]), flags: num(f[i + 2]), raidFlags: num(f[i + 3]) };
}

function parseAdvanced(block: Field[]): AdvancedInfo {
  const n = block.length;
  return {
    guid: str(block[0]),
    ownerGuid: str(block[1]),
    hp: num(block[2]),
    maxHp: num(block[3]),
    x: num(block[n - 5]),
    y: num(block[n - 4]),
    mapId: num(block[n - 3]),
    facing: num(block[n - 2]),
    level: num(block[n - 1]),
  };
}

/** Swing ability id: 1 for physical melee, else -school (e.g. -32 shadow), as WCL does. */
function swingAbility(school: number): number {
  return school === 1 || school === 0 ? 1 : -school;
}

/** Set `key` only for meaningful values, keeping events as sparse as WCL's. */
function setIf(o: Record<string, unknown>, key: string, value: number): void {
  if (value > 0) o[key] = value;
}

/**
 * Map one line to zero or more pending events. Control events (CHALLENGE_MODE_*,
 * ENCOUNTER_*, ZONE_CHANGE, COMBATANT_INFO, ...) are handled by the parser, not here.
 */
export function mapCombatEvent(line: RawLine, ctx: MapperContext): PendingEvent[] {
  const { event, fields: f, time } = line;

  if (event === "UNIT_DIED" || event === "UNIT_DESTROYED") {
    const target = unitAt(f, 4);
    const fields: Record<string, unknown> = { abilityGameID: 0 };
    if (event === "UNIT_DIED" && flag(f[8])) fields.feign = true;
    return [{ time, type: "death", units: { target }, fields }];
  }

  const prefix = PREFIXES.find(([p]) => event.startsWith(p));
  if (!prefix) return [];
  const [prefixName, prefixLength] = prefix;
  const suffix = event.slice(prefixName.length);

  const source = unitAt(f, 0);
  const target = unitAt(f, 4);
  let i = 8;
  let abilityGameID: number | undefined;
  if (prefixLength === 3) {
    abilityGameID = num(f[i]);
    i += 3;
  }

  let adv: AdvancedInfo | undefined;
  if (ctx.advanced && ADVANCED_SUFFIXES.has(suffix)) {
    if (event === "SPELL_CAST_SUCCESS") ctx.advancedLength = f.length - i;
    adv = parseAdvanced(f.slice(i, i + ctx.advancedLength));
    i += ctx.advancedLength;
  }
  const s = f.slice(i);
  const periodic = prefixName === "SPELL_PERIODIC_";
  const units = { source, target };

  switch (suffix) {
    case "DAMAGE": {
      const fields: Record<string, unknown> = {};
      let swing = prefixName === "SWING_";
      if (prefixName === "ENVIRONMENTAL_") {
        abilityGameID = ENVIRONMENTAL_ABILITY[str(s[0])] ?? 3;
        s.shift();
        swing = false;
      }
      // amount, baseAmount, overkill, school, resisted, blocked, absorbed, critical, glancing, crushing[, ST|AOE]
      const amount = num(s[0]);
      const base = num(s[1]);
      const overkill = num(s[2]);
      if (swing) abilityGameID = swingAbility(num(s[3]));
      const resisted = num(s[4]);
      const blocked = num(s[5]);
      const absorbed = num(s[6]);
      const crit = flag(s[7]);
      fields.abilityGameID = abilityGameID;
      fields.hitType = blocked > 0 ? 4 : flag(s[8]) ? 6 : flag(s[9]) ? 15 : crit ? 2 : 1;
      fields.amount = amount;
      setIf(fields, "mitigated", base - amount - absorbed);
      if (base > 0) fields.unmitigatedAmount = base;
      setIf(fields, "overkill", overkill);
      setIf(fields, "resisted", resisted);
      setIf(fields, "blocked", blocked);
      setIf(fields, "absorbed", absorbed);
      const scope = str(s[10]);
      if (scope) fields.isAoE = scope === "AOE";
      if (periodic) fields.tick = true;
      const out: PendingEvent[] = [{ time, type: "damage", units, fields, adv }];
      if (swing) out.unshift(meleeCast(time, units, abilityGameID!));
      return out;
    }
    case "MISSED": {
      // missType, isOffHand[, amountMissed, baseAmount, critical][, ST|AOE]
      const missType = str(s[0]);
      const fields: Record<string, unknown> = {};
      if (prefixName === "SWING_") abilityGameID = 1;
      fields.abilityGameID = abilityGameID;
      let rest = s.slice(2);
      const scope = str(rest[rest.length - 1]);
      if (scope === "ST" || scope === "AOE") {
        fields.isAoE = scope === "AOE";
        rest = rest.slice(0, -1);
      }
      if (missType === "ABSORB") {
        // Fully absorbed: WCL records a normal (or crit) hit for 0 with the absorb.
        fields.hitType = flag(rest[2]) ? 2 : 1;
        fields.amount = 0;
        if (num(rest[1]) > 0) fields.unmitigatedAmount = num(rest[1]);
        setIf(fields, "absorbed", num(rest[0]));
      } else {
        fields.hitType = MISS_HIT_TYPE[missType] ?? 0;
        fields.amount = 0;
        if (missType === "BLOCK" || missType === "RESIST") setIf(fields, missType === "BLOCK" ? "blocked" : "resisted", num(rest[0]));
      }
      if (periodic) fields.tick = true;
      const out: PendingEvent[] = [{ time, type: "damage", units, fields }];
      if (prefixName === "SWING_") out.unshift(meleeCast(time, units, 1));
      return out;
    }
    case "HEAL": {
      // amount, baseAmount, overhealing, absorbed, critical
      const amount = num(s[0]);
      const overheal = num(s[2]);
      const fields: Record<string, unknown> = {
        abilityGameID,
        hitType: flag(s[4]) ? 2 : 1,
        amount: Math.max(0, amount - overheal),
      };
      setIf(fields, "overheal", overheal);
      setIf(fields, "absorbed", num(s[3]));
      if (periodic) fields.tick = true;
      return [{ time, type: "heal", units, fields, adv }];
    }
    case "ENERGIZE": {
      // amount, overEnergize, powerType, maxPower
      return [{
        time,
        type: "resourcechange",
        units,
        fields: {
          abilityGameID,
          resourceChange: num(s[0]),
          resourceChangeType: num(s[2]),
          otherResourceChange: 0,
          maxResourceAmount: num(s[3]),
          waste: num(s[1]),
        },
        adv,
      }];
    }
    case "CAST_SUCCESS":
      return [{ time, type: "cast", units, fields: { abilityGameID }, adv }];
    case "CAST_START":
      return [{ time, type: "begincast", units, fields: { abilityGameID } }];
    case "AURA_APPLIED":
    case "AURA_REMOVED":
    case "AURA_REFRESH": {
      const kind = str(s[0]) === "DEBUFF" ? "debuff" : "buff";
      const verb = suffix === "AURA_APPLIED" ? "apply" : suffix === "AURA_REMOVED" ? "remove" : "refresh";
      const fields: Record<string, unknown> = { abilityGameID };
      setIf(fields, "absorb", num(s[1]));
      return [{ time, type: `${verb}${kind}`, units, fields }];
    }
    case "AURA_APPLIED_DOSE":
    case "AURA_REMOVED_DOSE": {
      const kind = str(s[0]) === "DEBUFF" ? "debuff" : "buff";
      const verb = suffix === "AURA_APPLIED_DOSE" ? "apply" : "remove";
      return [{ time, type: `${verb}${kind}stack`, units, fields: { abilityGameID, stack: num(s[1]) } }];
    }
    case "AURA_BROKEN":
    case "AURA_BROKEN_SPELL": {
      const extra = suffix === "AURA_BROKEN_SPELL" ? num(s[0]) : undefined;
      const auraType = str(s[suffix === "AURA_BROKEN_SPELL" ? 3 : 0]);
      const fields: Record<string, unknown> = { abilityGameID };
      if (extra !== undefined) fields.extraAbilityGameID = extra;
      fields.isBuff = auraType === "BUFF";
      return [{ time, type: "aurabroken", units, fields }];
    }
    case "INTERRUPT":
      return [{ time, type: "interrupt", units, fields: { abilityGameID, extraAbilityGameID: num(s[0]) } }];
    case "DISPEL":
    case "STOLEN":
      return [{
        time,
        type: suffix === "DISPEL" ? "dispel" : "spellsteal",
        units,
        fields: { abilityGameID, extraAbilityGameID: num(s[0]), isBuff: str(s[3]) === "BUFF" },
      }];
    case "SUMMON":
      return [{ time, type: "summon", units, fields: { abilityGameID } }];
    case "RESURRECT":
      return [{ time, type: "resurrect", units, fields: { abilityGameID } }];
    case "EXTRA_ATTACKS":
      return [{ time, type: "extraattacks", units, fields: { abilityGameID, extraAttacks: num(s[0]) } }];
    case "INSTAKILL":
      return [{ time, type: "instakill", units, fields: { abilityGameID } }];
    case "EMPOWER_START":
      return [{ time, type: "empowerstart", units, fields: { abilityGameID } }];
    case "EMPOWER_END":
      return [{ time, type: "empowerend", units, fields: { abilityGameID, empowermentLevel: num(s[0]) } }];
    case "ABSORBED":
      return [mapAbsorbed(time, f)];
    case "HEAL_ABSORBED":
      return [mapHealAbsorbed(time, f, abilityGameID)];
    default:
      return [];
  }
}

function meleeCast(time: number, units: { source: UnitRef; target: UnitRef }, abilityGameID: number): PendingEvent {
  return { time, type: "cast", units, fields: { abilityGameID, melee: true } };
}

/**
 * SPELL_ABSORBED: base units are attacker → victim; then the attacking spell (3 fields, absent
 * for melee), the absorbing unit (4), its shield spell (3), and amount, total, critical.
 * WCL: source = shield caster, target = victim, attacker = the original attacker.
 */
function mapAbsorbed(time: number, f: Field[]): PendingEvent {
  const melee = f.length < 21;
  const attackSpell = melee ? 1 : num(f[8]);
  const j = melee ? 8 : 11;
  return {
    time,
    type: "absorbed",
    units: { attacker: unitAt(f, 0), target: unitAt(f, 4), source: unitAt(f, j) },
    fields: { abilityGameID: num(f[j + 4]), amount: num(f[j + 7]), extraAbilityGameID: attackSpell },
  };
}

/** SPELL_HEAL_ABSORBED: the heal (healer + spell) after the absorbing aura, then the amount. */
function mapHealAbsorbed(time: number, f: Field[], abilityGameID: number | undefined): PendingEvent {
  return {
    time,
    type: "healabsorbed",
    units: { source: unitAt(f, 0), target: unitAt(f, 4), healer: unitAt(f, 11) },
    fields: { abilityGameID, extraAbilityGameID: num(f[15]), amount: num(f[18]) },
  };
}

/** COMBATANT_INFO → WCL combatantinfo fields (stats, spec, talents, gear, auras). */
export function mapCombatantInfo(f: Field[]): { guid: string; specId: number; fields: Record<string, unknown> } {
  // guid, faction, str, agi, sta, int, dodge, parry, block, ?, critMelee, critRanged, critSpell,
  // speed, leech, hasteMelee, hasteRanged, hasteSpell, avoidance, mastery, versDone, versHealing,
  // versTaken, armor, specId, [talents], (pvp talents), [gear], [auras], ...
  const specIdx = f.findIndex((x) => Array.isArray(x)) - 1;
  const at = (k: number) => num(f[k]);
  const specId = at(specIdx);
  const talents = list(f[specIdx + 1]).map((t) => {
    const [nodeID, id, rank] = list(t).map((x) => num(x));
    return { id, rank, nodeID };
  });
  const gear = list(f[specIdx + 3]).map((g) => {
    const [id, itemLevel, enchants, bonusIDs, gems] = list(g);
    const item: Record<string, unknown> = { id: num(id), itemLevel: num(itemLevel) };
    const [permanent, temporary] = list(enchants).map((x) => num(x));
    if (permanent) item.permanentEnchant = permanent;
    if (temporary) item.temporaryEnchant = temporary;
    const bonuses = list(bonusIDs).map((x) => num(x));
    if (bonuses.length) item.bonusIDs = bonuses;
    const gemList = list(gems).map((x) => num(x));
    if (gemList.length) {
      item.gems = [];
      for (let k = 0; k + 1 < gemList.length; k += 2) {
        (item.gems as unknown[]).push({ id: gemList[k], itemLevel: gemList[k + 1] });
      }
    }
    return item;
  });
  const auraFields = list(f[specIdx + 4]);
  const auras: Array<{ sourceGuid: string; ability: number; stacks: number }> = [];
  for (let k = 0; k + 2 < auraFields.length; k += 3) {
    auras.push({ sourceGuid: str(auraFields[k]), ability: num(auraFields[k + 1]), stacks: num(auraFields[k + 2]) });
  }
  return {
    guid: str(f[0]),
    specId,
    fields: {
      faction: at(1),
      specID: specId,
      strength: at(2),
      agility: at(3),
      stamina: at(4),
      intellect: at(5),
      dodge: at(6),
      parry: at(7),
      block: at(8),
      armor: at(specIdx - 1),
      critMelee: at(10),
      critRanged: at(11),
      critSpell: at(12),
      speed: at(13),
      leech: at(14),
      hasteMelee: at(15),
      hasteRanged: at(16),
      hasteSpell: at(17),
      avoidance: at(18),
      mastery: at(19),
      versatilityDamageDone: at(20),
      versatilityHealingDone: at(21),
      versatilityDamageReduction: at(22),
      talentTree: talents,
      gear,
      // Aura sources are GUIDs here; the parser rewrites them to actor ids.
      auras,
    },
  };
}
