/**
 * The AI connection changes between runs, with no restart of the engine.
 *
 * The server tells each run which way its model is reached (`forwardedProps.openbotModelRoute`):
 * `openai` or `anthropic` through the server's model gateway with the run's own token, or
 * `chatgpt-plan` / `claude-plan` to that plan's engine. The engine holds no provider key: its
 * environment names only the gateway and the plan engines.
 *
 * The gateway here is the contract's (test/model-gateway.ts). By default the fake provider stands
 * behind it; with `OPENBOT_LIVE_PROVIDERS=1` and the keys in this process's environment, the real
 * OpenAI and Anthropic APIs do, and the same tests must pass.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { inspect } from "node:util";
import {
  always,
  type FakeProvider,
  fakeProvider,
  type Responder,
} from "./fake-provider.ts";
import { conversation, run, WEATHER_TOOL, withEngine } from "./helpers.ts";
import {
  type Gateway,
  liveUpstreams,
  MISMATCH,
  modelGateway,
  type Provider,
  type Upstream,
} from "./model-gateway.ts";

const live = liveUpstreams();
const OPENAI_MODEL = live
  ? (process.env.OPENBOT_LIVE_OPENAI_MODEL ?? "gpt-4.1-mini")
  : "gpt-4.1-mini";
const RESPONSES_MODEL = live
  ? (process.env.OPENBOT_LIVE_RESPONSES_MODEL ?? "gpt-5.6")
  : "gpt-5.6-terra";
const ANTHROPIC_MODEL = live
  ? (process.env.OPENBOT_LIVE_ANTHROPIC_MODEL ?? "claude-haiku-4-5")
  : "claude-haiku-4-5";

/** What the engine's environment holds under the live connection: no provider key at all. */
const engineEnv = (gateway: string) => ({
  OPENBOT_MODEL_GATEWAY_URL: gateway,
  BOT_PROVIDER: "openai",
  OPENAI_API_KEY: "",
  ANTHROPIC_API_KEY: "",
});

const pineapple: Responder = (request) =>
  always({
    text: request.path.endsWith("/messages")
      ? "Pineapple, from Anthropic."
      : "Pineapple, from OpenAI.",
  })(request, 0);

async function withGateway<T>(
  first: Provider,
  body: (gateway: Gateway, upstream?: FakeProvider) => Promise<T>,
  answer: Responder = pineapple,
): Promise<T> {
  const fake = live ? undefined : await fakeProvider(answer);
  const upstreams: Record<Provider, Upstream> = live ?? {
    openai: { base: fake!.base, key: "sk-upstream-openai" },
    anthropic: { base: fake!.base, key: "sk-ant-upstream" },
  };
  const gateway = await modelGateway(upstreams, first);
  try {
    return await body(gateway, fake);
  } finally {
    await gateway.close();
    await fake?.close();
  }
}

const ask = (overrides: Record<string, unknown>) =>
  conversation({
    messages: [
      {
        id: "standing-role:test-bot",
        role: "system",
        content: "You are Test Bot. Answer in one short sentence.",
      },
      {
        id: "u1",
        role: "user",
        content: "Reply with the word pineapple and nothing else.",
      },
    ],
    ...overrides,
  });

function words(events: { type: string; delta?: unknown }[]): string {
  return events
    .filter((event) => event.type === "TEXT_MESSAGE_CONTENT")
    .map((event) => String(event.delta))
    .join("");
}

