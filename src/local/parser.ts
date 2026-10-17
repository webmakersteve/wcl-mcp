/**
 * Stateful combat log parser: segments a log into fights the way Warcraft Logs does and
 * turns each finished fight into seed-table rows (fights, actors, WCL-shaped events).
 *
 * Fights:
 *  - Mythic+ key: CHALLENGE_MODE_START → CHALLENGE_MODE_END. Bosses inside it are
 *    dungeonencounterstart/end events, not fights. An abandoned key (no END: the group left
 *    the zone, started another key, or the log ended) ends at its last damage event.
 *  - Boss pull outside a key: ENCOUNTER_START → ENCOUNTER_END.
 *  - Trash: outside both, combat between the group and hostile NPCs, split on a gap of
 *    TRASH_GAP_MS without any; kept only if a hostile NPC died.
 *
 * Unit GUIDs are resolved to actors when a fight closes (so ownership learned mid-fight
 * applies to the whole fight): players by GUID, pets/guardians by (creature id, owning
 * player), NPCs by creature id. Instances are numbered per fight and creature id in order of
 * first appearance, and left null when the creature id had a single spawn, as WCL does.
 */
import { classForSpec, wclDifficulty } from "./specs.js";
import { list, num, str, type RawLine } from "./tokenize.js";
import { mapCombatantInfo, mapCombatEvent, type MapperContext, type PendingEvent, type UnitRef } from "./mapper.js";
import { isFriendly, isFriendlyPlayerControlled, isHostile, isNilGuid, parseGuid, raidMarker, splitPlayerName } from "./units.js";

const TRASH_GAP_MS = 10_000;
/** Ownership chains (guardian of a pet of a player) are followed at most this deep. */
const MAX_OWNER_DEPTH = 5;

export interface FightRow {
  fight_id: number;
  name: string;
  encounter_id: number;
  difficulty: number | null;
  keystone_level: number | null;
  kill: boolean | null;
  fight_percentage: number | null;
  start_time: number;
  end_time: number;
  game_zone_id: number | null;
  challenge_mode_id: number | null;
}

export interface ActorRow {
  actor_id: number;
  game_id: number;
  pet_owner: number | null;
  name: string;
  type: string;
  sub_type: string;
  server: string | null;
  guid: string | null;
  player_key: string | null;
}

export interface EventRow {
  fight_id: number;
  timestamp: number;
  type: string;
  source_id: number | null;
  target_id: number | null;
  source_instance: number | null;
  target_instance: number | null;
  ability_game_id: number | null;
  amount: number | null;
  hit_type: number | null;
  raw: string;
}

/** A fight_health row: a unit's HP whenever an advanced-logging event shows it changed. */
export interface HealthRow {
  fight_id: number;
  hostility: "friendly" | "enemy";
  actor_id: number;
  timestamp: number;
  hit_points: number;
  max_hit_points: number;
  health_percent: number;
}

/** A finished fight, ready to write. */
export interface Segment {
  fight: FightRow;
  events: EventRow[];
  health: HealthRow[];
  /** Byte offset just past the last line in this fight: where to resume after committing it. */
  resumeOffset: number;
}

interface Buffered {
  ev: PendingEvent;
  /** Byte offset just past the line this event came from. */
  end: number;
}

interface OpenFight {
  kind: "key" | "encounter" | "trash";
  start: number;
  name: string;
  encounterId: number;
  difficulty: number | null;
  keystoneLevel: number | null;
  zoneId: number | null;
  challengeModeId: number | null;
  events: Buffered[];
  /** Events up to and including the last damage event (the trim point for abandoned fights). */
  lastCombatCount: number;
  lastCombatTime: number;
  /** Trash only: a hostile NPC died. */
  hostileDied: boolean;
  /** Trash name candidate: the hostile NPC with the most max HP. */
  bigHostile?: { name: string; maxHp: number };
}

interface EncounterTracking {
  /** Hostile creatures seen during the encounter: guid → level, creature id, last HP. */
  units: Map<string, { gameId: number; level: number; hp: number; maxHp: number }>;
}

