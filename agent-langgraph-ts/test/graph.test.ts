/**
 * The run's shape: a browser's tool handed back and resumed, and parallel calls streamed under
 * their own ids. Driven through the real AG-UI endpoint against a provider that speaks OpenAI's real
 * streaming format. The hand-back of OpenBot's own tools, the step budget across hand-backs and
 * recall are in hand-back.test.ts.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { fakeProvider } from "./fake-provider.ts";
import {
  conversation,
  type Event,
  pendingOf,
  run,
  WEATHER_TOOL,
  withEngine,
} from "./helpers.ts";

test("A surface tool ends the run on its call, and the next run carries on from its result", async () => {
  const provider = await fakeProvider((request) =>
    JSON.stringify(request.body.messages).includes("drawn by the browser")
      ? { text: "The chart is up." }
      : {
          calls: [
            { id: "call_ui", name: "render_ui", args: { component: "chart" } },
          ],
        },
  );
  const renderUi = {
    name: "render_ui",
    description: "Draw a component.",
    parameters: {
      type: "object",
      properties: { component: { type: "string" } },
    },
  };
  try {
    const env = {
      BOT_PROVIDER: "openai",
      // On Chat Completions, whose request this test reads.
      BOT_MODEL: "gpt-5.2",
      OPENAI_API_KEY: "sk-test",
      OPENAI_BASE_URL: `${provider.base}/v1`,
    };
    await withEngine({ env }, async (base) => {
      const first = await run(base, conversation({ tools: [renderUi] }));
      assert.equal(provider.requests.length, 1);
      const start = first.events.find(
        (event) => event.type === "TOOL_CALL_START",
      )!;
      assert.equal(start.toolCallName, "render_ui");
      assert.equal(start.toolCallId, "call_ui");
      assert.equal(first.events.at(-1)!.type, "RUN_FINISHED");
      assert.deepEqual(pendingOf(first.events), ["call_ui"]);

      const thread = [
        ...(conversation().messages as unknown[]),
        {
          id: "a2",
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "call_ui",
              type: "function",
              function: {
                name: "render_ui",
                arguments: '{"component":"chart"}',
              },
            },
          ],
        },
        {
          id: "t2",
          role: "tool",
          toolCallId: "call_ui",
          content: "drawn by the browser",
        },
      ];
      const second = await run(
        base,
        conversation({ messages: thread, tools: [renderUi], runId: "run-2" }),
      );
      assert.equal(second.events.at(-1)!.type, "RUN_FINISHED");
      assert.equal(
        second.events
          .filter((event) => event.type === "TEXT_MESSAGE_CONTENT")
          .map((event) => event.delta)
          .join(""),
        "The chart is up.",
      );
    });
    const sent = provider.requests[1]!.body.messages as {
      role: string;
      tool_call_id?: string;
      tool_calls?: { id: string }[];
    }[];
    assert.ok(
      sent.some(
        (message) =>
          message.role === "assistant" &&
          message.tool_calls?.[0]?.id === "call_ui",
      ),
    );
    assert.ok(
      sent.some(
        (message) =>
          message.role === "tool" && message.tool_call_id === "call_ui",
      ),
    );
  } finally {
    await provider.close();
  }
});

test("Parallel calls stream under their own ids, their arguments never mixed", async () => {
  const provider = await fakeProvider(() => ({
    calls: [
      {
        id: "call_paris",
        name: "get_weather",
        args: { city: "Paris, France" },
      },
      { id: "call_tokyo", name: "get_weather", args: { city: "Tokyo, Japan" } },
    ],
  }));
  try {
    const env = {
      BOT_PROVIDER: "openai",
      OPENAI_API_KEY: "sk-test",
      OPENAI_BASE_URL: `${provider.base}/v1`,
    };
    const result = await withEngine({ env }, (base) =>
      run(base, conversation({ tools: [WEATHER_TOOL] })),
    );
    const starts = result.events.filter(
      (event) => event.type === "TOOL_CALL_START",
    );
    assert.deepEqual(
      starts.map((event) => event.toolCallId),
      ["call_paris", "call_tokyo"],
    );
    assert.equal(new Set(starts.map((event) => event.parentMessageId)).size, 1);
    const args = (id: string) =>
      result.events
        .filter(
          (event: Event) =>
            event.type === "TOOL_CALL_ARGS" && event.toolCallId === id,
        )
        .map((event) => event.delta)
        .join("");
    assert.deepEqual(JSON.parse(args("call_paris")), { city: "Paris, France" });
    assert.deepEqual(JSON.parse(args("call_tokyo")), { city: "Tokyo, Japan" });
    assert.deepEqual(
      result.events
        .filter((event) => event.type === "TOOL_CALL_END")
        .map((event) => event.toolCallId)
        .sort(),
      ["call_paris", "call_tokyo"],
    );
    assert.equal(result.events.at(-1)!.type, "RUN_FINISHED");
    assert.deepEqual(pendingOf(result.events), ["call_paris", "call_tokyo"]);
  } finally {
    await provider.close();
  }
});