test("One engine process answers run 1 on the openai route and run 2 on the anthropic route", async () => {
  await withGateway("openai", async (gateway) => {
    gateway.mint("run-token-1");
    gateway.mint("run-token-2");
    await withEngine({ env: engineEnv(gateway.url) }, async (base) => {
      const first = await run(
        base,
        ask({
          runId: "run-1",
          forwardedProps: {
            openbotModel: { model: OPENAI_MODEL },
            openbotModelRoute: { via: "openai", token: "run-token-1" },
          },
        }),
      );
      assert.equal(
        first.events.at(-1)?.type,
        "RUN_FINISHED",
        inspect(first.events.at(-1)),
      );
      assert.match(words(first.events), /pineapple/i);

      // The person changes the AI connection. Nothing about the engine restarts.
      gateway.connect("anthropic");

      const second = await run(
        base,
        ask({
          runId: "run-2",
          forwardedProps: {
            openbotModel: { model: ANTHROPIC_MODEL },
            openbotModelRoute: { via: "anthropic", token: "run-token-2" },
          },
        }),
      );
      assert.equal(
        second.events.at(-1)?.type,
        "RUN_FINISHED",
        inspect(second.events.at(-1)),
      );
      assert.match(words(second.events), /pineapple/i);
    });

    const served = gateway.requests.map((request) => ({
      path: request.path,
      served: request.served,
      auth: request.auth,
      status: request.status,
      model: request.body.model,
    }));
    assert.deepEqual(served, [
      {
        path: "/api/model-provider/v1/chat/completions",
        served: "openai",
        auth: { header: "authorization", token: "run-token-1" },
        status: 200,
        model: OPENAI_MODEL,
      },
      {
        path: "/api/model-provider/anthropic/v1/messages",
        served: "anthropic",
        // @anthropic-ai/sdk 1.x sends a key as a bearer; the gateway takes either header.
        auth: { header: "authorization", token: "run-token-2" },
        status: 200,
        model: ANTHROPIC_MODEL,
      },
    ]);
  });
});

/*
 * SWITCHING MODELS MID-CONVERSATION, BETWEEN PROVIDERS, AND BACK.
 *
 * Found in dogfooding: a conversation answered on an OpenAI Responses model (GPT-6.2 Astra), then
 * the person picked Claude Opus 5.5 in the composer, whose effort the picker shows as Extra high,
 * and sent. The run ended in under a second with "The Bot stopped before it finished answering":
 * @langchain/anthropic checks its own default `thinking: disabled` against Opus 5's rule that
 * disabled thinking can't run at `xhigh` or `max`, though it never sends that default, and threw
 * before anything was asked.
 *
 * AG-UI has no idea of a provider. Each provider's opaque reasoning rides on the thread as an
 * `encryptedValue` (on a `reasoning` row, and on a call), and nothing says whose it is; OpenAI's
 * is a reference into OpenAI's own store that no other provider can use. So on every switch the
 * new provider is sent none of it, every visible turn and every tool result stays, and every
 * earlier call and its result are sent in the new provider's own shape, whoever made them.
 * Switching back to the first provider works the same way.
 */
type Side = {
  via: Provider;
  model: string;
  effort?: string;
  /** The id this provider gives a call, in its own format. */
  callId: string;
  /** This provider's opaque reasoning, as a surface keeps it on the thread. */
  sealed: string;
};

const ASTRA: Side = {
  via: "openai",
  model: live ? RESPONSES_MODEL : "gpt-6.2-astra",
  effort: "high",
  callId: "call_Wq3nX8pL2vR7",
  sealed: "gAAAAB-openai-encrypted-reasoning",
};
const OPUS: Side = {
  via: "anthropic",
  model: "claude-opus-5-5",
  effort: "xhigh",
  callId: "toolu_01AbCdEfGhIjKlMn",
  sealed: "EqQBCkYIBxgCKkA-anthropic-signature",
};

/** A turn of the conversation: the model picked, what the person asks, and whether a tool answers. */
type Leg = { side: Side; ask: string; city?: string };

/** The blocks of an Anthropic Messages body, or the items of a Responses body, flat. */
function partsOf(body: Record<string, unknown>): Record<string, unknown>[] {
  if (Array.isArray(body.input)) return body.input as Record<string, unknown>[];
  return (body.messages as { content: unknown }[]).flatMap((message) =>
    Array.isArray(message.content)
      ? (message.content as Record<string, unknown>[])
      : [],
  );
}

/** Every call id the request carries, as the call and as its result, in its provider's shape. */
function callsSent(via: Provider, body: Record<string, unknown>) {
  const parts = partsOf(body);
  const ids = (type: string, key: string) =>
    parts.filter((part) => part.type === type).map((part) => String(part[key]));
  return via === "anthropic"
    ? {
        calls: ids("tool_use", "id"),
        results: ids("tool_result", "tool_use_id"),
      }
    : {
        calls: ids("function_call", "call_id"),
        results: ids("function_call_output", "call_id"),
      };
}