export interface ParserState {
  /** Report start, Unix epoch ms; timestamps are relative to it. Null until the first line. */
  reportStart: number | null;
  nextFightId: number;
  actors: ActorRow[];
}

/** Notes for get_report_details: what differs between local imports and WCL downloads. */
export const SOURCE_NOTES = [
  "Local logs follow WCL's event shape but not its rule engine: damage WCL drops or reattributes " +
    "(anti-cheese rules) is kept, so totals can differ by a few percent.",
  "Casts aren't flagged `fake` (WCL marks proc/secondary casts that way); the casts themselves " +
    "are the same, so cast counts match but WCL-side filters on `fake` have no local equivalent.",
  "No prepull buffs synthesized from COMBATANT_INFO, and no Augmentation support-damage attribution.",
  "Trash fights are split on 10 s without combat and kept only if a hostile NPC died; WCL's " +
    "trash boundaries differ.",
  "fight_percentage is null for M+ keys; for raid wipes it's the boss's HP %, and 0 on a kill.",
  "Bosses (actors.sub_type = 'Boss') are the highest-level hostile creatures seen during an encounter.",
  "Local-only data is in raw.local: the HP, position and facing of the unit the event describes " +
    "(advanced combat logging), with `unit` naming which side ('source' or 'target').",
  "fight_health comes from that same advanced logging HP (one row whenever a unit's HP changed), " +
    "not WCL's Resources graph; readings are denser, and the same per-actor caveats apply.",
];

export class LogParser {
  private reportStart: number | null;
  private nextFightId: number;
  private readonly ctx: MapperContext = { advanced: true, advancedLength: 17 };

  private open: OpenFight | null = null;
  private encounter: EncounterTracking | null = null;
  private zone: { id: number; name: string; difficulty: number } | null = null;

  // Unit knowledge, kept across fights.
  private readonly owners = new Map<string, string>();
  private readonly playerClass = new Map<string, string>();
  private readonly names = new Map<string, string>();
  private readonly bosses = new Set<number>();
  /** Last overkilling hit per unit, for death killers. */
  private readonly lastHit = new Map<string, { source: UnitRef; ability: number }>();

  // Actors, stable across the whole report.
  private readonly actorsByKey = new Map<string, ActorRow>();
  private nextActorId = 1;
  private readonly changedActors = new Set<number>();

  /** Most recent line time, Unix epoch ms. */
  lastTime: number | null = null;
  /** Region counts from player names, for report_details.region. */
  private readonly regions = new Map<string, number>();
  /** First fight's zone, for report_details. */
  firstZone: { id: number; name: string } | null = null;

  constructor(state: ParserState) {
    this.reportStart = state.reportStart;
    this.nextFightId = state.nextFightId;
    for (const a of state.actors) {
      this.actorsByKey.set(actorKeyOfRow(a), a);
      this.nextActorId = Math.max(this.nextActorId, a.actor_id + 1);
      if (a.sub_type === "Boss") this.bosses.add(a.game_id);
    }
  }

  get start(): number | null {
    return this.reportStart;
  }

  get region(): string | null {
    let best: string | null = null;
    let bestN = 0;
    for (const [r, n] of this.regions) if (n > bestN) [best, bestN] = [r, n];
    return best?.toUpperCase() ?? null;
  }

  /** True while a fight is open (its events are still buffered). */
  get inFight(): boolean {
    return this.open !== null;
  }

  /** Actors added or changed since the last call. */
  takeChangedActors(): ActorRow[] {
    const rows = [...this.actorsByKey.values()].filter((a) => this.changedActors.has(a.actor_id));
    this.changedActors.clear();
    return rows;
  }

