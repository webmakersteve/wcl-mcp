import { z } from "zod";
import { queryRows, write } from "../db/duck.js";
import {
  assertValidReportCode,
  isDownloadComplete,
  notDownloadedMessage,
  quotedSchema,
} from "../db/schema.js";
import { decodeMdtString } from "../mdt/decode.js";
import { ensureMdtData, getMdtDungeon } from "../mdt/data.js";
import { matchRoute, outOfOrderPulls, type LogUnit } from "../mdt/match.js";
import { insertRows, resetRouteTables } from "../mdt/route-tables.js";
import { guard, ok, fail } from "./result.js";

export const importMdtRouteShape = {
  report_code: z.string().describe("Warcraft Logs report code, already downloaded locally."),
  mdt_string: z
    .string()
    .describe("Mythic Dungeon Tools route export string (starts with '!~MDT2~')."),
  fight_id: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "The Mythic+ run (fights.fight_id) to match against. Omit to pick the run whose enemies best match the route.",
    ),
  refresh_mdt_data: z
    .boolean()
    .optional()
    .describe("Re-check GitHub for newer MDT dungeon data before resolving the route."),
};

const inputSchema = z.object(importMdtRouteShape);

export async function importMdtRoute(args: unknown) {
  return guard(async () => {
    const { report_code, mdt_string, fight_id, refresh_mdt_data } = inputSchema.parse(args);
    assertValidReportCode(report_code);

    if (!(await isDownloadComplete(report_code))) {
      return fail(await notDownloadedMessage(report_code));
    }

    const route = decodeMdtString(mdt_string);
    const commit = await ensureMdtData(refresh_mdt_data ?? false);
    let dungeon = await getMdtDungeon(route.dungeonIdx);
    if (!dungeon && !refresh_mdt_data) {
      await ensureMdtData(true);
      dungeon = await getMdtDungeon(route.dungeonIdx);
    }
    if (!dungeon) {
      return fail(
        `MDT has no data for dungeon index ${route.dungeonIdx} (route '${route.name}') at commit ` +
          `${commit.slice(0, 7)}. It may be from a past season MDT no longer ships.`,
      );
    }

    const npcIds = [...new Set([...dungeon.enemies.values()].map((e) => e.npcId))];
    const fight = await pickFight(report_code, npcIds, fight_id);
    if ("error" in fight) return fail(fight.error);

    const wipes = await findWipes(report_code, fight.fight_id);
    const units = await loadUnits(report_code, fight.fight_id, wipes);
    const result = matchRoute(route, dungeon, units, {
      wipes,
      fightEnd: fight.end_time,
      fightKill: fight.kill,
    });
    const unknown = result.unknownEnemies.length;

    await write(async (conn) => {
      try {
        await conn.run("BEGIN TRANSACTION");
        await resetRouteTables(conn, report_code, fight.fight_id);
        await insertRows(conn, report_code, "route_imports", [
          [
            fight.fight_id,
            route.name,
            route.uid,
            route.dungeonIdx,
            dungeon.name,
            route.pulls.length,
            result.pulls.reduce((n, p) => n + p.plannedForces, 0),
            dungeon.totalForces,
            wipes.length,
            dungeon.commit,
            mdt_string.trim(),
            Date.now(),
          ],
        ]);
        await insertRows(
          conn,
          report_code,
          "route_pulls",
          result.pulls.map((p) => [
            fight.fight_id,
            p.pullIndex,
            p.plannedSlots,
            p.plannedForces,
            p.matchedSlots,
            p.matchedForces,
            p.addUnits,
            p.engagements.join(","),
            p.attempts.length,
            p.outcome,
            p.startTime,
            p.endTime,
            p.startTime !== null && p.endTime !== null ? p.endTime - p.startTime : null,
            p.activeMs,
            p.damage,
            dps(p.damage, p.activeMs),
            p.actualOrder,
            p.chainedFrom,
            p.overlapMs,
          ]),
        );
        await insertRows(
          conn,
          report_code,
          "route_pull_attempts",
          result.pulls.flatMap((p) =>
            p.attempts.map((a) => [
              fight.fight_id,
              p.pullIndex,
              a.attempt,
              a.outcome,
              a.startTime,
              a.endTime,
              a.activeMs,
              a.damage,
              dps(a.damage, a.activeMs),
              a.unitsFought,
              a.unitsKilled,
              a.chainedFrom,
              a.overlapMs,
            ]),
          ),
        );
        await insertRows(
          conn,
          report_code,
          "route_planned_units",
          result.slots.map((s) => [
            fight.fight_id,
            s.pullIndex,
            s.enemyIdx,
            s.cloneIdx,
            s.npcId,
            s.name,
            s.forces,
            s.isBoss,
            s.pack,
            s.matched?.actorId ?? null,
            s.matched?.instance ?? null,
          ]),
        );
        await insertRows(
          conn,
          report_code,
          "route_units",
          result.units.map((u) => [
            fight.fight_id,
            u.actorId,
            u.instance,
            u.npcId,
            u.name,
            u.firstHit,
            u.endTime,
            u.died,
            u.damageTaken,
            u.engagement,
            u.pullIndex,
            u.assignment,
            u.forces,
            u.spans.length,
          ]),
        );
        await conn.run("COMMIT");
      } catch (err) {
        await conn.run("ROLLBACK").catch(() => {
          /* transaction may already be aborted */
        });
        throw err;
      }
    });

    // Faithfulness summary.
    const sec = (ms: number | null) => (ms === null ? null : Math.round(ms / 100) / 10);
    const planned = result.slots.length;
    const matched = result.slots.filter((s) => s.matched).length;
    const plannedForces = result.pulls.reduce((n, p) => n + p.plannedForces, 0);
    const matchedForces = result.pulls.reduce((n, p) => n + p.matchedForces, 0);
    const offRoute = result.units.filter((u) => u.assignment === "off_route");
    const engagementPulls = new Map<number, number[]>();
    for (const p of result.pulls) {
      for (const e of p.engagements) engagementPulls.set(e, [...(engagementPulls.get(e) ?? []), p.pullIndex]);
    }

    return ok({
      report_code,
      fight_id: fight.fight_id,
      fight_name: fight.name,
      route: {
        name: route.name,
        dungeon: dungeon.name,
        pulls: route.pulls.length,
        planned_forces: plannedForces,
        total_forces: dungeon.totalForces,
        mdt_commit: dungeon.commit.slice(0, 7),
      },
      faithfulness: {
        planned_mobs_fought: `${matched}/${planned}`,
        planned_forces_fought: `${matchedForces}/${plannedForces}`,
        off_route_kills: {
          units: offRoute.length,
          forces: offRoute.reduce((n, u) => n + u.forces, 0),
          by_name: tally(offRoute.map((u) => u.name)),
        },
        missed_planned_mobs: tally(
          result.slots.filter((s) => !s.matched).map((s) => `pull ${s.pullIndex}: ${s.name}`),
        ),
        pulls_skipped: result.pulls.filter((p) => p.actualOrder === null).map((p) => p.pullIndex),
        pulls_out_of_order: outOfOrderPulls(result.pulls),
        pulls_chained: result.pulls.filter((p) => p.chainedFrom !== null).length,
        wipes: wipes.map((w) => ({
          at_s: sec(w - fight.start_time),
          on_pulls: result.pulls
            .filter((p) => p.attempts.some((a) => a.outcome === "wipe" && a.epoch === wipes.indexOf(w)))
            .map((p) => p.pullIndex),
        })),
        pulls_never_cleared: result.pulls.filter((p) => p.outcome !== null && p.outcome !== "kill").map((p) => p.pullIndex),
        pulls_merged: [...engagementPulls.values()].filter((ps) => ps.length > 1),
        pulls_split: result.pulls
          .filter((p) => p.engagements.length > 1)
          .map((p) => {
            const lo = Math.min(...p.engagements);
            const hi = Math.max(...p.engagements);
            const between = result.pulls
              .filter((o) => o.pullIndex !== p.pullIndex && o.engagements.some((e) => e > lo && e < hi))
              .map((o) => o.pullIndex);
            return { pull: p.pullIndex, pieces: p.engagements.length, ...(between.length ? { interleaved_with: between } : {}) };
          }),
        ...(unknown
          ? { unresolved_route_mobs: `${unknown} route mobs don't exist in MDT's current data (route made on an older MDT version?)` }
          : {}),
      },
      pulls: result.pulls.map((p) => ({
        pull: p.pullIndex,
        actual_order: p.actualOrder,
        start_s: p.startTime === null ? null : sec(p.startTime - fight.start_time),
        active_s: p.attempts.length ? sec(p.activeMs) : null,
        dps: p.attempts.length ? Math.round(dps(p.damage, p.activeMs) ?? 0) : null,
        mobs: `${p.matchedSlots}/${p.plannedSlots}`,
        ...(p.chainedFrom !== null ? { chained_from: p.chainedFrom, overlap_s: sec(p.overlapMs) } : {}),
        ...(p.attempts.length > 1 || (p.outcome && p.outcome !== "kill")
          ? {
              attempts: p.attempts.map((a) => ({
                attempt: a.attempt,
                outcome: a.outcome,
                start_s: sec(a.startTime - fight.start_time),
                active_s: sec(a.activeMs),
                dps: Math.round(dps(a.damage, a.activeMs) ?? 0),
                mobs_killed: `${a.unitsKilled}/${a.unitsFought}`,
              })),
            }
          : {}),
      })),
      hint:
        "Rows are in route_imports, route_pulls, route_pull_attempts, route_planned_units and " +
        "route_units (see get_report_details). DPS here is damage to the pull's own mobs over the " +
        "time they were being fought (active_s), so chaining and wipes don't skew it. Per-player " +
        "damage for a route pull: FROM route_units u JOIN fight_events e ON e.target_id = u.actor_id " +
        "AND coalesce(e.target_instance, 1) = u.instance WHERE u.fight_id = <fight> AND u.pull_index " +
        "= <n> AND e.type = 'damage' (for one attempt, also e.timestamp BETWEEN that attempt's " +
        "start_time AND end_time), attributing pets via actors.pet_owner; divide by " +
        "route_pulls.active_ms. Matching uses npc ids and engagement timing (logs carry no positions), so " +
        "same-npc mobs in adjacent pulls can be swapped; check route_units when a result looks off.",
    });
  });
}

