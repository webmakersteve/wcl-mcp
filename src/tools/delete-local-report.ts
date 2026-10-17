import { z } from "zod";
import {
  assertValidReportCode,
  dropRouteSchema,
  dropSchema,
  isLocalReportCode,
  schemaName,
} from "../db/schema.js";
import { getIngest, setIngest } from "../local/store.js";
import { guard, ok } from "./result.js";

export const deleteLocalReportShape = {
  report_code: z
    .string()
    .describe("Report code whose local copy should be removed (a WCL code or an imported log's local_ code)."),
};

const inputSchema = z.object(deleteLocalReportShape);

export async function deleteLocalReport(args: unknown) {
  return guard(async () => {
    const { report_code } = inputSchema.parse(args);
    assertValidReportCode(report_code);

    const removedLog = await dropSchema(report_code);
    const removedRoutes = await dropRouteSchema(report_code);
    const removed = removedLog || removedRoutes;
    // Keep sync_local_logs from re-importing a log the user deleted; import_local_log un-ignores it.
    const ingest = isLocalReportCode(report_code) ? await getIngest(report_code) : null;
    if (ingest) await setIngest(null, { ...ingest, byte_offset: 0, status: "ignored", updated_at: Date.now() });
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
