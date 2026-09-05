import { expect, test } from "bun:test";
import { matchingChannels } from "../src/components/app-sidebar/app-sidebar";
import type { ChannelSummary } from "../src/lib/channels/queries";

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
