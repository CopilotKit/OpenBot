import { afterEach, describe, expect, test } from "bun:test";
import { listTools, useArcadeClient } from "../src/plugins/arcade";
import { createArcadeClient } from "../src/plugins/arcade-adapter";
import type { AccountRef } from "../src/plugins/shared-accounts";

/**
 * EVERY "Arcade did not answer with a list" SENTENCE, AGAINST A REAL HTTP ENGINE.
 *
 * These guards cannot be tested in the style of the rest of the adapter suite, which stubs the
 * SDK's resource PROTOTYPES and so decides for itself what the adapter is handed. The defect they
 * exist for lives BETWEEN the wire and the adapter: `OffsetPage`'s constructor does
 * `this.items = body.items || []`, so an answer that carries no `items` at all reaches a reader of
 * the PAGE OBJECT as an empty array — a malformed listing wearing an empty one's clothes. A stub
 * that hands the adapter its own object never manufactures that default, so a test in that style
 * passes whether the guard reads the page or the body it was built from.
 *
 * So, as in `arcade-pagination-engine.test.ts`, the engine here serves real JSON over a real socket
 * through `ARCADE_BASE_URL` and the SDK builds its own pages.
 *
 * TWO UNREADABLE BODIES, NOT ONE, because they reach the guard down DIFFERENT routes and only the
 * first was ever covered:
 *
 * - `{"error": "nope"}` — a well-formed JSON object, 200, with no `items`: what an engine
 *   answering an error shape on the success path sends. The SDK parses it, so the page's `body` IS
 *   a record and the guard reads a real body that simply has no list on it.
 * - `<html><body>OK</body></html>` with `content-type: text/html` and a 200 — a proxy's courtesy
 *   page wearing a real answer's status. `defaultParseResponse` hands a STRING to the page
 *   constructor, so there is no record to read anywhere; the honest body is unreadable and the only
 *   `items` in existence are the ones `OffsetPage`'s constructor manufactured. A reader that falls
 *   back to the page object for want of a record therefore answers `[]` — "the vendor says there
 *   are none" — for a body it never read, and `revoke` returns `false` with no DELETE spent. That
 *   is the live defect, reached through the branch the JSON case above can never enter.
 */

const account: AccountRef = {
  holder: "person",
  userId: "u1",
  vendorUserId: "vendor-u1",
};

/** Which of the three listings answers the malformed body, or none of them. */
type Malformed = "tools" | "connections" | "authProviders" | "none";

/** WHICH unreadable body that listing answers with. See this file's opening note. */
type Unreadable = "json-without-items" | "not-json";

type Engine = { port: number; stop: () => void };

const MALFORMED = { error: "nope" };

/** The unreadable answer, served with the 200 of a real one either way. */
const unreadable = (kind: Unreadable): Response =>
  kind === "json-without-items"
    ? Response.json(MALFORMED)
    : new Response("<html><body>OK</body></html>", {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      });

/** A live connection row held under the `google-openbot` INSTANCE of the `google` provider. */
const connectionRow = () => ({
  id: "at_0",
  connection_id: "ac_0",
  connection_status: "active",
  provider_id: "google-openbot",
  provider_type: "oauth2",
  provider_user_info: { name: "person 0" },
  scopes: [],
  user_id: account.vendorUserId,
});

const toolRow = (toolkit: string) => ({
  qualified_name: `${toolkit}.Action0`,
  description: "",
  toolkit: { name: toolkit, description: "" },
  input: { parameters: [] },
  requirements: {
    authorization: { provider_id: "google", oauth2: { scopes: [] } },
  },
});

