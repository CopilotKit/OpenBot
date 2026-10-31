import { afterEach, describe, expect, test } from "bun:test";
import { listTools, useArcadeClient } from "../src/plugins/arcade";
import { createArcadeClient } from "../src/plugins/arcade-adapter";
import type { AccountRef } from "../src/plugins/shared-accounts";

/**
 * THE ADAPTER AGAINST A REAL HTTP ENGINE, BECAUSE NOTHING LESS CAN SEE THIS CLASS OF DEFECT.
 *
 * The rest of the adapter suite stubs the SDK's resource PROTOTYPES and hands the adapter a bare
 * async generator in place of a `PagePromise`. That substitution is exactly what hides the bug this
 * file is about: the real `OffsetPage` constructor does `this.total_count = body.total_count || 0`
 * and `nextPageRequestOptions()` returns `null` on a falsy total, so an engine that OMITS
 * `total_count` ends the SDK's own auto-pagination after page one AND disables every
 * `seen < total` cross-check — while a hand-written generator paginates perfectly and reports
 * whatever total the fixture chose to carry.
 *
 * So these tests serve real JSON over a real socket through `ARCADE_BASE_URL` and let the SDK build
 * its own pages. `new Arcade({ apiKey })` reads that variable at construction, which is why the
 * server is started BEFORE `createArcadeClient`.
 */

const account: AccountRef = {
  holder: "person",
  userId: "u1",
  vendorUserId: "vendor-u1",
};

type EngineOptions = {
  /** How many connection rows the engine holds. */
  connections: number;
  /** Send `total_count` on the connection listing at all? */
  connectionTotal: boolean;
  /** Serve this many connection rows and no more, while still reporting the full `total_count`. */
  connectionTruncateAt?: number;
  /**
   * The `connection_status` each row carries, row by row: a string is sent verbatim, `null` OMITS
   * the field as the wire may (the SDK declares it optional), and a row this does not reach carries
   * the live `"active"` the live API answers with.
   */
  connectionStatuses?: (string | null)[];
  /**
   * ANSWER EVERY CONNECTION PAGE FULL, FOREVER: no short page and no `total_count`, so nothing in
   * the answer ever says the listing is over. This is the engine a runaway guard exists for.
   */
  connectionsNeverEnd?: boolean;
  /** The toolkit listing claims this many actions... */
  toolsClaimed?: number;
  /** ...and serves only this many, dropping `total_count` from the short final page. */
  toolsServed?: number;
  /**
   * The `total_count` the toolkit listing reports on every page AFTER the first, when that differs
   * from the first page's claim — a vendor revising its count downward mid-listing.
   */
  toolsLaterTotal?: number;
  /**
   * How many auth-provider configurations the project holds. Only the LAST of them is the `google`
   * instance the connection rows are held under; the rest are filler of another type. Left unset,
   * the engine answers the single-config listing the other tests here want.
   */
  authProviders?: number;
  /**
   * The action listing DISAGREES WITH ITSELF ABOUT ITS AUTH PROVIDER from this index on: actions
   * before it carry `requirements.authorization.provider_id: "google"`, actions from here on carry
   * {@link toolLaterProvider}. Set past the first page, it is invisible to any reader that stops
   * at page one.
   */
  toolProviderSplitAt?: number;
  /** The provider id the actions from {@link toolProviderSplitAt} on carry. */
  toolLaterProvider?: string;
};

type Engine = {
  port: number;
  /** Every path+query the SDK asked for, in order. */
  requests: string[];
  stop: () => void;
};

const connectionRow = (n: number, status: string | null = "active") => ({
  id: `at_${n}`,
  connection_id: `ac_${n}`,
  // OMITTED when the engine says `null`, as the wire may omit it.
  ...(status === null ? {} : { connection_status: status }),
  // A provider INSTANCE id, never a provider type: see arcade-adapter-connections.test.ts.
  provider_id: "google-openbot",
  provider_type: "oauth2",
  provider_user_info: { name: `person ${n}` },
  scopes: [],
  user_id: account.vendorUserId,
});

const toolRow = (toolkit: string, n: number, provider = "google") => ({
  qualified_name: `${toolkit}.Action${n}`,
  description: "",
  toolkit: { name: toolkit, description: "" },
  input: { parameters: [] },
  requirements: {
    authorization: { provider_id: provider, oauth2: { scopes: [] } },
  },
});

