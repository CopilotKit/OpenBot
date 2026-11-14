/**
 * The Bots API as the server answers it, for a test that fakes `fetch` by hand.
 *
 * The app lists, reads, creates, changes and deletes Bots through the client generated from
 * api/openapi.yaml, at `/api/v2/organizations/default/bots`. A list comes back as
 * `{ bots, nextCursor }`, one Bot as `{ bot }`, and a delete as 204 with no body. Everything else
 * about a Bot (hide, pin, handoff, duplicate, its callback token) is still at `/api/agents/{id}`.
 */

/**
 * The Response a real `fetch` returns. Read before any test registers happy-dom, as each test file
 * that needs it does at its top.
 */
const NativeResponse = globalThis.Response;

/** Where the app sends the Bots operations: the API's address in the one organization. */
export const BOTS_PATH = "/api/v2/organizations/default/bots";

/** One Bot's address in the API, written as the generated client writes it. */
export function botPath(botId: string): string {
  return `${BOTS_PATH}/${encodeURIComponent(botId)}`;
}

/**
 * The server's answer to the app's request for the Bots list, or undefined for any other request.
 *
 * Today's server returns every Bot on the first page, whatever `limit` asks for, so the answer
 * always ends the list. `hidden=true` lists the Bots hidden from the list instead.
 */
export function answerBotsList(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  bots: { visible: readonly unknown[]; hidden?: readonly unknown[] },
): Response | undefined {
  const url = new URL(String(input), "http://openbot.invalid");
  if (url.pathname !== BOTS_PATH) return undefined;
  if ((init?.method ?? "GET").toUpperCase() !== "GET") return undefined;
  const hidden = url.searchParams.get("hidden") === "true";
  return NativeResponse.json({
    bots: hidden ? (bots.hidden ?? []) : bots.visible,
    nextCursor: null,
  });
}
