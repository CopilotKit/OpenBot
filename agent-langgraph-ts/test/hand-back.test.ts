/**
 * The engine on plain AG-UI, the contract a Bot somebody connects already keeps:
 *  - its instructions are the system messages in `messages`, nothing private in `forwardedProps`;
 *  - every OpenBot tool it calls ends the run with the call unanswered (`RUN_FINISHED` whose success
 *    outcome names the pending calls), and the next run brings each result back as a `tool` message;
 *  - the one tool it answers itself is its own `recall_earlier_results`;
 *  - it never calls OpenBot back. Each run is given the old callback's address and token, as a
 *    deployment from before the hand-back still sets them, and a server there counts every request.
 *
 * Driven through the real AG-UI endpoint against a provider that speaks each API's real streaming
 * format.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { always, fakeProvider, type Recorded } from "./fake-provider.ts";
import {
  conversation,
  type Event,
  oldCallbackEnv,
  pendingOf,
  run,
  tripwire,
  types,
  withEngine,
} from "./helpers.ts";

const LOOKUP = {
  name: "lookup",
  description: "Look something up.",
  parameters: { type: "object", properties: { q: { type: "string" } } },
};
const SEND = {
  name: "send_message",
  description: "Send a message.",
  parameters: { type: "object", properties: { to: { type: "string" } } },
};

/** What a server from before the hand-back still sends: the private keys this engine must ignore. */
const OLD_PROPS = {
  openbotDeploymentTools: ["lookup", "send_message"],
  openbotRun: "signed-run-statement",
  openbotSystemPrompt: "OLD_PRIVATE_PROMPT_MARKER",
};

const openAI = (base: string) => ({
  BOT_PROVIDER: "openai",
  // On Chat Completions, whose request these tests read.
  BOT_MODEL: "gpt-5.2",
  OPENAI_API_KEY: "sk-test",
  OPENAI_BASE_URL: `${base}/v1`,
});

const words = (list: Event[]) =>
  list
    .filter((event) => event.type === "TEXT_MESSAGE_CONTENT")
    .map((event) => event.delta)
    .join("");

type Sent = {
  role: string;
  content?: unknown;
  tool_call_id?: string;
  tool_calls?: { id: string }[];
};
const sentMessages = (request: Recorded) => request.body.messages as Sent[];

/** The thread the server sends next: this run's call, answered by OpenBot, then nothing else. */
function answered(
  thread: unknown[],
  calls: { id: string; name: string; args: unknown }[],
  results: Record<string, string>,
  id = "a-call",
) {
  return [
    ...thread,
    {
      id,
      role: "assistant",
      content: "",
      toolCalls: calls.map((call) => ({
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: JSON.stringify(call.args) },
      })),
    },
    ...calls.map((call) => ({
      id: `t-${call.id}`,
      role: "tool",
      toolCallId: call.id,
      content: results[call.id] ?? "",
    })),
  ];
}

test("The server's instruction rows are the system prompt, in order, then the context, and forwardedProps carries none", async () => {
  const provider = await fakeProvider(always({ text: "ok" }));
  const wire = await tripwire();
  try {
    const env = {
      BOT_PROVIDER: "anthropic",
      ANTHROPIC_API_KEY: "sk-ant-test",
      ANTHROPIC_BASE_URL: provider.base,
      ...oldCallbackEnv(wire),
    };
    const input = conversation({
      forwardedProps: OLD_PROPS,
      context: [
        { description: "The page the person is on", value: "CONTEXT_MARKER" },
      ],
    });
    // A system row the browser put in the thread (a picked skill used to come this way): data.
    (input.messages as unknown[]).splice(4, 0, {
      id: "skill-1",
      role: "system",
      content: "Answer in bullets. SKILL_MARKER",
    });
    // The learned Skills catalog the server writes, an instruction row like the role.
    (input.messages as unknown[]).splice(2, 0, {
      id: "openbot:learned-skills",
      role: "system",
      content: "Learned skills: CATALOG_MARKER",
    });
    const result = await withEngine({ env }, (base) => run(base, input));
    assert.equal(result.events.at(-1)!.type, "RUN_FINISHED");
    const { body } = provider.requests[0]!;
    const system = JSON.stringify(body.system);
    const order = [
      "STANDING_ROLE_MARKER",
      "GRANTED_TOOLS_MARKER",
      "CATALOG_MARKER",
      "CONTEXT_MARKER",
    ].map((marker) => system.indexOf(marker));
    assert.ok(
      order.every((at) => at >= 0),
      `every instruction row is in the system prompt: ${system}`,
    );
    assert.deepEqual(
      [...order].sort((a, b) => a - b),
      order,
      "in the order the thread holds them, then the context",
    );
    assert.ok(!system.includes("SKILL_MARKER"), "a browser's row is not");
    const sent = JSON.stringify(body.messages);
    assert.ok(sent.includes("SKILL_MARKER"), "it is conversation, quoted");
    assert.ok(
      sent.includes("LATEST_QUESTION_MARKER") &&
        sent.includes("EARLIER_ANSWER_MARKER"),
    );
    assert.ok(
      !JSON.stringify(body).includes("OLD_PRIVATE_PROMPT_MARKER"),
      "a prompt in forwardedProps is not read",
    );
    assert.deepEqual(wire.hits, []);
  } finally {
    await provider.close();
    await wire.close();
  }
});