  /** Feed one line; `end` is the byte offset just past it. Returns fights it closed. */
  feed(line: RawLine, end: number): Segment[] {
    if (this.reportStart === null) this.reportStart = line.time;
    this.lastTime = line.time;
    const out: Segment[] = [];
    const f = line.fields;

    // Trash ends after a quiet gap; check before this line can extend it.
    if (this.open?.kind === "trash" && line.time - this.open.lastCombatTime > TRASH_GAP_MS) {
      this.closeTrimmed(out);
    }

    switch (line.event) {
      case "COMBAT_LOG_VERSION": {
        const i = f.indexOf("ADVANCED_LOG_ENABLED");
        if (i >= 0) this.ctx.advanced = str(f[i + 1]) === "1";
        return out;
      }
      case "ZONE_CHANGE": {
        const zone = { id: num(f[0]), name: str(f[1]), difficulty: num(f[2]) };
        const o = this.open;
        if (o && (o.kind === "trash" || (o.zoneId !== null && o.zoneId !== zone.id))) this.closeTrimmed(out);
        this.zone = zone;
        this.push(
          { time: line.time, type: "zonechange", units: {}, fields: {
            zoneID: zone.id, zoneName: zone.name, zoneDifficulty: wclDifficulty(zone.difficulty), zoneSize: 0, zoneCounter: 0,
          } },
          end,
        );
        return out;
      }
      case "CHALLENGE_MODE_START": {
        // zoneName, instanceID, challengeModeID, keystoneLevel, [affixes]
        if (this.open) this.closeTrimmed(out);
        const zoneId = num(f[1]);
        this.open = this.newFight("key", line.time, {
          name: str(f[0]),
          encounterId: 10000 + zoneId,
          difficulty: 10,
          keystoneLevel: num(f[3]),
          zoneId,
          challengeModeId: num(f[2]),
        });
        this.push(
          { time: line.time, type: "dungeonstart", units: {}, fields: {
            encounterID: 10000 + zoneId, name: str(f[0]), difficulty: 10, size: 5, level: num(f[3]),
            affixes: list(f[4]).map((a) => num(a)),
          } },
          end,
        );
        return out;
      }
      case "CHALLENGE_MODE_END": {
        // instanceID, success, keystoneLevel, totalTime, rating, totalRating. WoW also writes a
        // zeroed END right before each START; with no key open there's nothing to end.
        const o = this.open;
        if (o?.kind !== "key") return out;
        const kill = str(f[1]) === "1";
        this.push(
          { time: line.time, type: "dungeonend", units: {}, fields: {
            encounterID: o.encounterId, name: "", difficulty: 10, size: 5, kill,
            rating: num(f[4]), loggerTotalRating: num(f[5]),
          } },
          end,
        );
        out.push(this.close(o, line.time, kill, null, o.events.length, end));
        return out;
      }
      case "ENCOUNTER_START": {
        // encounterID, name, difficultyID, groupSize, instanceID
        const fields = { encounterID: num(f[0]), name: str(f[1]), difficulty: wclDifficulty(num(f[2])), size: num(f[3]) };
        if (this.open?.kind === "key") {
          this.encounter = { units: new Map() };
          this.push({ time: line.time, type: "dungeonencounterstart", units: {}, fields }, end);
          return out;
        }
        // Close trash or an abandoned pull first: closing an encounter consumes its tracking.
        if (this.open) this.closeTrimmed(out);
        this.encounter = { units: new Map() };
        this.open = this.newFight("encounter", line.time, {
          name: fields.name,
          encounterId: fields.encounterID,
          difficulty: fields.difficulty,
          keystoneLevel: null,
          zoneId: num(f[4]) || null,
          challengeModeId: null,
        });
        this.push({ time: line.time, type: "encounterstart", units: {}, fields }, end);
        return out;
      }
      case "ENCOUNTER_END": {
        // encounterID, name, difficultyID, groupSize, success, fightTime
        const kill = str(f[4]) === "1";
        const fields = { encounterID: num(f[0]), name: str(f[1]), difficulty: wclDifficulty(num(f[2])), size: num(f[3]), kill };
        const bossHp = this.finishEncounter();
        const o = this.open;
        if (o?.kind === "key") {
          this.push({ time: line.time, type: "dungeonencounterend", units: {}, fields }, end);
        } else if (o?.kind === "encounter" && o.encounterId === fields.encounterID) {
          this.push({ time: line.time, type: "encounterend", units: {}, fields }, end);
          out.push(this.close(o, line.time, kill, kill ? 0 : bossHp, o.events.length, end));
        }
        return out;
      }
      case "COMBATANT_INFO": {
        const info = mapCombatantInfo(f);
        const cls = classForSpec(info.specId);
        if (cls) this.playerClass.set(info.guid, cls);
        if (this.open) {
          this.push(
            { time: line.time, type: "combatantinfo", units: { source: { guid: info.guid, name: "", flags: 0, raidFlags: 0 } }, fields: info.fields },
            end,
          );
        }
        return out;
      }
    }

    for (const ev of mapCombatEvent(line, this.ctx)) this.handleCombat(ev, end);
    return out;
  }

