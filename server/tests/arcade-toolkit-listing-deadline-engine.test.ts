import { afterEach, describe, expect, test } from "bun:test";
import { useArcadeClient } from "../src/plugins/arcade";
import { createArcadeClient } from "../src/plugins/arcade-adapter";
import { withVendorDeadline } from "../src/plugins/route-groups/context";
import type { AccountRef } from "../src/plugins/shared-accounts";

/**
 * ONE LARGE TOOLKIT MUST BE READABLE INSIDE ITS DEADLINE: THE GRANTS SCREEN AND DISCONNECT.
 *
 * The sibling of `arcade-directory-deadline-engine.test.ts`. That file holds the WHOLE directory to
 * the deadline; this one holds the PER-TOOLKIT action listing — read by `grantsFor` (the grants
 * screen) and by `authProvidersNamedBy` (behind `authProviderOf`, `isConnected` and `revoke`) — to
 * the same deadline, at the size of the largest toolkit Arcade publishes.
 *
 * MEASURED against the live directory (8,320 tools across 129 toolkits): `GithubApi` has **818**
 * actions. Read 100 at a time, one after another, that is 9 sequential pages at ~1.19 s each,
 * ~10.7 s — past the 10 s `VENDOR_CALL_TIMEOUT_MS` every one of those routes is wrapped in. The
 * grants screen for one of the most likely apps anybody adds could not load, and Disconnect for it
 * could not even start.
 *
 * Time is scaled ×10 as in the directory test; the RATIO between page latency and deadline is the
 * live one:
 *
 * | measured live                          | here (÷10)   |
 * |----------------------------------------|--------------|
 * | `GithubApi` 818 actions                | 818 (same)   |
 * | ~1.19 s per page at limit ≤ 100        | 119 ms       |
 * | ~1.8 s per page at limit 250…1000      | 180 ms       |
 * | limit above 1000 REJECTED, empty body  | same         |
 * | `VENDOR_CALL_TIMEOUT_MS` 10,000 ms     | 1,000 ms     |
 *
 * The admin listings and the DELETE on the Disconnect path were not measured separately; they are
 * served at the same small-page latency, which is the conservative reading.
 */

const SCALE = 10;
/** `route-groups/context.ts`'s `VENDOR_CALL_TIMEOUT_MS`, scaled. */
const DEADLINE_MS = 10_000 / SCALE;
/** The measured largest toolkit in Arcade's directory. */
const GITHUB_API = 818;
const TOOLKIT = "GithubApi";

const account: AccountRef = {
  holder: "person",
  userId: "u1",
  vendorUserId: "vendor-u1",
};

const toolRow = (n: number) => ({
  qualified_name: `${TOOLKIT}.Action${n}`,
  description: "",
  toolkit: { name: TOOLKIT, description: "" },
  input: { parameters: [] },
  requirements: {
    authorization: { provider_id: "github", oauth2: { scopes: [] } },
  },
});

type Asked = {
  toolkit: string | null;
  userId: string | null;
  limit: number;
  offset: number;
  /** How many tool-listing requests were in flight when this one arrived, itself included. */
  inFlightAtStart: number;
  /** How many tool-listing requests had already been ANSWERED when this one arrived. */
  answeredBefore: number;
};

type Engine = {
  /** Every request to `/v1/tools`, in arrival order. */
  asked: Asked[];
  maxInFlight: () => number;
  deletes: () => number;
  stop: () => void;
};

type EngineOptions = {
  /** What `total_count` says on every page of the action listing. */
  claimed: number;
  /** How many actions the engine actually serves, which may be fewer — or more — than it claims. */
  served?: number;
  /** Per-request latency in ms at limit ≤ 100, and above it. Defaults are the live ones, ÷10. */
  latency?: { small: number; large: number };
};

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

