/**
 * A provider's refusal ends the run with its own words, the code the server reads and
 * `metadata.errorCategory`. Each case is the provider's real error body, thrown by the real vendor
 * SDK under LangChain, through the real AG-UI endpoint.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { always, fakeProvider, type Turn } from "./fake-provider.ts";
import { conversation, run, withEngine } from "./helpers.ts";

type Provider = "openai" | "anthropic" | "google";

function envFor(provider: Provider, base: string): Record<string, string> {
  if (provider === "anthropic")
    return {
      BOT_PROVIDER: "anthropic",
      ANTHROPIC_API_KEY: "sk-ant-test",
      ANTHROPIC_BASE_URL: base,
    };
  if (provider === "google")
    return {
      BOT_PROVIDER: "google",
      GOOGLE_API_KEY: "AIza-test",
      GOOGLE_GENERATIVE_AI_BASE_URL: `${base}/v1beta`,
    };
  return {
    BOT_PROVIDER: "openai",
    OPENAI_API_KEY: "sk-test",
    OPENAI_BASE_URL: `${base}/v1`,
  };
}

async function runError(provider: Provider, turn: Turn) {
  const fake = await fakeProvider(always(turn));
  try {
    const result = await withEngine(
      { env: envFor(provider, fake.base) },
      (base) =>
        run(base, conversation({ forwardedProps: { openbotSendOnce: true } })),
    );
    const last = result.events.at(-1)!;
    assert.equal(
      last.type,
      "RUN_ERROR",
      "every failed run ends with one RUN_ERROR",
    );
    assert.equal(
      result.events.filter((event) => event.type === "RUN_ERROR").length,
      1,
    );
    return last as unknown as {
      message: string;
      code?: string;
      metadata?: { errorCategory?: string };
    };
  } finally {
    await fake.close();
  }
}

const CASES: {
  name: string;
  provider: Provider;
  turn: Turn;
  code: string;
  category: string;
  words: RegExp;
}[] = [
  {
    name: "OpenAI, a key it does not know",
    provider: "openai",
    turn: {
      status: 401,
      body: {
        error: {
          message:
            "Incorrect API key provided: sk-test. You can find your API key at https://platform.openai.com/account/api-keys.",
          type: "invalid_request_error",
          param: null,
          code: "invalid_api_key",
        },
      },
    },
    code: "OPENBOT_MODEL_AUTH_REQUIRED",
    category: "authentication_failed",
    words: /^Error code: 401 - Incorrect API key provided/,
  },
  {
    name: "OpenAI, a rate limit",
    provider: "openai",
    turn: {
      status: 429,
      body: {
        error: {
          message:
            "Rate limit reached for gpt-5.5 in organization org-abc on tokens per min (TPM): Limit 30000, Used 30000, Requested 500. Please try again in 1s.",
          type: "tokens",
          param: null,
          code: "rate_limit_exceeded",
        },
      },
    },
    code: "OPENBOT_MODEL_REFUSED",
    category: "rate_limit",
    words: /^Error code: 429 - Rate limit reached for gpt-5\.5/,
  },
  {
    name: "OpenAI, out of quota",
    provider: "openai",
    turn: {
      status: 429,
      body: {
        error: {
          message:
            "You exceeded your current quota, please check your plan and billing details.",
          type: "insufficient_quota",
          param: null,
          code: "insufficient_quota",
        },
      },
    },
    code: "OPENBOT_MODEL_BILLING",
    category: "billing_error",
    // At a base URL that is not api.openai.com the provider is not named, as on the Python harness.
    words:
      /^Your model provider didn't answer: the account is out of credit.*Your model provider said: "You exceeded your current quota/,
  },
  {
    name: "OpenAI, too many tools",
    provider: "openai",
    turn: {
      status: 400,
      body: {
        error: {
          message:
            "Invalid 'tools': array too long. Expected an array with maximum length 128, but got an array with length 202 instead.",
          type: "invalid_request_error",
          param: "tools",
          code: "array_above_max_length",
        },
      },
    },
    code: "OPENBOT_MODEL_REFUSED",
    category: "invalid_request",
    words: /^Error code: 400 - Invalid 'tools': array too long/,
  },
  {
    name: "OpenAI, a model the key cannot use",
    provider: "openai",
    turn: {
      status: 404,
      body: {
        error: {
          message:
            "The model `gpt-9` does not exist or you do not have access to it.",
          type: "invalid_request_error",
          param: null,
          code: "model_not_found",
        },
      },
    },
    code: "OPENBOT_MODEL_REFUSED",
    category: "model_not_found",
    words: /^Error code: 404 - The model `gpt-9` does not exist/,
  },
  {
    name: "Anthropic, a bad key",
    provider: "anthropic",
    turn: {
      status: 401,
      body: {
        type: "error",
        error: { type: "authentication_error", message: "invalid x-api-key" },
      },
    },
    code: "OPENBOT_MODEL_AUTH_REQUIRED",
    category: "authentication_failed",
    words: /^Error code: 401 - invalid x-api-key$/,
  },
  {
    name: "Anthropic, overloaded",
    provider: "anthropic",
    turn: {
      status: 529,
      body: {
        type: "error",
        error: { type: "overloaded_error", message: "Overloaded" },
      },
    },
    code: "OPENBOT_MODEL_REFUSED",
    category: "server_error",
    words: /^Error code: 529 - Overloaded$/,
  },
  {
    name: "Anthropic, out of credit",
    provider: "anthropic",
    turn: {
      status: 400,
      body: {
        type: "error",
        error: {
          type: "invalid_request_error",
          message:
            "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.",
        },
      },
    },
    code: "OPENBOT_MODEL_BILLING",
    category: "billing_error",
    words:
      /^Anthropic didn't answer: .*Anthropic said: "Your credit balance is too low/,
  },
  {
    name: "Anthropic, an unknown model",
    provider: "anthropic",
    turn: {
      status: 404,
      body: {
        type: "error",
        error: { type: "not_found_error", message: "model: claude-nope" },
      },
    },
    code: "OPENBOT_MODEL_REFUSED",
    category: "model_not_found",
    words: /^Error code: 404 - model: claude-nope$/,
  },
  {
    name: "Anthropic, Claude declines",
    provider: "anthropic",
    turn: { text: "I can't help with that.", stop: "refusal" },
    code: "OPENBOT_MODEL_REFUSED",
    category: "refusal",
    words: /I can't help with that\./,
  },
  {
    name: "Gemini, a key it does not take",
    provider: "google",
    turn: {
      status: 400,
      body: {
        error: {
          code: 400,
          message: "API key not valid. Please pass a valid API key.",
          status: "INVALID_ARGUMENT",
          details: [
            {
              "@type": "type.googleapis.com/google.rpc.ErrorInfo",
              reason: "API_KEY_INVALID",
              domain: "googleapis.com",
            },
          ],
        },
      },
    },
    code: "OPENBOT_MODEL_AUTH_REQUIRED",
    category: "authentication_failed",
    words: /^Error code: 400 - API key not valid/,
  },
  {
    name: "Gemini, exhausted",
    provider: "google",
    turn: {
      status: 429,
      body: {
        error: {
          code: 429,
          message: "Resource has been exhausted (e.g. check quota).",
          status: "RESOURCE_EXHAUSTED",
        },
      },
    },
    code: "OPENBOT_MODEL_REFUSED",
    category: "rate_limit",
    words: /^Error code: 429 - Resource has been exhausted/,
  },
  {
    name: "Gemini, overloaded",
    provider: "google",
    turn: {
      status: 503,
      body: {
        error: {
          code: 503,
          message: "The model is overloaded. Please try again later.",
          status: "UNAVAILABLE",
        },
      },
    },
    code: "OPENBOT_MODEL_REFUSED",
    category: "server_error",
    words: /^Error code: 503 - The model is overloaded/,
  },
];

for (const each of CASES) {
  test(`${each.name}: ${each.category}`, async () => {
    const error = await runError(each.provider, each.turn);
    assert.equal(error.code, each.code);
    assert.equal(error.metadata?.errorCategory, each.category);
    assert.match(error.message, each.words);
  });
}

/** A port nothing listens on: one the system just gave out and took back. */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

test("Nothing answering at the model's address says where it was dialled, and nothing more of the URL", async () => {
  const port = await closedPort();
  const env = {
    BOT_PROVIDER: "openai",
    OPENAI_API_KEY: "sk-test",
    OPENAI_BASE_URL: `http://user:secret@127.0.0.1:${port}/v1`,
  };
  const result = await withEngine({ env }, (base) =>
    run(base, conversation({ forwardedProps: { openbotSendOnce: true } })),
  );
  const error = result.events.at(-1)!;
  assert.equal(error.type, "RUN_ERROR");
  assert.equal(error.code, "OPENBOT_MODEL_UNREACHABLE");
  assert.equal(
    error.message,
    `OpenBot couldn't reach the AI model at 127.0.0.1:${port}. Check that it's running and the address is right.`,
  );
});
