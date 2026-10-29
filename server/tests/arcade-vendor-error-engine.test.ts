// server/tests/arcade-vendor-error-engine.test.ts
/**
 * WHAT A REFUSAL FROM ARCADE LOOKS LIKE BY THE TIME SOMEBODY READS IT.
 *
 * Two properties, measured on every door the adapter opens to the vendor:
 *
 * 1. WHAT IS THROWN IS AN `Error`. A bare object has no `message` and no stack, and
 *    `reasonWithoutStatement` — the one door every log line in `routes.ts` copies a reason through
 *    — answers `String(thrown)` for a non-`Error`, which is the literal text `[object Object]`.
 *    The one log line written at the moment a tool call failed then carries no information at all.
 *
 * 2. NOTHING THE VENDOR WROTE IS IN IT. The SDK's `APIError` builds its own `message` as
 *    `${status} ${body.message ?? JSON.stringify(body)}` (`core/error.js`, `makeMessage`), so an
 *    `APIError` left to escape puts the vendor's response body — which on this vendor's auth paths
 *    can carry a bearer url — into whatever log, admin page or error answer quotes the message.
 *    This PR's second subject claim is that such a thing never reaches a log, an error body, an
 *    audit row or a model, so the vendor's words stop at this adapter and this deployment's own
 *    sentence goes on from there.
 *
 * AND THE DEPENDENTS OF THE REFUSAL STILL WORK, which is the other half of the same test: the
 * normalized `status` that `routes.ts` keys its discard-or-keep decision on, the body's `error.name`
 * that `callTool` keys the authorize prompt on, and the `user_mismatch` answer `confirmReturn`
 * reads, are all still reachable through `normalizeArcadeError`.
 *
 * SERVED OVER A REAL SOCKET, as `arcade-pagination-engine.test.ts` is and for its reason: the rest
 * of the adapter suite stubs SDK resource PROTOTYPES, which hands the adapter a hand-built
 * rejection rather than the error the SDK itself builds out of a real response — and the error the
 * SDK builds is the whole subject here.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { reasonWithoutStatement } from "../src/db/query-failure";
import { callTool, useArcadeClient } from "../src/plugins/arcade";
import {
  createArcadeClient,
  normalizeArcadeError,
} from "../src/plugins/arcade-adapter";
import type { AccountRef } from "../src/plugins/shared-accounts";

const account: AccountRef = {
  holder: "person",
  userId: "u1",
  vendorUserId: "vendor-u1",
};

/** A bearer capability in the vendor's prose: whoever reads it can attach an account. */
const BEARER =
  "https://cloud.arcade.dev/auth/callback?flow=flow-abc&secret=SECRET-BEARER-f00d";
/** The vendor's own sentence, which this deployment never repeats. */
const VENDOR_PROSE = `tool not authorized; send the person to ${BEARER}`;

type Engine = { port: number; requests: string[]; stop: () => void };

/**
 * Every endpoint the adapter can reach, refusing with 403 and Arcade's own body shape
 * (`{ name, message }` — the shape `normalizeArcadeError` reads). 403 and not 500: the SDK retries
 * 5xx twice with backoff, and nothing here is about retries.
 */
function startEngine(): Engine {
  const requests: string[] = [];
  const refusal = () =>
    Response.json(
      { name: "tool_authorization_required", message: VENDOR_PROSE },
      { status: 403 },
    );
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      requests.push(url.pathname);
      return refusal();
    },
  });
  // `Bun.serve().port` is `number | undefined`; refuse loudly rather than coerce, as
  // `arcade-revoke-invariant.test.ts` does.
  const { port } = server;
  if (port === undefined)
    throw new Error("the stub vendor did not bind a port");
  return { port, requests, stop: () => server.stop(true) };
}

let running: Engine | null = null;
const wasBaseURL = process.env.ARCADE_BASE_URL;

function engine(): Engine {
  running = startEngine();
  process.env.ARCADE_BASE_URL = `http://localhost:${running.port}`;
  return running;
}

afterEach(() => {
  running?.stop();
  running = null;
  useArcadeClient(null);
  if (wasBaseURL === undefined) delete process.env.ARCADE_BASE_URL;
  else process.env.ARCADE_BASE_URL = wasBaseURL;
});

