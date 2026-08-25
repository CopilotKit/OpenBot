import { describe, expect, test } from "bun:test";
import type { ChannelPage, ChannelSummary } from "../src/lib/channels/queries";
import {
  applyChannelEvent,
  type ChannelActivityEvent,
} from "../src/lib/channels/use-channel-events";

/** A minimal but fully-typed channel summary, so tests build real objects rather than casts. */
function channel(
  id: string,
  overrides: Partial<ChannelSummary> = {},
): ChannelSummary {
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
    pinned: false,
    ...overrides,
  };
}

function cache(...pages: ChannelSummary[][]) {
  return {
    pages: pages.map(
      (channels): ChannelPage => ({ channels, nextCursor: null }),
    ),
    pageParams: pages.map(() => ""),
  };
}

function event(
  overrides: Partial<ChannelActivityEvent> & { channelId: string },
): ChannelActivityEvent {
  return {
    lastMessage: null,
    lastMessageAt: null,
    lastMessageAgentId: null,
    ...overrides,
  };
}

describe("an ordinary activity event", () => {
  test("patches the row inside the page that holds it and re-sorts that page", () => {
    const data = cache([
      channel("a", { lastMessageAt: "2024-03-01T00:00:00.000Z" }),
      channel("b"),
    ]);

    const patched = applyChannelEvent(
      data,
      event({
        channelId: "b",
        lastMessage: "Said something.",
        lastMessageAt: "2024-04-01T00:00:00.000Z",
      }),
    );

    expect(patched).not.toBe("unknown");
    if (patched === "unknown") return;
    expect(patched.pages[0]?.channels.map((row) => row.id)).toEqual(["b", "a"]);
    expect(patched.pages[0]?.channels[0]?.lastMessage).toBe("Said something.");
  });

  test("is unknown when no page holds the channel, so the caller refetches", () => {
    expect(
      applyChannelEvent(cache([channel("a")]), event({ channelId: "z" })),
    ).toBe("unknown");
  });
});

/**
 * A channel somebody deleted in another tab, or on another replica.
 *
 * The tab that issued the delete moves itself; every other tab only ever hears about it here, so
 * without this the row stays on their roster until something else makes them refetch.
 */
describe("a deleted channel", () => {
  test("is removed from the page that held it", () => {
    const data = cache([channel("a"), channel("b")], [channel("c")]);

    const patched = applyChannelEvent(
      data,
      event({ channelId: "b", deleted: true }),
    );

    expect(patched).not.toBe("unknown");
    if (patched === "unknown") return;
    expect(patched.pages[0]?.channels.map((row) => row.id)).toEqual(["a"]);
    // The other page is untouched, object identity included, so its rows do not re-render.
    expect(patched.pages[1]).toBe(data.pages[1]);
  });

  test("is never spread onto the row instead of removing it", () => {
    const patched = applyChannelEvent(
      cache([channel("a")]),
      event({ channelId: "a", deleted: true }),
    );

    expect(patched).not.toBe("unknown");
    if (patched === "unknown") return;
    // The failure this guards is a row left on the roster carrying `deleted: true`, which renders
    // as an ordinary channel whose every query now 404s.
    expect(patched.pages[0]?.channels).toEqual([]);
  });

  test("changes nothing when this cache never had the channel", () => {
    const data = cache([channel("a")]);

    // Unlike an ordinary event, an unknown id here is not a stale roster: the channel is already
    // gone from this cache, so there is nothing to patch and nothing to refetch for.
    expect(
      applyChannelEvent(data, event({ channelId: "z", deleted: true })),
    ).toBe(data);
  });
});

/**
 * A pin this person made in one of their own tabs.
 *
 * Scoped to them by the server, so arriving here means it is the reader's own pin.
 */
describe("a pin", () => {
  test("patches only the pinned flag, leaving the last message alone", () => {
    const data = cache([
      channel("a", {
        lastMessage: "Said something.",
        lastMessageAt: "2024-04-01T00:00:00.000Z",
        lastMessageAgentId: "agent-1",
      }),
    ]);

    const patched = applyChannelEvent(
      data,
      event({ channelId: "a", pinned: true }),
    );

    expect(patched).not.toBe("unknown");
    if (patched === "unknown") return;
    expect(patched.pages[0]?.channels[0]).toEqual({
      ...(data.pages[0]?.channels[0] as ChannelSummary),
      pinned: true,
    });
  });

  test("unpins the same way", () => {
    const patched = applyChannelEvent(
      cache([channel("a", { pinned: true })]),
      event({ channelId: "a", pinned: false }),
    );

    expect(patched).not.toBe("unknown");
    if (patched === "unknown") return;
    expect(patched.pages[0]?.channels[0]?.pinned).toBe(false);
  });

  test("returns the same cache when the row already says so", () => {
    const data = cache([channel("a", { pinned: true })]);

    // A duplicate, or the tab that made the pin hearing its own event back. Identity preserved, so
    // React re-renders nothing at all.
    expect(
      applyChannelEvent(data, event({ channelId: "a", pinned: true })),
    ).toBe(data);
  });
});
