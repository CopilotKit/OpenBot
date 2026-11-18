import { describe, expect, test } from "bun:test";
import type { AgentProfile } from "@/lib/agents/queries";
import type { ChannelSummary } from "@/lib/channels/queries";
import {
  groupConversations,
  kiteBots,
  needingYou,
  openBotId,
  skyLine,
  skyOrder,
} from "@/skins/kitebot/roster";
import { attentionOf } from "./bots-api";

/*
 * What Kite Bot's sidebar and Sky say about each Bot, from the three things OpenBot already loads:
 * the Bots, the conversations, and what waits on the person.
 */

function bot(id: string, name: string, more: Partial<AgentProfile> = {}) {
  return {
    id,
    name,
    title: "",
    avatarSeed: id,
    hidden: false,
    pinned: false,
    ...more,
  } as AgentProfile;
}

function conversation(
  id: string,
  agentIds: string[],
  more: Partial<ChannelSummary> = {},
): ChannelSummary {
  return {
    id,
    name: "",
    agentIds,
    threadId: `t-${id}`,
    active: true,
    lastMessageAt: "2026-11-17T10:00:00.000Z",
    summary: id,
    lastMessage: null,
    lastMessageAgentId: null,
    createdAt: "2026-11-01T10:00:00.000Z",
    pinned: false,
    lastReadAt: "2026-11-17T10:00:00.000Z",
    ...more,
  };
}

const BOTS = [
  bot("b-scout", "Scout"),
  bot("b-ledger", "Ledger"),
  bot("b-ivy", "Ivy"),
  bot("b-hidden", "Archive", { hidden: true }),
];

describe("each Bot's state", () => {
  test("waiting beats working, and a Bot with neither is idle", () => {
    const rows = kiteBots(
      BOTS,
      [
        conversation("c-1", ["b-scout"], { busy: true }),
        conversation("c-2", ["b-ledger"], { busy: true }),
      ],
      [attentionOf("b-ledger", "Ledger", { approvals: 2, questions: 1 })],
    );
    const state = Object.fromEntries(
      rows.map((one) => [one.bot.name, one.state]),
    );
    expect(state).toEqual({ Ivy: "idle", Ledger: "waiting", Scout: "working" });
    expect(rows.find((one) => one.bot.name === "Ledger")?.waiting).toBe(3);
  });

  test("a Bot working in a group conversation is working", () => {
    const rows = kiteBots(
      BOTS,
      [conversation("g-1", ["b-scout", "b-ivy"], { busy: true })],
      [],
    );
    expect(rows.find((one) => one.bot.name === "Ivy")?.state).toBe("working");
  });

  test("Bots hidden from the list are left out, and the rest stay in a steady order", () => {
    const rows = kiteBots(
      [...BOTS, bot("b-pinned", "Zed", { pinned: true })],
      [],
      [],
    );
    expect(rows.map((one) => one.bot.name)).toEqual([
      "Zed",
      "Ivy",
      "Ledger",
      "Scout",
    ]);
  });

  test("its conversations are the ones with it alone, pinned first, then newest first", () => {
    const rows = kiteBots(
      BOTS,
      [
        conversation("old", ["b-scout"], {
          lastMessageAt: "2026-11-10T10:00:00.000Z",
        }),
        conversation("new", ["b-scout"], {
          lastMessageAt: "2026-11-17T10:00:00.000Z",
        }),
        conversation("pinned", ["b-scout"], {
          lastMessageAt: "2026-11-01T10:00:00.000Z",
          pinned: true,
        }),
        conversation("group", ["b-scout", "b-ivy"]),
      ],
      [],
    );
    const scout = rows.find((one) => one.bot.name === "Scout");
    expect(scout?.conversations.map((one) => one.id)).toEqual([
      "pinned",
      "new",
      "old",
    ]);
    expect(scout?.lastActiveAt).toBe("2026-11-17T10:00:00.000Z");
  });

  test("unread is a Bot's message the person has not seen, never in the conversation on screen", () => {
    const unseen = conversation("c-1", ["b-ivy"], {
      lastMessageAgentId: "b-ivy",
      lastMessageAt: "2026-11-17T11:00:00.000Z",
      lastReadAt: "2026-11-17T10:00:00.000Z",
    });
    const ownWords = conversation("c-2", ["b-scout"], {
      lastMessageAgentId: null,
      lastReadAt: null,
    });
    const ivy = (open?: string) =>
      kiteBots(BOTS, [unseen, ownWords], [], open).find(
        (one) => one.bot.name === "Ivy",
      );
    expect(ivy()?.unread).toBe(true);
    expect(ivy("c-1")?.unread).toBe(false);
    expect(
      kiteBots(BOTS, [unseen, ownWords], []).find(
        (one) => one.bot.name === "Scout",
      )?.unread,
    ).toBe(false);
  });
});

