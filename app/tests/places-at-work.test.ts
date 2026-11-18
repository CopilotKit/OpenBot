import { expect, test } from "bun:test";
import type { ChannelSummary, ChannelWork } from "@/lib/channels/queries";
import { atWork } from "@/lib/places/at-work";
import { type NeedsYouEntry, recentFor } from "@/lib/places/openbot-sections";
import type { ListedTask } from "@/lib/tasks/groups";
import type { BotTask, TaskStatus } from "@/lib/tasks/queries";

/*
 * What For you lists under Working on (work that runs on its own, one row per conversation), and
 * the conversations its Recent lists after that.
 */

function channel(overrides: Partial<ChannelSummary>): ChannelSummary {
  return {
    id: "c1",
    name: "Assistant",
    agentIds: ["b1"],
    threadId: "thread-1",
    active: true,
    summary: null,
    lastMessage: null,
    lastMessageAt: null,
    lastMessageAgentId: null,
    createdAt: "2026-11-17T09:00:00.000Z",
    pinned: false,
    lastReadAt: null,
    ...overrides,
  };
}

function handoff(since: string): ChannelWork {
  return {
    kind: "handoff",
    key: `h-${since}`,
    botId: "b2",
    botName: null,
    since,
  };
}

function listed(
  status: TaskStatus,
  overrides: Partial<BotTask> = {},
): ListedTask {
  const task: BotTask = {
    id: "t1",
    agentId: "b1",
    channelId: "t1-channel",
    threadId: null,
    title: "A task",
    why: null,
    origin: "check_in",
    suggestionId: null,
    sourceApp: null,
    sourceLink: null,
    originChannelId: null,
    status,
    failure: null,
    failedAt: null,
    next: null,
    resolvedAt: null,
    createdAt: "2026-11-17T09:00:00.000Z",
    updatedAt: "2026-11-17T09:00:00.000Z",
    ...overrides,
  };
  return { task, status };
}

test("a conversation with owed work is a row, and one only answering the person is not", () => {
  const rows = atWork(
    [
      channel({ id: "c1", busy: true, work: undefined }),
      channel({ id: "c2", busy: true, work: [] }),
      channel({
        id: "c3",
        busy: false,
        work: [handoff("2026-11-17T10:00:00Z")],
      }),
    ],
    [],
  );
  expect(rows.map((row) => row.channelId)).toEqual(["c3"]);
});

test("a working task whose conversation is in the list too is listed once", () => {
  const rows = atWork(
    [channel({ id: "c1", work: [handoff("2026-11-17T10:00:00Z")] })],
    [listed("working", { channelId: "c1" })],
  );
  expect(rows).toHaveLength(1);
  expect(rows[0]?.channelId).toBe("c1");
});

test("a working task whose conversation is not in the list is still listed", () => {
  const rows = atWork(
    [],
    [
      listed("working", {
        channelId: "t9",
        agentId: "b1",
        title: "Draft the brief",
      }),
    ],
  );
  expect(rows).toEqual([
    {
      channelId: "t9",
      agentIds: ["b1"],
      title: "Draft the brief",
      work: [],
      since: null,
      group: false,
    },
  ]);
});

test("idle conversations and tasks that are not working are left out", () => {
  const rows = atWork(
    [channel({ id: "c1", busy: false, work: [] })],
    [
      listed("ready_for_review", { channelId: "a" }),
      listed("needs_input", { channelId: "b" }),
      listed("failed", { channelId: "c" }),
      listed("resolved", { channelId: "d" }),
    ],
  );
  expect(rows).toEqual([]);
});

test("the longest-running comes first", () => {
  const rows = atWork(
    [
      channel({ id: "late", work: [handoff("2026-11-17T10:05:00Z")] }),
      channel({ id: "early", work: [handoff("2026-11-17T10:00:00Z")] }),
    ],
    [
      listed("working", { channelId: "none-1" }),
      listed("working", { channelId: "none-2" }),
    ],
  );
  expect(rows.map((row) => row.channelId)).toEqual([
    "early",
    "late",
    "none-1",
    "none-2",
  ]);
});

test("Recent keeps used conversations, newest first, eight at most, and none listed above it", () => {
  const used = (id: string, extra: Partial<ChannelSummary> = {}) =>
    channel({
      id,
      threadId: `thread-${id}`,
      lastMessageAt: "2026-11-17T10:00:00Z",
      ...extra,
    });
  const channels = [
    used("asked"),
    used("running", { work: [handoff("2026-11-17T10:00:00Z")] }),
    used("a"),
    used("questioned"),
    channel({ id: "never-used", lastMessageAt: null }),
    used("tasked"),
    ...["b", "c", "d", "e", "f", "g", "h", "i"].map((id) => used(id)),
  ];
  const entries = [
    {
      kind: "question",
      id: "q",
      botId: "b1",
      at: "2026-11-17T10:00:00Z",
      question: { channelId: "questioned", threadId: "thread-questioned" },
    },
    {
      kind: "request",
      id: "r",
      botId: "b1",
      at: "2026-11-17T10:00:00Z",
      request: { action: { threadId: "thread-asked" } },
    },
    {
      kind: "task",
      id: "t",
      botId: "b1",
      at: "2026-11-17T10:00:00Z",
      listed: listed("needs_input", { channelId: "tasked" }),
    },
  ] as unknown as NeedsYouEntry[];
  const working = atWork(channels, []);

  expect(
    recentFor(channels, entries, working).map((found) => found.id),
  ).toEqual(["a", "b", "c", "d", "e", "f", "g", "h"]);
  expect(recentFor([], [], [])).toEqual([]);
});