/** What a log line would carry, read through the door every log line in `routes.ts` reads through. */
const asLogged = (thrown: unknown): string => reasonWithoutStatement(thrown);

async function refusalFrom(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error("the engine refused and the adapter did not.");
}

describe("a refusal from Arcade is an Error this deployment wrote", () => {
  const doors: [
    string,
    (c: ReturnType<typeof createArcadeClient>) => Promise<unknown>,
  ][] = [
    [
      "execute",
      ({ actions }) =>
        actions.execute({
          tool_name: "Gmail.SendEmail",
          input: {},
          user_id: account.vendorUserId,
        }),
    ],
    [
      "listTools",
      ({ actions }) =>
        actions.listTools({ toolkit: "Gmail", limit: 100, offset: 0 }),
    ],
    ["listApps", ({ broker }) => broker.listApps()],
    [
      "authorize",
      ({ broker }) =>
        broker.authorize({
          account,
          toolkit: "Gmail",
          returnUrl: "https://openbot.test/return",
          action: "Gmail.SendEmail",
        }),
    ],
    [
      "isConnected",
      ({ broker }) => broker.isConnected({ account, toolkit: "Gmail" }),
    ],
    [
      "accountName",
      ({ broker }) => broker.accountName({ account, toolkit: "Gmail" }),
    ],
    ["revoke", ({ broker }) => broker.revoke({ account, toolkit: "Gmail" })],
    ["revokeAccount", ({ broker }) => broker.revokeAccount("ac_1")],
    [
      "grantsFor",
      ({ broker }) => broker.grantsFor({ account, toolkit: "Gmail" }),
    ],
    ["authProviderOf", ({ broker }) => broker.authProviderOf("Gmail")],
    [
      "authorizations.status",
      ({ broker }) =>
        broker.authorizations?.status("ar_1") ??
        Promise.reject(new Error("no status member")),
    ],
    [
      "authorizations.confirmReturn",
      ({ broker }) =>
        broker.authorizations?.confirmReturn({
          handle: "flow-abc",
          vendorUserId: account.vendorUserId,
        }) ?? Promise.reject(new Error("no confirmReturn member")),
    ],
  ];

  for (const [door, call] of doors) {
    test(`${door} throws an Error carrying no vendor words`, async () => {
      engine();
      const client = createArcadeClient("never-dialled");
      const thrown = await refusalFrom(() => call(client));

      // 1. AN `Error`, so a log line has something to say.
      expect(thrown).toBeInstanceOf(Error);
      expect(asLogged(thrown)).not.toBe("[object Object]");
      expect(asLogged(thrown).length).toBeGreaterThan(0);

      // 2. NOTHING THE VENDOR WROTE, at any depth a reader can reach.
      expect(asLogged(thrown)).not.toContain(BEARER);
      expect(asLogged(thrown)).not.toContain(VENDOR_PROSE);
      expect(
        JSON.stringify(thrown, Object.keys(thrown as object)),
      ).not.toContain("SECRET-BEARER");
      let cause: unknown = (thrown as { cause?: unknown }).cause;
      for (let depth = 0; depth < 8 && cause !== undefined; depth += 1) {
        expect(asLogged(cause)).not.toContain(BEARER);
        cause = (cause as { cause?: unknown }).cause;
      }

      // 3. AND THE STATUS `routes.ts` KEYS ITS DECISION ON IS STILL READABLE: an answered status is
      //    what tells a definite refusal from a connection that may have started a flow.
      expect(normalizeArcadeError(thrown)?.status).toBe(403);
    });
  }

  test("the body's error.name still reaches callTool's authorize sentence", async () => {
    engine();
    const { actions } = createArcadeClient("never-dialled");
    useArcadeClient(actions);

    const result = await callTool(
      { url: "arcade://Gmail", actorId: account.vendorUserId },
      "Gmail.SendEmail",
      {},
    );
    expect(result.isError).toBe(true);
    expect(result.text).toBe(
      "Gmail.SendEmail has not been authorized on this account yet. Authorize it in Connections and ask again.",
    );
    // AND THE VENDOR'S WORDS ARE NOT IN WHAT A MODEL IS HANDED.
    expect(result.text).not.toContain(BEARER);
  });
});