/**
 * One conversation across `legs`, each on its own model. Every leg but the last asks for the
 * weather, the model calls the tool, and the person's app answers it; a reasoning row with that
 * provider's sealed reasoning goes on the thread, and the call carries it too. The last leg must
 * answer in words. Each run's request is read at the provider.
 */
async function conversationAcross(legs: Leg[]) {
  const choice = (side: Side) => ({
    model: side.model,
    ...(side.effort ? { reasoningEffort: side.effort } : {}),
  });
  const calling = legs.slice(0, -1);
  // Request `i` is leg `i`'s one request: a call, until the last leg, which answers.
  const answer: Responder = (request, index) => {
    const leg = calling[index];
    return leg
      ? {
          calls: [
            {
              id: leg.side.callId,
              name: "get_weather",
              args: { city: leg.city },
            },
          ],
        }
      : pineapple(request, index);
  };
  await withGateway(
    legs[0]!.side.via,
    async (gateway) => {
      for (const index of legs.keys()) gateway.mint(`run-token-leg-${index}`);
      let thread: Record<string, unknown>[] = [
        {
          id: "standing-role:test-bot",
          role: "system",
          content: "You are Test Bot. Answer in one short sentence.",
        },
      ];
      const callIds: string[] = [];
      await withEngine({ env: engineEnv(gateway.url) }, async (base) => {
        for (const [index, leg] of legs.entries()) {
          gateway.connect(leg.side.via);
          const asked = [
            ...thread,
            { id: `u${index}`, role: "user", content: leg.ask },
          ];
          const result = await run(
            base,
            ask({
              runId: `run-leg-${index}`,
              tools: [WEATHER_TOOL],
              messages: asked,
              forwardedProps: {
                openbotModel: choice(leg.side),
                openbotModelRoute: {
                  via: leg.side.via,
                  token: `run-token-leg-${index}`,
                },
              },
            }),
          );
          assert.equal(
            result.events.at(-1)?.type,
            "RUN_FINISHED",
            `leg ${index} on ${leg.side.model}: ${inspect(result.events.at(-1))}`,
          );
          const snapshot = result.events.findLast(
            (event) => event.type === "MESSAGES_SNAPSHOT",
          )?.messages as Record<string, unknown>[];
          if (index === legs.length - 1) {
            assert.match(words(result.events), /pineapple/i);
            break;
          }
          const called = snapshot
            .slice(asked.length)
            .find((message) => Array.isArray(message.toolCalls)) as {
            toolCalls: { id: string; encryptedValue?: string }[];
          };
          assert.ok(
            called,
            `leg ${index} on ${leg.side.model} called the tool`,
          );
          const callId = called.toolCalls[0]!.id;
          if (!live) assert.equal(callId, leg.side.callId);
          callIds.push(callId);
          // What the provider sealed travels on the thread, as AG-UI carries it.
          called.toolCalls[0]!.encryptedValue = leg.side.sealed;
          thread = [
            ...snapshot,
            {
              id: `result-${index}`,
              role: "tool",
              toolCallId: callId,
              content: `Sunny, ${20 + index} degrees in ${leg.city}.`,
            },
            {
              id: `reasoning-${index}`,
              role: "reasoning",
              content: "The weather tool answered; summarise it.",
              encryptedValue: leg.side.sealed,
            },
          ];
        }
      });

      assert.equal(gateway.requests.length, legs.length);
      for (const [index, leg] of legs.entries()) {
        if (index === 0) continue;
        const sent = gateway.requests[index]!;
        const label = `leg ${index} on ${leg.side.model}`;
        assert.equal(sent.served, leg.side.via, label);
        assert.equal(sent.status, 200, label);
        assert.equal(sent.body.model, leg.side.model, label);
        const text = JSON.stringify(sent.body);
        // No provider's opaque reasoning, not even this provider's own from an earlier turn.
        for (const earlier of legs.slice(0, index))
          assert.ok(
            !text.includes(earlier.side.sealed),
            `${label}: sealed reasoning sent`,
          );
        // Every visible turn stays.
        for (const earlier of legs.slice(0, index + 1))
          assert.ok(
            text.includes(earlier.ask),
            `${label}: "${earlier.ask}" missing`,
          );
        if (live) continue;
        if (leg.side.via === "anthropic") {
          if (leg.side.effort)
            assert.deepEqual(sent.body.output_config, {
              effort: leg.side.effort,
            });
          assert.notEqual(
            (sent.body.thinking as { type?: string } | undefined)?.type,
            "disabled",
          );
        }
        assert.ok(
          partsOf(sent.body).every(
            (part) =>
              part.type !== "thinking" &&
              part.type !== "redacted_thinking" &&
              part.type !== "reasoning",
          ),
          `${label}: reasoning sent`,
        );
        // Every earlier call and its result, whoever made it, in this provider's own shape.
        const { calls, results } = callsSent(leg.side.via, sent.body);
        const earlierCalls = callIds.slice(0, index);
        assert.deepEqual(calls, earlierCalls, `${label}: calls`);
        assert.deepEqual(results, earlierCalls, `${label}: results`);
        for (const id of calls) assert.match(id, /^[a-zA-Z0-9_-]+$/);
        for (const index_ of earlierCalls.keys())
          assert.ok(
            text.includes(`degrees in ${legs[index_]!.city}`),
            `${label}: a tool result is missing`,
          );
      }
    },
    answer,
  );
}

