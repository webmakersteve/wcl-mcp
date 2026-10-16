import type { MdtRoute } from "./decode.js";
import type { MdtDungeon } from "./data.js";

/**
 * Re-slices a Mythic+ run into the route's pulls. WCL splits a key into pulls
 * by time, which breaks when packs are chained. Here each enemy the group
 * fought is assigned to a planned route pull by *what it is* (npc id) and *when
 * it was engaged*, so a pull's damage is the damage done to its own mobs, no
 * matter how it overlapped with the pulls around it.
 *
 * 1. Enemies the route plans, or that are worth forces, are grouped into
 *    engagements: consecutive first hits less than ENGAGEMENT_GAP_MS apart.
 * 2. Engagements are taken in time order. Each goes to the route pull that can
 *    absorb the most of its enemies (by npc id, against that pull's unfilled
 *    spawns), ties going to the pull nearest the last one assigned. Enemies it
 *    can't take may spill into pulls within MERGE_RANGE route positions —
 *    that's how merged pulls show up.
 * 3. Leftovers go to the pull with room whose time window (first hit to last
 *    death) is nearest, if within NEAREST_WINDOW_MS; the rest are off-route.
 * 4. Everything else (summons, boss adds, 0-forces mobs the route doesn't
 *    plan) joins its summoner's pull, else the most recently started pull
 *    active when it was first hit.
 * 5. Wipes split the run into epochs. A pull gets one attempt per epoch its
 *    mobs were fought in; mobs reset by a wipe keep their log identity, so a
 *    later attempt holds only the mobs still alive. An attempt is a wipe if
 *    any of its mobs was alive and still being fought when the group died.
 *    Attempt time is the union of its mobs' first-hit-to-death intervals, so
 *    time spent on other pulls between pieces doesn't dilute its DPS.
 */
const ENGAGEMENT_GAP_MS = 5000;
const MERGE_RANGE = 2;
const NEAREST_WINDOW_MS = 60_000;
/** A mob last hit this close to a wipe (or the end of an untimed run) was still being fought. */
const STILL_FIGHTING_MS = 15_000;

/** One unit's damage taken within one epoch (the stretch between wipes). */
export interface Span {
  epoch: number;
  firstHit: number;
  endTime: number;
  died: boolean;
  damage: number;
}

export interface RunContext {
  /** Wipe times (report-relative ms), ascending; epoch k ends at wipes[k]. */
  wipes: number[];
  fightEnd: number;
  /** Whether the key was completed (an unfinished final attempt is then 'incomplete'). */
  fightKill: boolean;
}

export type Outcome = "kill" | "wipe" | "incomplete";

export interface AttemptResult {
  attempt: number;
  epoch: number;
  outcome: Outcome;
  startTime: number;
  endTime: number;
  /** Union of the attempt's mobs' first-hit-to-end intervals. */
  activeMs: number;
  damage: number;
  /** Route mobs fought in this attempt, and how many died. */
  unitsFought: number;
  unitsKilled: number;
  chainedFrom: number | null;
  overlapMs: number | null;
}

/** One enemy unit the group damaged (an actor id + instance in the log). */
export interface LogUnit {
  actorId: number;
  instance: number;
  npcId: number | null;
  name: string;
  /** First damage from a player or pet, report-relative ms. */
  firstHit: number;
  /** Death time, or last damage taken for units that never died (some bosses). */
  endTime: number;
  died: boolean;
  /** Damage dealt to this unit by players and pets (incl. absorbed). */
  damageTaken: number;
  /** Per-epoch breakdown; a mob fought across a wipe has one span per epoch. */
  spans: Span[];
  summoner: { actorId: number; instance: number } | null;
}

export interface PlannedSlot {
  pullIndex: number;
  enemyIdx: number;
  cloneIdx: number;
  npcId: number;
  name: string;
  forces: number;
  isBoss: boolean;
  pack: number | null;
  matched: LogUnit | null;
}

export type Assignment = "route" | "off_route" | "add";

export interface AssignedUnit extends LogUnit {
  engagement: number | null;
  pullIndex: number | null;
  assignment: Assignment;
  forces: number;
}

export interface PullResult {
  pullIndex: number;
  plannedSlots: number;
  plannedForces: number;
  matchedSlots: number;
  matchedForces: number;
  /** Engagements (step 1) that contributed enemies to this pull. */
  engagements: number[];
  startTime: number | null;
  endTime: number | null;
  damage: number;
  /** Summed active time over all attempts. */
  activeMs: number;
  addUnits: number;
  /** 1-based order this pull was actually started in. */
  actualOrder: number | null;
  attempts: AttemptResult[];
  /** Outcome of the last attempt. */
  outcome: Outcome | null;
  /** From the last attempt: the pull still in combat when it started (latest-started such pull). */
  chainedFrom: number | null;
  overlapMs: number | null;
}

