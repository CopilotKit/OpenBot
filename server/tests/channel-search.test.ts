import { describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AppVariables } from "../src/auth/guards";
import {
  ChannelSearchInputError,
  type ChannelSearchQuery,
  type ChannelStore,
  type ChannelSummary,
  createChannelRoutes,
  decodeChannelSearchCursor,
  encodeChannelCursor,
  encodeChannelSearchCursor,
  likeLiteral,
  normalizeChannelSearch,
  parseChannelSearchParams,
  SEARCH_CONTROL_ERROR,
  SEARCH_CURSOR_ERROR,
  SEARCH_TOO_LONG_ERROR,
  SEARCH_TOO_SHORT_ERROR,
} from "../src/channels/routes";
import { PAGE_LIMIT_ERROR } from "../src/paging";

const actor = { id: "user-1", role: "user" } as const;
const position = {
  pinned: false,
  recency: "2026-09-01T00:00:00.123456Z",
  id: "channel-1",
};

function params(query: Record<string, string>) {
  return new URLSearchParams(query);
}

describe("search parameters", () => {
  test.each([
    [{}, SEARCH_TOO_SHORT_ERROR],
    [{ q: "" }, SEARCH_TOO_SHORT_ERROR],
    [{ q: "   " }, SEARCH_TOO_SHORT_ERROR],
    [{ q: " a " }, SEARCH_TOO_SHORT_ERROR],
    // One code point, however many UTF-16 units it takes.
    [{ q: "🚀" }, SEARCH_TOO_SHORT_ERROR],
    [{ q: "x".repeat(201) }, SEARCH_TOO_LONG_ERROR],
    [{ q: "🚀".repeat(201) }, SEARCH_TOO_LONG_ERROR],
    [{ q: "ab\u0000cd" }, SEARCH_CONTROL_ERROR],
    [{ q: "ab\ncd" }, SEARCH_CONTROL_ERROR],
    [{ q: "ab", limit: "12abc" }, PAGE_LIMIT_ERROR],
    [{ q: "ab", limit: "-5" }, PAGE_LIMIT_ERROR],
    [{ q: "ab", limit: "3.9" }, PAGE_LIMIT_ERROR],
    [{ q: "ab", cursor: "%%%" }, SEARCH_CURSOR_ERROR],
  ])("refuses %p", (query, error) => {
    expect(parseChannelSearchParams(params(query))).toEqual({
      ok: false,
      error,
    });
  });

  test("accepts 2 to 200 code points, trimmed and composed", () => {
    expect(parseChannelSearchParams(params({ q: "  ab  " }))).toEqual({
      ok: true,
      value: { query: "ab" },
    });
    expect(parseChannelSearchParams(params({ q: "🚀".repeat(200) }))).toEqual({
      ok: true,
      value: { query: "🚀".repeat(200) },
    });
    expect(parseChannelSearchParams(params({ q: "e\u0301cole" }))).toEqual({
      ok: true,
      value: { query: "\u00e9cole" },
    });
  });

  test.each([
    ["10", 10],
    ["50", 50],
    ["51", 50],
    ["999999", 50],
    ["0", 1],
  ])("clamps a well-formed limit %p to %p", (limit, expected) => {
    expect(parseChannelSearchParams(params({ q: "ab", limit }))).toEqual({
      ok: true,
      value: { query: "ab", limit: expected },
    });
  });

  test("reads a blank cursor as the first page", () => {
    expect(parseChannelSearchParams(params({ q: "ab", cursor: "" }))).toEqual({
      ok: true,
      value: { query: "ab" },
    });
  });
});

describe("search cursor", () => {
  test("round-trips for the search that made it, including one typed differently", () => {
    const cursor = encodeChannelSearchCursor(position, "travel");
    expect(decodeChannelSearchCursor(cursor, "travel")).toEqual(position);
    expect(
      parseChannelSearchParams(params({ q: "  travel ", cursor })),
    ).toEqual({ ok: true, value: { query: "travel", cursor } });
  });

  test("belongs to one search only", () => {
    const cursor = encodeChannelSearchCursor(position, "travel");
    expect(decodeChannelSearchCursor(cursor, "travels")).toBeUndefined();
    expect(decodeChannelSearchCursor(cursor, "Travel")).toBeUndefined();
    expect(parseChannelSearchParams(params({ q: "invoice", cursor }))).toEqual({
      ok: false,
      error: SEARCH_CURSOR_ERROR,
    });
  });

  test("refuses the roster's cursor, and a tampered one", () => {
    expect(
      decodeChannelSearchCursor(encodeChannelCursor(position), "travel"),
    ).toBeUndefined();
    const forged = Buffer.from(
      JSON.stringify({ ...position, recency: "now", q: "x" }),
    ).toString("base64url");
    expect(decodeChannelSearchCursor(forged, "travel")).toBeUndefined();
  });
});

