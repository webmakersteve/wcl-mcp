import { z } from "zod";
import { getConfig } from "../config.js";
import { getWclClient } from "../wcl/client.js";
import { USER_REPORTS_QUERY } from "../wcl/queries.js";
import type { UserReportsResponse } from "../wcl/types.js";
import { guard, ok, fail } from "./result.js";

export const findReportsShape = {
  zone_id: z
    .number()
    .int()
    .optional()
    .describe("Filter to a specific WCL zone (instance) id, e.g. a particular raid or dungeon."),
  start_date: z
    .string()
    .optional()
    .describe("Only reports starting on/after this date. ISO date or datetime, e.g. '2026-06-01'."),
  end_date: z
    .string()
    .optional()
    .describe("Only reports starting on/before this date. ISO date or datetime."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe("Max reports to return per page (default 25)."),
  page: z.number().int().min(1).optional().describe("Page number (default 1)."),
};

const inputSchema = z.object(findReportsShape);

function toEpochMs(value: string | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    throw new Error(`Could not parse date: ${JSON.stringify(value)} (use e.g. '2026-06-01').`);
  }
  return ms;
}

export async function findReports(args: unknown) {
  return guard(async () => {
    const { zone_id, start_date, end_date, limit, page } = inputSchema.parse(args);

    const client = getWclClient();
    const loggedIn = client.loggedInUser;
    const userId = getConfig().userId ?? loggedIn?.userId;
    if (!userId) {
      return fail(
        "find_reports is scoped to your own uploads, which requires knowing who you are. " +
          "Call the login tool (also unlocks private reports), or set WCL_USER_ID (find it in " +
          "your profile URL: https://www.warcraftlogs.com/user/<id>). Alternatively, ask the " +
          "agent to use a known report code directly with download_report.",
      );
    }

    const data = await client.query<UserReportsResponse>(USER_REPORTS_QUERY, {
      userID: userId,
      zoneID: zone_id ?? null,
      startTime: toEpochMs(start_date),
      endTime: toEpochMs(end_date),
      limit: limit ?? 25,
      page: page ?? 1,
    });

    const reports = data.reportData.reports;
    if (!reports) {
      return ok({ report_codes: [], reports: [], total: 0, has_more_pages: false });
    }

    const results = reports.data.map((r) => ({
      report_code: r.code,
      title: r.title,
      zone: r.zone?.name ?? null,
      start_time: r.startTime,
      end_time: r.endTime,
      start_iso: new Date(r.startTime).toISOString(),
    }));

    return ok({
      report_codes: results.map((r) => r.report_code),
      reports: results,
      total: reports.total,
      current_page: reports.current_page,
      has_more_pages: reports.has_more_pages,
      note:
        `Scoped to user ${userId}'s uploads` +
        (loggedIn ? ", private reports included. " : " (public only; call login to include private). ") +
        "Player-name filtering is not supported by the API; download a report and use " +
        "execute_readonly_query to filter by participating players.",
    });
  });
}
