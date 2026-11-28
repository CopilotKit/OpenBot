/**
 * Gemini's thought signatures survive every hand-back, on Google's OpenAI-compatible API.
 *
 * FOUND ON OPENBOT CLOUD: a Bot on Gemini 3 behind the model gateway stopped at the second tool
 * step of a turn with Google's 400, "Function call is missing a thought_signature in functionCall
 * parts ... function call `default_api:search_tools`, position 6". The gateway reaches Gemini on its
 * OpenAI-compatible Chat Completions API, where the signature rides on the tool call as
 * `extra_content.google.thought_signature`, and @langchain/openai neither read it from the answer
 * nor sent it back. Each tool step is a run of its own, so the next run sent the call without it.
 *
 * The provider behind the gateway is the fake Gemini in fake-provider.ts, which refuses a request
 * exactly as Google does when the first call of a step in the current turn comes back without the
 * signature it gave, or with one it never gave.
 */
import assert from "node:assert/strict";
import { inspect } from "node:util";
import { test } from "node:test";
import {
  type FakeProvider,
  fakeProvider,
  type Responder,
} from "./fake-provider.ts";
import { type Event, pendingOf, run, withEngine } from "./helpers.ts";
import { modelGateway } from "./model-gateway.ts";

const SEARCH = {
  name: "search_tools",
  description: "Find the tools for a task.",
  parameters: { type: "object", properties: { query: { type: "string" } } },
};
const FIND_REPOS = {
  name: "composio-github__GITHUB_FIND_REPOSITORIES",
  description: "Find GitHub repositories.",
  parameters: { type: "object", properties: { query: { type: "string" } } },
};

const STANDING_ROLE = {
  id: "standing-role:test-bot",
  role: "system",
  content: "You are Test Bot.",
};

type Message = Record<string, unknown>;
type CallShape = { id: string; encryptedValue?: string };

function words(events: Event[]): string {
  return events
    .filter((event) => event.type === "TEXT_MESSAGE_CONTENT")
    .map((event) => String(event.delta))
    .join("");
}

function snapshotOf(events: Event[]): Message[] {
  return events.findLast((event) => event.type === "MESSAGES_SNAPSHOT")!
    .messages as Message[];
}

function finished(events: Event[], label: string) {
  assert.equal(
    events.at(-1)?.type,
    "RUN_FINISHED",
    `${label}: ${inspect(events.at(-1))}`,
  );
}

/** The engine behind OpenBot's model gateway, as on OpenBot Cloud, with the fake Gemini behind it. */
async function onTheGateway(
  answer: Responder,
  body: (
    base: string,
    ask: (
      runId: string,
      model: string,
      messages: Message[],
    ) => Promise<Event[]>,
    gemini: FakeProvider,
  ) => Promise<void>,
) {
  const gemini = await fakeProvider(answer);
  const gateway = await modelGateway(
    {
      openai: { base: gemini.base, key: "AIza-upstream" },
      anthropic: { base: gemini.base, key: "unused" },
    },
    "openai",
  );
  const env = {
    OPENBOT_MODEL_GATEWAY_URL: gateway.url,
    BOT_PROVIDER: "openai",
    OPENAI_API_KEY: "",
    ANTHROPIC_API_KEY: "",
  };
  try {
    await withEngine({ env }, async (base) => {
      const ask = async (runId: string, model: string, messages: Message[]) => {
        gateway.mint(`token-${runId}`);
        const result = await run(base, {
          threadId: "thread-gemini",
          runId,
          state: {},
          messages,
          tools: [SEARCH, FIND_REPOS],
          context: [],
          forwardedProps: {
            openbotModel: { model },
            openbotModelRoute: { via: "openai", token: `token-${runId}` },
          },
        });
        return result.events;
      };
      await body(base, ask, gemini);
    });
  } finally {
    await gateway.close();
    await gemini.close();
  }
}

/** The tool calls of the assistant messages a Chat Completions request carries, in order. */
function sentCalls(body: Record<string, unknown>) {
  return ((body.messages ?? []) as Message[])
    .filter(
      (message) =>
        message.role === "assistant" && Array.isArray(message.tool_calls),
    )
    .map((message) =>
      (
        message.tool_calls as {
          id: string;
          extra_content?: { google?: { thought_signature?: string } };
        }[]
      ).map((call) => ({
        id: call.id,
        signature: call.extra_content?.google?.thought_signature,
      })),
    );
}

