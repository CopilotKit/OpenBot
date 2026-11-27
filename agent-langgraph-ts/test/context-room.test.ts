/**
 * A long conversation keeps going past the model's window.
 *
 * A Bot on a long task stopped after a few hundred steps when its thread, nearly all of it old tool
 * output, grew past the model's window and the provider refused it as too long. These runs drive the
 * real AG-UI endpoint against a provider that speaks its real protocol behind a window: any request
 * over it gets that provider's exact refusal body. Anthropic's side also does what Anthropic does
 * when a request carries context editing and its beta: it clears old tool results before counting.
 *
 * The thread: 60 earlier tool calls, each with an 8,000-character result, then the person's latest
 * message. About 160,000 tokens as the fake counts them, so every window below refuses it whole.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { fakeProvider, type Recorded, type Turn } from "./fake-provider.ts";
import { conversation, type Event, run, types, withEngine } from "./helpers.ts";

const RESULTS = 60;
const RESULT_CHARS = 8_000;
const CONTEXT_EDITING_BETA = "context-management-2025-06-27";
const CONTEXT_EDITING = {
  edits: [
    {
      type: "clear_tool_uses_20250919",
      trigger: { type: "input_tokens", value: 100_000 },
      keep: { type: "tool_uses", value: 10 },
      clear_at_least: { type: "input_tokens", value: 20_000 },
      exclude_tools: ["search_tools"],
    },
  ],
};
const cleared = (id: string) =>
  `[This result was cleared to make room in the conversation. Call recall_earlier_results with call_id "${id}" to read it again.]`;
const CUT_NOTE =
  "[The rest of this message was cut to make room in the conversation.]";

// The providers' own refusals, word for word.
const ANTHROPIC_TOO_LONG: Turn = {
  status: 400,
  body: {
    type: "error",
    error: {
      type: "invalid_request_error",
      message: "prompt is too long: 1008027 tokens > 1000000 maximum",
    },
  },
};
const OPENAI_TOO_LONG: Turn = {
  status: 400,
  body: {
    error: {
      message:
        "This model's maximum context length is 128000 tokens. However, your messages resulted in 210345 tokens. Please reduce the length of the messages.",
      type: "invalid_request_error",
      param: "messages",
      code: "context_length_exceeded",
    },
  },
};
/** A proxy in front of Claude that passes the Messages API but not context editing. */
const PROXY_REFUSES_EDITING: Turn = {
  status: 400,
  body: {
    type: "error",
    error: {
      type: "invalid_request_error",
      message: "context_management: Extra inputs are not permitted",
    },
  },
};

const LOOKUP = {
  name: "lookup",
  description: "Look something up.",
  parameters: { type: "object", properties: { q: { type: "string" } } },
};

/** Result `i`: its own marker, every seventh one about a quarterly zebra, padded to 8,000. */
function resultBody(i: number): string {
  const head = `RESULT_${i}_START ${i % 7 === 0 ? "Quarterly zebra census. " : ""}`;
  return (head + "lorem ipsum dolor sit amet ".repeat(400)).slice(
    0,
    RESULT_CHARS,
  );
}

/** The two oldest calls are `search_tools`, which is never cleared. */
const toolOf = (i: number) => (i < 2 ? "search_tools" : "lookup");

function longThread(latest = "Keep going LATEST_MARKER", earlier?: string) {
  const messages: Record<string, unknown>[] = [
    {
      id: "u1",
      role: "user",
      content: earlier ?? "Start the long task FIRST_USER_MARKER",
    },
  ];
  for (let i = 0; i < RESULTS; i += 1) {
    messages.push({
      id: `a${i}`,
      role: "assistant",
      content: i === 0 ? "On it. BOT_WORDS_MARKER" : "",
      toolCalls: [
        {
          id: `call_${i}`,
          type: "function",
          function: {
            name: toolOf(i),
            arguments: JSON.stringify({ q: `page ${i}` }),
          },
        },
      ],
    });
    messages.push({
      id: `t${i}`,
      role: "tool",
      toolCallId: `call_${i}`,
      content: resultBody(i),
    });
  }
  messages.push({ id: "u2", role: "user", content: latest });
  const base = conversation();
  return conversation({
    messages: [...(base.messages as unknown[]).slice(0, 2), ...messages],
    tools: [LOOKUP],
  });
}