function dps(damage: number, activeMs: number): number | null {
  return activeMs > 0 ? damage / (activeMs / 1000) : null;
}

function tally(xs: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const x of xs) out[x] = (out[x] ?? 0) + 1;
  return out;
}

interface FightPick {
  fight_id: number;
  name: string;
  start_time: number;
  end_time: number;
  kill: boolean;
}

/** The requested fight, or the one whose kills best overlap the dungeon's npc ids. */
async function pickFight(
  code: string,
  npcIds: number[],
  fightId: number | undefined,
): Promise<FightPick | { error: string }> {
  const schema = quotedSchema(code);
  const ids = npcIds.filter(Number.isInteger).join(",") || "NULL";
  const rows = await queryRows(
    `SELECT f.fight_id, f.name, f.start_time, f.end_time, f.kill, count(DISTINCT a.game_id) AS overlap
     FROM ${schema}.fights f
     LEFT JOIN ${schema}.fight_events e ON e.fight_id = f.fight_id AND e.type = 'death'
     LEFT JOIN ${schema}.actors a ON a.actor_id = e.target_id AND a.game_id IN (${ids})
     GROUP BY ALL ORDER BY overlap DESC, f.fight_id`,
  );
  const toPick = (r: Record<string, unknown>): FightPick => ({
    fight_id: Number(r.fight_id),
    name: String(r.name),
    start_time: Number(r.start_time),
    end_time: Number(r.end_time),
    kill: r.kill === true,
  });
  if (fightId !== undefined) {
    const row = rows.find((r) => Number(r.fight_id) === fightId);
    if (!row) return { error: `Fight ${fightId} not found in report '${code}'.` };
    if (Number(row.overlap) === 0) {
      return { error: `Fight ${fightId} (${row.name}) has no kills of this route's dungeon enemies.` };
    }
    return toPick(row);
  }
  const best = rows[0];
  if (!best || Number(best.overlap) === 0) {
    return { error: `No fight in report '${code}' has kills of this route's dungeon enemies.` };
  }
  return toPick(best);
}