function startEngine(options: EngineOptions): Engine {
  const asked: Asked[] = [];
  const latency = options.latency ?? {
    small: 1190 / SCALE,
    large: 1800 / SCALE,
  };
  const served = options.served ?? options.claimed;
  let inFlight = 0;
  let peak = 0;
  let answered = 0;
  let deleted = 0;
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const offset = Number(url.searchParams.get("offset") ?? "0");
      const limit = Number(url.searchParams.get("limit") ?? "25");

      if (url.pathname.startsWith("/v1/admin/user_connections/")) {
        await sleep(latency.small);
        deleted += 1;
        return new Response(null, { status: 204 });
      }
      if (url.pathname === "/v1/admin/user_connections") {
        await sleep(latency.small);
        const items =
          offset === 0
            ? [
                {
                  id: "at_1",
                  connection_id: "ac_1",
                  connection_status: "active",
                  provider_id: "github-openbot",
                  provider_type: "oauth2",
                  provider_user_info: { name: "person one" },
                  scopes: [],
                  user_id: account.vendorUserId,
                },
              ]
            : [];
        return Response.json({
          items,
          offset,
          limit,
          page_count: items.length,
          total_count: 1,
        });
      }
      if (url.pathname === "/v1/admin/auth_providers") {
        await sleep(latency.small);
        const items =
          offset === 0
            ? [{ id: "github-openbot", provider_id: "github", type: "oauth2" }]
            : [];
        return Response.json({
          items,
          offset,
          limit,
          page_count: items.length,
          total_count: 1,
        });
      }
      if (url.pathname !== "/v1/tools")
        return new Response("not found", { status: 404 });

      inFlight += 1;
      peak = Math.max(peak, inFlight);
      asked.push({
        toolkit: url.searchParams.get("toolkit"),
        userId: url.searchParams.get("user_id"),
        limit,
        offset,
        inFlightAtStart: inFlight,
        answeredBefore: answered,
      });
      try {
        // MEASURED: limit=5000 answered an EMPTY response in ~0.17 s. A page size past the
        // vendor's ceiling must fail here exactly as it fails live.
        if (limit > 1000) {
          await sleep(170 / SCALE);
          return new Response("", { status: 200 });
        }
        await sleep(limit <= 100 ? latency.small : latency.large);
        const items = [];
        for (let n = offset; n < Math.min(offset + limit, served); n++)
          items.push(toolRow(n));
        return Response.json({
          items,
          offset,
          limit,
          page_count: items.length,
          total_count: options.claimed,
        });
      } finally {
        inFlight -= 1;
        answered += 1;
      }
    },
  });
  process.env.ARCADE_BASE_URL = `http://localhost:${server.port}`;
  return {
    asked,
    maxInFlight: () => peak,
    deletes: () => deleted,
    stop: () => server.stop(true),
  };
}

let running: Engine | null = null;
const wasBaseURL = process.env.ARCADE_BASE_URL;

function engine(options: EngineOptions): Engine {
  running = startEngine(options);
  return running;
}

afterEach(() => {
  running?.stop();
  running = null;
  useArcadeClient(null);
  if (wasBaseURL === undefined) delete process.env.ARCADE_BASE_URL;
  else process.env.ARCADE_BASE_URL = wasBaseURL;
});

/** Each broker member exactly as its route calls it: under the vendor deadline. */
const underDeadline = <T>(
  run: (broker: ReturnType<typeof createArcadeClient>["broker"]) => Promise<T>,
) =>
  withVendorDeadline(
    () => run(createArcadeClient("never-dialled").broker),
    DEADLINE_MS,
  );

const grants = () =>
  underDeadline((broker) => broker.grantsFor({ account, toolkit: TOOLKIT }));

/** The offsets asked for after page one, in offset order. */
const restOffsets = (e: Engine) =>
  e.asked
    .slice(1)
    .map((one) => one.offset)
    .sort((a, b) => a - b);