/** Tokens as the fake provider counts them: three characters each, over the whole body. */
const fakeTokens = (body: unknown) =>
  Math.ceil(JSON.stringify(body).length / 3);

type Block = Record<string, unknown>;
const blocks = (message: Block): Block[] =>
  Array.isArray(message.content) ? (message.content as Block[]) : [];

/**
 * What Anthropic counts when a request carries context editing and its beta: past the trigger,
 * every tool result but the last `keep` cleared, never an excluded tool's, and only if that frees
 * `clear_at_least`.
 */
function afterAnthropicEditing(request: Recorded): Record<string, unknown> {
  const body = request.body;
  const edit = (body.context_management as typeof CONTEXT_EDITING | undefined)
    ?.edits?.[0];
  const beta = String(request.headers["anthropic-beta"] ?? "");
  if (!edit || !beta.includes(CONTEXT_EDITING_BETA)) return body;
  if (fakeTokens(body) <= edit.trigger.value) return body;
  const copy = structuredClone(body);
  const messages = copy.messages as Block[];
  const names = new Map<string, string>();
  for (const message of messages)
    for (const block of blocks(message))
      if (block.type === "tool_use")
        names.set(String(block.id), String(block.name));
  const results = messages.flatMap((message) =>
    blocks(message).filter((block) => block.type === "tool_result"),
  );
  for (const block of results.slice(
    0,
    Math.max(0, results.length - edit.keep.value),
  ))
    if (
      !edit.exclude_tools.includes(names.get(String(block.tool_use_id)) ?? "")
    )
      block.content = "[cleared]";
  if (fakeTokens(body) - fakeTokens(copy) < edit.clear_at_least.value)
    return body;
  return copy;
}

/**
 * A provider behind a window of `window` tokens: over it, the refusal; under it, `script` with how
 * many requests it has answered so far.
 */
function behindWindow(
  window: number,
  refusal: Turn,
  script: (request: Recorded, answered: number) => Turn,
  before?: (request: Recorded) => Turn | undefined,
) {
  let answered = 0;
  return (request: Recorded): Turn => {
    const early = before?.(request);
    if (early) return early;
    const counted = request.path.endsWith("/messages")
      ? afterAnthropicEditing(request)
      : request.body;
    if (fakeTokens(counted) > window) return refusal;
    return script(request, answered++);
  };
}

/** The tool results a request carried, by call id, in either provider's shape. */
function sentResults(body: Record<string, unknown>): Map<string, string> {
  const out = new Map<string, string>();
  for (const message of body.messages as Block[]) {
    if (message.role === "tool")
      out.set(String(message.tool_call_id), String(message.content));
    for (const block of blocks(message))
      if (block.type === "tool_result")
        out.set(
          String(block.tool_use_id),
          typeof block.content === "string"
            ? block.content
            : (block.content as Block[]).map((part) => part.text).join(""),
        );
  }
  return out;
}

/** The call ids a request carried, in either provider's shape. */
function sentCalls(body: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const message of body.messages as Block[]) {
    for (const call of (message.tool_calls as Block[] | undefined) ?? [])
      out.push(String(call.id));
    for (const block of blocks(message))
      if (block.type === "tool_use") out.push(String(block.id));
  }
  return out;
}

/** How many of the results went whole, and the ids of those that went as a cleared note. */
function shape(body: Record<string, unknown>) {
  const results = sentResults(body);
  const whole: string[] = [];
  const notes: string[] = [];
  for (const [id, content] of results) {
    const marker = /^RESULT_(\d+)_START/.exec(content);
    if (content === cleared(id)) notes.push(id);
    else if (marker) {
      assert.equal(content, resultBody(Number(marker[1])), `${id} is whole`);
      whole.push(id);
    }
  }
  return { results, whole, notes };
}

const runEnd = (events: Event[]) =>
  events.filter((event) => event.type.startsWith("RUN_")).at(-1)!;

const openAIEnv = (base: string) => ({
  BOT_PROVIDER: "openai",
  OPENAI_API_KEY: "sk-test",
  OPENAI_BASE_URL: `${base}/v1`,
});
const anthropicEnv = (base: string) => ({
  BOT_PROVIDER: "anthropic",
  ANTHROPIC_API_KEY: "sk-ant-test",
  ANTHROPIC_BASE_URL: base,
});
/** On Chat Completions, whose request these tests read. */
const OPENAI_MODEL = { model: "gpt-5.2" };
const CLAUDE_MODEL = { model: "claude-sonnet-5-5" };

