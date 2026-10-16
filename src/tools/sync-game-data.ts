import { z } from "zod";
import { syncGameData } from "../gamedata/sync.js";
import { guard, ok } from "./result.js";

export const syncGameDataShape = {
  force: z
    .boolean()
    .optional()
    .describe("Re-download even if the local data is already on the latest build."),
};

const inputSchema = z.object(syncGameDataShape);

export async function syncGameDataTool(args: unknown) {
  return guard(async () => {
    const { force } = inputSchema.parse(args);
    const result = await syncGameData(force ?? false);
    return ok({
      ...result,
      schema: "gamedata",
      hint:
        result.status === "up_to_date"
          ? "Already on the latest live build."
          : "Spell data loaded. Use lookup_spells, or join gamedata.spell in execute_readonly_query.",
    });
  });
}