function startEngine(malformed: Malformed, kind: Unreadable): Engine {
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      const limit = Number(url.searchParams.get("limit") ?? "100");
      const offset = Number(url.searchParams.get("offset") ?? "0");

      // The DELETE, always available, so "no DELETE was spent" is a statement about the adapter.
      if (url.pathname.startsWith("/v1/admin/user_connections/")) {
        return new Response(null, { status: 204 });
      }

      if (url.pathname === "/v1/admin/user_connections") {
        if (malformed === "connections") return unreadable(kind);
        const items =
          malformed === "none" && offset === 0 ? [connectionRow()] : [];
        return Response.json({
          items,
          offset,
          limit,
          page_count: items.length,
        });
      }
      if (url.pathname === "/v1/admin/auth_providers") {
        if (malformed === "authProviders") return unreadable(kind);
        return Response.json({
          items: [
            { id: "google-openbot", provider_id: "google", type: "oauth2" },
          ],
          offset: 0,
          limit,
          page_count: 1,
          total_count: 1,
        });
      }
      if (url.pathname === "/v1/tools") {
        if (malformed === "tools") return unreadable(kind);
        const toolkit = url.searchParams.get("toolkit") ?? "Gmail";
        const page = offset === 0 ? [toolRow(toolkit)] : [];
        return Response.json({
          items: page,
          offset,
          limit,
          page_count: page.length,
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  // `Bun.serve().port` is `number | undefined`. Refuse loudly rather than coercing: a stub that
  // never bound a port would send every request of this file to a nonsense address, and the
  // refusals below would then "hold" because nothing reached a vendor at all.
  const { port } = server;
  if (port === undefined)
    throw new Error("the stub vendor did not bind a port");
  return { port, stop: () => server.stop(true) };
}

let running: Engine | null = null;
const wasBaseURL = process.env.ARCADE_BASE_URL;

function engine(
  malformed: Malformed,
  kind: Unreadable = "json-without-items",
): void {
  running = startEngine(malformed, kind);
  process.env.ARCADE_BASE_URL = `http://localhost:${running.port}`;
}

afterEach(() => {
  running?.stop();
  running = null;
  useArcadeClient(null);
  if (wasBaseURL === undefined) delete process.env.ARCADE_BASE_URL;
  else process.env.ARCADE_BASE_URL = wasBaseURL;
});

describe("a listing with no items refuses rather than reading as empty", () => {
  test("listApps refuses a tool listing that is not a list", async () => {
    engine("tools");
    const { broker } = createArcadeClient("never-dialled");

    await expect(broker.listApps()).rejects.toThrow(
      /Arcade did not answer with a tool list/,
    );
  });

  test("grantsFor refuses a tool listing that is not a list", async () => {
    engine("tools");
    const { broker } = createArcadeClient("never-dialled");

    await expect(
      broker.grantsFor({ account, toolkit: "Gmail" }),
    ).rejects.toThrow(/Arcade did not answer with an action list for Gmail/);
  });

  test("isConnected refuses a tool listing that is not a list", async () => {
    // Through `authProviderOf`, the one unpaged listing in the adapter.
    engine("tools");
    const { broker } = createArcadeClient("never-dialled");

    await expect(
      broker.isConnected({ account, toolkit: "Gmail" }),
    ).rejects.toThrow(
      /Arcade did not answer with an action list for Gmail, so the auth provider/,
    );
  });

  test("the transport refuses a tool listing that is not a list", async () => {
    engine("tools");
    const { actions } = createArcadeClient("never-dialled");
    useArcadeClient(actions);

    await expect(listTools({ url: "arcade://Gmail" })).rejects.toThrow(
      /Arcade did not answer with an action list for Gmail\. Nothing was refreshed/,
    );
  });

  test("isConnected refuses an auth-provider listing that is not a list", async () => {
    engine("authProviders");
    const { broker } = createArcadeClient("never-dialled");

    await expect(
      broker.isConnected({ account, toolkit: "Gmail" }),
    ).rejects.toThrow(/Arcade did not answer with an auth-provider list/);
  });

  test("isConnected refuses a connection listing that is not a list", async () => {
    engine("connections");
    const { broker } = createArcadeClient("never-dialled");

    await expect(
      broker.isConnected({ account, toolkit: "Gmail" }),
    ).rejects.toThrow(/Arcade did not answer with a connection list/);
  });

  test("revoke refuses a connection listing that is not a list", async () => {
    engine("connections");
    const { broker } = createArcadeClient("never-dialled");

    await expect(broker.revoke({ account, toolkit: "Gmail" })).rejects.toThrow(
      /Arcade did not answer with a connection list/,
    );
  });
});

/**
 * THE SAME SENTENCES, OFF A BODY THAT IS NOT JSON AT ALL.
 *
 * Every case above serves a body the SDK successfully PARSES, so the page carries a readable
 * record and a reader that takes the page's own `items` when it finds no record never has to
 * decide anything. A non-JSON 200 is the branch where that decision is actually made: the parsed
 * body is a STRING, no record exists, and `OffsetPage`'s manufactured `items: []` is the only list
 * on the object. The rule these pin is that AN UNREADABLE BODY IS NOT AN EMPTY PAGE — it refuses
 * in the same sentence a body with no `items` refuses in, because the two are the same fact about
 * what this deployment was told.
 */
describe("a listing whose body is not JSON refuses rather than reading as empty", () => {
  test("listApps refuses a non-JSON tool listing", async () => {
    engine("tools", "not-json");
    const { broker } = createArcadeClient("never-dialled");

    await expect(broker.listApps()).rejects.toThrow(
      /Arcade did not answer with a tool list/,
    );
  });

  test("the transport refuses a non-JSON tool listing", async () => {
    engine("tools", "not-json");
    const { actions } = createArcadeClient("never-dialled");
    useArcadeClient(actions);

    await expect(listTools({ url: "arcade://Gmail" })).rejects.toThrow(
      /Arcade did not answer with an action list for Gmail\. Nothing was refreshed/,
    );
  });

  test("isConnected refuses a non-JSON auth-provider listing", async () => {
    engine("authProviders", "not-json");
    const { broker } = createArcadeClient("never-dialled");

    await expect(
      broker.isConnected({ account, toolkit: "Gmail" }),
    ).rejects.toThrow(/Arcade did not answer with an auth-provider list/);
  });

  test("isConnected refuses a non-JSON connection listing", async () => {
    engine("connections", "not-json");
    const { broker } = createArcadeClient("never-dialled");

    await expect(
      broker.isConnected({ account, toolkit: "Gmail" }),
    ).rejects.toThrow(/Arcade did not answer with a connection list/);
  });

  test("revoke refuses a non-JSON connection listing rather than answering false", async () => {
    // THE LIVE DEFECT'S EXACT SIGNATURE: `false` with no DELETE spent, while the caller deletes
    // the local row anyway and a live grant at the vendor is left with nothing naming it.
    engine("connections", "not-json");
    const { broker } = createArcadeClient("never-dialled");

    await expect(broker.revoke({ account, toolkit: "Gmail" })).rejects.toThrow(
      /Arcade did not answer with a connection list/,
    );
  });
});

/**
 * THE COMPATIBILITY CASE THE PAGE FALLBACK EXISTS FOR, PINNED SO IT CANNOT BE DELETED WITH IT.
 *
 * `admin.authProviders.list` returns a plain `APIPromise<AuthProviderListResponse>` — the parsed
 * body ITSELF, never a page — so it has no `body` property to read through and its own properties
 * are the honest ones. Nothing was manufactured for it, so reading it directly is not a guess.
 * `authProviderInstances` is the only reader of it, and `isConnected` answering TRUE here is the
 * whole chain saying so: the `google` type resolved to the `google-openbot` INSTANCE off that
 * body, and the connection row matched it.
 */
describe("a listing that is its own body is still read", () => {
  test("isConnected reads the auth-provider configuration off a plain APIPromise", async () => {
    engine("none");
    const { broker } = createArcadeClient("never-dialled");

    expect(await broker.isConnected({ account, toolkit: "Gmail" })).toBe(true);
  });
});