describe("the largest Arcade toolkit is read inside the vendor deadline", () => {
  test("the grants screen lists all 818 GithubApi actions before the deadline", async () => {
    const e = engine({ claimed: GITHUB_API });
    const started = performance.now();

    const held = await grants();

    const took = performance.now() - started;
    expect(held.length).toBe(GITHUB_API);
    expect(took).toBeLessThan(DEADLINE_MS);
    // Still nine pages of 100 — the page size did not change, only when the pages are asked for.
    expect(e.asked.length).toBe(9);
    for (const one of e.asked) {
      expect(one.toolkit).toBe(TOOLKIT);
      expect(one.userId).toBe(account.vendorUserId);
      expect(one.limit).toBe(100);
    }
  });

  test("page one is asked for alone, then the other eight pages at once", async () => {
    const e = engine({ claimed: GITHUB_API });

    await grants();

    // Page one first, alone — its `total_count` is what says how many pages follow.
    expect(e.asked[0]).toMatchObject({
      limit: 100,
      offset: 0,
      inFlightAtStart: 1,
      answeredBefore: 0,
    });
    expect(restOffsets(e)).toEqual([100, 200, 300, 400, 500, 600, 700, 800]);
    // ...all asked for AFTER page one answered and BEFORE any of them answered: one wave.
    for (const one of e.asked.slice(1)) expect(one.answeredBefore).toBe(1);
    expect(e.maxInFlight()).toBe(8);
  });

  test("the auth-provider read behind authProviderOf finishes before the deadline too", async () => {
    const e = engine({ claimed: GITHUB_API });

    expect(
      await underDeadline((broker) => broker.authProviderOf(TOOLKIT)),
    ).toBe("github");
    expect(e.asked.length).toBe(9);
    // The catalogue read carries no person: it is the same listing for everybody.
    for (const one of e.asked) expect(one.userId).toBeNull();
    expect(restOffsets(e)).toEqual([100, 200, 300, 400, 500, 600, 700, 800]);
    expect(e.maxInFlight()).toBe(8);
  });

  test("Disconnect on GithubApi — the action listing, then the connection lifecycle — fits the deadline", async () => {
    const e = engine({ claimed: GITHUB_API });

    expect(
      await underDeadline((broker) =>
        broker.revoke({ account, toolkit: TOOLKIT }),
      ),
    ).toBe(true);
    expect(e.deletes()).toBe(1);
  });

  test("a bigger toolkit is still fetched at most eight pages at a time", async () => {
    // 2,000 actions: 20 pages after the first, so the bound — not the toolkit — decides the peak.
    const e = engine({ claimed: 2000, latency: { small: 5, large: 20 } });

    expect((await grants()).length).toBe(2000);
    expect(e.asked.length).toBe(21);
    expect(e.maxInFlight()).toBe(8);
  });
});

describe("fetching a toolkit ahead does not weaken the incompleteness check", () => {
  test("a toolkit that claims 818 and serves 750 is refused, on the grants screen and on Disconnect", async () => {
    const e = engine({ claimed: GITHUB_API, served: 750 });

    await expect(grants()).rejects.toThrow(
      /listed 750 of 818 actions for GithubApi, so what this account holds there could not be read in full/,
    );
    await expect(
      underDeadline((broker) => broker.revoke({ account, toolkit: TOOLKIT })),
    ).rejects.toThrow(
      /listed 750 of 818 actions for GithubApi, so the auth provider/,
    );
    expect(e.deletes()).toBe(0);
  });

  test("a short page in the MIDDLE ends the listing, and the pages fetched past it are not counted", async () => {
    // The page at offset 400 holds 50 rows; the four pages fetched ahead past it hold nothing.
    engine({ claimed: GITHUB_API, served: 450 });

    await expect(grants()).rejects.toThrow(/listed 450 of 818 actions/);
  });

  test("a total that UNDER-reports is read on past, sequentially, to the real end", async () => {
    // Claims 300, serves 818: the prefetch covers offsets 100…300, all full, so the listing must
    // go on asking — a short page ends it, never the total.
    const e = engine({
      claimed: 300,
      served: GITHUB_API,
      latency: { small: 5, large: 20 },
    });

    expect((await grants()).length).toBe(GITHUB_API);
    expect(e.asked.map((one) => one.offset).sort((a, b) => a - b)).toEqual([
      0, 100, 200, 300, 400, 500, 600, 700, 800,
    ]);
  });
});