  /** End of input: close whatever is open (only for a finished log, never a live one). */
  finish(): Segment[] {
    const out: Segment[] = [];
    if (this.open) this.closeTrimmed(out);
    return out;
  }

  private handleCombat(ev: PendingEvent, end: number): void {
    const { source, target } = ev.units;
    for (const u of [source, target]) if (u) this.learnUnit(u);
    if (ev.adv) this.learnAdvanced(ev);
    if (ev.type === "summon" && source && target && !isNilGuid(source.guid)) {
      this.owners.set(target.guid, source.guid);
    }

    const combat = ev.type === "damage" && source && target && isGroupVsHostile(source, target);
    // The killing blow is the hit that overkilled; without one WCL names no killer.
    if (ev.type === "damage" && target && source && Number(ev.fields.overkill ?? 0) > 0) {
      this.lastHit.set(target.guid, { source, ability: Number(ev.fields.abilityGameID ?? 0) });
    }
    if (ev.type === "death" && target) {
      const hit = this.lastHit.get(target.guid);
      if (hit) {
        ev.units.killer = hit.source;
        ev.fields.killingAbilityGameID = hit.ability;
      }
      this.lastHit.delete(target.guid);
    }

    if (!this.open && combat) {
      this.open = this.newFight("trash", ev.time, {
        name: "", encounterId: 0, difficulty: null, keystoneLevel: null,
        zoneId: this.zone?.id ?? null, challengeModeId: null,
      });
    }
    const o = this.open;
    if (!o) return;
    if (o.kind === "trash" && ev.type === "death" && target && isHostile(target.flags) && parseGuid(target.guid).kind !== "Player") {
      o.hostileDied = true;
    }
    this.push(ev, end);
    if (ev.type === "damage") {
      o.lastCombatCount = o.events.length;
      if (o.kind !== "trash" || combat) o.lastCombatTime = ev.time;
    }
  }

  private learnUnit(u: UnitRef): void {
    if (isNilGuid(u.guid) || !u.name || u.name === "nil") return;
    this.names.set(u.guid, u.name);
  }

  private learnAdvanced(ev: PendingEvent): void {
    const adv = ev.adv!;
    if (!isNilGuid(adv.ownerGuid) && adv.ownerGuid !== adv.guid) this.owners.set(adv.guid, adv.ownerGuid);
    const unit = ev.units.source?.guid === adv.guid ? ev.units.source : ev.units.target?.guid === adv.guid ? ev.units.target : undefined;
    if (!unit) return;
    const g = parseGuid(adv.guid);
    if (g.kind !== "Creature" && g.kind !== "Vehicle") return;
    if (!isHostile(unit.flags)) return;
    if (this.encounter) {
      this.encounter.units.set(adv.guid, { gameId: g.gameId, level: adv.level, hp: adv.hp, maxHp: adv.maxHp });
    }
    const o = this.open;
    if (o?.kind === "trash" && adv.maxHp > (o.bigHostile?.maxHp ?? 0)) {
      o.bigHostile = { name: unit.name, maxHp: adv.maxHp };
    }
  }

