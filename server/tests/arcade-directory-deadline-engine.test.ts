import { afterEach, describe, expect, test } from "bun:test";
import { useArcadeClient } from "../src/plugins/arcade";
import { createArcadeClient } from "../src/plugins/arcade-adapter";
import { withVendorDeadline } from "../src/plugins/route-groups/context";

/**
 * "BROWSE ARCADE" MUST LOAD INSIDE ITS DEADLINE AGAINST A DIRECTORY OF ARCADE'S REAL SIZE.
 *
 * Every other `listApps` test serves a handful of rows, so nothing ever asked whether the listing
 * finishes in time. Against the live API it could not: 8,320 tools read 100 at a time is 84
 * SEQUENTIAL pages at ~1.2 s each, ~100 s, and the route wraps the whole of `listApps` in the 10 s
 * `VENDOR_CALL_TIMEOUT_MS` — the browser got a 502 after 10,157 ms, every time.
 *
 * So this engine serves THE MEASURED DIRECTORY over a real socket, with the MEASURED LATENCY, and
 * holds the listing to the deadline. Time is scaled down ×10 throughout so the suite stays fast;
 * the RATIO between page latency and deadline is the live one:
 *
 * | measured live                          | here (÷10)   |
 * |----------------------------------------|--------------|
 * | `total_count` 8,320                    | 8,320 (same) |
 * | ~1.19 s per page at limit ≤ 100        | 119 ms       |
 * | ~1.8 s per page at limit 250…1000      | 180 ms       |
 * | limit above 1000 REJECTED, empty body  | same         |
 * | `VENDOR_CALL_TIMEOUT_MS` 10,000 ms     | 1,000 ms     |
 */

const SCALE = 10;
/** `route-groups/context.ts`'s `VENDOR_CALL_TIMEOUT_MS`, scaled. */
const DEADLINE_MS = 10_000 / SCALE;
const DIRECTORY = 8_320;
const TOOLKIT_SIZE = 52; // 8,320 / 52 = 160 toolkits

const toolRow = (n: number) => {
  const toolkit = `Kit${Math.floor(n / TOOLKIT_SIZE)}`;
  return {
    qualified_name: `${toolkit}.Action${n}`,
    description: "",
    toolkit: { name: toolkit, description: "" },
    input: { parameters: [] },
  };
};

type Asked = {
  limit: number;
  offset: number;
  /** How many requests were in flight at the moment this one arrived, itself included. */
  inFlightAtStart: number;
  /** How many requests had already been ANSWERED when this one arrived. */
  answeredBefore: number;
};

type Engine = {
  asked: Asked[];
  maxInFlight: () => number;
  stop: () => void;
};

type EngineOptions = {
  /** What `total_count` says on every page. */
  claimed: number;
  /** How many rows the engine actually serves, which may be fewer — or more — than it claims. */
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
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname !== "/v1/tools")
        return new Response("not found", { status: 404 });
      const offset = Number(url.searchParams.get("offset") ?? "0");
      const limit = Number(url.searchParams.get("limit") ?? "25");
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      asked.push({
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
  return { asked, maxInFlight: () => peak, stop: () => server.stop(true) };
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

/** `listApps` exactly as the "Browse Arcade" route calls it: under the vendor deadline. */
const browse = () =>
  withVendorDeadline(
    () => createArcadeClient("never-dialled").broker.listApps(),
    DEADLINE_MS,
  );

describe("the Arcade directory loads inside the vendor deadline at its real size", () => {
  test("8,320 tools are listed in full before the deadline", async () => {
    const e = engine({ claimed: DIRECTORY });
    const started = performance.now();

    const apps = await browse();

    const took = performance.now() - started;
    expect(apps.reduce((n, app) => n + app.actionCount, 0)).toBe(DIRECTORY);
    expect(apps.length).toBe(DIRECTORY / TOOLKIT_SIZE);
    // Comfortably inside, not merely inside: one page alone, then one wave of the rest.
    expect(took).toBeLessThan(DEADLINE_MS);
    expect(e.asked.length).toBe(9);
  });

  test("page one is asked for alone, then every remaining page at once", async () => {
    const e = engine({ claimed: DIRECTORY });

    await browse();

    const [first, ...rest] = e.asked;
    // Page one first, alone — its `total_count` is what says how many pages follow.
    expect(first).toEqual({
      limit: 1000,
      offset: 0,
      inFlightAtStart: 1,
      answeredBefore: 0,
    });
    // Every other page, by offset, at the same page size, and none of them twice.
    expect(rest.map((one) => one.offset).sort((a, b) => a - b)).toEqual([
      1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000,
    ]);
    for (const one of rest) expect(one.limit).toBe(1000);
    // ...all asked for AFTER page one answered, and BEFORE any of them answered: one wave.
    for (const one of rest) expect(one.answeredBefore).toBe(1);
    expect(e.maxInFlight()).toBe(8);
  });

  test("a bigger directory is still fetched at most eight pages at a time", async () => {
    // 20,000 tools: 19 pages after the first, so the bound — not the directory — decides the peak.
    const e = engine({ claimed: 20_000, latency: { small: 5, large: 20 } });

    const apps = await browse();

    expect(apps.reduce((n, app) => n + app.actionCount, 0)).toBe(20_000);
    expect(e.asked.length).toBe(21);
    expect(e.maxInFlight()).toBe(8);
  });
});

describe("fetching ahead does not weaken the incompleteness check", () => {
  test("a directory that claims 8,320 and serves 8,000 is refused", async () => {
    engine({ claimed: DIRECTORY, served: 8000 });

    await expect(browse()).rejects.toThrow(
      /listed 8000 of 8320 actions, so its app catalogue is incomplete/,
    );
  });

  test("a short page in the MIDDLE ends the listing, and the pages fetched past it are not counted", async () => {
    // The page at offset 4000 holds 500 rows; the five pages fetched ahead past it hold nothing.
    // A reader that summed every answer would still see 4500 — but one that kept reading past the
    // short page would be trusting a listing that already said it was over.
    engine({ claimed: DIRECTORY, served: 4500 });

    await expect(browse()).rejects.toThrow(
      /listed 4500 of 8320 actions, so its app catalogue is incomplete/,
    );
  });

  test("a total that UNDER-reports is read on past, sequentially, to the real end", async () => {
    // Claims 2000, serves 3500: the prefetch covers offsets 1000 and 2000, both full, so the
    // listing must go on asking — a short page ends it, never the total.
    const e = engine({
      claimed: 2000,
      served: 3500,
      latency: { small: 5, large: 20 },
    });

    const apps = await browse();

    expect(apps.reduce((n, app) => n + app.actionCount, 0)).toBe(3500);
    expect(e.asked.map((one) => one.offset).sort((a, b) => a - b)).toEqual([
      0, 1000, 2000, 3000,
    ]);
  });
});
