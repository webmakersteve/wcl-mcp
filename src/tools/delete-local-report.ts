import { z } from "zod";
import { assertValidReportCode, dropRouteSchema, dropSchema, schemaName } from "../db/schema.js";
import { guard, ok } from "./result.js";

export const deleteLocalReportShape = {
  report_code: z
    .string()
    .describe("Warcraft Logs report code whose local copy should be removed."),
};

const inputSchema = z.object(deleteLocalReportShape);

export async function deleteLocalReport(args: unknown) {
  return guard(async () => {
    const { report_code } = inputSchema.parse(args);
    assertValidReportCode(report_code);

    const removedLog = await dropSchema(report_code);
    const removedRoutes = await dropRouteSchema(report_code);
    const removed = removedLog || removedRoutes;
    return ok({
      status: removed ? "deleted" : "not_found",
      report_code,
      schema: schemaName(report_code),
      message: removed
        ? `Dropped the local log data and imported MDT routes for report ${report_code}.`
        : `No local copy of report ${report_code} was found; nothing to delete.`,
    });
  });
}
