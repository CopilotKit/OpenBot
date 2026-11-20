import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { InfiniteQueryObserver, QueryClient } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import {
  EXPANDED_BOTS_STORAGE_KEY,
  orderBots,
  readExpanded,
  useExpandedBots,
} from "@/lib/bots/panel";
import {
  deleteChannelMutationOptions,
  markChannelReadMutationOptions,
  renameChannelMutationOptions,
} from "@/lib/channels/mutations";
import { type ChannelSummary, channelKeys } from "@/lib/channels/queries";
import { applyToBotLists } from "@/lib/channels/use-channel-events";
import { settleReactWork } from "./settle-react-work";

/*
 * The Bots panel lists every Bot by its latest conversation, newest first: the server's word for
 * it, or a conversation the live list has heard about since, whichever is later. The top three open
 * by default, once, when the panel first has its Bots; what the person opens or closes sticks.
 */

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
beforeEach(() => window.localStorage.clear());
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const bot = (id: string, name: string, lastConversationAt: string | null) => ({
  id,
  name,
  lastConversationAt,
});

function conversation(
  id: string,
  agentIds: string[],
  lastMessageAt: string | null,
  createdAt = "2026-11-01T00:00:00.000Z",
): ChannelSummary {
  return {
    id,
    name: "",
    agentIds,
    threadId: id,
    active: true,
    lastMessageAt,
    summary: null,
    lastMessage: null,
    lastMessageAgentId: null,
    createdAt,
    pinned: false,
    lastReadAt: null,
  } as ChannelSummary;
}

const ids = (bots: { id: string }[]) => bots.map((each) => each.id);

test("Bots go newest conversation first, and Bots with none go last by name", () => {
  expect(
    ids(
      orderBots([
        bot("zed", "Zed", null),
        bot("old", "Old", "2026-11-01T10:00:00.000Z"),
        bot("ada", "Ada", null),
        bot("new", "New", "2026-11-03T10:00:00.000Z"),
      ]),
    ),
  ).toEqual(["new", "old", "ada", "zed"]);
});

test("a conversation the live list heard about since moves its Bot up, group ones for each Bot in it", () => {
  const bots = [
    bot("a", "A", "2026-11-03T10:00:00.000Z"),
    bot("b", "B", "2026-11-02T10:00:00.000Z"),
    bot("c", "C", null),
  ];
  expect(
    ids(
      orderBots(bots, [
        conversation("x", ["c", "b"], "2026-11-04T10:00:00.000Z"),
      ]),
    ),
    // B and C share that conversation's time, so they go by name, ahead of A.
  ).toEqual(["b", "c", "a"]);
  // A conversation with no message yet counts by when it was started, as the list does.
  expect(
    ids(
      orderBots(bots, [
        conversation("y", ["c"], null, "2026-11-05T10:00:00.000Z"),
      ]),
    ),
  ).toEqual(["c", "a", "b"]);
});

test("what this browser stored about open Bots is read loosely", () => {
  expect(readExpanded(null)).toEqual({});
  expect(readExpanded("not json")).toEqual({});
  expect(readExpanded('{"a":true,"b":false,"c":"yes"}')).toEqual({
    a: true,
    b: false,
  });
});

test("the top three open by default, once: a Bot that climbs into them later stays closed", () => {
  const { result, rerender } = renderHook(
    ({ order }: { order: string[] }) => useExpandedBots(order),
    { initialProps: { order: ["a", "b", "c", "d"] } },
  );
  expect(["a", "b", "c", "d"].map(result.current.isExpanded)).toEqual([
    true,
    true,
    true,
    false,
  ]);
  rerender({ order: ["d", "a", "b", "c"] });
  expect(result.current.isExpanded("d")).toBe(false);
  expect(result.current.isExpanded("c")).toBe(true);
});

test("a Bot opened or closed stays that way, in this browser", () => {
  const first = renderHook(() => useExpandedBots(["a", "b", "c", "d"]));
  act(() => {
    first.result.current.toggle("a");
    first.result.current.toggle("d");
  });
  expect(first.result.current.isExpanded("a")).toBe(false);
  expect(first.result.current.isExpanded("d")).toBe(true);
  expect(
    JSON.parse(window.localStorage.getItem(EXPANDED_BOTS_STORAGE_KEY) ?? "{}"),
  ).toEqual({ a: false, d: true });
  first.unmount();
  const again = renderHook(() => useExpandedBots(["a", "b", "c", "d"]));
  expect(again.result.current.isExpanded("a")).toBe(false);
  expect(again.result.current.isExpanded("d")).toBe(true);
});

