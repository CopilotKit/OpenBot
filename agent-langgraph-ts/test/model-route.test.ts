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
 * SWITCHING MODELS MID-CONVERSATION. Found in dogfooding: a conversation answered on an OpenAI
 * Responses model, then the person picked Claude Opus 5.5 in the composer, whose effort the picker
 * shows as Extra high, and sent. The run ended in under a second with "The Bot stopped before it
 * finished answering": @langchain/anthropic checks its own default `thinking: disabled` against
 * Opus 5's rule that disabled thinking can't run at `xhigh` or `max`, though it never sends that
 * default, and threw before anything was asked.
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

const OPENAI_SIDE: Side = {
  via: "openai",
  model: RESPONSES_MODEL,
  callId: "call_Wq3nX8pL2vR7",
  sealed: "gAAAAB-openai-encrypted-reasoning",
};
const OPUS_SIDE: Side = {
  via: "anthropic",
  model: "claude-opus-5-5",
  effort: "xhigh",
  callId: "toolu_01AbCdEfGhIjKlMn",
  sealed: "EqQBCkYIBxgCKkA-anthropic-signature",
};

/**
 * One conversation, two providers: the first run on `from` calls a tool, the person's app answers
 * it, a reasoning row with `from`'s sealed reasoning sits on the thread, then the person picks
 * `to`'s model and sends. The second run must answer, sent the call and its result in `to`'s own
 * shape and nothing of `from`'s sealed reasoning.
 */
async function switchesMidConversation(from: Side, to: Side) {
  const choice = (side: Side) => ({
    model: side.model,
    ...(side.effort ? { reasoningEffort: side.effort } : {}),
  });
  // The first request is asked to call the tool; every later one answers.
  const answer: Responder = (request, index) =>
    index === 0
      ? {
          calls: [
            { id: from.callId, name: "get_weather", args: { city: "Paris" } },
          ],
        }
      : pineapple(request, index);
  await withGateway(
    from.via,
    async (gateway) => {
      gateway.mint("run-token-switch-1");
      gateway.mint("run-token-switch-2");
      await withEngine({ env: engineEnv(gateway.url) }, async (base) => {
        const first = await run(
          base,
          ask({
            runId: "run-switch-1",
            tools: [WEATHER_TOOL],
            messages: [
              {
                id: "standing-role:test-bot",
                role: "system",
                content: "You are Test Bot. Answer in one short sentence.",
              },
              {
                id: "u1",
                role: "user",
                content: "What is the weather in Paris? Use get_weather.",
              },
            ],
            forwardedProps: {
              openbotModel: choice(from),
              openbotModelRoute: { via: from.via, token: "run-token-switch-1" },
            },
          }),
        );
        assert.equal(
          first.events.at(-1)?.type,
          "RUN_FINISHED",
          inspect(first.events.at(-1)),
        );
        const snapshot = first.events.findLast(
          (event) => event.type === "MESSAGES_SNAPSHOT",
        )?.messages as Record<string, unknown>[];
        const called = snapshot.find((message) =>
          Array.isArray(message.toolCalls),
        ) as { toolCalls: { id: string; encryptedValue?: string }[] };
        const callId = called.toolCalls[0]!.id;
        if (!live) assert.equal(callId, from.callId);
        // What the provider sealed travels on the thread, as AG-UI carries it.
        called.toolCalls[0]!.encryptedValue = from.sealed;

        gateway.connect(to.via);

        const second = await run(
          base,
          ask({
            runId: "run-switch-2",
            tools: [WEATHER_TOOL],
            messages: [
              ...snapshot,
              {
                id: "result-1",
                role: "tool",
                toolCallId: callId,
                content: "Sunny, 21 degrees.",
              },
              {
                id: "reasoning-1",
                role: "reasoning",
                content: "The weather tool answered; summarise it.",
                encryptedValue: from.sealed,
              },
              {
                id: "u2",
                role: "user",
                content:
                  "Thanks. Now reply with the word pineapple and nothing else.",
              },
            ],
            forwardedProps: {
              openbotModel: choice(to),
              openbotModelRoute: { via: to.via, token: "run-token-switch-2" },
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

      const asked = gateway.requests.at(-1)!;
      assert.equal(asked.served, to.via);
      assert.equal(asked.status, 200);
      assert.equal(asked.body.model, to.model);
      const sent = JSON.stringify(asked.body);
      assert.ok(
        !sent.includes(from.sealed),
        "the other provider's sealed reasoning is never sent",
      );
      if (live) return;
      if (to.via === "anthropic") {
        assert.equal(asked.path, "/api/model-provider/anthropic/v1/messages");
        if (to.effort)
          assert.deepEqual(asked.body.output_config, { effort: to.effort });
        assert.notEqual(
          (asked.body.thinking as { type?: string } | undefined)?.type,
          "disabled",
        );
        const blocks = (asked.body.messages as { content: unknown }[]).flatMap(
          (message) =>
            Array.isArray(message.content)
              ? (message.content as Record<string, unknown>[])
              : [],
        );
        assert.ok(
          blocks.every(
            (block) =>
              block.type !== "thinking" && block.type !== "redacted_thinking",
          ),
        );
        const use = blocks.find((block) => block.type === "tool_use");
        const result = blocks.find((block) => block.type === "tool_result");
        assert.equal(use?.id, from.callId);
        assert.match(String(use?.id), /^[a-zA-Z0-9_-]+$/);
        assert.equal(result?.tool_use_id, from.callId);
      } else {
        assert.equal(asked.path, "/api/model-provider/v1/responses");
        const items = asked.body.input as Record<string, unknown>[];
        assert.ok(items.every((item) => item.type !== "reasoning"));
        const call = items.find((item) => item.type === "function_call");
        const output = items.find(
          (item) => item.type === "function_call_output",
        );
        assert.equal(call?.call_id, from.callId);
        assert.equal(output?.call_id, from.callId);
      }
    },
    answer,
  );
}

test("Switching from an OpenAI model to Claude Opus 5.5 at Extra high mid-conversation, with a tool call and reasoning on the thread, the next run answers", async () => {
  await switchesMidConversation(OPENAI_SIDE, OPUS_SIDE);
});

test("Switching from Claude Opus 5.5 at Extra high to an OpenAI model mid-conversation, with a tool call and reasoning on the thread, the next run answers", async () => {
  await switchesMidConversation(OPUS_SIDE, { ...OPENAI_SIDE, effort: "high" });
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
