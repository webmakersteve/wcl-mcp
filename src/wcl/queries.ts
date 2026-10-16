/**
 * GraphQL query strings for the Warcraft Logs v2 API (the `/api/v2/client` endpoint).
 * Field selections kept intentionally lean — just what the seed tables need.
 */

/**
 * Report header + fight list + player master data.
 * Used by download_report to populate report_details, fights, and actors.
 */
export const REPORT_META_QUERY = /* GraphQL */ `
  query ReportMeta($code: String!) {
    reportData {
      report(code: $code) {
        code
        title
        startTime
        endTime
        zone {
          id
          name
        }
        region {
          slug
        }
        owner {
          name
        }
        fights(killType: All) {
          id
          name
          encounterID
          difficulty
          keystoneLevel
          kill
          fightPercentage
          startTime
          endTime
        }
        masterData {
          actors {
            id
            gameID
            petOwner
            name
            type
            subType
            server
          }
        }
      }
    }
  }
`;

/**
 * One page of the full event stream for a single fight.
 * Paginate by re-issuing with startTime = nextPageTimestamp until it is null.
 */
export const FIGHT_EVENTS_QUERY = /* GraphQL */ `
  query FightEvents(
    $code: String!
    $fightID: Int!
    $startTime: Float!
    $endTime: Float!
    $limit: Int!
  ) {
    reportData {
      report(code: $code) {
        events(
          fightIDs: [$fightID]
          startTime: $startTime
          endTime: $endTime
          dataType: All
          limit: $limit
          includeResources: false
        ) {
          data
          nextPageTimestamp
        }
      }
    }
  }
`;

/**
 * List reports uploaded by a given user, optionally filtered by zone and time range.
 * Used by find_reports.
 */
export const USER_REPORTS_QUERY = /* GraphQL */ `
  query UserReports(
    $userID: Int!
    $zoneID: Int
    $startTime: Float
    $endTime: Float
    $limit: Int!
    $page: Int!
  ) {
    reportData {
      reports(
        userID: $userID
        zoneID: $zoneID
        startTime: $startTime
        endTime: $endTime
        limit: $limit
        page: $page
      ) {
        total
        per_page
        current_page
        has_more_pages
        data {
          code
          title
          startTime
          endTime
          zone {
            id
            name
          }
        }
      }
    }
  }
`;

/** The logged-in user (only valid against /api/v2/user with a user token). */
export const CURRENT_USER_QUERY = /* GraphQL */ `
  query CurrentUser {
    userData {
      currentUser {
        id
        name
      }
    }
  }
`;
