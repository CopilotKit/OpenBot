import { describe, expect, test } from "bun:test";
import type { Message } from "@ag-ui/core";
import { mergeStoredMessages } from "../src/components/channels/channel-chat";

const call = (id: string) => ({
  id,
  type: "function" as const,
  function: {
    name: "mcp__composio-airtable__AIRTABLE_LIST_BASES",
    arguments: "{}",
  },
});

const question: Message = {
  id: "user-1",
  role: "user",
  content: "What bases do I have?",
};
const result: Message = {
  id: "result-1",
  role: "tool",
  toolCallId: "call_1",
  content: "Refused. Connect Airtable.",
};
const answer: Message = {
  id: "answer-1",
  role: "assistant",
  content: "Airtable is not connected.",
};

describe("mergeStoredMessages", () => {
  test("a stored tool call the live turn already holds under another id is not added again", () => {
    const local: Message[] = [
      question,
      { id: "call_1", role: "assistant", toolCalls: [call("call_1")] },
      result,
      answer,
    ];
    const stored: Message[] = [
      question,
      {
        id: "assistant-call_1",
        role: "assistant",
        toolCalls: [call("call_1")],
      },
      result,
      answer,
    ];
    expect(mergeStoredMessages(local, stored)).toBe(local);
  });

  test("a missing stored message still lands before the live message holding the same call", () => {
    const local: Message[] = [
      { id: "call_1", role: "assistant", toolCalls: [call("call_1")] },
      result,
    ];
    const stored: Message[] = [
      question,
      {
        id: "assistant-call_1",
        role: "assistant",
        toolCalls: [call("call_1")],
      },
      result,
    ];
    expect(mergeStoredMessages(local, stored).map((m) => m.id)).toEqual([
      "user-1",
      "call_1",
      "result-1",
    ]);
  });

  /*
   * A conversation moved to OpenBot Cloud and carried on there, reopened while the replay was still
   * coming in. Shapes as the gateway replays them and the store lists them: an imported turn's
   * thinking is `<assistant id>__r<n>`, and the store lists it at the end, with the later turn the
   * browser sent it back on. The screen held turns 0 to 2 when the store was read.
   */
  test("thinking the store lists with a later turn does not pull missing turns to the top", () => {
    const user = (id: string, content: string): Message => ({
      id,
      role: "user",
      content,
    });
    const said = (
      id: string,
      content: string | undefined,
      calls: string[] = [],
    ): Message => ({
      id,
      role: "assistant",
      ...(content === undefined ? {} : { content }),
      ...(calls.length > 0 ? { toolCalls: calls.map(call) } : {}),
    });
    const tool = (id: string, toolCallId: string): Message => ({
      id,
      role: "tool",
      toolCallId,
      content: "Results",
    });
    const thought = (id: string): Message => ({
      id,
      role: "reasoning",
      content: "Turn 0: I should look this up first.",
    });

    const turn0 = [
      user("20f0f2e0-5729-43ad-acab-6c7e2584c5d1", "Turn 0: go on."),
      said("assistant-gb0x-3", "Looking it up.", [
        "call-gb0x-4",
        "call-gb0x-6",
      ]),
      tool("tool-gb0x-5", "call-gb0x-4"),
      tool("tool-gb0x-7", "call-gb0x-6"),
      said("assistant-gb0x-9", undefined, ["call-gb0x-10"]),
      tool("tool-gb0x-11", "call-gb0x-10"),
      said("assistant-gb0x-13", "Here is turn 0's answer."),
    ];
    const turn1 = [
      user("0632c862-83bd-458e-82c3-6a8baeb75e0d", "Turn 1: go on."),
    ];
    const turn2 = [
      user("7ad14a82-b516-4b25-a304-ab8a69533d96", "Turn 2: go on."),
      said("assistant-gb0x-16", "Starting on it.", ["call-gb0x-17"]),
      tool("tool-gb0x-18", "call-gb0x-17"),
    ];
    const stillComing = [
      user("22cb628e-8df9-465c-900e-3fd9115e0cdc", "Turn 3: go on."),
      said("assistant-gb0x-19", undefined, ["call-gb0x-20"]),
      tool("tool-gb0x-21", "call-gb0x-20"),
      user(
        "3acbbd79-f953-45d8-a8b6-2de9e429e392",
        "Turn 3: only the European ones.",
      ),
      said("assistant-gb0x-22", "Only the European ones for turn 3."),
      user("a434b6a6-0f2d-4397-a595-8ccc30dd9c0d", "Thanks."),
      said("assistant-gb0x-338", "You're welcome."),
    ];
    const thinking = [
      thought("assistant-gb0x-3__r0"),
      thought("assistant-gb0x-3__r1"),
      thought("assistant-gb0x-3__r2"),
      thought("reasoning-gb0x-14__r0"),
    ];
    const carriedOn = [
      user("c1", "Cloud turn: what did we find so far?"),
      said("c2", "OK."),
    ];

    // The replay so far: the thinking sits where it was said.
    const local: Message[] = [
      turn0[0] as Message,
      ...thinking.slice(0, 3),
      ...turn0.slice(1),
      ...turn1,
      thinking[3] as Message,
      ...turn2,
    ];
    // The store: every turn in order, then the thinking the carried-on turn sent back, then it.
    const stored: Message[] = [
      ...turn0,
      ...turn1,
      ...turn2,
      ...stillComing,
      ...thinking,
      ...carriedOn,
    ];

    const words = (messages: Message[]) =>
      messages
        .filter((m) => m.role === "user" || m.role === "assistant")
        .map((m) => m.content)
        .filter((content) => typeof content === "string");
    expect(words(mergeStoredMessages(local, stored))).toEqual(words(stored));
  });

  test("a stored tool call the live turn does not hold is still added", () => {
    const local: Message[] = [question];
    const stored: Message[] = [
      question,
      {
        id: "assistant-call_2",
        role: "assistant",
        toolCalls: [call("call_2")],
      },
    ];
    expect(mergeStoredMessages(local, stored).map((m) => m.id)).toEqual([
      "user-1",
      "assistant-call_2",
    ]);
  });

  /*
   * Seen on OpenBot Cloud: a person came back to a conversation while its Bot was answering, and the
   * join replayed some of the answer's pieces and dropped the rest. The stored answer, from the
   * reply as it was first drawn; the screen held every other piece of it.
   */
  const STORED_ANSWER =
    "**The three options**\n\n- **A · The Ledger** is blue-black ink on pale green ledger paper, with a margin rule and Caslon headlines. It has a monthly-report visual and a Hands-on / Light touch switch.\n- **B · The Key Cabinet** is deep green with brass and stamped condensed numerals. A staggered statement layout replaces feature cards.";
  const piecesOf = (text: string) =>
    Array.from({ length: Math.ceil(text.length / 11) }, (_, index) =>
      text.slice(index * 11, index * 11 + 11),
    );

  test("an answer the screen holds in pieces reads as stored", () => {
    const pieces = piecesOf(STORED_ANSWER);
    const inPieces = pieces.filter((_, index) => index % 2 === 0).join("");
    const local: Message[] = [
      question,
      { id: "answer-1", role: "assistant", content: inPieces },
    ];
    const stored: Message[] = [
      question,
      { id: "answer-1", role: "assistant", content: STORED_ANSWER },
    ];
    expect(mergeStoredMessages(local, stored)).toEqual(stored);
  });

  test("a store behind the screen never cuts an answer short", () => {
    const local: Message[] = [
      question,
      { id: "answer-1", role: "assistant", content: STORED_ANSWER },
    ];
    const behind: Message[] = [
      question,
      {
        id: "answer-1",
        role: "assistant",
        content: STORED_ANSWER.slice(0, 60),
      },
    ];
    expect(mergeStoredMessages(local, behind)).toBe(local);
  });
});
