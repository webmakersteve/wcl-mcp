import { z } from "zod";
import { fetchFightInsights } from "../wipefest/client.js";
import { condenseInsights } from "../wipefest/insights.js";
import { guard, ok, fail } from "./result.js";

export const getPullInsightsShape = {
  report_code: z.string().describe("Warcraft Logs report code. Need not be downloaded locally."),
  fight_id: z
    .number()
    .int()
    .positive()
    .describe("Fight (pull) id within the report, i.e. fights.fight_id."),
};

const inputSchema = z.object(getPullInsightsShape);

export async function getPullInsights(args: unknown) {
  return guard(async () => {
    const { report_code, fight_id } = inputSchema.parse(args);
    const insights = await fetchFightInsights(report_code, fight_id);
    if (!insights.length) {
      return fail(
        `Wipefest returned no insights for ${report_code} fight ${fight_id}. ` +
          "It only analyzes raid boss encounters it has mechanic configs for.",
      );
    }

    return ok({
      report_code,
      fight_id,
      source: "wipefest.gg",
      ...condenseInsights(insights),
      hint:
        "Times are fight-relative; fight_events.timestamp is report-relative, so add " +
        "fights.start_time. To dig into a mechanic, download_report then query fight_events " +
        "WHERE fight_id = <fight_id> AND ability_game_id IN (<spell_ids>), joining actors for " +
        "names. Compare by_first_death with the whole-fight summary to separate what caused " +
        "the wipe from the fallout after it. lookup_spells explains unfamiliar spell ids.",
    });
  });
}