test("a panel that first has no Bots takes its defaults when they arrive", () => {
  const { result, rerender } = renderHook(
    ({ order }: { order: string[] }) => useExpandedBots(order),
    { initialProps: { order: [] as string[] } },
  );
  rerender({ order: ["a", "b"] });
  expect(result.current.isExpanded("a")).toBe(true);
  expect(result.current.isExpanded("b")).toBe(true);
});

/*
 * The socket keeps every open Bot's list current the way it keeps the Conversations list: a known
 * conversation is patched in place; one a Bot's list does not hold yet is read again, for the Bots
 * in it only.
 */
test("a live event patches the open Bot lists that hold its conversation, and rereads the ones that should", () => {
  const client = new QueryClient();
  const page = (channels: ChannelSummary[]) => ({
    pages: [{ channels, nextCursor: null }],
    pageParams: [""],
  });
  client.setQueryData(
    channelKeys.list(),
    page([conversation("c1", ["a"], "2026-11-01T10:00:00.000Z")]),
  );
  client.setQueryData(
    channelKeys.byBot("a"),
    page([conversation("c1", ["a"], "2026-11-01T10:00:00.000Z")]),
  );
  client.setQueryData(channelKeys.byBot("b"), page([]));
  const event = {
    channelId: "c1",
    lastMessage: "New words",
    lastMessageAt: "2026-11-06T10:00:00.000Z",
    lastMessageAgentId: "a",
  };
  applyToBotLists(client, event);
  const a = client.getQueryData<{ pages: { channels: ChannelSummary[] }[] }>(
    channelKeys.byBot("a"),
  );
  expect(a?.pages[0]?.channels[0]?.lastMessage).toBe("New words");
  // B is not in that conversation: its list is left alone, not read again.
  expect(client.getQueryState(channelKeys.byBot("b"))?.isInvalidated).toBe(
    false,
  );

  // A conversation A's open list has not got yet is read again, for A.
  client.setQueryData(
    channelKeys.list(),
    page([conversation("c2", ["a"], "2026-11-07T10:00:00.000Z")]),
  );
  applyToBotLists(client, { ...event, channelId: "c2" });
  expect(client.getQueryState(channelKeys.byBot("a"))?.isInvalidated).toBe(
    true,
  );
});

test("a live message for a conversation past a Bot's first page rereads that Bot's list, so it can go to the top", () => {
  const client = new QueryClient();
  const firstPage = [1, 2, 3, 4, 5].map((n) =>
    conversation(`p${n}`, ["a"], `2026-11-0${n}T10:00:00.000Z`),
  );
  client.setQueryData(channelKeys.list(), {
    pages: [{ channels: [], nextCursor: null }],
    pageParams: [""],
  });
  client.setQueryData(channelKeys.byBot("a"), {
    pages: [
      { channels: firstPage, nextCursor: "next" },
      {
        channels: [conversation("late", ["a"], "2026-10-01T10:00:00.000Z")],
        nextCursor: null,
      },
    ],
    pageParams: ["", "next"],
  });
  applyToBotLists(client, {
    channelId: "late",
    lastMessage: "Back to life",
    lastMessageAt: "2026-11-09T10:00:00.000Z",
    lastMessageAgentId: "a",
  });
  expect(client.getQueryState(channelKeys.byBot("a"))?.isInvalidated).toBe(
    true,
  );
});

test("reading a conversation marks it read under its Bots as well, and a rename or delete rereads their lists", async () => {
  const client = new QueryClient();
  client.setQueryData(channelKeys.byBot("a"), {
    pages: [
      {
        channels: [
          {
            ...conversation("c1", ["a"], "2026-11-01T10:00:00.000Z"),
            lastMessageAgentId: "a",
          },
        ],
        nextCursor: null,
      },
    ],
    pageParams: [""],
  });
  const read = markChannelReadMutationOptions(client);
  await read.onMutate?.("c1", undefined as never);
  const row = client.getQueryData<{
    pages: { channels: ChannelSummary[] }[];
  }>(channelKeys.byBot("a"))?.pages[0]?.channels[0];
  expect(row?.lastReadAt).not.toBeNull();

  for (const made of [
    renameChannelMutationOptions(client),
    deleteChannelMutationOptions(client),
  ]) {
    client.setQueryData(channelKeys.byBot("b"), {
      pages: [{ channels: [], nextCursor: null }],
      pageParams: [""],
    });
    await (made.onSuccess as unknown as (() => unknown) | undefined)?.();
    expect(client.getQueryState(channelKeys.byBot("b"))?.isInvalidated).toBe(
      true,
    );
  }
});

