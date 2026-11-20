/**
 * Routines, check-ins and goals as the server answers them, for a test that fakes `fetch` by hand.
 *
 * The app reads and writes them through the client generated from api/openapi.yaml, under
 * `/api/v2/organizations/default`: `routines`, `check-ins`, `check-in-items`, `check-in-usage`,
 * `goals` (with each goal's `runs` and `triggers`) and `github-event-sources`. A list comes back as
 * its items under the resource's name with `nextCursor`, and is asked for with `limit` and, past the
 * first page, `cursor`. A request to one of the addresses these lived at before matches nothing
 * here, so a caller that slips back to one is not answered.
 */

/**
 * The Response a real `fetch` returns. Read before any test registers happy-dom, as each test file
 * that needs it does at its top.
 */
const NativeResponse = globalThis.Response;

/** The one organization's address in the API. */
export const ORGANIZATION_PATH = "/api/v2/organizations/default";

export const ROUTINES_PATH = `${ORGANIZATION_PATH}/routines`;
export const CHECK_INS_PATH = `${ORGANIZATION_PATH}/check-ins`;
export const CHECK_IN_ITEMS_PATH = `${ORGANIZATION_PATH}/check-in-items`;
export const CHECK_IN_USAGE_PATH = `${ORGANIZATION_PATH}/check-in-usage`;
export const GOALS_PATH = `${ORGANIZATION_PATH}/goals`;
export const GITHUB_EVENT_SOURCES_PATH = `${ORGANIZATION_PATH}/github-event-sources`;

/** The address a request was sent to, without its query: a list is asked for with `limit`. */
export function pathOf(input: RequestInfo | URL): string {
  return new URL(
    input instanceof Request ? input.url : String(input),
    "http://openbot.invalid",
  ).pathname;
}

/** A routine's runs, as the app asks for them. */
export function routineRunsPath(routineId: string): string {
  return `${ROUTINES_PATH}/${encodeURIComponent(routineId)}/runs`;
}

/** A goal's runs, as the app asks for them. */
export function goalRunsPath(goalId: string): string {
  return `${GOALS_PATH}/${encodeURIComponent(goalId)}/runs`;
}

/** A goal's triggers, as the app asks for them. */
export function goalTriggersPath(goalId: string): string {
  return `${GOALS_PATH}/${encodeURIComponent(goalId)}/triggers`;
}

/** What a test's server holds. Anything left out is an empty list. */
export type ScheduleLists = {
  routines?: readonly unknown[];
  checkIns?: readonly unknown[];
  /** Whether an admin lets this person's Bots check in. True unless said otherwise. */
  allowed?: boolean;
  checkInItems?: readonly unknown[];
  goals?: readonly unknown[];
  githubEventSources?: readonly unknown[];
};

/**
 * The server's answer to the app's request for one of these lists, or undefined for any other
 * request. Every item is on the first page, whatever `limit` asks for, so the answer ends the list.
 */
export function answerScheduleLists(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  lists: ScheduleLists = {},
): Response | undefined {
  if ((init?.method ?? "GET").toUpperCase() !== "GET") return undefined;
  const path = pathOf(input);
  if (path === ROUTINES_PATH)
    return NativeResponse.json({
      routines: lists.routines ?? [],
      nextCursor: null,
    });
  if (path === CHECK_INS_PATH)
    return NativeResponse.json({
      checkIns: lists.checkIns ?? [],
      allowed: lists.allowed ?? true,
      nextCursor: null,
    });
  if (path === CHECK_IN_ITEMS_PATH)
    return NativeResponse.json({
      checkInItems: lists.checkInItems ?? [],
      nextCursor: null,
    });
  if (path === GOALS_PATH)
    return NativeResponse.json({ goals: lists.goals ?? [], nextCursor: null });
  if (path === GITHUB_EVENT_SOURCES_PATH)
    return NativeResponse.json({
      githubEventSources: lists.githubEventSources ?? [],
      nextCursor: null,
    });
  return undefined;
}