test("Needs you lists the Bots that wait on the person, most waiting first", () => {
  const rows = kiteBots(
    BOTS,
    [],
    [
      attentionOf("b-scout", "Scout", { questions: 1 }),
      attentionOf("b-ivy", "Ivy", { approvals: 3, waitingIn: "c-9" }),
    ],
  );
  const needs = needingYou(rows);
  expect(
    needs.map((one) => [one.bot.name, one.waiting, one.waitingIn]),
  ).toEqual([
    ["Ivy", 3, "c-9"],
    ["Scout", 1, null],
  ]);
});

test("Groups are the conversations with more than one Bot, newest first", () => {
  const groups = groupConversations([
    conversation("solo", ["b-ivy"]),
    conversation("g-old", ["b-ivy", "b-scout"], {
      lastMessageAt: "2026-11-02T10:00:00.000Z",
    }),
    conversation("g-new", ["b-ivy", "b-ledger"], {
      lastMessageAt: "2026-11-16T10:00:00.000Z",
    }),
  ]);
  expect(groups.map((one) => one.id)).toEqual(["g-new", "g-old"]);
});

test("the Sky puts what needs you first, then what is working, then the busiest", () => {
  const rows = kiteBots(
    [...BOTS, bot("b-quiet", "Quill")],
    [
      conversation("c-scout", ["b-scout"], { busy: true }),
      conversation("c-ivy", ["b-ivy"], {
        lastMessageAt: "2026-11-17T12:00:00.000Z",
      }),
    ],
    [attentionOf("b-ledger", "Ledger", { questions: 1 })],
  );
  expect(skyOrder(rows).map((one) => one.bot.name)).toEqual([
    "Ledger",
    "Scout",
    "Ivy",
    "Quill",
  ]);
});

test("the Sky's line under each name says what the Bot is doing", () => {
  const rows = kiteBots(
    [...BOTS, bot("b-new", "Quill", { title: "Writer" })],
    [
      conversation("c-scout", ["b-scout"], { busy: true }),
      conversation("c-ivy", ["b-ivy"]),
    ],
    [
      attentionOf("b-ledger", "Ledger", { approvals: 2 }),
      attentionOf("b-ivy", "Ivy", { paused: true }),
    ],
  );
  const line = (name: string) =>
    skyLine(
      rows.find((one) => one.bot.name === name) ?? rows[0],
      () => "3h ago",
    );
  expect(line("Ledger")).toBe("Waiting on you · 2");
  expect(line("Scout")).toBe("Working");
  expect(line("Ivy")).toBe("Paused");
  expect(line("Quill")).toBe("Writer");
});

test("the Bot the sidebar opens out is the one on screen", () => {
  const channels = [
    conversation("c-1", ["b-scout"]),
    conversation("g-1", ["b-scout", "b-ivy"]),
  ];
  expect(openBotId("/channel/c-1", channels)).toBe("b-scout");
  expect(openBotId("/group/g-1", channels)).toBeNull();
  expect(openBotId("/bots/b-ivy/memory", channels)).toBe("b-ivy");
  expect(openBotId("/routines", channels)).toBeNull();
});
