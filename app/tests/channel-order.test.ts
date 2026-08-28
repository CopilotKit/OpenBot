import { expect, test } from "bun:test";
import { pinnedFirst } from "../src/components/app-sidebar/app-sidebar";
import type { ChannelSummary } from "../src/lib/channels/queries";

/** A minimal but fully-typed channel summary, so tests build real objects rather than casts. */
function channel(id: string, pinned: boolean): ChannelSummary {
  return {
    id,
    name: id,
    agentIds: [],
    threadId: `thread-${id}`,
    active: true,
    lastMessage: null,
    lastMessageAt: null,
    lastMessageAgentId: null,
    createdAt: "2024-01-01T00:00:00.000Z",
    pinned,
    lastReadAt: null,
  };
}

test("holds pinned channels at the top, newest-activity order preserved within each group", () => {
  /*
   * Interleaved, which is what the cache can hold between refetches: the server hands back
   * pinned-first, and then the socket patches a pin onto a loaded row without moving it, or re-sorts
   * a page by recency alone. This function is the render-level mirror that closes that window.
   */
  const channels = [
    channel("a", false),
    channel("b", true),
    channel("c", false),
    channel("d", true),
    channel("e", false),
  ];

  expect(pinnedFirst(channels).map((c) => c.id)).toEqual([
    "b",
    "d",
    "a",
    "c",
    "e",
  ]);
});

test("leaves an all-unpinned roster in its original order", () => {
  const channels = [
    channel("a", false),
    channel("b", false),
    channel("c", false),
  ];

  expect(pinnedFirst(channels).map((c) => c.id)).toEqual(["a", "b", "c"]);
});
