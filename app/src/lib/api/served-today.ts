/**
 * Where today's server answers the API's operations, until it answers them at /api/v2.
 *
 * WHY THIS EXISTS. api/openapi.yaml is the contract every client is generated from, and its addresses
 * are the API's, under `/api/v2/organizations/{organizationId}/`. Where the server does not answer an
 * operation there yet, the generated client reaches it through this table. The Bots operations are
 * answered at their API addresses now and are not here; a conversation's reactions still are.
 *
 * WHAT IT DOES. Rewrites the address and puts the answer in the API's shape. Nothing else: a refusal
 * is read the same way (`clientRequest` takes `error` or `detail`), and a list today's server returns
 * on one page answers `nextCursor: null`.
 *
 * WHEN IT GOES. Delete an entry when the server answers that operation at its API address, and this
 * file with the last one. An operation not listed here is sent to the address the spec gives it.
 */

type Route = {
  /** Where today's server answers it. */
  path: string;
  /** Today's answer, in the API's shape. */
  answer: (body: unknown) => unknown;
};

/**
 * Whether the table is consulted at all. Always on in the app. A test that drives a screen against
 * the spec's own mock server (the generated MSW handlers) turns it off, to talk to the API as the
 * server will serve it, and back on when it is done.
 */
export const todayRoutes = { on: true };

const REACTIONS = /^\/api\/v2\/organizations\/[^/?]+\/reactions\/?(?:\?(.*))?$/;

/**
 * A conversation's reactions, which today's server answers at `/api/tasks/reactions/{threadId}`,
 * every one on the first page.
 */
function reactionsToday(url: string, method: string): Route | undefined {
  const match = REACTIONS.exec(url);
  if (!match || method.toUpperCase() !== "GET") return undefined;
  const threadId = new URLSearchParams(match[1]).get("threadId");
  if (!threadId) return undefined;
  return {
    path: `/api/tasks/reactions/${encodeURIComponent(threadId)}`,
    answer: (body) => ({
      reactions: (body as { reactions?: unknown }).reactions ?? [],
      nextCursor: null,
    }),
  };
}

export function servedToday(url: string, method = "GET"): Route | undefined {
  if (!todayRoutes.on) return undefined;
  return reactionsToday(url, method);
}
