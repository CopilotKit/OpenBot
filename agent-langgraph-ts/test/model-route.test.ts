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
import { inspect } from "node:util";
import { test } from "node:test";
import { always, type FakeProvider, fakeProvider } from "./fake-provider.ts";
import { conversation, run, withEngine } from "./helpers.ts";
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

async function withGateway<T>(
  first: Provider,
  body: (gateway: Gateway, upstream?: FakeProvider) => Promise<T>,
): Promise<T> {
  const fake = live
    ? undefined
    : await fakeProvider((request) =>
        always({
          text: request.path.endsWith("/messages")
            ? "Pineapple, from Anthropic."
            : "Pineapple, from OpenAI.",
        })(request, 0),
      );
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