  /** Mark the encounter's bosses; returns the main boss's remaining HP %. */
  private finishEncounter(): number | null {
    const enc = this.encounter;
    this.encounter = null;
    if (!enc || enc.units.size === 0) return null;
    const top = Math.max(...[...enc.units.values()].map((u) => u.level));
    let main: { hp: number; maxHp: number } | null = null;
    for (const u of enc.units.values()) {
      if (u.level !== top) continue;
      if (!this.bosses.has(u.gameId)) {
        this.bosses.add(u.gameId);
        const row = this.actorsByKey.get(`npc:${u.gameId}`);
        if (row && row.sub_type !== "Boss") {
          row.sub_type = "Boss";
          this.changedActors.add(row.actor_id);
        }
      }
      if (!main || u.maxHp > main.maxHp) main = u;
    }
    return main && main.maxHp > 0 ? Math.round((main.hp / main.maxHp) * 10000) / 100 : null;
  }

  private newFight(kind: OpenFight["kind"], start: number, meta: Omit<OpenFight, "kind" | "start" | "events" | "lastCombatCount" | "lastCombatTime" | "hostileDied">): OpenFight {
    return { kind, start, ...meta, events: [], lastCombatCount: 0, lastCombatTime: start, hostileDied: false };
  }

  private push(ev: PendingEvent, end: number): void {
    this.open?.events.push({ ev, end });
  }

  /** Close an open fight that had no end marker, at its last damage event. */
  private closeTrimmed(out: Segment[]): void {
    const o = this.open!;
    if (o.kind === "encounter") this.finishEncounter();
    const count = o.lastCombatCount;
    if (o.kind === "trash" && (!o.hostileDied || count === 0)) {
      this.open = null;
      return;
    }
    const last = o.events[count - 1];
    const endTime = last ? last.ev.time : o.start;
    const resume = last ? last.end : o.events[0]?.end ?? 0;
    out.push(this.close(o, endTime, o.kind === "trash" ? null : false, null, count, resume));
  }

  private close(o: OpenFight, endTime: number, kill: boolean | null, pct: number | null, count: number, resumeOffset: number): Segment {
    this.open = null;
    if (o.kind === "trash") o.name = o.bigHostile?.name ?? firstHostileName(o) ?? "Trash";
    const fightId = this.nextFightId++;
    const events = o.events.slice(0, count).map((b) => b.ev);
    if (o.zoneId && !this.firstZone) this.firstZone = { id: o.zoneId, name: o.kind === "key" ? o.name : this.zone?.name ?? o.name };
    return {
      fight: {
        fight_id: fightId,
        name: o.name,
        encounter_id: o.encounterId,
        difficulty: o.difficulty,
        keystone_level: o.keystoneLevel,
        kill,
        fight_percentage: o.kind === "key" ? null : pct,
        start_time: o.start - this.reportStart!,
        end_time: endTime - this.reportStart!,
        game_zone_id: o.zoneId,
        challenge_mode_id: o.challengeModeId,
      },
      ...this.resolve(events, fightId),
      resumeOffset,
    };
  }

  // ---- actor resolution -------------------------------------------------------------

  private rootOwner(guid: string): string | null {
    let cur = guid;
    for (let depth = 0; depth < MAX_OWNER_DEPTH; depth++) {
      const owner = this.owners.get(cur);
      if (!owner || owner === cur) break;
      if (parseGuid(owner).kind === "Player") return owner;
      cur = owner;
    }
    return null;
  }