export interface MatchResult {
  slots: PlannedSlot[];
  units: AssignedUnit[];
  pulls: PullResult[];
  unknownEnemies: { enemyIdx: number; cloneIdx: number; pullIndex: number }[];
}

export function plannedSlots(route: MdtRoute, dungeon: MdtDungeon): Pick<MatchResult, "slots" | "unknownEnemies"> {
  const slots: PlannedSlot[] = [];
  const unknownEnemies: MatchResult["unknownEnemies"] = [];
  route.pulls.forEach((pull, i) => {
    const pullIndex = i + 1;
    for (const [enemyIdx, clones] of pull.enemies) {
      const enemy = dungeon.enemies.get(enemyIdx);
      for (const cloneIdx of clones) {
        if (!enemy || !enemy.spawns.has(cloneIdx)) {
          unknownEnemies.push({ enemyIdx, cloneIdx, pullIndex });
          continue;
        }
        slots.push({
          pullIndex,
          enemyIdx,
          cloneIdx,
          npcId: enemy.npcId,
          name: enemy.name,
          forces: enemy.forces,
          isBoss: enemy.isBoss,
          pack: enemy.spawns.get(cloneIdx) ?? null,
          matched: null,
        });
      }
    }
  });
  // Fill packs in a stable order so same-npc spawns are matched predictably.
  slots.sort((a, b) => a.pullIndex - b.pullIndex || (a.pack ?? 1e9) - (b.pack ?? 1e9) || a.enemyIdx - b.enemyIdx || a.cloneIdx - b.cloneIdx);
  return { slots, unknownEnemies };
}