/**
 * Group wipes. A player is dead from their death event until they're
 * resurrected or cast again. A wipe is a moment every player is dead, or all
 * but one when the group then stops damaging enemies (the survivor dropped
 * combat and the mobs reset): no group damage for QUIET_MS starting within
 * QUIET_WITHIN_MS. Wipes within WIPE_MERGE_MS (self-res, a late death)
 * collapse into the last one.
 */
const WIPE_MERGE_MS = 30_000;
const QUIET_MS = 15_000;
const QUIET_WITHIN_MS = 10_000;

async function findWipes(code: string, fightId: number): Promise<number[]> {
  const schema = quotedSchema(code);
  const players = await queryRows(
    `SELECT DISTINCT source_id FROM ${schema}.fight_events WHERE fight_id = $fight AND type = 'combatantinfo'`,
    { fight: fightId },
  );
  const size = players.length;
  if (!size) return [];
  const events = await queryRows(
    `SELECT e.timestamp, e.type, CASE WHEN e.type IN ('cast', 'begincast') THEN e.source_id ELSE e.target_id END AS player
     FROM ${schema}.fight_events e
     JOIN ${schema}.actors a ON a.actor_id = CASE WHEN e.type IN ('cast', 'begincast') THEN e.source_id ELSE e.target_id END
     WHERE e.fight_id = $fight AND a.type = 'Player' AND e.type IN ('death', 'resurrect', 'cast', 'begincast')
     ORDER BY e.timestamp`,
    { fight: fightId },
  );
  // Lulls in group damage to enemies, including from the last hit to fight end.
  const lulls = (
    await queryRows(
      `WITH hits AS (
         SELECT e.timestamp FROM ${schema}.fight_events e
         JOIN ${schema}.actors s ON s.actor_id = e.source_id
         JOIN ${schema}.actors t ON t.actor_id = e.target_id
         WHERE e.fight_id = $fight AND e.type = 'damage'
           AND s.type IN ('Player', 'Pet') AND t.type IN ('NPC', 'Boss')
         UNION ALL SELECT end_time FROM ${schema}.fights WHERE fight_id = $fight
       )
       SELECT quiet_from FROM (
         SELECT lag(timestamp) OVER (ORDER BY timestamp) AS quiet_from, timestamp AS quiet_to FROM hits
       ) WHERE quiet_to - quiet_from >= $quiet OR quiet_to = (SELECT end_time FROM ${schema}.fights WHERE fight_id = $fight)`,
      { fight: fightId, quiet: QUIET_MS },
    )
  )
    .map((r) => Number(r.quiet_from))
    .filter(Number.isFinite);
  const goesQuiet = (t: number) => lulls.some((q) => q >= t - QUIET_WITHIN_MS && q <= t + QUIET_WITHIN_MS);

  const dead = new Set<number>();
  const wipes: number[] = [];
  for (const e of events) {
    const player = Number(e.player);
    if (e.type !== "death") {
      dead.delete(player);
      continue;
    }
    dead.add(player);
    const t = Number(e.timestamp);
    if (dead.size < size - 1 || (dead.size === size - 1 && (size === 1 || !goesQuiet(t)))) continue;
    if (wipes.length && t - wipes[wipes.length - 1]! <= WIPE_MERGE_MS) wipes[wipes.length - 1] = t;
    else wipes.push(t);
  }
  return wipes;
}