test("A call to an OpenBot tool ends the run unanswered, and the next run carries its result to a final answer", async () => {
  const provider = await fakeProvider((request) =>
    JSON.stringify(request.body.messages).includes("RESULT_FROM_OPENBOT")
      ? { text: "The answer is 42." }
      : { calls: [{ id: "call_1", name: "lookup", args: { q: "answer" } }] },
  );
  const wire = await tripwire();
  try {
    const env = { ...openAI(provider.base), ...oldCallbackEnv(wire) };
    await withEngine({ env }, async (base) => {
      const first = await run(
        base,
        conversation({ tools: [LOOKUP], forwardedProps: OLD_PROPS }),
      );
      assert.equal(provider.requests.length, 1, "one model call, then back");
      const kinds = types(first.events);
      assert.deepEqual(
        [...new Set(kinds.filter((type) => type.startsWith("TOOL_CALL_")))],
        ["TOOL_CALL_START", "TOOL_CALL_ARGS", "TOOL_CALL_END"],
        "streamed, and never answered here",
      );
      assert.equal(kinds.at(-1), "RUN_FINISHED");
      const finished = first.events.at(-1)!;
      assert.deepEqual(finished.outcome, {
        type: "success",
        pendingToolCallIds: ["call_1"],
      });
      const start = first.events.find(
        (event) => event.type === "TOOL_CALL_START",
      )!;
      assert.equal(start.toolCallName, "lookup");
      assert.equal(start.toolCallId, "call_1");

      const second = await run(
        base,
        conversation({
          runId: "run-2",
          tools: [LOOKUP],
          forwardedProps: OLD_PROPS,
          messages: answered(
            conversation().messages as unknown[],
            [{ id: "call_1", name: "lookup", args: { q: "answer" } }],
            { call_1: "RESULT_FROM_OPENBOT: 42" },
          ),
        }),
      );
      assert.equal(second.events.at(-1)!.type, "RUN_FINISHED");
      assert.equal(pendingOf(second.events), undefined, "nothing left over");
      assert.equal(words(second.events), "The answer is 42.");
    });
    assert.equal(provider.requests.length, 2);
    const sent = sentMessages(provider.requests[1]!);
    assert.ok(
      sent.some(
        (message) =>
          message.role === "assistant" &&
          message.tool_calls?.[0]?.id === "call_1",
      ),
      "the call goes back to the model",
    );
    assert.ok(
      sent.some(
        (message) =>
          message.role === "tool" &&
          message.tool_call_id === "call_1" &&
          String(message.content).includes("RESULT_FROM_OPENBOT"),
      ),
      "with OpenBot's result, kept by the history sanitiser",
    );
    assert.deepEqual(wire.hits, [], "OpenBot was never called back");
  } finally {
    await provider.close();
    await wire.close();
  }
});

