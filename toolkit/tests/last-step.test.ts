import { describe, expect, test } from "bun:test";
import type { BaseEvent } from "@ag-ui/client";
import {
  BuiltInAgent,
  type BuiltInAgentConfiguration,
} from "@copilotkit/runtime/v2";
import { BuiltInAgentWithSaneHistory } from "../src/copilotkit/agents";
import { parametersFor } from "../src/granted-tool";
import { answersOnLastStep } from "../src/copilotkit/last-step";

/**
 * A run stops after `maxSteps` model steps. A Bot that searched once per step spent all of them on
 * searches and its run ended on the last search's results with nothing said: a subtask that "did not
 * finish", then its Bot did the same. The last step is now sent with no tool to choose.
 */

const usage = {
  inputTokens: {
    total: 1,
    noCache: 1,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};

type Call = { toolChoice?: { type: string }; turns: number };

/** A model that searches on every step it is allowed to, and answers only when it may not. */
function searchingForever(calls: Call[]) {
  return {
    specificationVersion: "v3" as const,
    provider: "fake",
    modelId: "fake",
    supportedUrls: {},
    doGenerate: async () => {
      throw new Error("Only streamed here.");
    },
    doStream: async (options: {
      toolChoice?: { type: string };
      prompt: { role: string }[];
    }) => {
      calls.push({
        ...(options.toolChoice ? { toolChoice: options.toolChoice } : {}),
        turns: options.prompt.filter((message) => message.role === "assistant")
          .length,
      });
      const parts =
        options.toolChoice?.type === "none"
          ? [
              { type: "stream-start", warnings: [] },
              { type: "text-start", id: "text" },
              {
                type: "text-delta",
                id: "text",
                delta: "Here is what I found.",
              },
              { type: "text-end", id: "text" },
              {
                type: "finish",
                finishReason: { unified: "stop", raw: "stop" },
                usage,
              },
            ]
          : [
              { type: "stream-start", warnings: [] },
              {
                type: "tool-call",
                toolCallId: `call-${calls.length}`,
                toolName: "search",
                input: "{}",
              },
              {
                type: "finish",
                finishReason: { unified: "tool-calls", raw: "tool_calls" },
                usage,
              },
            ];
      return {
        stream: new ReadableStream({
          start(controller) {
            for (const part of parts) controller.enqueue(part);
            controller.close();
          },
        }),
      };
    },
  };
}

function configuration(calls: Call[]): BuiltInAgentConfiguration {
  return {
    model: searchingForever(calls) as never,
    prompt: "Find things.",
    maxSteps: 3,
    tools: [
      {
        name: "search",
        description: "Search the web.",
        parameters: parametersFor({ type: "object", properties: {} } as never),
        execute: async () => "A result.",
      },
    ],
  } as BuiltInAgentConfiguration;
}

async function said(agent: BuiltInAgent): Promise<string> {
  agent.threadId = "thread";
  agent.setMessages([{ id: "ask", role: "user", content: "Find five." }]);
  let text = "";
  await agent.runAgent(
    {},
    {
      onEvent: ({ event }: { event: BaseEvent }) => {
        if (event.type === "TEXT_MESSAGE_CONTENT")
          text += (event as BaseEvent & { delta: string }).delta;
      },
    },
  );
  return text;
}

describe("a run's last step", () => {
  test("a Bot that would search forever answers on the last step it is allowed", async () => {
    const calls: Call[] = [];
    const agent = new BuiltInAgentWithSaneHistory(configuration(calls), {
      observe: (run) => run,
    });
    expect(await said(agent)).toBe("Here is what I found.");
    expect(calls.map((call) => call.toolChoice?.type)).toEqual([
      "auto",
      "auto",
      "none",
    ]);
  });

  test("without it, the same run ends on a search with nothing said", async () => {
    const calls: Call[] = [];
    expect(await said(new BuiltInAgent(configuration(calls)))).toBe("");
    expect(calls).toHaveLength(3);
  });

  test("a step sent again with the same prompt is the same step, so a retry does not use one up", async () => {
    const calls: Call[] = [];
    const wrapped = answersOnLastStep(configuration(calls), {});
    if ("factory" in wrapped) throw new Error("Expected a model.");
    const model = wrapped.model as ReturnType<typeof searchingForever>;
    const prompt = [{ role: "user" }];
    await model.doStream({ prompt });
    await model.doStream({ prompt });
    await model.doStream({ prompt: [...prompt, { role: "assistant" }] });
    expect(calls.map((call) => call.toolChoice?.type)).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
    await model.doStream({
      prompt: [...prompt, { role: "assistant" }, { role: "assistant" }],
    });
    expect(calls.at(-1)?.toolChoice?.type).toBe("none");
  });

  test("a run counts from where it starts, not from the conversation before it", async () => {
    const calls: Call[] = [];
    const agent = new BuiltInAgentWithSaneHistory(configuration(calls), {
      observe: (run) => run,
    });
    agent.threadId = "thread";
    // A long conversation already: four earlier turns that each used a tool.
    agent.setMessages([
      ...[1, 2, 3, 4].flatMap((n) => [
        {
          id: `call-message-${n}`,
          role: "assistant" as const,
          content: "",
          toolCalls: [
            {
              id: `earlier-${n}`,
              type: "function" as const,
              function: { name: "search", arguments: "{}" },
            },
          ],
        },
        {
          id: `result-${n}`,
          role: "tool" as const,
          toolCallId: `earlier-${n}`,
          content: "A result.",
        },
      ]),
      { id: "ask", role: "user", content: "Find five." },
    ]);
    await agent.runAgent({}, {});
    expect(calls.map((call) => call.toolChoice?.type)).toEqual([
      "auto",
      "auto",
      "none",
    ]);
  });

  test("the runtime still names where the model is hosted", () => {
    const named = { ...configuration([]), model: "openai/gpt-5.6-terra" };
    const agent = new BuiltInAgentWithSaneHistory(
      { ...named, apiKey: "test" } as BuiltInAgentConfiguration,
      { observe: (run) => run },
    );
    expect(agent.modelHostClass).toBe(
      new BuiltInAgent(named as BuiltInAgentConfiguration).modelHostClass,
    );
  });
});
