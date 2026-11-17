/**
 * The run's shape: the step budget and its last-step answer, the server's tools run here through
 * the signed callback, the surface's tools handed back and resumed, and parallel calls streamed
 * under their own ids. Driven through the real AG-UI endpoint against a provider that speaks
 * OpenAI's real streaming format.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { LAST_STEP_NOTICE } from "../../shared/run-notices.ts";
import { MAX_STEPS } from "../src/run.ts";
import { fakeProvider, type Recorded } from "./fake-provider.ts";
import {
  conversation,
  type Event,
  run,
  types,
  WEATHER_TOOL,
  withEngine,
} from "./helpers.ts";

type Callback = {
  url: string;
  calls: { name: string; args: unknown; run: unknown; token: unknown }[];
  close: () => Promise<void>;
};

/** The server's `/api/agent-tools/call`, answering every call it is sent. */
async function toolCallback(
  answer = (name: string) => `result of ${name}`,
  delay = (_name: string) => 0,
): Promise<Callback> {
  const calls: Callback["calls"] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    calls.push({
      name: body.name,
      args: body.args,
      run: body.run,
      token: request.headers["x-openbot-agent-token"],
    });
    await new Promise((resolve) => setTimeout(resolve, delay(body.name)));
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ text: answer(body.name) }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/api/agent-tools/call`,
    calls,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const LOOKUP = {
  name: "lookup",
  description: "Look something up.",
  parameters: { type: "object", properties: { q: { type: "string" } } },
};

function lastMessage(request: Recorded): { role: string; content: unknown } {
  return (request.body.messages as { role: string; content: unknown }[]).at(
    -1,
  )!;
}

test(`A run takes at most ${MAX_STEPS} steps, and the last one answers in words with tools off`, async () => {
  const provider = await fakeProvider((request, index) =>
    request.body.tool_choice === "none"
      ? { text: "Here is what I found so far, and what I did not get to." }
      : {
          calls: [
            {
              id: `call_${index}`,
              name: "lookup",
              args: { q: `page ${index}` },
            },
          ],
        },
  );
  const callback = await toolCallback();
  try {
    const env = {
      BOT_PROVIDER: "openai",
      OPENAI_API_KEY: "sk-test",
      OPENAI_BASE_URL: `${provider.base}/v1`,
      AGENT_TOOL_TOKEN: "tool-token",
      OPENBOT_TOOL_URL: callback.url,
    };
    const result = await withEngine({ env }, (base) =>
      run(
        base,
        conversation({
          tools: [LOOKUP],
          forwardedProps: {
            openbotDeploymentTools: ["lookup"],
            openbotRun: "signed-run-statement",
            // On Chat Completions, whose request this test reads.
            openbotModel: { model: "gpt-5.2" },
          },
        }),
      ),
    );
    assert.equal(
      provider.requests.length,
      MAX_STEPS,
      "one model call per step, and no more",
    );
    for (const request of provider.requests.slice(0, -1))
      assert.notEqual(request.body.tool_choice, "none");
    const last = provider.requests.at(-1)!;
    assert.equal(
      last.body.tool_choice,
      "none",
      "tools are off on the last step",
    );
    assert.ok(
      (last.body.tools as unknown[]).length > 0,
      "the tools are still described, so the history reads",
    );
    assert.deepEqual(lastMessage(last), {
      role: "user",
      content: LAST_STEP_NOTICE,
    });

    assert.equal(callback.calls.length, MAX_STEPS - 1);
    assert.ok(
      callback.calls.every(
        (call) =>
          call.token === "tool-token" && call.run === "signed-run-statement",
      ),
    );
    const kinds = types(result.events);
    assert.equal(
      kinds.filter((type) => type === "TOOL_CALL_RESULT").length,
      MAX_STEPS - 1,
    );
    assert.equal(kinds.at(-1), "RUN_FINISHED");
    const words = result.events
      .filter((event) => event.type === "TEXT_MESSAGE_CONTENT")
      .map((event) => event.delta)
      .join("");
    assert.equal(
      words,
      "Here is what I found so far, and what I did not get to.",
    );
    // The notice was this call's only: it is not in the thread the run hands back.
    const snapshot = result.events.find(
      (event) => event.type === "MESSAGES_SNAPSHOT",
    )!;
    assert.ok(!JSON.stringify(snapshot).includes(LAST_STEP_NOTICE));
  } finally {
    await provider.close();
    await callback.close();
  }
});

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
  const callback = await toolCallback();
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
      AGENT_TOOL_TOKEN: "t",
      OPENBOT_TOOL_URL: callback.url,
    };
    await withEngine({ env }, async (base) => {
      const first = await run(
        base,
        conversation({
          tools: [renderUi],
          forwardedProps: { openbotDeploymentTools: [], openbotRun: "s" },
        }),
      );
      assert.equal(provider.requests.length, 1);
      assert.equal(
        callback.calls.length,
        0,
        "the surface's tool is never run here",
      );
      const start = first.events.find(
        (event) => event.type === "TOOL_CALL_START",
      )!;
      assert.equal(start.toolCallName, "render_ui");
      assert.equal(start.toolCallId, "call_ui");
      assert.equal(first.events.at(-1)!.type, "RUN_FINISHED");

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
    await callback.close();
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
  } finally {
    await provider.close();
  }
});

test("A step mixing a server tool with a surface tool goes back to the surface without running either", async () => {
  const provider = await fakeProvider(() => ({
    calls: [
      { id: "call_send", name: "send_message", args: { to: "x" } },
      { id: "call_ui", name: "render_ui", args: {} },
    ],
  }));
  const callback = await toolCallback();
  try {
    const env = {
      BOT_PROVIDER: "openai",
      OPENAI_API_KEY: "sk-test",
      OPENAI_BASE_URL: `${provider.base}/v1`,
      AGENT_TOOL_TOKEN: "t",
      OPENBOT_TOOL_URL: callback.url,
    };
    const tools = [
      {
        name: "send_message",
        description: "Send.",
        parameters: { type: "object", properties: {} },
      },
      {
        name: "render_ui",
        description: "Draw.",
        parameters: { type: "object", properties: {} },
      },
    ];
    const result = await withEngine({ env }, (base) =>
      run(
        base,
        conversation({
          tools,
          forwardedProps: {
            openbotDeploymentTools: ["send_message"],
            openbotRun: "s",
          },
        }),
      ),
    );
    assert.equal(callback.calls.length, 0);
    assert.equal(provider.requests.length, 1);
    assert.equal(result.events.at(-1)!.type, "RUN_FINISHED");
  } finally {
    await provider.close();
    await callback.close();
  }
});

test("A Bot's computer calls run one after another, in the order the model made them", async () => {
  const provider = await fakeProvider((_request, index) =>
    index === 0
      ? {
          calls: [
            { id: "c1", name: "computer_type", args: { text: "slow" } },
            { id: "c2", name: "computer_click", args: { at: "save" } },
          ],
        }
      : { text: "Saved." },
  );
  const callback = await toolCallback(
    (name) => `${name} done`,
    (name) => (name === "computer_type" ? 80 : 0),
  );
  try {
    const env = {
      BOT_PROVIDER: "openai",
      OPENAI_API_KEY: "sk-test",
      OPENAI_BASE_URL: `${provider.base}/v1`,
      AGENT_TOOL_TOKEN: "t",
      OPENBOT_TOOL_URL: callback.url,
    };
    const tools = ["computer_type", "computer_click"].map((name) => ({
      name,
      description: name,
      parameters: { type: "object", properties: {} },
    }));
    const result = await withEngine({ env }, (base) =>
      run(
        base,
        conversation({
          tools,
          forwardedProps: {
            openbotDeploymentTools: ["computer_type", "computer_click"],
            openbotRun: "s",
          },
        }),
      ),
    );
    assert.deepEqual(
      callback.calls.map((call) => call.name),
      ["computer_type", "computer_click"],
    );
    const results = result.events.filter(
      (event) => event.type === "TOOL_CALL_RESULT",
    );
    assert.deepEqual(
      results.map((event) => [event.toolCallId, event.content]),
      [
        ["c1", "computer_type done"],
        ["c2", "computer_click done"],
      ],
    );
    assert.equal(result.events.at(-1)!.type, "RUN_FINISHED");
  } finally {
    await provider.close();
    await callback.close();
  }
});

// FOUND ON THE REAL GEMINI API: @langchain/google streams a call whole, in `tool_calls`, with no
// `tool_call_chunks`, so a run that read only the chunks saw no call and finished with nothing said.
for (const [gemini, id] of [
  ["Gemini 3, which names its calls", "call_10067008614775455048"],
  ["Gemini 2.5, which does not", ""],
] as const) {
  test(`${gemini}: a call streamed whole is run, and its thought signature goes back with it`, async () => {
    const provider = await fakeProvider((request) =>
      JSON.stringify(request.body.contents).includes("Reading id W-1")
        ? { text: "Paris: 17 C (W-1)." }
        : {
            calls: [
              {
                id,
                name: "get_weather",
                args: { city: "Paris" },
                signature: "SIGNATURE_MARKER",
              },
            ],
          },
    );
    const callback = await toolCallback(() => "Paris: 17 C. Reading id W-1.");
    try {
      const env = {
        BOT_PROVIDER: "google",
        GOOGLE_API_KEY: "AIza-test",
        GOOGLE_GENERATIVE_AI_BASE_URL: `${provider.base}/v1beta`,
        AGENT_TOOL_TOKEN: "t",
        OPENBOT_TOOL_URL: callback.url,
      };
      const result = await withEngine({ env }, (base) =>
        run(
          base,
          conversation({
            tools: [WEATHER_TOOL],
            forwardedProps: {
              openbotDeploymentTools: ["get_weather"],
              openbotRun: "s",
              openbotModel: { model: "gemini-3.6-flash" },
            },
          }),
        ),
      );
      const start = result.events.find(
        (event) => event.type === "TOOL_CALL_START",
      );
      assert.equal(start?.toolCallName, "get_weather");
      if (id) assert.equal(start?.toolCallId, id);
      assert.deepEqual(
        callback.calls.map((call) => call.args),
        [{ city: "Paris" }],
      );
      assert.equal(provider.requests.length, 2);
      const followUp = JSON.stringify(provider.requests[1]?.body.contents);
      assert.ok(
        followUp.includes("SIGNATURE_MARKER"),
        "the thought signature goes back with the call",
      );
      assert.ok(followUp.includes("functionResponse"));
      const words = result.events
        .filter((event) => event.type === "TEXT_MESSAGE_CONTENT")
        .map((event) => event.delta)
        .join("");
      assert.equal(words, "Paris: 17 C (W-1).");
    } finally {
      await provider.close();
      await callback.close();
    }
  });
}