  /** Actor for a unit, creating or updating its row. Returns -1 for no unit. */
  private actorFor(u: UnitRef): ActorRow | null {
    if (isNilGuid(u.guid)) return null;
    const g = parseGuid(u.guid);
    const name = this.names.get(u.guid) ?? u.name;
    if (g.kind === "Player") {
      const key = `player:${u.guid}`;
      let row = this.actorsByKey.get(key);
      const { name: short, server, region } = splitPlayerName(name);
      const cls = this.playerClass.get(u.guid);
      if (!row) {
        if (region) this.regions.set(region, (this.regions.get(region) ?? 0) + 1);
        row = {
          actor_id: this.nextActorId++, game_id: g.gameId, pet_owner: null, name: short, type: "Player",
          sub_type: cls ?? "Unknown", server, guid: u.guid, player_key: server ? `${short}-${server}` : null,
        };
        this.addActor(key, row);
      } else if ((cls && row.sub_type !== cls) || (server && !row.server) || (short && !row.name)) {
        row.name = row.name || short;
        row.sub_type = cls ?? row.sub_type;
        row.server = row.server ?? server;
        row.player_key = row.player_key ?? (server ? `${short}-${server}` : null);
        this.changedActors.add(row.actor_id);
      }
      return row;
    }
    const root = this.rootOwner(u.guid);
    if (root) {
      const owner = this.actorFor({ guid: root, name: this.names.get(root) ?? "", flags: 0, raidFlags: 0 })!;
      const key = `pet:${g.gameId}:${owner.actor_id}`;
      let row = this.actorsByKey.get(key);
      if (!row) {
        row = {
          actor_id: this.nextActorId++, game_id: g.gameId, pet_owner: owner.actor_id, name, type: "Pet",
          sub_type: "Pet", server: null, guid: u.guid, player_key: null,
        };
        this.addActor(key, row);
      }
      return row;
    }
    const key = `npc:${g.gameId}`;
    let row = this.actorsByKey.get(key);
    if (!row) {
      row = {
        actor_id: this.nextActorId++, game_id: g.gameId, pet_owner: null, name: name || "Unknown", type: "NPC",
        sub_type: this.bosses.has(g.gameId) ? "Boss" : "NPC", server: null, guid: u.guid, player_key: null,
      };
      this.addActor(key, row);
    } else if ((row.name === "Unknown" || !row.name) && name) {
      row.name = name;
      this.changedActors.add(row.actor_id);
    }
    return row;
  }

  private addActor(key: string, row: ActorRow): void {
    this.actorsByKey.set(key, row);
    this.changedActors.add(row.actor_id);
  }