describe("search pattern", () => {
  test("escapes the wildcards and the escape character, and nothing else", () => {
    expect(likeLiteral("100%")).toBe("100\\%");
    expect(likeLiteral("a_b")).toBe("a\\_b");
    expect(likeLiteral("C:\\Users")).toBe("C:\\\\Users");
    expect(likeLiteral("plain 'text' [x]")).toBe("plain 'text' [x]");
  });

  test("normalises by trimming and composing, not by case", () => {
    expect(normalizeChannelSearch("  Cafe\u0301 ")).toBe("Caf\u00e9");
  });
});

function summary(id: string): ChannelSummary {
  return {
    id,
    name: "Knowledge",
    agentIds: ["agent-1"],
    threadId: `thread-${id}`,
    active: true,
    lastMessageAt: new Date("2026-09-01T00:00:00.000Z"),
    summary: "Travel receipts",
    opening: "Which receipts count?",
    lastMessage: "These three.",
    lastMessageAgentId: "agent-1",
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
    pinned: false,
    lastReadAt: null,
    canRename: true,
    task: false,
  };
}

function appWith(
  search: ChannelStore["search"],
  calls: { search: ChannelSearchQuery[]; other: string[] },
  requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
    context,
    next,
  ) => {
    context.set("actor", actor);
    await next();
  },
) {
  const other = (name: string) => async (): Promise<never> => {
    calls.other.push(name);
    throw new Error(`Unexpected ${name}`);
  };
  const store: ChannelStore = {
    create: other("create"),
    direct: other("direct"),
    get: other("get"),
    list: other("list"),
    async search(receivedActor, query) {
      calls.search.push(query);
      return search(receivedActor, query);
    },
    setPinned: other("setPinned"),
    markRead: other("markRead"),
    rename: other("rename"),
    softDelete: other("softDelete"),
    recordActivity: other("recordActivity"),
    signalBusy: other("signalBusy"),
    signalChannelBusy: other("signalChannelBusy"),
    signalWork: other("signalWork"),
    async workIn() {
      return new Map();
    },
  };
  const app = new Hono<{ Variables: AppVariables }>();
  app.route("/", createChannelRoutes(store, requireUser));
  return app;
}

describe("GET /search", () => {
  test("is its own route, not a channel called search", async () => {
    const calls = { search: [] as ChannelSearchQuery[], other: [] as string[] };
    const app = appWith(
      async () => ({ channels: [summary("found")], nextCursor: "next" }),
      calls,
    );

    const response = await app.request(
      "http://openbot.test/search?q=%20travel%20&limit=5",
    );

    expect(response.status).toBe(200);
    expect(calls.other).toEqual([]);
    expect(calls.search).toEqual([{ query: "travel", limit: 5 }]);
    // The roster's DTO, row for row.
    expect(await response.json()).toEqual({
      channels: [
        {
          id: "found",
          name: "Knowledge",
          agentIds: ["agent-1"],
          threadId: "thread-found",
          active: true,
          lastMessageAt: "2026-09-01T00:00:00.000Z",
          summary: "Travel receipts",
          opening: "Which receipts count?",
          lastMessage: "These three.",
          lastMessageAgentId: "agent-1",
          createdAt: "2026-08-01T00:00:00.000Z",
          pinned: false,
          lastReadAt: null,
          canRename: true,
          task: false,
          work: [],
        },
      ],
      nextCursor: "next",
    });
  });

  test.each([
    ["q=a", SEARCH_TOO_SHORT_ERROR],
    [`q=${"x".repeat(201)}`, SEARCH_TOO_LONG_ERROR],
    ["q=ab%00", SEARCH_CONTROL_ERROR],
    ["q=ab&limit=ten", PAGE_LIMIT_ERROR],
    ["q=ab&cursor=garbage", SEARCH_CURSOR_ERROR],
  ])(
    "answers 400 for ?%s and never reaches the store",
    async (query, error) => {
      const calls = {
        search: [] as ChannelSearchQuery[],
        other: [] as string[],
      };
      const app = appWith(async () => {
        throw new Error("unreachable");
      }, calls);

      const response = await app.request(`http://openbot.test/search?${query}`);

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error });
      expect(calls).toEqual({ search: [], other: [] });
    },
  );

  test("maps the store's own refusal to the same 400", async () => {
    const calls = { search: [] as ChannelSearchQuery[], other: [] as string[] };
    const app = appWith(async () => {
      throw new ChannelSearchInputError(SEARCH_CURSOR_ERROR);
    }, calls);

    const response = await app.request("http://openbot.test/search?q=ab");

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: SEARCH_CURSOR_ERROR });
  });

  test("is behind authentication", async () => {
    const calls = { search: [] as ChannelSearchQuery[], other: [] as string[] };
    const app = appWith(
      async () => ({ channels: [], nextCursor: null }),
      calls,
      (context) => Promise.resolve(context.json({ error: "denied" }, 401)),
    );

    const response = await app.request("http://openbot.test/search?q=ab");

    expect(response.status).toBe(401);
    expect(calls).toEqual({ search: [], other: [] });
  });
});
