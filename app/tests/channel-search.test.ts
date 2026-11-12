import { afterEach, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { matchingChannels } from "../src/components/app-sidebar/app-sidebar";
import {
  type ChannelSummary,
  channelKeys,
  channelListQueryOptions,
  channelSearchInfiniteQueryOptions,
  isChannelSearchable,
  normalizeChannelSearch,
} from "../src/lib/channels/queries";

/** A roster row as the search box sees it. */
function channel(overrides: Partial<ChannelSummary>): ChannelSummary {
  return {
    id: "channel-1",
    name: "Knowledge",
    agentIds: ["agent-1"],
    threadId: "thread-1",
    active: true,
    summary: null,
    lastMessage: "The three flights and the hotel do.",
    lastMessageAt: "2026-08-25T12:00:00.000Z",
    lastMessageAgentId: "agent-1",
    createdAt: "2026-08-25T11:00:00.000Z",
    pinned: false,
    lastReadAt: null,
    ...overrides,
  };
}

test("an untitled channel is still found by its Bot's name", () => {
  // The fallback the row draws is the name, so the name has to stay searchable or a conversation
  // that has not been named yet becomes unreachable from the search box.
  const rows = [channel({ id: "untitled" })];

  expect(matchingChannels(rows, "knowl").map((row) => row.id)).toEqual([
    "untitled",
  ]);
});

test("a titled channel is found by a word in its title", () => {
  const rows = [channel({ id: "titled", summary: "Travel receipt rules" })];

  expect(matchingChannels(rows, "receipt").map((row) => row.id)).toEqual([
    "titled",
  ]);
});

test("a word from the last message still matches", () => {
  // The second line falls back to the last message until a conversation is named, so that text is
  // still something the roster can show and therefore still something search must find.
  const rows = [channel({ id: "titled", summary: "Travel receipt rules" })];

  expect(matchingChannels(rows, "hotel").map((row) => row.id)).toEqual([
    "titled",
  ]);
});

test("an empty query returns the very same array, not a copy", () => {
  // Identity matters: a new array on every keystroke restages the whole animated list.
  const rows = [channel({})];

  expect(matchingChannels(rows, "   ")).toBe(rows);
});

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** Answer every request with `body`, and keep what was asked for and with which signal. */
function serve(body: unknown) {
  const seen: { url: string; signal: AbortSignal | undefined }[] = [];
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ url: String(input), signal: init?.signal ?? undefined });
      return Response.json(body);
    },
    { preconnect: originalFetch.preconnect },
  );
  return seen;
}

test("a search has its own key, apart from the roster's, by its normalised text and page size", () => {
  const options = channelSearchInfiniteQueryOptions("  Cafe\u0301 receipts ");
  // Spread, to compare the key itself and not the type tag TanStack puts on it.
  const key = [...options.queryKey];
  expect(key).toEqual([...channelKeys.search("Caf\u00e9 receipts", 20)]);
  expect(key).toEqual([
    "channels",
    "search",
    { query: "Caf\u00e9 receipts", limit: 20 },
  ]);
  // Not under the roster's key, so a roster write or invalidation never lands on a search.
  const list = channelListQueryOptions().queryKey;
  expect(key.slice(0, list.length)).not.toEqual([...list]);
  // Under the root and its own prefix, so a change to any conversation refreshes it.
  expect(key.slice(0, 1)).toEqual([...channelKeys.all]);
  expect(key.slice(0, 2)).toEqual([...channelKeys.searches()]);
  expect([
    ...channelSearchInfiniteQueryOptions("receipts", 5).queryKey,
  ]).toEqual([...channelKeys.search("receipts", 5)]);
});

test("only two or more characters are searched", () => {
  expect(isChannelSearchable("a")).toBe(false);
  expect(isChannelSearchable("  a  ")).toBe(false);
  // One code point, though it is two UTF-16 units.
  expect(isChannelSearchable("🚀")).toBe(false);
  expect(isChannelSearchable("ab")).toBe(true);
  expect(channelSearchInfiniteQueryOptions("a").enabled).toBe(false);
  expect(channelSearchInfiniteQueryOptions("ab").enabled).toBe(true);
  expect(normalizeChannelSearch("  e\u0301cole ")).toBe("\u00e9cole");
});

test("asks the search endpoint with the query, the page size, the cursor and the query's signal", async () => {
  const seen = serve({
    channels: [channel({ id: "found" })],
    nextCursor: "next/page",
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const options = channelSearchInfiniteQueryOptions("100% & more", 5);

  const first = await queryClient.fetchInfiniteQuery(options);
  expect(seen[0]?.url).toBe("/api/channels/search?q=100%25+%26+more&limit=5");
  expect(seen[0]?.signal).toBeInstanceOf(AbortSignal);
  expect(first.pages[0]?.nextCursor).toBe("next/page");
  // Flattened for the caller, like the roster.
  expect(options.select?.(first).map((row) => row.id)).toEqual(["found"]);

  // Two pages: the first again, then the one its cursor names.
  await queryClient.fetchInfiniteQuery({ ...options, pages: 2 });
  expect(seen.at(-1)?.url).toBe(
    "/api/channels/search?q=100%25+%26+more&limit=5&cursor=next%2Fpage",
  );
  // A search never writes into the roster's cache.
  expect(queryClient.getQueryData(channelKeys.list())).toBeUndefined();
  queryClient.clear();
});
