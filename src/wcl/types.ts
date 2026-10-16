/** Response/data shapes for the WCL queries in queries.ts. */

export interface WclActor {
  id: number;
  /** Creature id for NPCs, spell id for some pets, 0 for players. */
  gameID: number | null;
  /** Owning actor id for pets. */
  petOwner: number | null;
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
  sourceInstance?: number;
  targetInstance?: number;
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

/** One actor's health series from the Resources graph (abilityID 1000 = Health). */
export interface WclHealthSeries {
  name: string;
  /** Actor id; a series covers every instance of that actor. */
  id: number;
  guid: number | null;
  type: string | null;
  /** [timestamp (report-relative ms), health percent] pairs. */
  data: Array<[number, number]>;
  /** Absolute hit points, parallel to data. */
  currentValues?: number[];
  /** Absolute max hit points, parallel to data. */
  maxValues?: number[];
}

export interface FightHealthResponse {
  reportData: {
    report: {
      /** The `graph` field is untyped JSON; null-ish when the fight has no health data. */
      graph: { data?: { series?: WclHealthSeries[] } } | null;
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

export interface CurrentUserResponse {
  userData: {
    currentUser: { id: number; name: string } | null;
  };
}