test("Gemini 3 behind the model gateway: a turn of two tool steps, one of them parallel, keeps each step's thought signature and answers", async () => {
  const answer: Responder = (request) => {
    const text = JSON.stringify(request.body.messages);
    if (text.includes("Reading R-2")) return { text: "Found 2 repositories." };
    if (text.includes("Reading R-1"))
      return {
        calls: [
          {
            id: "function-call-2",
            name: FIND_REPOS.name,
            args: { query: "openbot" },
            signature: "SIG_STEP_2",
          },
          // A parallel call: Gemini signs only the first call of a step.
          {
            id: "function-call-3",
            name: SEARCH.name,
            args: { query: "issues" },
          },
        ],
      };
    return {
      calls: [
        {
          id: "function-call-1",
          name: SEARCH.name,
          args: { query: "github" },
          signature: "SIG_STEP_1",
        },
      ],
    };
  };
  await onTheGateway(answer, async (_base, ask, gemini) => {
    const asked: Message[] = [
      STANDING_ROLE,
      { id: "u1", role: "user", content: "Find my GitHub repositories." },
    ];

    // Step 1: the call is handed back with its signature, the AG-UI way.
    const first = await ask("run-1", "gemini-3.5-flash", asked);
    finished(first, "step 1");
    assert.deepEqual(pendingOf(first), ["function-call-1"]);
    const afterFirst = snapshotOf(first);

    // Step 2: OpenBot answers the call and sends the thread back, as the snapshot held it.
    const second = await ask("run-2", "gemini-3.5-flash", [
      ...afterFirst,
      {
        id: "t1",
        role: "tool",
        toolCallId: "function-call-1",
        content: "search_tools found GitHub. Reading R-1.",
      },
    ]);
    finished(second, "step 2");
    assert.deepEqual(pendingOf(second), ["function-call-2", "function-call-3"]);
    const afterSecond = snapshotOf(second);

    // Step 3: both results back; Gemini answers in words.
    const third = await ask("run-3", "gemini-3.5-flash", [
      ...afterSecond,
      {
        id: "t2",
        role: "tool",
        toolCallId: "function-call-2",
        content: "2 repositories. Reading R-2.",
      },
      {
        id: "t3",
        role: "tool",
        toolCallId: "function-call-3",
        content: "No issues.",
      },
    ]);
    finished(third, "step 3");
    assert.equal(words(third), "Found 2 repositories.");

    // Each handed-back call carried its signature the AG-UI way: the event, then the snapshot.
    const sealed = first.find(
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
        entityId: "function-call-1",
        encryptedValue: "SIG_STEP_1",
      },
    );
    assert.equal(
      (afterFirst.at(-1)!.toolCalls as CallShape[])[0]!.encryptedValue,
      "SIG_STEP_1",
    );
    const parallel = afterSecond.at(-1)!.toolCalls as CallShape[];
    assert.equal(parallel[0]!.encryptedValue, "SIG_STEP_2");
    assert.equal(parallel[1]!.encryptedValue, undefined);

    assert.deepEqual(
      gemini.requests.map((request) => request.refused),
      [undefined, undefined, undefined],
      "Gemini refused none of the steps",
    );
    // Exactly the signatures Gemini gave, each on its own call, and nothing on the unsigned one.
    assert.deepEqual(sentCalls(gemini.requests[2]!.body), [
      [{ id: "function-call-1", signature: "SIG_STEP_1" }],
      [
        { id: "function-call-2", signature: "SIG_STEP_2" },
        { id: "function-call-3", signature: undefined },
      ],
    ]);
  });
});

test("Gemini 3: a turn whose earlier call lost its signature before this fix goes on, on Google's placeholder", async () => {
  const answer: Responder = () => ({ text: "Here are your repositories." });
  await onTheGateway(answer, async (_base, ask, gemini) => {
    const events = await ask("run-old", "gemini-3.8-flash", [
      STANDING_ROLE,
      { id: "u1", role: "user", content: "Find my GitHub repositories." },
      {
        id: "a1",
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "function-call-9",
            type: "function",
            function: { name: SEARCH.name, arguments: '{"query":"github"}' },
          },
        ],
      },
      {
        id: "t9",
        role: "tool",
        toolCallId: "function-call-9",
        content: "search_tools found GitHub.",
      },
    ]);
    finished(events, "the stored turn");
    assert.equal(words(events), "Here are your repositories.");
    assert.equal(gemini.requests[0]!.refused, undefined);
    assert.deepEqual(sentCalls(gemini.requests[0]!.body), [
      [
        {
          id: "function-call-9",
          signature: "skip_thought_signature_validator",
        },
      ],
    ]);
  });
});

test("A Gemini signature on the thread is never sent to another provider's model", async () => {
  const answer: Responder = () => ({ text: "Sunny." });
  await onTheGateway(answer, async (_base, ask, provider) => {
    const events = await ask("run-gpt", "gpt-5.5", [
      STANDING_ROLE,
      { id: "u1", role: "user", content: "Find my GitHub repositories." },
      {
        id: "a1",
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "function-call-1",
            type: "function",
            function: { name: SEARCH.name, arguments: '{"query":"github"}' },
            encryptedValue: "SIG_STEP_1",
          },
        ],
      },
      {
        id: "t1",
        role: "tool",
        toolCallId: "function-call-1",
        content: "search_tools found GitHub.",
      },
      { id: "u2", role: "user", content: "And the weather?" },
    ]);
    finished(events, "gpt-5.5");
    const sent = JSON.stringify(provider.requests[0]!.body);
    assert.ok(!sent.includes("SIG_STEP_1"), sent);
    assert.ok(!sent.includes("extra_content"), sent);
  });
});