export function matchRoute(
  route: MdtRoute,
  dungeon: MdtDungeon,
  logUnits: LogUnit[],
  run: RunContext,
): MatchResult {
  const { slots, unknownEnemies } = plannedSlots(route, dungeon);
  const plannedNpcIds = new Set(slots.map((s) => s.npcId));
  const forcesByNpc = new Map([...dungeon.enemies.values()].map((e) => [e.npcId, e.forces]));
  const isRouteMob = (npcId: number | null) =>
    npcId !== null && (plannedNpcIds.has(npcId) || (forcesByNpc.get(npcId) ?? 0) > 0);

  const units: AssignedUnit[] = [...logUnits]
    .sort((a, b) => a.firstHit - b.firstHit || a.actorId - b.actorId || a.instance - b.instance)
    .map((u) => ({
      ...u,
      engagement: null,
      pullIndex: null,
      assignment: isRouteMob(u.npcId) ? "off_route" : "add",
      forces: 0,
    }));

  // 1. Engagements over route mobs.
  const known = units.filter((u) => u.assignment !== "add");
  const engagements: AssignedUnit[][] = [];
  let last = -Infinity;
  for (const u of known) {
    if (u.firstHit - last >= ENGAGEMENT_GAP_MS || !engagements.length) engagements.push([]);
    u.engagement = engagements.length;
    engagements[engagements.length - 1]!.push(u);
    last = u.firstHit;
  }

  const open = (pullIndex: number, npcId: number) =>
    slots.filter((s) => s.pullIndex === pullIndex && s.npcId === npcId && !s.matched);
  const assign = (u: AssignedUnit, pullIndex: number): boolean => {
    const slot = open(pullIndex, u.npcId!)[0];
    if (!slot) return false;
    slot.matched = u;
    u.pullIndex = pullIndex;
    u.assignment = "route";
    u.forces = slot.forces;
    return true;
  };

  // 2. Assign each engagement to its best pull, spilling only into nearby pulls.
  let cursor = 0;
  const leftovers: AssignedUnit[] = [];
  for (const group of engagements) {
    let pending = group;
    let primary: number | null = null;
    while (pending.length) {
      const scores = new Map<number, number>();
      const byNpc = countBy(pending, (u) => u.npcId!);
      for (const p of new Set(slots.filter((s) => !s.matched).map((s) => s.pullIndex))) {
        if (primary !== null && Math.abs(p - primary) > MERGE_RANGE) continue;
        let score = 0;
        for (const [npcId, n] of byNpc) score += Math.min(n, open(p, npcId).length);
        if (score > 0) scores.set(p, score);
      }
      if (!scores.size) break;
      const best = [...scores].sort(
        ([pa, sa], [pb, sb]) => sb - sa || Math.abs(pa - cursor - 0.5) - Math.abs(pb - cursor - 0.5),
      )[0]![0];
      if (primary === null) {
        primary = best;
        cursor = best;
      }
      pending = pending.filter((u) => !assign(u, best));
    }
    leftovers.push(...pending);
  }

  // 3. Leftovers: nearest pull window in time, else off-route.
  const windows = pullWindows(units);
  for (const u of leftovers) {
    let pick: number | null = null;
    let pickDistance = NEAREST_WINDOW_MS;
    for (const [p, w] of windows) {
      const distance = Math.max(0, w.start - u.firstHit, u.firstHit - w.end);
      if (distance <= pickDistance && open(p, u.npcId!).length) {
        pick = p;
        pickDistance = distance;
      }
    }
    if (pick !== null) assign(u, pick);
  }
  // Off-route kills still grant forces; record them for the faithfulness totals.
  for (const u of units) if (u.assignment === "off_route") u.forces = forcesByNpc.get(u.npcId!) ?? 0;

  // 4. Adds: summoner's pull, else the latest-started pull attempt active at first hit.
  const routeWindows = attemptWindows(units.filter((u) => u.assignment === "route"));
  const key = (actorId: number, instance: number) => `${actorId}:${instance}`;
  const byKey = new Map(units.map((u) => [key(u.actorId, u.instance), u]));
  for (const u of units) {
    if (u.assignment !== "add") continue;
    const summoner = u.summoner && byKey.get(key(u.summoner.actorId, u.summoner.instance));
    if (summoner?.pullIndex) {
      u.pullIndex = summoner.pullIndex;
      continue;
    }
    let pick: number | null = null;
    let pickStart = -Infinity;
    for (const w of routeWindows) {
      if (w.start <= u.firstHit && u.firstHit <= w.end && w.start > pickStart) {
        pick = w.pullIndex;
        pickStart = w.start;
      }
    }
    u.pullIndex = pick;
  }

  // 5. Attempts per pull, then chaining across all attempts.
  const attemptsByPull = new Map<number, AttemptResult[]>();
  for (const u of units) {
    if (u.pullIndex === null) continue;
    if (!attemptsByPull.has(u.pullIndex)) attemptsByPull.set(u.pullIndex, []);
  }
  for (const [pullIndex, list] of attemptsByPull) {
    const mine = units.filter((u) => u.pullIndex === pullIndex);
    const epochs = [...new Set(mine.flatMap((u) => u.spans.map((sp) => sp.epoch)))].sort((a, b) => a - b);
    for (const epoch of epochs) {
      const spans = mine.flatMap((u) =>
        u.spans.filter((sp) => sp.epoch === epoch).map((sp) => ({ ...sp, route: u.assignment === "route" })),
      );
      const routeSpans = spans.filter((sp) => sp.route);
      if (!routeSpans.length) continue; // only adds left over from an earlier attempt
      const stopAt = epoch < run.wipes.length ? run.wipes[epoch]! : run.fightKill ? null : run.fightEnd;
      const stillUp = routeSpans.some((sp) => !sp.died && stopAt !== null && sp.endTime >= stopAt - STILL_FIGHTING_MS);
      list.push({
        attempt: list.length + 1,
        epoch,
        outcome: !stillUp ? "kill" : epoch < run.wipes.length ? "wipe" : "incomplete",
        startTime: Math.min(...spans.map((sp) => sp.firstHit)),
        endTime: Math.max(...spans.map((sp) => sp.endTime)),
        activeMs: unionMs(spans),
        damage: sum(spans, (sp) => sp.damage),
        unitsFought: routeSpans.length,
        unitsKilled: routeSpans.filter((sp) => sp.died).length,
        chainedFrom: null,
        overlapMs: null,
      });
    }
  }
  const allAttempts = [...attemptsByPull].flatMap(([pullIndex, list]) => list.map((a) => ({ pullIndex, a })));
  for (const { pullIndex, a } of allAttempts) {
    let bestStart = -Infinity;
    for (const { pullIndex: other, a: o } of allAttempts) {
      if (other !== pullIndex && o.startTime < a.startTime && o.endTime > a.startTime && o.startTime > bestStart) {
        a.chainedFrom = other;
        a.overlapMs = Math.min(o.endTime, a.endTime) - a.startTime;
        bestStart = o.startTime;
      }
    }
  }

  // Per-pull results.
  const startOrder = [...attemptsByPull]
    .filter(([, list]) => list.length)
    .sort(([, a], [, b]) => a[0]!.startTime - b[0]!.startTime)
    .map(([p]) => p);
  const pulls: PullResult[] = route.pulls.map((_, i) => {
    const pullIndex = i + 1;
    const mine = slots.filter((s) => s.pullIndex === pullIndex);
    const attempts = attemptsByPull.get(pullIndex) ?? [];
    const final = attempts[attempts.length - 1];
    const assigned = units.filter((u) => u.pullIndex === pullIndex);
    return {
      pullIndex,
      plannedSlots: mine.length,
      plannedForces: sum(mine, (s) => s.forces),
      matchedSlots: mine.filter((s) => s.matched).length,
      matchedForces: sum(mine.filter((s) => s.matched), (s) => s.forces),
      engagements: [...new Set(assigned.filter((u) => u.assignment === "route").map((u) => u.engagement!))],
      startTime: attempts[0]?.startTime ?? null,
      endTime: final?.endTime ?? null,
      damage: sum(attempts, (a) => a.damage),
      activeMs: sum(attempts, (a) => a.activeMs),
      addUnits: assigned.filter((u) => u.assignment === "add").length,
      actualOrder: attempts.length ? startOrder.indexOf(pullIndex) + 1 : null,
      attempts,
      outcome: final?.outcome ?? null,
      chainedFrom: final?.chainedFrom ?? null,
      overlapMs: final?.overlapMs ?? null,
    };
  });

  return { slots, units, pulls, unknownEnemies };
}