/*
 * Only something said in a conversation can bring it onto a Bot's list or up it. Found in review:
 * busy, work and naming events on a conversation past a Bot's loaded rows read that Bot's list
 * again every time, and a task thread's events read every open Bot's list, each read cancelling the
 * one before (Show more's among them), and none of them ever bringing the row in.
 */
const pageOf = (
  channels: ChannelSummary[],
  nextCursor: string | null = null,
) => ({
  pages: [{ channels, nextCursor }],
  pageParams: [""],
});

test("busy, work, a name and a pin on a conversation a Bot's list has not loaded read nothing again", () => {
  const client = new QueryClient();
  client.setQueryData(
    channelKeys.list(),
    pageOf([conversation("old", ["a"], "2026-10-01T10:00:00.000Z")]),
  );
  client.setQueryData(
    channelKeys.byBot("a"),
    pageOf([conversation("recent", ["a"], "2026-11-05T10:00:00.000Z")], "next"),
  );
  const quiet = {
    channelId: "old",
    lastMessage: null,
    lastMessageAt: null,
    lastMessageAgentId: null,
  };
  for (const event of [
    { ...quiet, busy: true },
    { ...quiet, work: [] },
    { ...quiet, summary: "Quarterly report" },
    { ...quiet, opening: "Can you draft the report?" },
    { ...quiet, pinned: true },
  ]) {
    applyToBotLists(client, event);
    expect(client.getQueryState(channelKeys.byBot("a"))?.isInvalidated).toBe(
      false,
    );
  }
});

test("a busy event on a row past a Bot's first page patches it there, and reads nothing again", () => {
  const client = new QueryClient();
  const firstPage = [1, 2, 3, 4, 5].map((n) =>
    conversation(`p${n}`, ["a"], `2026-11-0${n}T10:00:00.000Z`),
  );
  client.setQueryData(channelKeys.byBot("a"), {
    pages: [
      { channels: firstPage, nextCursor: "next" },
      {
        channels: [conversation("late", ["a"], "2026-10-01T10:00:00.000Z")],
        nextCursor: null,
      },
    ],
    pageParams: ["", "next"],
  });
  applyToBotLists(client, {
    channelId: "late",
    lastMessage: null,
    lastMessageAt: null,
    lastMessageAgentId: null,
    busy: true,
  });
  expect(client.getQueryState(channelKeys.byBot("a"))?.isInvalidated).toBe(
    false,
  );
  const late = client
    .getQueryData<{ pages: { channels: ChannelSummary[] }[] }>(
      channelKeys.byBot("a"),
    )
    ?.pages[1]?.channels.find((channel) => channel.id === "late");
  expect(late?.busy).toBe(true);
});

test("a line in a conversation the roster is reading again for rereads only its Bots' lists once that read lands, and none for a task's thread", async () => {
  const client = new QueryClient();
  // The roster on screen, read from a server this test answers.
  let answer: ChannelSummary[] = [];
  const roster = new InfiniteQueryObserver(client, {
    queryKey: channelKeys.list(),
    initialPageParam: "",
    queryFn: async () => ({ channels: answer, nextCursor: null }),
    getNextPageParam: () => undefined,
  });
  const stop = roster.subscribe(() => {});
  await roster.refetch();
  client.setQueryData(channelKeys.byBot("a"), pageOf([]));
  client.setQueryData(channelKeys.byBot("b"), pageOf([]));
  const line = {
    lastMessage: "Done: the summary is in the doc.",
    lastMessageAt: "2026-11-09T10:00:00.000Z",
    lastMessageAgentId: "a",
  };

  // A task's thread: the roster, read again, still does not hold it, so no Bot's list does either.
  void client.invalidateQueries({ queryKey: channelKeys.list() });
  applyToBotLists(client, { ...line, channelId: "task-thread" });
  await roster.refetch({ cancelRefetch: false });
  await settleReactWork();
  expect(client.getQueryState(channelKeys.byBot("a"))?.isInvalidated).toBe(
    false,
  );
  expect(client.getQueryState(channelKeys.byBot("b"))?.isInvalidated).toBe(
    false,
  );

  // A new conversation with A: once the roster's read lands holding it, A's list is read again, and
  // B's is left alone.
  answer = [conversation("fresh", ["a"], line.lastMessageAt)];
  void client.invalidateQueries({ queryKey: channelKeys.list() });
  applyToBotLists(client, { ...line, channelId: "fresh" });
  await roster.refetch({ cancelRefetch: false });
  await settleReactWork();
  expect(client.getQueryState(channelKeys.byBot("a"))?.isInvalidated).toBe(
    true,
  );
  expect(client.getQueryState(channelKeys.byBot("b"))?.isInvalidated).toBe(
    false,
  );
  stop();
});