test("On the Responses API too, a handed-back call and OpenBot's result reach the next step as a call and its output", async () => {
  const provider = await fakeProvider((request) =>
    JSON.stringify(request.body.input).includes("RESULT_FROM_OPENBOT")
      ? { text: "Done." }
      : { calls: [{ id: "call_r", name: "lookup", args: { q: "x" } }] },
  );
  try {
    const env = {
      BOT_PROVIDER: "openai",
      OPENAI_API_KEY: "sk-test",
      OPENAI_BASE_URL: `${provider.base}/v1`,
    };
    // A model that takes tools only on the Responses API (request-shape.test.ts).
    const props = { openbotModel: { model: "gpt-5.6-terra" } };
    await withEngine({ env }, async (base) => {
      const first = await run(
        base,
        conversation({ tools: [LOOKUP], forwardedProps: props }),
      );
      assert.deepEqual(pendingOf(first.events), ["call_r"]);
      const second = await run(
        base,
        conversation({
          runId: "run-2",
          tools: [LOOKUP],
          forwardedProps: props,
          messages: answered(
            conversation().messages as unknown[],
            [{ id: "call_r", name: "lookup", args: { q: "x" } }],
            { call_r: "RESULT_FROM_OPENBOT" },
          ),
        }),
      );
      assert.equal(words(second.events), "Done.");
    });
    assert.equal(provider.requests[1]!.path, "/v1/responses");
    const input = provider.requests[1]!.body.input as Record<string, unknown>[];
    const call = input.findIndex(
      (item) => item.type === "function_call" && item.call_id === "call_r",
    );
    const output = input.findIndex(
      (item) =>
        item.type === "function_call_output" && item.call_id === "call_r",
    );
    assert.ok(call >= 0 && output > call, JSON.stringify(input));
  } finally {
    await provider.close();
  }
});

test("Parallel calls hand back together, in one run end, in the order the model made them", async () => {
  const provider = await fakeProvider(() => ({
    calls: [
      { id: "call_a", name: "send_message", args: { to: "Ana" } },
      { id: "call_b", name: "lookup", args: { q: "Bo" } },
      { id: "call_c", name: "computer_click", args: { at: "save" } },
    ],
  }));
  const wire = await tripwire();
  try {
    const env = { ...openAI(provider.base), ...oldCallbackEnv(wire) };
    const computer = {
      name: "computer_click",
      description: "Click.",
      parameters: { type: "object", properties: {} },
    };
    const result = await withEngine({ env }, (base) =>
      run(
        base,
        conversation({
          tools: [SEND, LOOKUP, computer],
          forwardedProps: {
            ...OLD_PROPS,
            openbotDeploymentTools: [
              "send_message",
              "lookup",
              "computer_click",
            ],
          },
        }),
      ),
    );
    assert.equal(provider.requests.length, 1);
    assert.deepEqual(pendingOf(result.events), ["call_a", "call_b", "call_c"]);
    assert.ok(!types(result.events).includes("TOOL_CALL_RESULT"));
    assert.deepEqual(
      result.events
        .filter((event) => event.type === "TOOL_CALL_END")
        .map((event) => event.toolCallId)
        .sort(),
      ["call_a", "call_b", "call_c"],
    );
    // The snapshot holds the step's one assistant message, its three calls unanswered.
    const snapshot = result.events.find(
      (event) => event.type === "MESSAGES_SNAPSHOT",
    )!;
    const last = (
      snapshot.messages as { role: string; toolCalls?: { id: string }[] }[]
    ).at(-1)!;
    assert.equal(last.role, "assistant");
    assert.deepEqual(
      last.toolCalls?.map((call) => call.id),
      ["call_a", "call_b", "call_c"],
    );
    assert.deepEqual(wire.hits, []);
  } finally {
    await provider.close();
    await wire.close();
  }
});

test("recall_earlier_results is answered here; in a mixed step the recall is answered and the rest handed back", async () => {
  const provider = await fakeProvider((_request, index) =>
    index === 0
      ? {
          calls: [
            {
              id: "recall_1",
              name: "recall_earlier_results",
              args: { call_id: "call_old" },
            },
          ],
        }
      : index === 1
        ? {
            calls: [
              {
                id: "recall_2",
                name: "recall_earlier_results",
                args: { call_id: "call_old" },
              },
              { id: "call_send", name: "send_message", args: { to: "Ana" } },
            ],
          }
        : { text: "never" },
  );
  const wire = await tripwire();
  try {
    const env = { ...openAI(provider.base), ...oldCallbackEnv(wire) };
    const messages = answered(
      conversation().messages as unknown[],
      [{ id: "call_old", name: "lookup", args: { q: "old" } }],
      { call_old: "OLD_RESULT_MARKER" },
    );
    // The person's latest message after the earlier call.
    messages.push({ id: "u3", role: "user", content: "and now?" });
    const result = await withEngine({ env }, (base) =>
      run(
        base,
        conversation({
          messages,
          tools: [LOOKUP, SEND],
          forwardedProps: OLD_PROPS,
        }),
      ),
    );
    assert.equal(provider.requests.length, 2, "a recall step, then the mix");
    const recalled = sentMessages(provider.requests[1]!).find(
      (message) => message.tool_call_id === "recall_1",
    );
    assert.ok(String(recalled?.content).includes("OLD_RESULT_MARKER"));
    const results = result.events.filter(
      (event) => event.type === "TOOL_CALL_RESULT",
    );
    assert.deepEqual(
      results.map((event) => event.toolCallId),
      ["recall_1", "recall_2"],
      "only the recalls are answered here",
    );
    assert.deepEqual(pendingOf(result.events), ["call_send"]);
    assert.equal(result.events.at(-1)!.type, "RUN_FINISHED");
    assert.deepEqual(wire.hits, []);
  } finally {
    await provider.close();
    await wire.close();
  }
});

