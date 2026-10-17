import { quotedIdentifier } from "@duckdb/node-api";
import { queryRows, write } from "../db/duck.js";
import type { TableSpec } from "../db/seeds.js";
import { parseAssignedTable, type LuaTable, type LuaValue } from "./lua.js";

/**
 * Shared (not per-report) schema holding MDT's per-dungeon enemy data, synced
 * from the addon's GitHub repo. MDT routes reference enemies by their position
 * in these tables (enemy_idx/clone_idx), so a route only resolves against the
 * data it was made with — sync pins one commit and records it.
 */
export const MDT_SCHEMA = "mdt";
const META_TABLE = "_meta";

const REPO = "Nnoggie/MythicDungeonTools";
/** The load-on-demand UI addon's TOC lists the expansion data folders to load. */
const UI_TOC = "MythicDungeonTools_UI/MythicDungeonTools_UI.toc";
/** TOC entries that are code, not dungeon data. */
const NON_DATA_DIRS = new Set(["libs", "AceGUIWidgets", "Modules", "Developer", "Core"]);
/** Re-check GitHub for a newer MDT commit at most this often. */
const RECHECK_MS = 24 * 60 * 60 * 1000;

export const MDT_TABLES: Record<string, TableSpec> = {
  dungeons: {
    description: "One row per dungeon MDT has data for.",
    columns: {
      dungeon_idx: { type: "INTEGER", description: "MDT's dungeon index (a route's currentDungeonIdx)." },
      name: { type: "VARCHAR", description: "English dungeon name." },
      map_id: { type: "INTEGER", description: "Challenge-mode map id." },
      total_forces: { type: "INTEGER", description: "Enemy forces needed for 100%." },
      source_file: { type: "VARCHAR", description: "Data file in the MDT repo." },
    },
  },
  enemies: {
    description: "One row per enemy type in a dungeon, in MDT's order.",
    columns: {
      dungeon_idx: { type: "INTEGER", description: "Join to dungeons.dungeon_idx." },
      enemy_idx: { type: "INTEGER", description: "MDT enemy index within the dungeon (route pulls reference this)." },
      npc_id: { type: "INTEGER", description: "Creature id.", usage: "Matches actors.game_id in a report." },
      name: { type: "VARCHAR", description: "Enemy name." },
      forces: { type: "INTEGER", description: "Enemy forces granted per kill." },
      health: { type: "BIGINT", description: "Base health in MDT's data." },
      is_boss: { type: "BOOLEAN", description: "True for boss encounter units." },
      encounter_id: { type: "INTEGER", description: "Journal encounter id for bosses (not the combat-log encounter id)." },
      creature_type: { type: "VARCHAR", description: "Creature type, e.g. 'Undead'." },
    },
  },
  spawns: {
    description: "One row per placed spawn (MDT 'clone') of an enemy.",
    columns: {
      dungeon_idx: { type: "INTEGER", description: "Join to enemies.dungeon_idx." },
      enemy_idx: { type: "INTEGER", description: "Join to enemies.enemy_idx." },
      clone_idx: { type: "INTEGER", description: "Spawn index within the enemy (route pulls reference this)." },
      pack: { type: "INTEGER", description: "MDT group number: spawns sharing it are one pack. Null for loners." },
      sublevel: { type: "INTEGER", description: "Map floor." },
      x: { type: "DOUBLE", description: "MDT map x (not world coordinates)." },
      y: { type: "DOUBLE", description: "MDT map y (not world coordinates)." },
    },
  },
};

export interface MdtEnemy {
  enemyIdx: number;
  npcId: number;
  name: string;
  forces: number;
  isBoss: boolean;
  encounterId: number | null;
  /** clone_idx -> pack (null when the spawn has no group). */
  spawns: Map<number, number | null>;
}

export interface MdtDungeon {
  dungeonIdx: number;
  name: string;
  totalForces: number;
  commit: string;
  enemies: Map<number, MdtEnemy>;
}

function q(name: string): string {
  return quotedIdentifier(name);
}

async function getSyncedCommit(): Promise<{ commit: string; syncedAt: number } | null> {
  const rows = await queryRows(
    `SELECT commit, synced_at_ms FROM ${q(MDT_SCHEMA)}.${q(META_TABLE)} LIMIT 1`,
  ).catch(() => []);
  const row = rows[0];
  return row ? { commit: String(row.commit), syncedAt: Number(row.synced_at_ms) } : null;
}

async function fetchText(url: string, accept?: string): Promise<string> {
  const res = await fetch(url, {
    headers: { "User-Agent": "wcl-mcp", ...(accept ? { Accept: accept } : {}) },
  });
  if (!res.ok) throw new Error(`GET ${url} failed: ${res.status} ${res.statusText}`);
  return res.text();
}

