/** GUIDs, unit flags and raid markers from combat log unit fields. */

export const NIL_GUID = "0000000000000000";

export type GuidKind = "Player" | "Creature" | "Pet" | "Vehicle" | "GameObject" | "Other";

export interface GuidInfo {
  kind: GuidKind;
  /** Creature/pet/vehicle/gameobject template id; for players, the hex part as an integer. */
  gameId: number;
}

const guidCache = new Map<string, GuidInfo>();

/**
 * Parse a unit GUID:
 *   Player-<serverId>-<hex>
 *   Creature|Pet|Vehicle|GameObject-0-<server>-<instance>-<zoneUid>-<id>-<spawnUid>
 */
export function parseGuid(guid: string): GuidInfo {
  let info = guidCache.get(guid);
  if (info) return info;
  const parts = guid.split("-");
  const head = parts[0];
  if (head === "Player") {
    info = { kind: "Player", gameId: parseInt(parts[2] ?? "0", 16) || 0 };
  } else if (head === "Creature" || head === "Pet" || head === "Vehicle" || head === "GameObject") {
    info = { kind: head, gameId: Number(parts[5] ?? 0) || 0 };
  } else {
    info = { kind: "Other", gameId: 0 };
  }
  if (guidCache.size > 200_000) guidCache.clear();
  guidCache.set(guid, info);
  return info;
}

export function isNilGuid(guid: string): boolean {
  return guid === "" || guid === NIL_GUID || guid === "nil";
}

// Unit flag bits (COMBATLOG_OBJECT_*).
const REACTION_FRIENDLY = 0x10;
const REACTION_HOSTILE = 0x40;
const CONTROL_PLAYER = 0x100;

export function isFriendly(flags: number): boolean {
  return (flags & REACTION_FRIENDLY) !== 0;
}

export function isHostile(flags: number): boolean {
  return (flags & REACTION_HOSTILE) !== 0;
}

export function isFriendlyPlayerControlled(flags: number): boolean {
  return (flags & REACTION_FRIENDLY) !== 0 && (flags & CONTROL_PLAYER) !== 0;
}

/**
 * Raid target marker (1 star … 8 skull) from raid flags, or undefined when unmarked.
 * The low byte holds one bit per marker.
 */
export function raidMarker(raidFlags: number): number | undefined {
  const bits = raidFlags & 0xff;
  if (bits === 0) return undefined;
  return 31 - Math.clz32(bits & -bits) + 1;
}

/** Split "Name-Realm-REGION" into its parts (realm and region absent for NPCs). */
export function splitPlayerName(full: string): { name: string; server: string | null; region: string | null } {
  const parts = full.split("-");
  if (parts.length >= 3) {
    return { name: parts.slice(0, -2).join("-"), server: parts[parts.length - 2]!, region: parts[parts.length - 1]! };
  }
  if (parts.length === 2) return { name: parts[0]!, server: parts[1]!, region: null };
  return { name: full, server: null, region: null };
}
