import { expect, test } from "bun:test";
import {
  hasUnseenActivity,
  isUnread,
} from "../src/components/app-sidebar/app-sidebar";
import type { ChannelSummary } from "../src/lib/channels/queries";

/** A minimal but fully-typed summary, so tests build real objects rather than casts. */
function channel(overrides: Partial<ChannelSummary>): ChannelSummary {
  return {
    id: "channel-1",
    name: "Assistant channel",
    agentIds: ["agent-1"],
    threadId: "thread-1",
    active: true,
    lastMessage: "hello",
    lastMessageAt: "2026-08-25T12:00:00.000Z",
    lastMessageAgentId: "agent-1",
    createdAt: "2026-08-25T11:00:00.000Z",
    pinned: false,
    lastReadAt: null,
    ...overrides,
  };
}

test("a Bot message in a never-opened channel is unseen", () => {
  expect(hasUnseenActivity(channel({}))).toBe(true);
});

test("a Bot message newer than the read marker is unseen", () => {
  expect(
    hasUnseenActivity(channel({ lastReadAt: "2026-08-25T11:30:00.000Z" })),
  ).toBe(true);
});

test("a read marker after the last message means nothing is unseen", () => {
  expect(
    hasUnseenActivity(channel({ lastReadAt: "2026-08-25T12:30:00.000Z" })),
  ).toBe(false);
});

test("your own last message never counts as unseen", () => {
  expect(hasUnseenActivity(channel({ lastMessageAgentId: null }))).toBe(false);
});

test("a silent channel has nothing unseen", () => {
  expect(
    hasUnseenActivity(
      channel({
        lastMessage: null,
        lastMessageAt: null,
        lastMessageAgentId: null,
      }),
    ),
  ).toBe(false);
});

test("the open channel is never unread, however unseen its activity", () => {
  expect(isUnread(channel({}), "channel-1")).toBe(false);
  expect(isUnread(channel({}), "channel-2")).toBe(true);
  expect(isUnread(channel({}), undefined)).toBe(true);
});