  /**
   * Resolve GUIDs to actor ids and per-fight instances, serialize WCL-shaped events, and
   * collect health readings (on change) from the advanced logging info.
   */
  private resolve(events: PendingEvent[], fightId: number): { events: EventRow[]; health: HealthRow[] } {
    // Instance numbering: per creature id, by first appearance in this fight.
    const spawns = new Map<number, Map<string, number>>();
    const note = (u: UnitRef | undefined) => {
      if (!u || isNilGuid(u.guid)) return;
      const g = parseGuid(u.guid);
      if (g.kind === "Player") return;
      let m = spawns.get(g.gameId);
      if (!m) spawns.set(g.gameId, (m = new Map()));
      if (!m.has(u.guid)) m.set(u.guid, m.size + 1);
    };
    for (const ev of events) for (const u of Object.values(ev.units)) note(u);
    const instanceOf = (u: UnitRef): number | undefined => {
      const g = parseGuid(u.guid);
      if (g.kind === "Player") return undefined;
      const m = spawns.get(g.gameId);
      return m && m.size > 1 ? m.get(u.guid) : undefined;
    };

    const start = this.reportStart!;
    const health: HealthRow[] = [];
    const lastHp = new Map<string, number>();
    const rows = events.map((ev) => {
      const o: Record<string, unknown> = { timestamp: ev.time - start, type: ev.type };
      const ids: Partial<Record<string, number | undefined>> = {};
      for (const role of ["source", "target"] as const) {
        const u = ev.units[role];
        if (!u) continue;
        const actor = this.actorFor(u);
        o[`${role}ID`] = ids[`${role}ID`] = actor ? actor.actor_id : -1;
        const inst = actor ? instanceOf(u) : undefined;
        if (inst !== undefined) o[`${role}Instance`] = ids[`${role}Instance`] = inst;
      }
      if (ev.type === "death") o.sourceID = ids.sourceID = -1;
      if ((ev.type === "cast" || ev.type === "begincast") && !ev.units.target) o.targetID = -1;
      Object.assign(o, { abilityGameID: ev.fields.abilityGameID, fight: fightId });
      if (o.abilityGameID === undefined) delete o.abilityGameID;
      for (const [k, v] of Object.entries(ev.fields)) {
        if (k !== "abilityGameID" && v !== undefined) o[k] = v;
      }
      for (const role of ["attacker", "healer", "killer"] as const) {
        const u = ev.units[role];
        if (!u) continue;
        const actor = this.actorFor(u);
        o[`${role}ID`] = actor ? actor.actor_id : -1;
        const inst = actor ? instanceOf(u) : undefined;
        if (inst !== undefined) o[`${role}Instance`] = inst;
      }
      if (ev.type === "combatantinfo" && Array.isArray(o.auras)) {
        o.auras = (o.auras as Array<{ sourceGuid: string; ability: number; stacks: number }>).map((a) => ({
          source: this.actorFor({ guid: a.sourceGuid, name: "", flags: 0, raidFlags: 0 })?.actor_id ?? -1,
          ability: a.ability,
          stacks: a.stacks,
        }));
      }
      for (const role of ["source", "target", "attacker"] as const) {
        const m = ev.units[role] ? raidMarker(ev.units[role]!.raidFlags) : undefined;
        if (m !== undefined) o[`${role}Marker`] = m;
      }
      if (ev.adv) {
        const side = ev.units.target?.guid === ev.adv.guid ? "target" : ev.units.source?.guid === ev.adv.guid ? "source" : null;
        if (side) {
          o.local = {
            unit: side, hp: ev.adv.hp, maxHP: ev.adv.maxHp, x: ev.adv.x, y: ev.adv.y,
            facing: ev.adv.facing, mapID: ev.adv.mapId,
          };
          const id = ids[`${side}ID`];
          if (id !== undefined && id >= 0 && ev.adv.maxHp > 0 && lastHp.get(ev.adv.guid) !== ev.adv.hp) {
            lastHp.set(ev.adv.guid, ev.adv.hp);
            health.push({
              fight_id: fightId,
              hostility: isFriendly(ev.units[side]!.flags) ? "friendly" : "enemy",
              actor_id: id,
              timestamp: ev.time - start,
              hit_points: ev.adv.hp,
              max_hit_points: ev.adv.maxHp,
              health_percent: Math.round((ev.adv.hp / ev.adv.maxHp) * 10000) / 100,
            });
          }
        }
      }
      return {
        fight_id: fightId,
        timestamp: ev.time - start,
        type: ev.type,
        source_id: ids.sourceID ?? null,
        target_id: ids.targetID ?? (o.targetID as number | undefined) ?? null,
        source_instance: ids.sourceInstance ?? null,
        target_instance: ids.targetInstance ?? null,
        ability_game_id: typeof o.abilityGameID === "number" ? o.abilityGameID : null,
        amount: typeof o.amount === "number" ? o.amount : null,
        hit_type: typeof o.hitType === "number" ? o.hitType : null,
        raw: JSON.stringify(o),
      };
    });
    return { events: rows, health };
  }
}

function isGroupVsHostile(a: UnitRef, b: UnitRef): boolean {
  const hostileNpc = (u: UnitRef) => isHostile(u.flags) && parseGuid(u.guid).kind !== "Player";
  return (isFriendlyPlayerControlled(a.flags) && hostileNpc(b)) || (isFriendlyPlayerControlled(b.flags) && hostileNpc(a));
}

function firstHostileName(o: OpenFight): string | undefined {
  for (const { ev } of o.events) {
    for (const u of [ev.units.source, ev.units.target]) {
      if (u && isHostile(u.flags) && parseGuid(u.guid).kind !== "Player" && u.name) return u.name;
    }
  }
  return undefined;
}

/** The registry key for a stored actor row (inverse of actorFor's keys). */
function actorKeyOfRow(a: ActorRow): string {
  if (a.type === "Player") return `player:${a.guid}`;
  if (a.type === "Pet") return `pet:${a.game_id}:${a.pet_owner}`;
  return `npc:${a.game_id}`;
}
