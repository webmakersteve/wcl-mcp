import { inflateRawSync } from "node:zlib";
import { Decoder } from "cbor-x";

/**
 * MDT export format (MythicDungeonTools Modules/Transmission.lua):
 *   "!~MDT2~" + base64( raw-deflate( CBOR(preset) ) )
 * WoW's C_EncodingUtil.SerializeCBOR writes every Lua string — keys included —
 * as a CBOR byte string, so they're converted back to text here. Older
 * (pre-MDT2, LibSerialize-based) strings are no longer accepted by MDT itself.
 */
const PREFIX = "!~MDT2~";

/** One planned pull: MDT enemy index -> clone (spawn) indexes in that pull. */
export interface MdtPull {
  enemies: Map<number, number[]>;
  color: string | null;
}

export interface MdtRoute {
  name: string;
  uid: string | null;
  dungeonIdx: number;
  week: number | null;
  difficulty: number | null;
  pulls: MdtPull[];
}

const decoder = new Decoder({ mapsAsObjects: false, useRecords: false });

type Plain = string | number | boolean | null | undefined | Plain[] | { [k: string]: Plain };

/** CBOR Maps/byte strings -> plain objects/strings. */
function toPlain(v: unknown): Plain {
  if (v instanceof Map) {
    const out: { [k: string]: Plain } = {};
    for (const [k, x] of v) out[k instanceof Uint8Array ? Buffer.from(k).toString("utf8") : String(k)] = toPlain(x);
    return out;
  }
  if (v instanceof Uint8Array) return Buffer.from(v).toString("utf8");
  if (Array.isArray(v)) return v.map(toPlain);
  return v as Plain;
}

/** Lua sequences may arrive as CBOR arrays or as maps with "1".."n" keys. */
function entries(v: Plain): [string, Plain][] {
  if (Array.isArray(v)) return v.map((x, i) => [String(i + 1), x]);
  if (v && typeof v === "object") return Object.entries(v);
  return [];
}

export function decodeMdtString(input: string): MdtRoute {
  const s = input.trim();
  if (!s.startsWith(PREFIX)) {
    throw new Error(
      `Not an MDT route string: expected it to start with "${PREFIX}" (MDT's current export format).`,
    );
  }

  let preset: Plain;
  try {
    const compressed = Buffer.from(s.slice(PREFIX.length), "base64");
    preset = toPlain(decoder.decode(inflateRawSync(compressed)));
  } catch (err) {
    throw new Error(
      `Couldn't decode the MDT string (${err instanceof Error ? err.message : String(err)}). ` +
        "Make sure it was copied in full.",
    );
  }

  if (!preset || typeof preset !== "object" || Array.isArray(preset)) {
    throw new Error("MDT string decoded to something other than a route.");
  }
  const value = preset.value;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("MDT route has no `value` table.");
  }
  const dungeonIdx = Number(value.currentDungeonIdx);
  if (!Number.isInteger(dungeonIdx)) throw new Error("MDT route has no dungeon index.");

  const pulls: MdtPull[] = entries(value.pulls).map(([, pull]) => {
    const enemies = new Map<number, number[]>();
    let color: string | null = null;
    for (const [k, clones] of entries(pull)) {
      if (k === "color") {
        color = typeof clones === "string" ? clones : null;
        continue;
      }
      const enemyIdx = Number(k);
      if (!Number.isInteger(enemyIdx)) continue;
      const cloneIdxs = entries(clones).map(([, c]) => Number(c)).filter(Number.isInteger);
      if (cloneIdxs.length) enemies.set(enemyIdx, cloneIdxs);
    }
    return { enemies, color };
  });

  return {
    name: typeof preset.text === "string" ? preset.text : "Untitled route",
    uid: typeof preset.uid === "string" ? preset.uid : null,
    dungeonIdx,
    week: typeof preset.week === "number" ? preset.week : null,
    difficulty: typeof preset.difficulty === "number" ? preset.difficulty : null,
    pulls,
  };
}