async function latestCommit(): Promise<string> {
  const sha = await fetchText(
    `https://api.github.com/repos/${REPO}/commits/HEAD`,
    "application/vnd.github.sha",
  );
  return sha.trim();
}

const raw = (commit: string, path: string) =>
  `https://raw.githubusercontent.com/${REPO}/${commit}/${path}`;

interface ParsedDungeon {
  dungeonIdx: number;
  name: string;
  mapId: number | null;
  totalForces: number;
  file: string;
  enemies: LuaTable;
}

/** Parse one MDT dungeon file, or null if it isn't a dungeon data file. */
function parseDungeonFile(file: string, src: string): ParsedDungeon | null {
  const enemies = parseAssignedTable(src, "MDT.dungeonEnemies[dungeonIndex]");
  if (!enemies) return null;
  const idx = src.match(/local\s+dungeonIndex\s*=\s*(\d+)/);
  if (!idx) throw new Error(`${file}: no dungeonIndex.`);
  const total = parseAssignedTable(src, "MDT.dungeonTotalCount[dungeonIndex]");
  return {
    dungeonIdx: Number(idx[1]),
    name: src.match(/englishName\s*=\s*"([^"]+)"/)?.[1] ?? file,
    mapId: Number(src.match(/mapID\s*=\s*(\d+)/)?.[1] ?? NaN) || null,
    totalForces: Number(total?.normal ?? 0),
    file,
    enemies,
  };
}

async function fetchDungeons(commit: string): Promise<ParsedDungeon[]> {
  const toc = await fetchText(raw(commit, UI_TOC));
  const loaders = [...toc.matchAll(/^\.\.\\MythicDungeonTools\\(\w+)\\(load_\w+\.xml)/gm)]
    .filter((m) => !NON_DATA_DIRS.has(m[1]!))
    .map((m) => `${m[1]}/${m[2]}`);
  if (!loaders.length) throw new Error(`No dungeon data folders found in ${UI_TOC}; MDT's layout may have changed.`);

  const files = (
    await Promise.all(
      loaders.map(async (loader) => {
        const dir = loader.slice(0, loader.indexOf("/"));
        const xml = await fetchText(raw(commit, loader));
        return [...xml.matchAll(/<Script\s+file=['"]([^'"]+\.lua)['"]/g)].map((m) => `${dir}/${m[1]}`);
      }),
    )
  ).flat();

  const parsed = await Promise.all(
    files.map(async (file) => parseDungeonFile(file, await fetchText(raw(commit, file)))),
  );
  return parsed.filter((d): d is ParsedDungeon => d !== null);
}

const num = (v: LuaValue | undefined): number | null => (typeof v === "number" ? v : null);
const sorted = (t: LuaTable) => Object.entries(t).sort(([a], [b]) => Number(a) - Number(b));

function loadDungeons(commit: string, dungeons: ParsedDungeon[]): Promise<void> {
  return write(async (conn) => {
    try {
      await conn.run("BEGIN TRANSACTION");
      await conn.run(`DROP SCHEMA IF EXISTS ${q(MDT_SCHEMA)} CASCADE`);
      await conn.run(`CREATE SCHEMA ${q(MDT_SCHEMA)}`);
      for (const [table, spec] of Object.entries(MDT_TABLES)) {
        const cols = Object.entries(spec.columns).map(([n, c]) => `${q(n)} ${c.type}`).join(", ");
        await conn.run(`CREATE TABLE ${q(MDT_SCHEMA)}.${q(table)} (${cols})`);
      }

      const dungeonsA = await conn.createAppender("dungeons", MDT_SCHEMA);
      const enemiesA = await conn.createAppender("enemies", MDT_SCHEMA);
      const spawnsA = await conn.createAppender("spawns", MDT_SCHEMA);
      const int = (a: typeof spawnsA, v: number | null) => (v === null ? a.appendNull() : a.appendInteger(v));
      try {
        for (const d of dungeons) {
          dungeonsA.appendInteger(d.dungeonIdx);
          dungeonsA.appendVarchar(d.name);
          int(dungeonsA, d.mapId);
          dungeonsA.appendInteger(d.totalForces);
          dungeonsA.appendVarchar(d.file);
          dungeonsA.endRow();

          for (const [k, v] of sorted(d.enemies)) {
            if (!v || typeof v !== "object") continue;
            const e = v as LuaTable;
            enemiesA.appendInteger(d.dungeonIdx);
            enemiesA.appendInteger(Number(k));
            int(enemiesA, num(e.id));
            enemiesA.appendVarchar(String(e.name ?? ""));
            enemiesA.appendInteger(num(e.count) ?? 0);
            const health = num(e.health);
            if (health === null) enemiesA.appendNull();
            else enemiesA.appendBigInt(BigInt(Math.trunc(health)));
            enemiesA.appendBoolean(e.isBoss === true);
            int(enemiesA, num(e.encounterID));
            if (typeof e.creatureType === "string") enemiesA.appendVarchar(e.creatureType);
            else enemiesA.appendNull();
            enemiesA.endRow();

            const clones = e.clones && typeof e.clones === "object" ? (e.clones as LuaTable) : {};
            for (const [ci, cv] of sorted(clones)) {
              if (!cv || typeof cv !== "object") continue;
              const c = cv as LuaTable;
              spawnsA.appendInteger(d.dungeonIdx);
              spawnsA.appendInteger(Number(k));
              spawnsA.appendInteger(Number(ci));
              int(spawnsA, num(c.g));
              int(spawnsA, num(c.sublevel));
              const x = num(c.x);
              const y = num(c.y);
              if (x === null) spawnsA.appendNull();
              else spawnsA.appendDouble(x);
              if (y === null) spawnsA.appendNull();
              else spawnsA.appendDouble(y);
              spawnsA.endRow();
            }
          }
        }
        dungeonsA.flushSync();
        enemiesA.flushSync();
        spawnsA.flushSync();
      } finally {
        dungeonsA.closeSync();
        enemiesA.closeSync();
        spawnsA.closeSync();
      }

      await conn.run(
        `CREATE TABLE ${q(MDT_SCHEMA)}.${q(META_TABLE)} AS
         SELECT $commit::VARCHAR AS commit, $now::BIGINT AS synced_at_ms`,
        { commit, now: Date.now() },
      );
      await conn.run("COMMIT");
    } catch (err) {
      await conn.run("ROLLBACK").catch(() => {
        /* transaction may already be aborted */
      });
      throw err;
    }
  });
}

