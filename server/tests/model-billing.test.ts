import { afterEach, expect, test } from "bun:test";
import { buildAgents, type RuntimeModel } from "../src/copilot";
import { billingRefusal } from "../src/model-billing";

/*
 * A provider that is out of credit or at its spending limit is told as that, with which provider and
 * in its own words, never as "Forbidden" or a retry count. The bodies are the providers' own:
 * OpenAI's and xAI's captured from their APIs on 2026-11-05 (tests/fixtures/billing/), Anthropic's
 * and Google's as their APIs document them.
 */

const FIXTURES = `${import.meta.dir}/fixtures/billing/`;
const ANTHROPIC_CREDIT = {
  status: 400,
  body: {
    type: "error",
    error: {
      type: "invalid_request_error",
      message:
        "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.",
    },
  },
};

const saved = {
  openai: process.env.OPENAI_BASE_URL,
  anthropic: process.env.ANTHROPIC_BASE_URL,
};
const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
  for (const [name, value] of [
    ["OPENAI_BASE_URL", saved.openai],
    ["ANTHROPIC_BASE_URL", saved.anthropic],
  ] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

/** A provider that answers every call with one refusal, counting the calls. */
function refusing(answer: { status: number; body: unknown }) {
  let calls = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => {
      calls += 1;
      /*
       * A 429 is retried by the AI SDK, as in production, and the SDK waits as long as the
       * provider's `retry-after-ms` says before each retry, 2 s then 4 s when it says nothing.
       * OpenAI says nothing on its no-credits 429, so this header is the one difference from its
       * real answer: it is the SDK's own seam for the wait, and keeps every attempt real.
       */
      return Response.json(answer.body, {
        status: answer.status,
        headers: answer.status === 429 ? { "retry-after-ms": "0" } : {},
      });
    },
  });
  servers.push(server);
  return { url: `http://127.0.0.1:${server.port}`, calls: () => calls };
}

/** What a person is told when a built-in Bot's run fails at the provider. */
async function runError(model: RuntimeModel): Promise<string> {
  const agents = await buildAgents(
    [{ id: "bot", name: "Bot", type: "built_in", systemPrompt: "Answer." }],
    model,
    "synthetic-key",
  );
  const agent = agents.bot?.clone();
  if (!agent) throw new Error("Bot missing");
  return new Promise<string>((resolve) => {
    agent
      .run({
        threadId: "thread",
        runId: "run",
        messages: [{ id: "q", role: "user", content: "Hello" }],
        tools: [],
        context: [],
        state: {},
        forwardedProps: {},
      })
      .subscribe({
        error: (error: unknown) =>
          resolve(error instanceof Error ? error.message : String(error)),
        complete: () => resolve("completed"),
      });
  });
}

test("xAI's spending-limit 403 is told as that, in xAI's words, never as Forbidden", async () => {
  const xai = await Bun.file(`${FIXTURES}xai-spending-limit.json`).json();
  const provider = refusing(xai);
  process.env.OPENAI_BASE_URL = `${provider.url}/v1`;
  const message = await runError({
    provider: "openai",
    defaultModel: "grok-4.7",
  });
  expect(message).not.toContain("Forbidden");
  expect(message).toContain(
    "the account is out of credit or has reached its spending limit",
  );
  expect(message).toContain(
    "has either used all available credits or reached its monthly spending limit",
  );
});

test("OpenAI's no-credits 429 is told as that, not as three failed attempts", async () => {
  const openai = await Bun.file(`${FIXTURES}openai-no-credits.json`).json();
  const provider = refusing(openai);
  process.env.OPENAI_BASE_URL = `${provider.url}/v1`;
  const message = await runError({
    provider: "openai",
    defaultModel: "gpt-6.1-terra",
  });
  // Retried as the SDK retries any 429, and told as a billing refusal at the end.
  expect(provider.calls()).toBe(3);
  expect(message).not.toContain("Failed after");
  expect(message).toContain(
    'said: "You have no credits remaining. Add credits to continue using the API',
  );
});

test("Anthropic's credit-balance refusal names Anthropic", async () => {
  const provider = refusing(ANTHROPIC_CREDIT);
  process.env.ANTHROPIC_BASE_URL = `${provider.url}/v1`;
  const message = await runError({
    provider: "anthropic",
    defaultModel: "claude-sonnet-5-5",
  });
  expect(message).toStartWith(
    "Anthropic didn't answer: the account is out of credit or has reached its spending limit.",
  );
  expect(message).toContain("Your credit balance is too low");
});

test("a rate limit is not a billing problem, and is told as a rate limit", async () => {
  const provider = refusing({
    status: 429,
    body: {
      error: {
        message:
          "Rate limit reached for gpt-6.1-terra on tokens per min (TPM): Limit 30000, Used 30000, Requested 900. Please try again in 1.8s.",
        type: "tokens",
        param: null,
        code: "rate_limit_exceeded",
      },
    },
  });
  process.env.OPENAI_BASE_URL = `${provider.url}/v1`;
  const message = await runError({
    provider: "openai",
    defaultModel: "gpt-6.1-terra",
  });
  expect(provider.calls()).toBe(3);
  // In words, as every refusal is (provider-refusal.test.ts); the provider's go to the log.
  expect(message).toContain(
    "is limiting how many requests this account can send",
  );
  expect(message).not.toContain("out of credit");
});

test("each provider is named by who serves the models", () => {
  const refusal = (status: number, body: unknown) =>
    // The fields the AI SDK's APICallError carries, which is all the reader looks at.
    Object.assign(new Error("Forbidden"), {
      name: "AI_APICallError",
      statusCode: status,
      responseBody: JSON.stringify(body),
    });
  expect(
    billingRefusal(
      refusal(429, {
        error: {
          code: 429,
          message:
            "You exceeded your current quota, please check your plan and billing details.",
          status: "RESOURCE_EXHAUSTED",
        },
      }),
      "Google",
    )?.message,
  ).toStartWith("Google didn't answer");
  expect(
    billingRefusal(
      refusal(400, { error: { message: "Bad tool schema" } }),
      "xAI",
    ),
  ).toBeUndefined();
});