const lookupOnce = (_: Recorded, answered: number): Turn =>
  answered === 0
    ? { calls: [{ id: "call_new", name: "lookup", args: { q: "next page" } }] }
    : { text: "Done. FINAL_WORDS" };

/**
 * The run OpenBot sends after answering `call_new`, which the first run handed back: the same
 * thread with that call and `result` after it.
 */
function continued(
  input: Record<string, unknown>,
  result: string,
): Record<string, unknown> {
  return {
    ...input,
    runId: "run-2",
    messages: [
      ...(input.messages as unknown[]),
      {
        id: "a-new",
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "call_new",
            type: "function",
            function: {
              name: "lookup",
              arguments: JSON.stringify({ q: "next page" }),
            },
          },
        ],
      },
      { id: "t-new", role: "tool", toolCallId: "call_new", content: result },
    ],
  };
}

/** A step, then the run that carries it on with `result`, on one engine. */
async function stepAndContinue(
  env: Record<string, string>,
  input: Record<string, unknown>,
  result: string,
) {
  return withEngine({ env }, async (base) => {
    const first = await run(base, input);
    assert.equal(runEnd(first.events).type, "RUN_FINISHED");
    const second = await run(base, continued(input, result));
    assert.equal(runEnd(second.events).type, "RUN_FINISHED");
    return { first, second };
  });
}

test("OpenAI: a conversation past the model's window keeps going, old results cleared from what is sent", async () => {
  const provider = await fakeProvider(
    behindWindow(128_000, OPENAI_TOO_LONG, lookupOnce),
  );
  try {
    const env = openAIEnv(provider.base);
    const input = longThread();
    input.forwardedProps = { openbotModel: OPENAI_MODEL };
    const { first: result } = await stepAndContinue(
      env,
      input,
      resultBody(RESULTS),
    );
    assert.equal(provider.requests.length, 2, "no request was refused");

    const first = provider.requests[0]!.body;
    const { whole, notes } = shape(first);
    // The last ten results whole, the two search_tools results whole, every other one a note.
    assert.deepEqual(whole, [
      "call_0",
      "call_1",
      ...Array.from({ length: 10 }, (_, i) => `call_${50 + i}`),
    ]);
    assert.deepEqual(
      notes,
      Array.from({ length: 48 }, (_, i) => `call_${2 + i}`),
    );
    // Every call still has its result, so no provider sees an orphan.
    assert.deepEqual(
      [...sentResults(first).keys()].sort(),
      sentCalls(first).sort(),
    );
    // The system prompt, the person's messages and the Bot's words all went.
    const sent = JSON.stringify(first);
    for (const marker of [
      "STANDING_ROLE_MARKER",
      "GRANTED_TOOLS_MARKER",
      "FIRST_USER_MARKER",
      "BOT_WORDS_MARKER",
      "LATEST_MARKER",
    ])
      assert.ok(sent.includes(marker), `${marker} reached the model`);
    assert.equal(
      (first.messages as Block[])[0]!.role === "system" ||
        (first.messages as Block[])[0]!.role === "developer",
      true,
    );

    // The next step, in the run that carries the turn on, clears again; the new result is whole.
    const second = shape(provider.requests[1]!.body);
    assert.ok(second.whole.includes("call_new"));
    assert.equal(second.whole.length, 12);

    // Only what was sent was cut: the thread the run hands back is whole.
    const snapshot = result.events.find(
      (event) => event.type === "MESSAGES_SNAPSHOT",
    )!;
    const stored = (snapshot.messages as Block[]).filter(
      (message) => message.role === "tool",
    );
    assert.equal(stored.length, RESULTS);
    for (let i = 0; i < RESULTS; i += 1)
      assert.equal(stored[i]!.content, resultBody(i));
  } finally {
    await provider.close();
  }
});