test("GPT-6.2 Astra to Claude Opus 5.5 at Extra high and back, mid-conversation, with tool calls and reasoning on the thread: every run answers", async () => {
  await conversationAcross([
    {
      side: ASTRA,
      ask: "What is the weather in Paris? Use get_weather.",
      city: "Paris",
    },
    { side: OPUS, ask: "And in London? Use get_weather.", city: "London" },
    {
      side: ASTRA,
      ask: "Thanks. Now reply with the word pineapple and nothing else.",
    },
  ]);
});

test("Claude Opus 5.5 at Extra high to GPT-6.2 Astra and back, mid-conversation, with tool calls and reasoning on the thread: every run answers", async () => {
  await conversationAcross([
    {
      side: OPUS,
      ask: "What is the weather in Paris? Use get_weather.",
      city: "Paris",
    },
    { side: ASTRA, ask: "And in London? Use get_weather.", city: "London" },
    {
      side: OPUS,
      ask: "Thanks. Now reply with the word pineapple and nothing else.",
    },
  ]);
});

test("On the openai route a model that takes tools only on the Responses API goes to the gateway's /v1/responses", async () => {
  await withGateway("openai", async (gateway) => {
    gateway.mint("run-token-r");
    const result = await withEngine({ env: engineEnv(gateway.url) }, (base) =>
      run(
        base,
        ask({
          forwardedProps: {
            openbotModel: { model: RESPONSES_MODEL, reasoningEffort: "low" },
            openbotModelRoute: { via: "openai", token: "run-token-r" },
          },
        }),
      ),
    );
    assert.equal(
      result.events.at(-1)?.type,
      "RUN_FINISHED",
      inspect(result.events.at(-1)),
    );
    assert.match(words(result.events), /pineapple/i);
    assert.equal(gateway.requests.length, 1);
    assert.equal(gateway.requests[0]!.path, "/api/model-provider/v1/responses");
    assert.deepEqual(gateway.requests[0]!.body.reasoning, { effort: "low" });
  });
});

test("A route whose wire the connection can't serve ends the run with the gateway's sentence, asked once", async () => {
  await withGateway("anthropic", async (gateway) => {
    gateway.mint("run-token-3");
    const result = await withEngine({ env: engineEnv(gateway.url) }, (base) =>
      run(
        base,
        ask({
          forwardedProps: {
            openbotModel: { model: OPENAI_MODEL },
            openbotModelRoute: { via: "openai", token: "run-token-3" },
          },
        }),
      ),
    );
    const error = result.events.at(-1)!;
    assert.equal(error.type, "RUN_ERROR");
    assert.equal(error.message, `Error code: 409 - ${MISMATCH.openai}`);
    assert.equal(error.code, "OPENBOT_MODEL_REFUSED");
    assert.equal(
      gateway.requests.length,
      1,
      "a 409 the gateway says not to retry is not retried",
    );
  });
});