let inFlight: Promise<string> | undefined;

/**
 * Make sure MDT data is present and reasonably current. Re-checks GitHub at
 * most daily (or when `force`); a failed check keeps the existing data.
 * Returns the synced commit.
 */
export function ensureMdtData(force = false): Promise<string> {
  if (!inFlight) {
    inFlight = (async () => {
      const current = await getSyncedCommit();
      if (current && !force && Date.now() - current.syncedAt < RECHECK_MS) return current.commit;
      let commit: string;
      try {
        commit = await latestCommit();
      } catch (err) {
        if (current) return current.commit;
        throw err;
      }
      if (current?.commit === commit) {
        await write((conn) =>
          conn.run(`UPDATE ${q(MDT_SCHEMA)}.${q(META_TABLE)} SET synced_at_ms = $now`, {
            now: BigInt(Date.now()),
          }),
        );
        return commit;
      }
      await loadDungeons(commit, await fetchDungeons(commit));
      return commit;
    })().finally(() => {
      inFlight = undefined;
    });
  }
  return inFlight;
}

/** Load one dungeon's enemy data from the local mdt schema. */
export async function getMdtDungeon(dungeonIdx: number): Promise<MdtDungeon | null> {
  const meta = await getSyncedCommit();
  const dungeon = (
    await queryRows(
      `SELECT name, total_forces FROM ${q(MDT_SCHEMA)}.dungeons WHERE dungeon_idx = $idx`,
      { idx: dungeonIdx },
    )
  )[0];
  if (!meta || !dungeon) return null;

  const enemies = new Map<number, MdtEnemy>();
  for (const e of await queryRows(
    `SELECT enemy_idx, npc_id, name, forces, is_boss, encounter_id
     FROM ${q(MDT_SCHEMA)}.enemies WHERE dungeon_idx = $idx`,
    { idx: dungeonIdx },
  )) {
    enemies.set(Number(e.enemy_idx), {
      enemyIdx: Number(e.enemy_idx),
      npcId: Number(e.npc_id),
      name: String(e.name),
      forces: Number(e.forces),
      isBoss: e.is_boss === true,
      encounterId: e.encounter_id === null ? null : Number(e.encounter_id),
      spawns: new Map(),
    });
  }
  for (const s of await queryRows(
    `SELECT enemy_idx, clone_idx, pack FROM ${q(MDT_SCHEMA)}.spawns WHERE dungeon_idx = $idx`,
    { idx: dungeonIdx },
  )) {
    enemies.get(Number(s.enemy_idx))?.spawns.set(Number(s.clone_idx), s.pack === null ? null : Number(s.pack));
  }

  return {
    dungeonIdx,
    name: String(dungeon.name),
    totalForces: Number(dungeon.total_forces),
    commit: meta.commit,
    enemies,
  };
}

/** Column docs for get_report_details. */
export function mdtTableDocs() {
  return Object.entries(MDT_TABLES).map(([table, spec]) => ({
    table: `${MDT_SCHEMA}.${table}`,
    description: spec.description,
    columns: Object.entries(spec.columns).map(([name, c]) => ({
      name,
      type: c.type,
      description: c.description,
      ...(c.usage ? { usage: c.usage } : {}),
    })),
  }));
}