test("Claude: every request carries context editing and its beta, with the whole history, and Anthropic clears it", async () => {
  const provider = await fakeProvider(
    behindWindow(128_000, ANTHROPIC_TOO_LONG, lookupOnce),
  );
  try {
    const env = anthropicEnv(provider.base);
    const input = longThread();
    input.forwardedProps = { openbotModel: CLAUDE_MODEL };
    await stepAndContinue(env, input, "a short result");
    assert.equal(provider.requests.length, 2, "no request was refused");
    for (const request of provider.requests) {
      assert.equal(request.path, "/v1/messages");
      assert.deepEqual(request.body.context_management, CONTEXT_EDITING);
      assert.ok(
        String(request.headers["anthropic-beta"]).includes(
          CONTEXT_EDITING_BETA,
        ),
      );
      const { whole, notes } = shape(request.body);
      assert.equal(whole.length, RESULTS, "the whole history, uncleared");
      assert.equal(notes.length, 0);
    }
  } finally {
    await provider.close();
  }
});

test("Claude behind a proxy that refuses context editing: cleared here instead, and remembered for the process", async () => {
  const provider = await fakeProvider(
    behindWindow(
      128_000,
      ANTHROPIC_TOO_LONG,
      () => ({ text: "Carried on." }),
      (request) =>
        request.body.context_management ? PROXY_REFUSES_EDITING : undefined,
    ),
  );
  try {
    const env = anthropicEnv(provider.base);
    const input = longThread();
    input.forwardedProps = { openbotModel: CLAUDE_MODEL };
    await withEngine({ env }, async (base) => {
      const first = await run(base, input);
      assert.equal(runEnd(first.events).type, "RUN_FINISHED");
      const second = await run(base, { ...input, runId: "run-2" });
      assert.equal(runEnd(second.events).type, "RUN_FINISHED");
    });
    assert.equal(provider.requests.length, 3);
    assert.ok(provider.requests[0]!.body.context_management);
    for (const request of provider.requests.slice(1)) {
      assert.equal(request.body.context_management, undefined);
      assert.ok(
        !String(request.headers["anthropic-beta"] ?? "").includes(
          CONTEXT_EDITING_BETA,
        ),
      );
      const { whole, notes } = shape(request.body);
      assert.equal(whole.length, 12);
      assert.equal(notes.length, 48);
    }
  } finally {
    await provider.close();
  }
});

test("A smaller window: the refused call is retried cleared harder, and the run that carries it on gets through the same way", async () => {
  // Ten whole results are too many for this window; three fit.
  const provider = await fakeProvider(
    behindWindow(25_000, OPENAI_TOO_LONG, lookupOnce),
  );
  try {
    const env = openAIEnv(provider.base);
    const input = longThread();
    input.forwardedProps = { openbotModel: OPENAI_MODEL };
    const { second } = await stepAndContinue(env, input, resultBody(61));
    // The first run: refused once, then the stage that fits. The thread keeps that stage, so the
    // run after the hand-back starts there and is not refused first: a long task carried on step
    // after step is refused once, not once a step.
    assert.equal(provider.requests.length, 3);
    assert.equal(shape(provider.requests[0]!.body).whole.length, 12);
    const retried = shape(provider.requests[1]!.body);
    assert.deepEqual(retried.whole, [
      "call_0",
      "call_1",
      "call_57",
      "call_58",
      "call_59",
    ]);
    const next = shape(provider.requests[2]!.body);
    assert.deepEqual(next.whole, [
      "call_0",
      "call_1",
      "call_58",
      "call_59",
      "call_new",
    ]);
    assert.equal(next.notes.length, RESULTS - 2 - 2);
    assert.equal(
      second.events
        .filter((event) => event.type === "TEXT_MESSAGE_CONTENT")
        .map((event) => event.delta)
        .join(""),
      "Done. FINAL_WORDS",
    );
  } finally {
    await provider.close();
  }
});

