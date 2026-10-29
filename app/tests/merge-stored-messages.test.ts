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
});
