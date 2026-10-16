/** Response/data shapes for the WCL queries in queries.ts. */

export interface WclActor {
  id: number;
  name: string;
  type: string | null;
  subType: string | null;
  server: string | null;
}

export interface WclFight {
  id: number;
  name: string | null;
  encounterID: number | null;
  difficulty: number | null;
  keystoneLevel: number | null;
  kill: boolean | null;
  fightPercentage: number | null;
  startTime: number;
  endTime: number;
}

export interface WclReportMeta {
  code: string;
  title: string | null;
  startTime: number;
  endTime: number;
  zone: { id: number | null; name: string | null } | null;
  region: { slug: string | null } | null;
  owner: { name: string | null } | null;
  fights: WclFight[];
  masterData: { actors: WclActor[] } | null;
}

export interface ReportMetaResponse {
  reportData: { report: WclReportMeta | null };
}

/**
 * A single combat-log event. The WCL `events.data` field is an untyped JSON array;
 * every event has a `timestamp` and `type`, and most have these common fields.
 * Anything not promoted here is preserved in fight_events.raw.
 */
export interface WclEvent {
  timestamp: number;
  type: string;
  sourceID?: number;
  targetID?: number;
  abilityGameID?: number;
  amount?: number;
  hitType?: number;
  [key: string]: unknown;
}

export interface FightEventsResponse {
  reportData: {
    report: {
      events: { data: WclEvent[] | null; nextPageTimestamp: number | null } | null;
    } | null;
  };
}

export interface UserReportSummary {
  code: string;
  title: string | null;
  startTime: number;
  endTime: number;
  zone: { id: number | null; name: string | null } | null;
}

export interface UserReportsResponse {
  reportData: {
    reports: {
      total: number;
      per_page: number;
      current_page: number;
      has_more_pages: boolean;
      data: UserReportSummary[];
    } | null;
  };
}