// No budget counts steps across a turn: the server answers every hand-back and calls again, and a
// long task takes hundreds of steps. Under the old 40-step budget the forty-first step was sent
// with its tools off and told it was on its last step, so a long task stopped half done.
const LONG_TURN = 45;

test(`A turn ${LONG_TURN} hand-backs deep is still sent its tools, and never told it is on its last step`, async () => {
  const provider = await fakeProvider((_request, index) => ({
    calls: [{ id: `call_next_${index}`, name: "lookup", args: { q: "more" } }],
  }));
  const wire = await tripwire();
  try {
    const env = { ...openAI(provider.base), ...oldCallbackEnv(wire) };
    let thread = conversation().messages as unknown[];
    for (let i = 0; i < LONG_TURN; i += 1)
      thread = answered(
        thread,
        [{ id: `call_${i}`, name: "lookup", args: { q: `p${i}` } }],
        { [`call_${i}`]: `result ${i}` },
        `a-${i}`,
      );
    await withEngine({ env }, async (base) => {
      for (let step = 0; step < 2; step += 1) {
        const result = await run(
          base,
          conversation({
            runId: `run-${step}`,
            messages: thread,
            tools: [LOOKUP],
          }),
        );
        assert.equal(result.events.at(-1)!.type, "RUN_FINISHED");
        const pending = pendingOf(result.events);
        assert.deepEqual(pending, [`call_next_${step}`], "the step hands back");
        thread = answered(
          thread,
          [{ id: `call_next_${step}`, name: "lookup", args: { q: "more" } }],
          { [`call_next_${step}`]: "more" },
          `a-next-${step}`,
        );
      }
    });
    assert.equal(provider.requests.length, 2);
    for (const request of provider.requests) {
      assert.notEqual(request.body.tool_choice, "none");
      const tools = (request.body.tools ?? []) as {
        function: { name: string };
      }[];
      assert.ok(
        tools.some((tool) => tool.function.name === "lookup"),
        "the step is sent its tools",
      );
      assert.ok(
        !JSON.stringify(request.body.messages).includes("last step"),
        "and is not told to stop",
      );
    }
    assert.deepEqual(wire.hits, []);
  } finally {
    await provider.close();
    await wire.close();
  }
});

// The server clears old tool results from the thread it sends, and offers recall_earlier_results as
// a tool of its own, answered from the whole conversation it stores. A recall answered here would
// read the server's placeholder back instead of the result.
test("A recall_earlier_results the caller offers is handed back like any other call, not answered here", async () => {
  const offeredRecall = {
    name: "recall_earlier_results",
    description: "Read a cleared result again.",
    parameters: {
      type: "object",
      properties: { call_id: { type: "string" } },
    },
  };
  const provider = await fakeProvider((_request, index) =>
    index === 0
      ? {
          calls: [
            {
              id: "recall_1",
              name: "recall_earlier_results",
              args: { call_id: "call_old" },
            },
          ],
        }
      : { text: "answered from the engine's own thread" },
  );
  const wire = await tripwire();
  try {
    const env = { ...openAI(provider.base), ...oldCallbackEnv(wire) };
    const messages = answered(
      conversation().messages as unknown[],
      [{ id: "call_old", name: "lookup", args: { q: "old" } }],
      {
        call_old:
          '[This result was cleared to make room in the conversation. Call recall_earlier_results with call_id "call_old" to read it again.]',
      },
    );
    const result = await withEngine({ env }, (base) =>
      run(base, conversation({ messages, tools: [LOOKUP, offeredRecall] })),
    );
    assert.equal(provider.requests.length, 1, "one model call, then back");
    assert.equal(result.events.at(-1)!.type, "RUN_FINISHED");
    assert.deepEqual(pendingOf(result.events), ["recall_1"]);
    assert.ok(
      !types(result.events).includes("TOOL_CALL_RESULT"),
      "the engine does not answer it",
    );
    const names = (
      (provider.requests[0]!.body.tools ?? []) as {
        function: { name: string; description: string };
      }[]
    ).filter((tool) => tool.function.name === "recall_earlier_results");
    assert.equal(names.length, 1, "the caller's recall, offered once");
    assert.equal(names[0]!.function.description, offeredRecall.description);
    assert.deepEqual(wire.hits, []);
  } finally {
    await provider.close();
    await wire.close();
  }
});