test("An openai route goes to the gateway even where a ChatGPT plan engine is configured", async () => {
  await withGateway("openai", async (gateway) => {
    gateway.mint("run-token-4");
    const result = await withEngine(
      {
        env: {
          ...engineEnv(gateway.url),
          // Every engine in the live connection knows both plan engines from its start.
          CHATGPT_PLAN_HARNESS_URL: "http://127.0.0.1:9/never",
          CLAUDE_PLAN_HARNESS_URL: "http://127.0.0.1:9/never",
        },
      },
      (base) =>
        run(
          base,
          ask({
            forwardedProps: {
              openbotModel: { model: OPENAI_MODEL },
              openbotModelRoute: { via: "openai", token: "run-token-4" },
            },
          }),
        ),
    );
    assert.equal(
      result.events.at(-1)?.type,
      "RUN_FINISHED",
      inspect(result.events.at(-1)),
    );
    assert.equal(gateway.requests.length, 1);
    assert.equal(gateway.requests[0]!.served, "openai");
  });
});

test("No route, or no gateway address: the deployment's own environment, as before", async () => {
  const provider = await fakeProvider(always({ text: "from the environment" }));
  try {
    const env = {
      BOT_PROVIDER: "openai",
      OPENAI_BASE_URL: `${provider.base}/v1`,
      OPENAI_API_KEY: "sk-env",
    };
    const routedWithoutGateway = await withEngine({ env }, (base) =>
      run(
        base,
        ask({
          forwardedProps: {
            openbotModel: { model: OPENAI_MODEL },
            openbotModelRoute: { via: "anthropic", token: "run-token-5" },
          },
        }),
      ),
    );
    assert.equal(words(routedWithoutGateway.events), "from the environment");
    const withGatewayNoRoute = await withEngine(
      {
        env: {
          ...env,
          OPENBOT_MODEL_GATEWAY_URL: "http://127.0.0.1:9/api/model-provider",
        },
      },
      (base) =>
        run(
          base,
          ask({ forwardedProps: { openbotModel: { model: OPENAI_MODEL } } }),
        ),
    );
    assert.equal(words(withGatewayNoRoute.events), "from the environment");
    assert.deepEqual(
      provider.requests.map((request) => [
        request.path,
        request.headers.authorization,
      ]),
      [
        ["/v1/chat/completions", "Bearer sk-env"],
        ["/v1/chat/completions", "Bearer sk-env"],
      ],
    );
  } finally {
    await provider.close();
  }
});

test("A gateway route with no token is refused in words, and nothing is sent", async () => {
  await withGateway("openai", async (gateway) => {
    const result = await withEngine({ env: engineEnv(gateway.url) }, (base) =>
      run(
        base,
        ask({
          forwardedProps: {
            openbotModel: { model: OPENAI_MODEL },
            openbotModelRoute: { via: "openai" },
          },
        }),
      ),
    );
    const error = result.events.at(-1)!;
    assert.equal(error.type, "RUN_ERROR");
    assert.match(String(error.message), /model gateway/);
    assert.equal(gateway.requests.length, 0);
  });
});

test("Neither the run's token nor its forwardedProps reach the log, whatever fails", async () => {
  const TOKEN = "run-token-secret-6f1c";
  const logged: unknown[] = [];
  const log = {
    warn: (...args: unknown[]) => logged.push(...args),
    error: (...args: unknown[]) => logged.push(...args),
  };
  // Nothing answering at the gateway's address, then a gateway that refuses the token.
  await withEngine(
    { env: engineEnv("http://127.0.0.1:9/api/model-provider"), log },
    (base) =>
      run(
        base,
        ask({
          forwardedProps: {
            openbotSendOnce: true,
            openbotModel: { model: OPENAI_MODEL },
            openbotModelRoute: { via: "openai", token: TOKEN },
          },
        }),
      ),
  );
  await withGateway("anthropic", async (gateway) => {
    await withEngine({ env: engineEnv(gateway.url), log }, (base) =>
      run(
        base,
        ask({
          forwardedProps: {
            openbotModel: { model: ANTHROPIC_MODEL },
            openbotModelRoute: { via: "anthropic", token: TOKEN },
          },
        }),
      ),
    );
    assert.equal(gateway.requests[0]?.status, 401);
  });
  assert.ok(logged.length > 0, "the failures were logged");
  const text = logged.map((entry) => inspect(entry, { depth: 12 })).join("\n");
  assert.ok(!text.includes(TOKEN), "the run token is never logged");
  assert.ok(
    !text.includes("openbotModelRoute"),
    "forwardedProps are never logged",
  );
});
