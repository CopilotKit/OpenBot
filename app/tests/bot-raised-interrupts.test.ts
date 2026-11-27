import { describe, expect, test } from "bun:test";
import type { Message } from "@ag-ui/core";
import { OPENBOT_WAITING_METADATA } from "@openbot/shared/waiting";
import {
  answersFor,
  asksForApproval,
  botRaisedInterrupts,
  interruptedCall,
} from "@/lib/copilot/bot-raised-interrupts";

const yesOrNo = {
  type: "object",
  properties: { approved: { type: "boolean" } },
  required: ["approved"],
};
/** What a Strands harness sends when it asks before running one of its own tools. */
const fromTheBot = {
  id: "int-1",
  reason: "tool_call",
  toolCallId: "call-1",
  responseSchema: yesOrNo,
};
const fromTheServer = {
  id: "call-2",
  reason: "human_input",
  metadata: { [OPENBOT_WAITING_METADATA]: { requestId: "r1" } },
};
const aQuestion = {
  id: "int-3",
  reason: "input_required",
  responseSchema: { type: "object", properties: { city: { type: "string" } } },
};

describe("a wait the Bot raised itself", () => {
  test("is told apart from one the server answers", () => {
    expect(botRaisedInterrupts([fromTheBot, fromTheServer])).toEqual([
      fromTheBot,
    ]);
  });

  test("asks yes or no when its one required answer is the boolean `approved`", () => {
    expect(asksForApproval(fromTheBot)).toBe(true);
    expect(asksForApproval(aQuestion)).toBe(false);
    expect(asksForApproval({ id: "bare" })).toBe(false);
    expect(
      asksForApproval({
        id: "more",
        responseSchema: { ...yesOrNo, required: ["approved", "reason"] },
      }),
    ).toBe(false);
  });

  test("names the call it is about, from the conversation", () => {
    const messages: Message[] = [
      { id: "u", role: "user", content: "run it" },
      {
        id: "a",
        role: "assistant",
        toolCalls: [
          {
            id: "call-1",
            type: "function",
            function: { name: "shell", arguments: '{"command":"ls"}' },
          },
        ],
      },
    ];
    expect(interruptedCall(fromTheBot, messages)).toEqual({
      name: "shell",
      args: '{"command":"ls"}',
    });
    expect(interruptedCall(aQuestion, messages)).toBeUndefined();
  });

  test("is answered with the decision, and the server's waits are left to the server", () => {
    expect(answersFor([fromTheBot, fromTheServer], true)).toEqual([
      { interruptId: "int-1", status: "resolved", payload: { approved: true } },
    ]);
    expect(answersFor([fromTheBot], false)).toEqual([
      {
        interruptId: "int-1",
        status: "resolved",
        payload: { approved: false },
      },
    ]);
  });

  test("is cancelled when its answer is not a yes or no, so the conversation can go on", () => {
    expect(answersFor([aQuestion], true)).toEqual([
      { interruptId: "int-3", status: "cancelled" },
    ]);
  });
});
