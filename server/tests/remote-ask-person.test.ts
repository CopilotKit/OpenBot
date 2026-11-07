import { expect, spyOn, test } from "bun:test";
import {
  type BaseEvent,
  EventType,
  HttpAgent,
  type RunAgentInput,
} from "@ag-ui/client";
import type { GrantedTool } from "@openbot/toolkit/granted-tool";
import { from } from "rxjs";
import { z } from "zod";
import { buildAgents } from "../src/copilot";

/*
 * A Bot at an endpoint that runs every tool through the AG-UI client lifecycle, as the Claude Agent
 * SDK harness does: it streams the call and ends its run, and the caller answers it. The Claude-plan
 * starter Bot is one. Its `ask_person` used to reach the browser unanswered, so no question was
 * saved, the person saw no notice, and their reply was taken as the interrupted call's result.
 */
const QUESTION = "Which page URL should I open in the browser?";
const PUT_TO_PERSON =
  "Put to the person in the source conversation; the question is saved awaiting their reply";

async function fixture({ callsBack = false } = {}) {
  const requests: RunAgentInput[] = [];
  const run = spyOn(HttpAgent.prototype, "run").mockImplementation((input) => {
    requests.push(input);
    const answered = input.messages.some(
      (message) => message.role === "tool" && message.toolCallId === "ask-call",
    );
    if (answered)
      return from<BaseEvent[]>([
        {
          type: EventType.RUN_STARTED,
          threadId: input.threadId,
          runId: input.runId,
        },
        {
          type: EventType.TEXT_MESSAGE_START,
          messageId: "after-asking",
          role: "assistant",
        },
        {
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: "after-asking",
          delta: "I've asked you which page to open.",
        },
        { type: EventType.TEXT_MESSAGE_END, messageId: "after-asking" },
        {
          type: EventType.RUN_FINISHED,
          threadId: input.threadId,
          runId: input.runId,
        },
      ]);
    return from<BaseEvent[]>([
      {
        type: EventType.RUN_STARTED,
        threadId: input.threadId,
        runId: input.runId,
      },
      {
        type: EventType.TOOL_CALL_START,
        toolCallId: "ask-call",
        toolCallName: "ask_person",
        parentMessageId: "asking",
      },
      {
        type: EventType.TOOL_CALL_ARGS,
        toolCallId: "ask-call",
        delta: JSON.stringify({ question: QUESTION }),
      },
      { type: EventType.TOOL_CALL_END, toolCallId: "ask-call" },
      // An endpoint that calls OpenBot back for coordination answers the call itself.
      ...(callsBack
        ? [
            {
              type: EventType.TOOL_CALL_RESULT,
              messageId: "callback-result",
              toolCallId: "ask-call",
              content: PUT_TO_PERSON,
              role: "tool" as const,
            },
          ]
        : []),
      {
        type: EventType.RUN_FINISHED,
        threadId: input.threadId,
        runId: input.runId,
      },
    ]);
  });
  const asked: unknown[] = [];
  const askPerson: GrantedTool = {
    name: "ask_person",
    ref: "bot/ask_person",
    description: "Ask the person",
    parameters: z.object({ question: z.string() }),
    execute: async (args) => {
      asked.push(args);
      return PUT_TO_PERSON;
    },
  };
  const args: Parameters<typeof buildAgents> = [
    [
      {
        id: "picked-harness",
        name: "Claude Agent SDK",
        type: "remote_ag_ui",
        endpoint: "https://harness.test/",
        standingMessage: {
          id: "standing-role:picked-harness",
          role: "system",
          content: "Answer questions and do work.",
        },
      },
    ],
    { provider: "openai", defaultModel: "test" },
    null,
  ];
  args[5] = () => "signed-run";
  args[10] = async () => [askPerson];
  const agent = (await buildAgents(...args))["picked-harness"];
  if (!agent) throw new Error("Missing fixture agent");
  agent.threadId = "conversation-thread";
  agent.messages = [
    {
      id: "person-message",
      role: "user",
      content: "Help me read a page. Ask me for its URL.",
    },
  ];
  return { run, requests, agent, asked };
}

test("a Bot that hands its tool calls back has its question to the person put by OpenBot", async () => {
  const f = await fixture();
  try {
    const result = await f.agent.runAgent({ runId: "asking-run" });
    // Saved for the person, exactly once, with the Bot's own words.
    expect(f.asked).toEqual([{ question: QUESTION }]);
    // The Bot heard where its question went, and finished its turn on that.
    expect(f.requests).toHaveLength(2);
    expect(
      f.requests[1]?.messages.find(
        (message) =>
          message.role === "tool" && message.toolCallId === "ask-call",
      )?.content,
    ).toBe(PUT_TO_PERSON);
    // Nothing is left for the browser to answer, which is what lost the person's reply.
    const toolResults = result.newMessages.filter(
      (message) => message.role === "tool",
    );
    expect(toolResults.map((message) => message.toolCallId)).toContain(
      "ask-call",
    );
    // An endpoint that calls back for coordination is still told it may.
    expect(f.requests[0]?.forwardedProps.openbotDeploymentTools).toContain(
      "ask_person",
    );
  } finally {
    f.run.mockRestore();
  }
});

test("a question the endpoint already put through the callback is not asked twice", async () => {
  const f = await fixture({ callsBack: true });
  try {
    await f.agent.runAgent({ runId: "asking-run" });
    expect(f.asked).toEqual([]);
    expect(f.requests).toHaveLength(1);
  } finally {
    f.run.mockRestore();
  }
});
