import { expect, test } from "bun:test";
import type { Message } from "@ag-ui/client";
import type { BuiltInAgentConfiguration } from "@copilotkit/runtime/v2";
import { BuiltInAgentWithSaneHistory } from "../src/copilotkit/agents";
import { parametersFor } from "../src/granted-tool";

/**
 * A built-in Bot's steps, each in an assistant message of its own.
 *
 * Whether a chart was drawn from results already read, or in the same step as the searches that
 * fill it, is read from the message its call is in (`shared/tool-steps.ts`). The runtime put a step
 * with no words of its own in the message of the step before, so a search followed by a chart looked
 * exactly like a search and a chart asked for together, and the chart drawn properly would have been
 * refused. These drive the real agent with a model that answers each step as Claude does.
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

type Part = Record<string, unknown>;
const call = (id: string, name: string): Part => ({
  type: "tool-call",
  toolCallId: id,
  toolName: name,
  input: "{}",
});
const words = (text: string): Part[] => [
  { type: "text-start", id: "0" },
  { type: "text-delta", id: "0", delta: text },
  { type: "text-end", id: "0" },
];

/** A model that answers its steps with these parts, in order, and keeps every prompt it was sent. */
function scripted(steps: Part[][], prompts: unknown[][]) {
  let step = 0;
  return {
    specificationVersion: "v3" as const,
    provider: "fake",
    modelId: "fake",
    supportedUrls: {},
    doGenerate: async () => {
      throw new Error("Only streamed here.");
    },
    doStream: async (options: { prompt: unknown[] }) => {
      prompts.push(options.prompt);
      const parts = [
        { type: "stream-start", warnings: [] },
        ...(steps[step] ?? words("Done.")),
        {
          type: "finish",
          finishReason: (steps[step] ?? []).some(
            (part) => part.type === "tool-call",
          )
            ? { unified: "tool-calls", raw: "tool_use" }
            : { unified: "stop", raw: "end_turn" },
          usage,
        },
      ];
      step += 1;
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

async function run(steps: Part[][]) {
  const prompts: unknown[][] = [];
  const agent = new BuiltInAgentWithSaneHistory(
    {
      model: scripted(steps, prompts) as never,
      prompt: "Find things.",
      maxSteps: 5,
      tools: [
        {
          name: "web_search",
          description: "Search the web.",
          parameters: parametersFor({
            type: "object",
            properties: {},
          } as never),
          execute: async () => "Five companies.",
        },
      ],
    } as BuiltInAgentConfiguration,
    { observe: (stream) => stream },
  );
  agent.threadId = "thread";
  agent.setMessages([
    { id: "ask", role: "user", content: "Find five logistics companies." },
  ]);
  // The chart is the browser's to draw, so it reaches the run as a tool the run is offered.
  await agent.runAgent({
    tools: [
      {
        name: "showBarChart",
        description: "Show values as a bar chart.",
        parameters: { type: "object", properties: {} },
      },
    ],
  });
  return { messages: agent.messages, prompts };
}

/** Each assistant message's calls, by name, in order. */
function stepsOf(messages: Message[]): string[][] {
  return messages.flatMap((message) =>
    message.role === "assistant" && message.toolCalls?.length
      ? [message.toolCalls.map((each) => each.function.name)]
      : [],
  );
}

test("a chart drawn in the step after the search is a step of its own", async () => {
  const { messages, prompts } = await run([
    [...words("Let me look."), call("search-1", "web_search")],
    [call("chart-1", "showBarChart")],
  ]);
  expect(stepsOf(messages)).toEqual([["web_search"], ["showBarChart"]]);
  // What the model is sent back is unchanged: no empty block of words in its own turns.
  const second = prompts[1] as {
    role: string;
    content: { type: string; text?: string }[] | string;
  }[];
  const empty = second.flatMap((message) =>
    message.role === "assistant" && Array.isArray(message.content)
      ? message.content.filter(
          (part) => part.type === "text" && part.text === "",
        )
      : [],
  );
  expect(empty).toEqual([]);
});

test("a search and a chart asked for together stay one step", async () => {
  const { messages } = await run([
    [call("search-1", "web_search"), call("chart-1", "showBarChart")],
  ]);
  expect(stepsOf(messages)).toEqual([["web_search", "showBarChart"]]);
});

test("a step's words and its calls stay together", async () => {
  const { messages } = await run([
    [call("search-1", "web_search")],
    [...words("Here they are."), call("chart-1", "showBarChart")],
  ]);
  const drawn = messages.find(
    (message) =>
      message.role === "assistant" &&
      message.toolCalls?.some((each) => each.id === "chart-1"),
  );
  expect(drawn).toMatchObject({ content: "Here they are." });
  expect(stepsOf(messages)).toEqual([["web_search"], ["showBarChart"]]);
});