/** Damage this soon after a wipe (DoTs, pets) still belongs to the wiped attempt. */
const WIPE_GRACE_MS = 10_000;

/** Every NPC unit players/pets damaged in the fight, with per-epoch timing and damage taken. */
async function loadUnits(code: string, fightId: number, wipes: number[]): Promise<LogUnit[]> {
  const schema = quotedSchema(code);
  const bounds = wipes.map((w) => Math.trunc(w + WIPE_GRACE_MS)).join(",");
  const rows = await queryRows(
    `WITH ev AS (
       SELECT e.timestamp, e.type, e.target_id, coalesce(e.target_instance, 1) AS inst,
              len(list_filter([${bounds}]::BIGINT[], b -> b < e.timestamp)) AS epoch,
              coalesce(e.amount, 0) + coalesce(json_extract(e.raw, '$.absorbed')::BIGINT, 0) AS dmg,
              s.type IN ('Player', 'Pet') AS by_group
       FROM ${schema}.fight_events e
       LEFT JOIN ${schema}.actors s ON s.actor_id = e.source_id
       WHERE e.fight_id = $fight AND e.type IN ('damage', 'death')
     )
     SELECT ev.target_id AS actor_id, ev.inst AS instance, a.game_id AS npc_id, a.name, ev.epoch,
            min(ev.timestamp) FILTER (WHERE ev.type = 'damage' AND ev.by_group) AS first_hit,
            max(ev.timestamp) FILTER (WHERE ev.type = 'death') AS death_time,
            max(ev.timestamp) FILTER (WHERE ev.type = 'damage') AS last_damage,
            coalesce(sum(ev.dmg) FILTER (WHERE ev.type = 'damage' AND ev.by_group), 0) AS damage
     FROM ev JOIN ${schema}.actors a ON a.actor_id = ev.target_id
     WHERE a.type IN ('NPC', 'Boss')
     GROUP BY ALL
     HAVING first_hit IS NOT NULL
     ORDER BY actor_id, instance, epoch`,
    { fight: fightId },
  );
  const summons = await queryRows(
    `SELECT e.target_id, coalesce(e.target_instance, 1) AS inst,
            e.source_id, coalesce(e.source_instance, 1) AS source_inst
     FROM ${schema}.fight_events e JOIN ${schema}.actors s ON s.actor_id = e.source_id
     WHERE e.fight_id = $fight AND e.type = 'summon' AND s.type IN ('NPC', 'Boss')`,
    { fight: fightId },
  );
  const summoner = new Map(
    summons.map((s) => [
      `${s.target_id}:${s.inst}`,
      { actorId: Number(s.source_id), instance: Number(s.source_inst) },
    ]),
  );

  const units = new Map<string, LogUnit>();
  for (const r of rows) {
    const key = `${r.actor_id}:${r.instance}`;
    const died = r.death_time !== null;
    const span = {
      epoch: Number(r.epoch),
      firstHit: Number(r.first_hit),
      endTime: Number(died ? r.death_time : r.last_damage),
      died,
      damage: Number(r.damage),
    };
    const unit = units.get(key);
    if (!unit) {
      units.set(key, {
        actorId: Number(r.actor_id),
        instance: Number(r.instance),
        npcId: r.npc_id === null ? null : Number(r.npc_id),
        name: String(r.name),
        firstHit: span.firstHit,
        endTime: span.endTime,
        died,
        damageTaken: span.damage,
        spans: [span],
        summoner: summoner.get(key) ?? null,
      });
    } else {
      unit.spans.push(span);
      unit.endTime = span.endTime;
      unit.died = died;
      unit.damageTaken += span.damage;
    }
  }
  return [...units.values()];
}
