import { z } from "zod";
import { findSpellIdsByName, lookupSpellsById } from "../gamedata/lookup.js";
import { getGameDataStatus, syncGameData, type SyncResult } from "../gamedata/sync.js";
import { guard, ok, fail } from "./result.js";

const MAX_IDS = 50;
const NAME_MATCH_LIMIT = 10;

export const lookupSpellsShape = {
  spell_ids: z
    .array(z.number().int().positive())
    .max(MAX_IDS)
    .optional()
    .describe(
      `Spell ids to look up (max ${MAX_IDS}). These are WCL ability gameIDs — e.g. fight_events.ability_game_id.`,
    ),
  name: z
    .string()
    .min(2)
    .optional()
    .describe(
      `Find spells by (partial) name instead, e.g. 'Combustion'. Returns up to ${NAME_MATCH_LIMIT} matches, exact names first.`,
    ),
  include_raw: z
    .boolean()
    .optional()
    .describe("Also return the raw description templates ($s1, $d, ... tokens)."),
};

const inputSchema = z.object(lookupSpellsShape);

export async function lookupSpells(args: unknown) {
  return guard(async () => {
    const { spell_ids, name, include_raw } = inputSchema.parse(args);
    if (!spell_ids?.length && !name) {
      return fail("Provide spell_ids or name.");
    }

    // First use: pull spell data for the current live build.
    let synced: SyncResult | undefined;
    if (!(await getGameDataStatus())) synced = await syncGameData();

    const ids = [...(spell_ids ?? [])];
    if (name) ids.push(...(await findSpellIdsByName(name, NAME_MATCH_LIMIT)));
    const unique = [...new Set(ids)];

    const result = unique.length
      ? await lookupSpellsById(unique, { includeRaw: include_raw })
      : { spells: [], not_found: [] };
    const status = await getGameDataStatus();

    return ok({
      game_build: status?.build,
      ...result,
      ...(synced ? { note: `Downloaded spell data for build ${synced.build} (first use).` } : {}),
      hint:
        "Descriptions are rendered from client data. Values that scale with the character show as " +
        "'(N% of Spell Power)'; talent-dependent text shows as '[with <talent>: ...]'.",
    });
  });
}
