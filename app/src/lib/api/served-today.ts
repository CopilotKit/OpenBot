/**
 * Where today's server answers the API's operations, until it answers them at /api/v2.
 *
 * WHY THIS EXISTS. api/openapi.yaml is the contract every client is generated from, and its addresses
 * are the API's: `/api/v2/organizations/{organizationId}/bots`. The server still answers the Bots
 * routes it always has, at `/api/agents`, with the same Bot in an envelope named after it
 * (`{ agents }`, `{ agent }`). Until the server answers at the API's addresses, the generated client
 * reaches it through this table.
 *
 * WHAT IT DOES. Rewrites the address and renames the envelope. Nothing else: the Bot itself is the
 * same object either way (api/openapi.yaml's `Bot` is exactly what `/api/agents` returns), a refusal
 * is read the same way (`clientRequest` takes `error` or `detail`), and today's server returns every
 * Bot on one page, so a list answers `nextCursor: null`.
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

const BOTS =
  /^\/api\/v2\/organizations\/[^/?]+\/bots(?:\/([^/?]+))?\/?(?:\?(.*))?$/;

type Envelope = { agents?: unknown; agent?: unknown; sharedApps?: unknown };

/**
 * Whether the table is consulted at all. Always on in the app. A test that drives a screen against
 * the spec's own mock server (the generated MSW handlers) turns it off, to talk to the API as the
 * server will serve it, and back on when it is done.
 */
export const todayRoutes = { on: true };

export function servedToday(url: string, method = "GET"): Route | undefined {
  if (!todayRoutes.on) return undefined;
  const match = BOTS.exec(url);
  if (!match) return undefined;
  const [, botId, query] = match;
  const verb = method.toUpperCase();

  if (botId === undefined) {
    if (verb === "GET") {
      // `cursor` and `limit` have nothing to do here: the whole list comes back on the first page.
      const hidden = new URLSearchParams(query).get("hidden") === "true";
      return {
        path: `/api/agents${hidden ? "?hidden=true" : ""}`,
        answer: (body) => ({
          bots: (body as Envelope).agents,
          nextCursor: null,
        }),
      };
    }
    if (verb === "POST") {
      return {
        path: "/api/agents",
        answer: (body) => ({ bot: (body as Envelope).agent }),
      };
    }
    return undefined;
  }

  // Still encoded as the generated client wrote it, so an id stays one path segment.
  const path = `/api/agents/${botId}`;
  if (verb === "GET" || verb === "DELETE") {
    return { path, answer: (body) => ({ bot: (body as Envelope).agent }) };
  }
  if (verb === "PATCH") {
    return {
      path,
      answer: (body) => {
        const { agent, sharedApps } = body as Envelope;
        return { bot: agent, ...(sharedApps ? { sharedApps } : {}) };
      },
    };
  }
  return undefined;
}