// FOUND ON THE REAL GEMINI API: Gemini 3 refuses a function call sent back without the thought
// signature it came with. Across a hand-back the call lives in OpenBot's thread, so the signature
// travels the AG-UI way: REASONING_ENCRYPTED_VALUE on the call, and `encryptedValue` on it after.
for (const [gemini, id] of [
  ["Gemini 3, which names its calls", "call_10067008614775455048"],
  ["Gemini 2.5, which does not", ""],
] as const) {
  test(`${gemini}: a handed-back call keeps its thought signature into the next run`, async () => {
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
    const wire = await tripwire();
    const weather = {
      name: "get_weather",
      description: "Current weather for a city.",
      parameters: {
        type: "object",
        properties: { city: { type: "string" } },
      },
    };
    try {
      const env = {
        BOT_PROVIDER: "google",
        GOOGLE_API_KEY: "AIza-test",
        GOOGLE_GENERATIVE_AI_BASE_URL: `${provider.base}/v1beta`,
        ...oldCallbackEnv(wire),
      };
      const props = { openbotModel: { model: "gemini-3.6-flash" } };
      await withEngine({ env }, async (base) => {
        const first = await run(
          base,
          conversation({ tools: [weather], forwardedProps: props }),
        );
        const start = first.events.find(
          (event) => event.type === "TOOL_CALL_START",
        )!;
        assert.equal(start.toolCallName, "get_weather");
        if (id) assert.equal(start.toolCallId, id);
        const callId = String(start.toolCallId);
        assert.deepEqual(pendingOf(first.events), [callId]);
        const sealed = first.events.find(
          (event) => event.type === "REASONING_ENCRYPTED_VALUE",
        );
        assert.deepEqual(
          sealed && {
            subtype: sealed.subtype,
            entityId: sealed.entityId,
            encryptedValue: sealed.encryptedValue,
          },
          {
            subtype: "tool-call",
            entityId: callId,
            encryptedValue: "SIGNATURE_MARKER",
          },
        );
        const snapshot = first.events.find(
          (event) => event.type === "MESSAGES_SNAPSHOT",
        )!;
        const call = (
          snapshot.messages as {
            toolCalls?: { id: string; encryptedValue?: string }[];
          }[]
        ).at(-1)!.toolCalls![0]!;
        assert.equal(call.encryptedValue, "SIGNATURE_MARKER");

        // OpenBot answers it and sends the thread back, the call as the snapshot held it.
        const second = await run(
          base,
          conversation({
            runId: "run-2",
            tools: [weather],
            forwardedProps: props,
            messages: [
              ...(snapshot.messages as unknown[]),
              {
                id: "t-weather",
                role: "tool",
                toolCallId: callId,
                content: "Paris: 17 C. Reading id W-1.",
              },
            ],
          }),
        );
        assert.equal(words(second.events), "Paris: 17 C (W-1).");
      });
      assert.equal(provider.requests.length, 2);
      const followUp = JSON.stringify(provider.requests[1]?.body.contents);
      assert.ok(
        followUp.includes("SIGNATURE_MARKER"),
        "the thought signature goes back with the call",
      );
      const contents = provider.requests[1]!.body.contents as {
        role: string;
        parts: Record<string, unknown>[];
      }[];
      const called = contents.findIndex((turn) =>
        turn.parts.some((part) => "functionCall" in part),
      );
      const answeredAt = contents.findIndex((turn) =>
        turn.parts.some((part) => "functionResponse" in part),
      );
      assert.ok(
        called >= 0 && answeredAt === called + 1,
        `the call is sent as a call, right before its result: ${followUp}`,
      );
      assert.deepEqual(wire.hits, []);
    } finally {
      await provider.close();
      await wire.close();
    }
  });
}