/**
 * Pulls that were done out of route order: those outside the longest run of
 * pulls whose actual start order is increasing in route order.
 */
export function outOfOrderPulls(pulls: PullResult[]): number[] {
  const done = pulls.filter((p) => p.actualOrder !== null).sort((a, b) => a.actualOrder! - b.actualOrder!);
  const seq = done.map((p) => p.pullIndex);
  const len = seq.map(() => 1);
  const prev = seq.map(() => -1);
  for (let i = 0; i < seq.length; i++) {
    for (let j = 0; j < i; j++) {
      if (seq[j]! < seq[i]! && len[j]! + 1 > len[i]!) {
        len[i] = len[j]! + 1;
        prev[i] = j;
      }
    }
  }
  let end = len.indexOf(Math.max(...len, 0));
  const inOrder = new Set<number>();
  while (end !== -1) {
    inOrder.add(seq[end]!);
    end = prev[end]!;
  }
  return seq.filter((p) => !inOrder.has(p)).sort((a, b) => a - b);
}

/** Each pull's window over its routed units: first hit to last end. */
function pullWindows(units: AssignedUnit[]): Map<number, { start: number; end: number }> {
  const windows = new Map<number, { start: number; end: number }>();
  for (const u of units) {
    if (u.assignment !== "route") continue;
    const w = windows.get(u.pullIndex!);
    if (!w) windows.set(u.pullIndex!, { start: u.firstHit, end: u.endTime });
    else {
      w.start = Math.min(w.start, u.firstHit);
      w.end = Math.max(w.end, u.endTime);
    }
  }
  return windows;
}

/** Each pull's per-epoch window over the given units' spans. */
function attemptWindows(units: AssignedUnit[]): { pullIndex: number; start: number; end: number }[] {
  const windows = new Map<string, { pullIndex: number; start: number; end: number }>();
  for (const u of units) {
    for (const sp of u.spans) {
      const k = `${u.pullIndex}:${sp.epoch}`;
      const w = windows.get(k);
      if (!w) windows.set(k, { pullIndex: u.pullIndex!, start: sp.firstHit, end: sp.endTime });
      else {
        w.start = Math.min(w.start, sp.firstHit);
        w.end = Math.max(w.end, sp.endTime);
      }
    }
  }
  return [...windows.values()];
}

/** Total length covered by a set of [firstHit, endTime] intervals. */
function unionMs(spans: { firstHit: number; endTime: number }[]): number {
  const sorted = [...spans].sort((a, b) => a.firstHit - b.firstHit);
  let total = 0;
  let curStart = -Infinity;
  let curEnd = -Infinity;
  for (const sp of sorted) {
    if (sp.firstHit > curEnd) {
      if (curEnd > curStart) total += curEnd - curStart;
      curStart = sp.firstHit;
      curEnd = sp.endTime;
    } else {
      curEnd = Math.max(curEnd, sp.endTime);
    }
  }
  if (curEnd > curStart) total += curEnd - curStart;
  return total;
}

function countBy<T, K>(xs: T[], f: (x: T) => K): Map<K, number> {
  const m = new Map<K, number>();
  for (const x of xs) m.set(f(x), (m.get(f(x)) ?? 0) + 1);
  return m;
}

function sum<T>(xs: T[], f: (x: T) => number): number {
  return xs.reduce((n, x) => n + f(x), 0);
}