/** The provider id action `n` of the listing carries, per {@link EngineOptions.toolProviderSplitAt}. */
function toolProviderOf(options: EngineOptions, n: number): string {
  const split = options.toolProviderSplitAt;
  if (split === undefined || n < split) return "google";
  return options.toolLaterProvider ?? "microsoft";
}

/**
 * The project's auth-provider configurations, with the ONE that matters LAST.
 *
 * `id` is the provider INSTANCE and `provider_id` the TYPE, as the live project spells them. The
 * filler carries type `github`, so a reader that stops before the end of this listing finds no
 * `google` instance at all and answers "not connected" for a person who is.
 */
const authProviderRows = (count: number) =>
  Array.from({ length: count }, (_, n) =>
    n === count - 1
      ? { id: "google-openbot", provider_id: "google", type: "oauth2" }
      : { id: `filler-${n}`, provider_id: "github", type: "oauth2" },
  );

function statusOf(options: EngineOptions, n: number): string | null {
  const listed = options.connectionStatuses?.[n];
  return listed === undefined ? "active" : listed;
}

function startEngine(options: EngineOptions): Engine {
  const requests: string[] = [];
  const rows = Array.from({ length: options.connections }, (_, n) =>
    // `undefined` (unlisted) is the live default; `null` means OMIT the field, so it is kept apart.
    connectionRow(n, statusOf(options, n)),
  );
  const served = options.connectionTruncateAt ?? rows.length;
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      requests.push(url.pathname + url.search);
      const offset = Number(url.searchParams.get("offset") ?? "0");
      const limit = Number(url.searchParams.get("limit") ?? "100");

      if (url.pathname.startsWith("/v1/admin/user_connections/")) {
        return new Response(null, { status: 204 });
      }
      if (url.pathname === "/v1/admin/user_connections") {
        if (options.connectionsNeverEnd) {
          return Response.json({
            items: Array.from({ length: limit }, (_, n) =>
              connectionRow(offset + n),
            ),
            offset,
            limit,
            page_count: limit,
          });
        }
        const page = rows.slice(offset, Math.min(offset + limit, served));
        const body: Record<string, unknown> = {
          items: page,
          offset,
          limit,
          page_count: page.length,
        };
        if (options.connectionTotal) body.total_count = rows.length;
        return Response.json(body);
      }
      if (url.pathname === "/v1/admin/auth_providers") {
        if (options.authProviders === undefined) {
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
        // PAGED, AND WITH NO `total_count`: a short page is the only thing that ends this listing,
        // so a reader that does not advance its own offset never reaches the last configuration.
        const page = authProviderRows(options.authProviders).slice(
          offset,
          offset + limit,
        );
        return Response.json({
          items: page,
          offset,
          limit,
          page_count: page.length,
        });
      }
      if (url.pathname === "/v1/tools") {
        const toolkit = url.searchParams.get("toolkit") ?? "Gmail";
        const claimed = options.toolsClaimed ?? 1;
        const toolsServed = options.toolsServed ?? claimed;
        const page: unknown[] = [];
        for (let n = offset; n < Math.min(offset + limit, toolsServed); n++) {
          page.push(toolRow(toolkit, n, toolProviderOf(options, n)));
        }
        const body: Record<string, unknown> = {
          items: page,
          offset,
          limit,
          page_count: page.length,
        };
        // The short final page DROPS the field — which is what defeats a cross-check that keeps
        // the LAST page's total rather than the highest one reported. A later page may also REVISE
        // the count downward, which defeats the same cross-check without dropping anything.
        if (page.length === limit) {
          body.total_count =
            offset === 0 ? claimed : (options.toolsLaterTotal ?? claimed);
        }
        return Response.json(body);
      }
      return new Response("not found", { status: 404 });
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

function engine(options: EngineOptions): Engine {
  running = startEngine(options);
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

const deletes = (e: Engine) =>
  e.requests.filter((r) => r.startsWith("/v1/admin/user_connections/"));

describe("the connection listing is read to its end, not to the SDK's", () => {
  test("revoke deletes every connection when the engine omits total_count", async () => {
    // 250 rows at a page size of 100: three pages, and NO `total_count` anywhere. The SDK's own
    // auto-pagination gives up after the first of them.
    const e = engine({ connections: 250, connectionTotal: false });
    const { broker } = createArcadeClient("never-dialled");

    expect(await broker.revoke({ account, toolkit: "Gmail" })).toBe(true);
    expect(deletes(e).length).toBe(250);
  });

  test("a truncated connection listing throws rather than reading as success or as nothing", async () => {
    // The engine reports 250 and serves 100: a short second page, which ends the listing, and a
    // `total_count` that says it should not have.
    const e = engine({
      connections: 250,
      connectionTotal: true,
      connectionTruncateAt: 100,
    });
    const { broker } = createArcadeClient("never-dialled");

    await expect(broker.revoke({ account, toolkit: "Gmail" })).rejects.toThrow(
      /listed 100 of 250 connections/,
    );
    await expect(
      broker.isConnected({ account, toolkit: "Gmail" }),
    ).rejects.toThrow(/listed 100 of 250 connections/);
    await expect(
      broker.accountName({ account, toolkit: "Gmail" }),
    ).rejects.toThrow(/listed 100 of 250 connections/);
    // NOT ONE DELETE WAS SPENT on a listing that could not be trusted to be the whole of it.
    expect(deletes(e).length).toBe(0);
  });
});

/**
 * A LISTING THAT NEVER SAYS IT IS OVER IS NOT A COMPLETE ONE, AND THE RUNAWAY GUARD IS WHAT SAYS SO.
 *
 * Every other test here reaches a short page eventually, so the `maxPages` bound and the sentence
 * behind it were never once reached: deleting the `unending` throw outright left the whole arcade
 * suite green. What the throw prevents is the worst reading of all — a listing cut off at the bound
 * presenting as the whole of itself, which is `isConnected` answering off an arbitrary 10,000-row
 * prefix and `revoke` reporting success having deleted a prefix of somebody's connections.
 *
 * Only a real engine can pose the question: the SDK's own pagination stops at page one here (no
 * `total_count`), and a hand-written generator ends when its fixture array does.
 */
describe("a listing that never ends is refused rather than cut off at the bound", () => {
  test("isConnected refuses a connection listing that answers full pages forever", async () => {
    const e = engine({
      connections: 0,
      connectionTotal: false,
      connectionsNeverEnd: true,
    });
    const { broker } = createArcadeClient("never-dialled");

    await expect(
      broker.isConnected({ account, toolkit: "Gmail" }),
    ).rejects.toThrow(/connection list never ended after 100 pages/);
    // The bound is a bound: it asked 100 times and stopped.
    expect(
      e.requests.filter((r) => r.startsWith("/v1/admin/user_connections?"))
        .length,
    ).toBe(100);
  });

  test("revoke spends no delete on a listing that never ended", async () => {
    const e = engine({
      connections: 0,
      connectionTotal: false,
      connectionsNeverEnd: true,
    });
    const { broker } = createArcadeClient("never-dialled");

    await expect(broker.revoke({ account, toolkit: "Gmail" })).rejects.toThrow(
      /connection list never ended after 100 pages/,
    );
    expect(deletes(e).length).toBe(0);
  });
});

/**
 * THE AUTH-PROVIDER LISTING IS PAGED TOO, AND ONLY A REAL ENGINE ASKS IT TO BE.
 *
 * This is the one listing whose paging parameters travel INSIDE a `query` wrapper
 * (`list({ query: { limit, offset } })`), and the one no test ever gave a second page: every
 * fixture and every engine here answered a single configuration. So freezing its offset at zero —
 * or sending no paging parameters at all — changed nothing any test could see, while on a project
 * holding more than 100 configurations it means every person connected under an instance past the
 * first page reads as not connected at all.
 */
describe("the auth-provider listing is read past its first page", () => {
  test("a connection held under an instance on the second page is still found", async () => {
    const e = engine({
      connections: 1,
      connectionTotal: false,
      // 150 configurations: a full page, then a short one carrying the `google` instance.
      authProviders: 150,
    });
    const { broker } = createArcadeClient("never-dialled");

    expect(await broker.isConnected({ account, toolkit: "Gmail" })).toBe(true);
    // Two pages were asked for, and the second one by offset — the SDK really does put the
    // wrapper's fields on the query string.
    expect(
      e.requests.filter((r) => r.startsWith("/v1/admin/auth_providers")),
    ).toEqual([
      "/v1/admin/auth_providers?limit=100&offset=0",
      "/v1/admin/auth_providers?limit=100&offset=100",
    ]);
  });
});

/**
 * `connection_status` IS THE ROW'S OWN ANSWER TO "IS THIS USABLE", AND THE POSITIVE READS TAKE IT.
 *
 * A row's EXISTENCE used to be the whole of the answer, so a connection the vendor was reporting as
 * no longer usable — expired, revoked at the provider, pending, failed — read as `isConnected: true`
 * with a name beside it, and the only way to find out was a tool call failing later with nothing on
 * the screen to explain it.
 *
 * The three cases below are the three halves of the design: a reported-dead row is not a connection,
 * a row the vendor said NOTHING about is still one (the field is optional on the wire, and reading
 * silence as dead would un-connect everybody against any engine that omits it), and `revoke` acts on
 * BOTH — a dead row is still a row to delete, and leaving it would be debris nobody can reach.
 */
describe("a connection the vendor reports as dead is not a live connection", () => {
  test("isConnected and accountName refuse a row whose connection_status is not live", async () => {
    engine({
      connections: 1,
      connectionTotal: false,
      connectionStatuses: ["expired"],
    });
    const { broker } = createArcadeClient("never-dialled");

    expect(await broker.isConnected({ account, toolkit: "Gmail" })).toBe(false);
    expect(await broker.accountName({ account, toolkit: "Gmail" })).toBe(null);
  });

  test("a live row beside a dead one answers for the live one", async () => {
    engine({
      connections: 2,
      connectionTotal: false,
      connectionStatuses: ["expired", "active"],
    });
    const { broker } = createArcadeClient("never-dialled");

    expect(await broker.isConnected({ account, toolkit: "Gmail" })).toBe(true);
    // `person 0`'s row is the dead one, so its name must not be the one shown.
    expect(await broker.accountName({ account, toolkit: "Gmail" })).toBe(
      "person 1",
    );
  });

  test("a row carrying no connection_status at all still reads as connected", async () => {
    engine({
      connections: 1,
      connectionTotal: false,
      connectionStatuses: [null],
    });
    const { broker } = createArcadeClient("never-dialled");

    expect(await broker.isConnected({ account, toolkit: "Gmail" })).toBe(true);
    expect(await broker.accountName({ account, toolkit: "Gmail" })).toBe(
      "person 0",
    );
  });

  test("revoke still deletes a dead row, and says it asked", async () => {
    const e = engine({
      connections: 2,
      connectionTotal: false,
      connectionStatuses: ["expired", "active"],
    });
    const { broker } = createArcadeClient("never-dialled");

    expect(await broker.revoke({ account, toolkit: "Gmail" })).toBe(true);
    expect(deletes(e).length).toBe(2);
  });
});

describe("the action listing's total_count cross-check survives a short final page", () => {
  test("the transport refuses a listing truncated at 250 of 300", async () => {
    engine({
      connections: 0,
      connectionTotal: true,
      toolsClaimed: 300,
      toolsServed: 250,
    });
    const { actions } = createArcadeClient("never-dialled");
    useArcadeClient(actions);

    await expect(listTools({ url: "arcade://Gmail" })).rejects.toThrow(
      /listed 250 of 300 actions for Gmail/,
    );
  });

  test("a complete listing is still accepted", async () => {
    engine({
      connections: 0,
      connectionTotal: true,
      toolsClaimed: 250,
      toolsServed: 250,
    });
    const { actions } = createArcadeClient("never-dialled");
    useArcadeClient(actions);

    expect((await listTools({ url: "arcade://Gmail" })).length).toBe(250);
  });

  // THE CATALOGUE'S TWO CASES ARE SCALED ×10 FROM THE TRANSPORT'S: `listApps` reads the directory in
  // pages of 1000 (`DIRECTORY_PAGE_SIZE`), so 250-of-300 would be ONE short page with the total
  // dropped from it — no second page and nothing to cross-check, which is not the case under test.
  // At 2500-of-3000 page one carries the claim and the rest are fetched AHEAD, concurrently, so
  // these also hold that fetching ahead did not weaken the incompleteness check.
  test("the catalogue refuses a truncated listing too", async () => {
    engine({
      connections: 0,
      connectionTotal: true,
      toolsClaimed: 3000,
      toolsServed: 2500,
    });
    const { broker } = createArcadeClient("never-dialled");

    await expect(broker.listApps()).rejects.toThrow(
      /listed 2500 of 3000 actions, so its app catalogue is incomplete/,
    );
  });

  test("a later page revising the count DOWN does not erase the first page's claim", async () => {
    // Page one claims 3000, page two revises it to 2500, and 2500 is all the engine serves. Keeping
    // the LAST total any page reported — rather than the highest — makes the truncation agree with
    // itself and the listing commits as a complete one.
    engine({
      connections: 0,
      connectionTotal: true,
      toolsClaimed: 3000,
      toolsServed: 2500,
      toolsLaterTotal: 2500,
    });
    const { broker } = createArcadeClient("never-dialled");

    await expect(broker.listApps()).rejects.toThrow(
      /listed 2500 of 3000 actions, so its app catalogue is incomplete/,
    );
  });

  test("grantsFor pages past the first page", async () => {
    engine({
      connections: 0,
      connectionTotal: true,
      toolsClaimed: 250,
      toolsServed: 250,
    });
    const { broker } = createArcadeClient("never-dialled");

    expect((await broker.grantsFor({ account, toolkit: "Gmail" })).length).toBe(
      250,
    );
  });
});

/**
 * THE ACTION LISTING BEHIND THE AUTH-PROVIDER READ IS PAGED TOO, AND ONLY A REAL ENGINE ASKS IT TO.
 *
 * `authProviderOf` read ONE request with no `limit`, no `offset` and no loop, on the argument that
 * every tool in a toolkit shares its auth provider, so a further page could only repeat the first.
 * Against a real engine that is false in exactly the way that matters: a 150-action `Gmail` listing
 * whose first 100 actions sit under `google` and whose last 50 sit under `microsoft` answered
 * `google` off one unpaged request — CONFIDENTLY, from a window the VENDOR chose, since the request
 * carried no `limit` at all. The function's own guard (the distinct provider ids, anything but
 * exactly one answering unanswered) was reading a prefix, so it could never fire.
 *
 * It cannot be seen by stubbing the SDK's prototypes: a hand-written generator serves the whole
 * fixture whatever the caller asked for, so the missing `limit`/`offset` and the missing loop both
 * vanish into the stub.
 */
describe("the auth provider is read off the WHOLE action listing", () => {
  test("a toolkit whose later pages name another provider refuses, naming both", async () => {
    const e = engine({
      connections: 1,
      connectionTotal: false,
      toolsClaimed: 150,
      toolsServed: 150,
      // The first page is uniformly `google`; the short second page is `microsoft`.
      toolProviderSplitAt: 100,
    });
    const { broker } = createArcadeClient("never-dialled");

    // UNANSWERED, AND THE THREE CALLERS REFUSE RATHER THAN ANSWER IT. They used to spell it as no
    // rows — not connected, no name, `revoke` false with NO DELETE SPENT — and that reading is the
    // defect `arcade-revoke-invariant.test.ts` pins: `false` means "there was nothing to withdraw",
    // a claim about the vendor's side, while `store.ts` deletes the local row on it and a live
    // grant is left at the vendor that nothing names. A listing naming two providers was not read;
    // it is refused, in this deployment's own sentence, with both providers in it.
    const refusal = /names 2 different auth providers \(google, microsoft\)/;
    await expect(
      broker.isConnected({ account, toolkit: "Gmail" }),
    ).rejects.toThrow(refusal);
    await expect(
      broker.accountName({ account, toolkit: "Gmail" }),
    ).rejects.toThrow(refusal);
    await expect(broker.revoke({ account, toolkit: "Gmail" })).rejects.toThrow(
      refusal,
    );
    expect(deletes(e).length).toBe(0);
  });

  test("the provider read asks for pages by limit and offset", async () => {
    const e = engine({
      connections: 1,
      connectionTotal: false,
      toolsClaimed: 150,
      toolsServed: 150,
    });
    const { broker } = createArcadeClient("never-dialled");

    // One provider across all 150 actions, so the toolkit still resolves and the person reads as
    // connected — but it took two requests, and the window is this file's own page size rather than
    // whatever the vendor happens to default to.
    expect(await broker.isConnected({ account, toolkit: "Gmail" })).toBe(true);
    expect(e.requests.filter((r) => r.startsWith("/v1/tools"))).toEqual([
      "/v1/tools?toolkit=Gmail&limit=100&offset=0",
      "/v1/tools?toolkit=Gmail&limit=100&offset=100",
    ]);
  });

  test("a truncated action listing refuses rather than answering a provider off a prefix", async () => {
    const e = engine({
      connections: 1,
      connectionTotal: false,
      toolsClaimed: 300,
      toolsServed: 250,
    });
    const { broker } = createArcadeClient("never-dialled");

    await expect(
      broker.isConnected({ account, toolkit: "Gmail" }),
    ).rejects.toThrow(/listed 250 of 300 actions for Gmail/);
    await expect(broker.revoke({ account, toolkit: "Gmail" })).rejects.toThrow(
      /listed 250 of 300 actions for Gmail/,
    );
    expect(deletes(e).length).toBe(0);
  });
});