test("A latest message too long even alone ends the run with OPENBOT_MODEL_MESSAGE_TOO_LONG and the provider's words", async () => {
  const provider = await fakeProvider(
    behindWindow(20_000, ANTHROPIC_TOO_LONG, () => ({ text: "never" })),
  );
  try {
    const env = anthropicEnv(provider.base);
    const latest = `HUGE_LATEST ${"paste ".repeat(70_000)}`;
    const earlier = `EARLY_LONG ${"context ".repeat(1_000)}`;
    const input = longThread(latest, earlier);
    input.forwardedProps = { openbotModel: CLAUDE_MODEL };
    const result = await withEngine({ env }, (base) => run(base, input));
    const end = runEnd(result.events);
    assert.equal(end.type, "RUN_ERROR");
    assert.equal(end.code, "OPENBOT_MODEL_MESSAGE_TOO_LONG");
    assert.equal(
      end.message,
      "prompt is too long: 1008027 tokens > 1000000 maximum",
    );
    assert.ok(!types(result.events).includes("MESSAGES_SNAPSHOT"));

    // The first try and three retries, each harder.
    assert.equal(provider.requests.length, 4);
    const [first, stage1, stage2, stage3] = provider.requests.map(
      (request) => request.body,
    );
    assert.equal(shape(first!).notes.length, 0, "Anthropic clears the first");
    assert.equal(shape(stage1!).whole.length, 2 + 3);
    assert.equal(shape(stage2!).whole.length, 2 + 1);
    assert.equal(shape(stage3!).whole.length, 2, "only search_tools whole");
    const firstUser = (body: Record<string, unknown>) =>
      JSON.stringify((body.messages as Block[])[0]!.content);
    assert.ok(firstUser(stage1!).length > 7_000, "not cut before stage 2");
    for (const body of [stage2!, stage3!]) {
      assert.ok(firstUser(body).includes(CUT_NOTE.slice(1, -1)));
      assert.ok(firstUser(body).length < 2_300);
    }
    // The latest message itself is never cut.
    for (const body of [first!, stage1!, stage2!, stage3!])
      assert.ok(JSON.stringify(body).includes(latest));
  } finally {
    await provider.close();
  }
});

test("recall_earlier_results reads a cleared result back whole by call_id, and finds results by words", async () => {
  const provider = await fakeProvider(
    behindWindow(128_000, OPENAI_TOO_LONG, (_, answered) =>
      answered === 0
        ? {
            calls: [
              {
                id: "recall_1",
                name: "recall_earlier_results",
                args: { call_id: "call_5" },
              },
              {
                id: "recall_2",
                name: "recall_earlier_results",
                args: { words: "QUARTERLY zebra" },
              },
            ],
          }
        : { text: "Found them." },
    ),
  );
  try {
    const env = openAIEnv(provider.base);
    const input = longThread();
    input.forwardedProps = { openbotModel: OPENAI_MODEL };
    const result = await withEngine({ env }, (base) => run(base, input));
    assert.equal(runEnd(result.events).type, "RUN_FINISHED");
    assert.equal(provider.requests.length, 2, "a recall is answered here");

    const first = provider.requests[0]!.body;
    assert.deepEqual(
      (first.tools as { function: { name: string } }[]).map(
        (tool) => tool.function.name,
      ),
      ["lookup", "recall_earlier_results"],
    );
    assert.ok(shape(first).notes.includes("call_5"), "call_5 was cleared");

    const recalled = sentResults(provider.requests[1]!.body);
    assert.equal(
      recalled.get("recall_1"),
      `Result of lookup (call_id "call_5"):\n${resultBody(5)}`,
    );
    const found = recalled.get("recall_2")!;
    // The three most recent results about a quarterly zebra, newest first: 56, 49, 42.
    assert.ok(
      found.startsWith(
        `Result of lookup (call_id "call_56"):\n${resultBody(56)}`,
      ),
    );
    assert.ok(found.includes(`Result of lookup (call_id "call_49"):`));
    assert.ok(found.includes(`Result of lookup (call_id "call_42"):`));
    assert.ok(!found.includes(`(call_id "call_35")`));
    // Three whole results run past 20,000 characters: cut, and it says so.
    assert.ok(
      found.endsWith(
        "[Cut here: what was recalled ran past 20,000 characters.]",
      ),
    );
    assert.ok(found.length < 20_100);
  } finally {
    await provider.close();
  }
});

test("A Bot with no tools is not offered recall_earlier_results", async () => {
  const provider = await fakeProvider(() => ({ text: "ok" }));
  try {
    await withEngine({ env: openAIEnv(provider.base) }, (base) =>
      run(
        base,
        conversation({ forwardedProps: { openbotModel: OPENAI_MODEL } }),
      ),
    );
    assert.equal(provider.requests[0]!.body.tools, undefined);
  } finally {
    await provider.close();
  }
});
