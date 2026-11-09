import { afterAll, afterEach, beforeAll, expect, spyOn, test } from "bun:test";
import type { RunAgentInput } from "@ag-ui/client";
import { createActorAgentResolver } from "../src/agents/agent-resolver";
import { createAgentFetch } from "../src/agents/endpoint";
import { loadConfig } from "../src/config";
import { currentEdition, setEdition } from "../src/edition";
import {
  mountCopilotRuntime,
  type RegisteredAgent,
  type RuntimeModel,
  registeredAgentFromRow,
} from "../src/copilot";
import { clearDesktopConnectionFailure } from "../src/desktop-connection-failure";
import { testEnvironment } from "./support/environment";

/**
 * A model provider refusing a run, as the person reading the conversation is told.
 *
 * Seen on OpenBot Desktop: a Bot on the LangGraph harness ended its turn in red with "Error code: 400
 * - Invalid 'tools': array too long. Expected an array with maximum length 128, but got an array with
 * length 202 instead." Each run here goes through the real runtime to a fake Intelligence, and the
 * RUN_ERROR that reaches it is what both surfaces draw and what a reload replays.
 *
 * Two paths. A built-in Bot calls the provider itself, through the AI SDK, so its runs go to a stub
 * answering with each provider's real error body: OpenAI's captured from its API on 2026-11-07, and
 * Anthropic's as its API answers them. A harness Bot reports the refusal itself, so the harness here
 * sends exactly the RUN_ERROR the real one sent for those bodies, captured from agent-langgraph-agui
 * and agent-claude-sdk run against the same stub.
 */

const OPENAI = {
  tools: {
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
  key: {
    status: 401,
    body: {
      error: {
        message:
          "Incorrect API key provided: openbot-*****************0000. You can find your API key at https://platform.openai.com/account/api-keys.",
        type: "invalid_request_error",
        param: null,
        code: "invalid_api_key",
      },
    },
  },
  noKey: {
    status: 401,
    body: {
      error: {
        message:
          "You didn't provide an API key. You need to provide your API key in an Authorization header using Bearer auth (i.e. Authorization: Bearer YOUR_KEY), or as the password field (with blank username) if you're accessing the API from your browser and are prompted for a username and password. You can obtain an API key from https://platform.openai.com/account/api-keys.",
        type: "invalid_request_error",
        param: null,
        code: null,
      },
    },
  },
  quota: {
    status: 429,
    body: {
      error: {
        message:
          "You exceeded your current quota, please check your plan and billing details. For more information on this error, read the docs: https://platform.openai.com/docs/guides/error-codes/api-errors.",
        type: "insufficient_quota",
        param: null,
        code: "insufficient_quota",
      },
    },
  },
  rate: {
    status: 429,
    body: {
      error: {
        message:
          "Rate limit reached for gpt-5.5 in organization org-0000 on tokens per min (TPM): Limit 30000, Used 30000, Requested 900. Please try again in 1.8s. Visit https://platform.openai.com/account/rate-limits to learn more.",
        type: "tokens",
        param: null,
        code: "rate_limit_exceeded",
      },
    },
  },
  model: {
    status: 404,
    body: {
      error: {
        message:
          "The model `gpt-9-imaginary` does not exist or you do not have access to it.",
        type: "invalid_request_error",
        param: null,
        code: "model_not_found",
      },
    },
  },
  context: {
    status: 400,
    body: {
      error: {
        message:
          "This model's maximum context length is 128000 tokens. However, your messages resulted in 140008 tokens. Please reduce the length of the messages.",
        type: "invalid_request_error",
        param: "messages",
        code: "context_length_exceeded",
      },
    },
  },
  down: {
    status: 500,
    body: {
      error: {
        message:
          "The server had an error while processing your request. Sorry about that!",
        type: "server_error",
        param: null,
        code: null,
      },
    },
  },
  other: {
    status: 400,
    body: {
      error: {
        message:
          "Invalid value for 'temperature': expected a number between 0 and 2.",
        type: "invalid_request_error",
        param: "temperature",
        code: "invalid_value",
      },
    },
  },
} as const;

const ANTHROPIC = {
  key: {
    status: 401,
    body: {
      type: "error",
      error: { type: "authentication_error", message: "invalid x-api-key" },
    },
  },
  overloaded: {
    status: 529,
    body: {
      type: "error",
      error: { type: "overloaded_error", message: "Overloaded" },
    },
  },
} as const;

/** What the person reads, by kind, for a provider named `p`. */
const said = {
  key: (p: string) =>
    `${p} didn't accept the API key. Check that it's set, correct and still active, then try again.`,
  rate: (p: string) =>
    `${p} is limiting how many requests this account can send. Wait a minute, then try again.`,
  model: (p: string) =>
    `${p} doesn't offer the model this Bot uses, or this account can't use it. Choose another model, then try again.`,
  tools: (p: string) =>
    `${p} turned down the request because this Bot has more tools than the model accepts. Remove some of this Bot's apps, then try again.`,
  tooLong: (p: string) =>
    `${p} turned down the request because this conversation is too long for the model. Start a new conversation, then try again.`,
  tooLarge: (p: string) =>
    `${p} turned down the request because it was too large. Remove some attachments or start a new conversation, then try again.`,
  down: (p: string) =>
    `${p} is having problems right now. Wait a few minutes, then try again.`,
  other: (p: string) =>
    `${p} turned down the request. Try again, or ask an admin if it keeps happening.`,
  // The personal edition has nobody else to ask.
  otherPersonal: (p: string) =>
    `${p} turned down the request. Try again, or choose another model if it keeps happening.`,
};

/** AG-UI events the runner delivered to the platform. */
const delivered: {
  runId?: string;
  type?: string;
  message?: string;
  code?: string;
}[] = [];

let platform: ReturnType<typeof Bun.serve>;
let provider: ReturnType<typeof Bun.serve>;
let harness: ReturnType<typeof Bun.serve>;
/** What the stub provider answers next. */
let answer: { status: number; body: unknown } = OPENAI.tools;
/** What the stub harness ends its next run with. */
let harnessError: { message: string; code?: string } = { message: "" };

const saved = {
  openai: process.env.OPENAI_BASE_URL,
  anthropic: process.env.ANTHROPIC_BASE_URL,
  token: process.env.MANAGED_AGENT_TOKEN,
  picked: process.env.PICKED_HARNESS_URL,
};

beforeAll(() => {
  // Intelligence, as small as a run needs: the thread, its lock, and the runner's channel, every
  // push acknowledged. The same fake unreachable-bot.test.ts drives a run with.
  type Frame = [
    string | null,
    string | null,
    string,
    string,
    Record<string, unknown>,
  ];
  platform = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request, server) {
      const url = new URL(request.url);
      if (url.pathname === "/runner/websocket") {
        return server.upgrade(request, {
          data: undefined,
          headers: { "Sec-WebSocket-Protocol": "phoenix" },
        })
          ? undefined
          : new Response("upgrade failed", { status: 400 });
      }
      const [, api, threads, threadId, rest] = url.pathname.split("/");
      if (api === "api" && threads === "threads" && threadId) {
        if (rest === undefined && request.method === "GET")
          return Response.json({ thread: { id: threadId, name: "Mine" } });
        if (rest === "messages" && request.method === "GET")
          return Response.json({ messages: [] });
        if (rest === "lock" && request.method === "POST") {
          const body = (await request.json()) as { runId: string };
          return Response.json({
            threadId,
            runId: body.runId,
            joinToken: "join-token",
            ttlSeconds: 20,
          });
        }
        if (rest === "lock" && request.method === "PATCH")
          return Response.json({ ttlSeconds: 20 });
        if (rest === "lock" && request.method === "DELETE")
          return new Response(null, { status: 204 });
      }
      return Response.json({ error: "not found" }, { status: 404 });
    },
    websocket: {
      message(socket, message) {
        const [joinRef, ref, topic, event, payload] = JSON.parse(
          String(message),
        ) as Frame;
        if (event === "event") delivered.push(payload);
        if (event === "events")
          delivered.push(...(payload.events as typeof delivered));
        socket.send(
          JSON.stringify([
            joinRef,
            ref,
            topic,
            "phx_reply",
            { status: "ok", response: {} },
          ]),
        );
      },
    },
  });
  provider = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () =>
      Response.json(answer.body, {
        status: answer.status,
        /*
         * The AI SDK retries a 429 and a 5xx, as in production, and waits as long as the provider's
         * `retry-after-ms` says before each retry. The header is the SDK's own seam for that wait,
         * as in model-billing.test.ts, and keeps every attempt real.
         */
        headers: { "retry-after-ms": "0" },
      }),
  });
  harness = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const input = (await request.json()) as RunAgentInput;
      const events = [
        { type: "RUN_STARTED", threadId: input.threadId, runId: input.runId },
        { type: "RUN_ERROR", ...harnessError },
      ];
      return new Response(
        events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
});

afterEach(() => {
  // A refused key goes through the real path, which records a model failure for Desktop to ask for
  // the credential again. That state is one per process, so it is not left for the next file.
  clearDesktopConnectionFailure("model");
  for (const [name, value] of [
    ["OPENAI_BASE_URL", saved.openai],
    ["ANTHROPIC_BASE_URL", saved.anthropic],
    ["MANAGED_AGENT_TOKEN", saved.token],
    ["PICKED_HARNESS_URL", saved.picked],
  ] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

afterAll(() => {
  platform.stop(true);
  provider.stop(true);
  harness.stop(true);
});

/** The RUN_ERROR one run delivered, and what the server logged about it. */
async function runError(
  bot: RegisteredAgent,
  model: RuntimeModel,
): Promise<{ message?: string; code?: string; logged: string[] }> {
  const config = loadConfig(
    testEnvironment({
      INTELLIGENCE_API_URL: `http://127.0.0.1:${platform.port}`,
      INTELLIGENCE_GATEWAY_WS_URL: `ws://127.0.0.1:${platform.port}`,
    }),
  );
  const person = { id: "person", name: "Person" };
  const runtime = mountCopilotRuntime(
    config,
    createActorAgentResolver({
      model,
      loadAgents: async () => [bot],
      resolveModelApiKey: async () => "synthetic-key",
      agentFetch: createAgentFetch({ allowPrivateHosts: true }),
    }),
    async () => person,
    async () => ({ id: person.id, role: "user" }),
  );
  const logged: string[] = [];
  const log = spyOn(console, "error").mockImplementation((...line) => {
    logged.push(line.map(String).join(" "));
  });
  try {
    const runId = `run-${crypto.randomUUID()}`;
    const response = await runtime.handler.fetch(
      new Request(`http://127.0.0.1/api/copilotkit/agent/${bot.id}/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          threadId: `thread-${runId}`,
          runId,
          state: {},
          messages: [{ id: `ask-${runId}`, role: "user", content: "Hello?" }],
          tools: [],
          context: [],
          forwardedProps: {},
        } satisfies RunAgentInput),
      }),
    );
    expect(response.status).toBe(200);
    const deadline = Date.now() + 10_000;
    const failure = () =>
      delivered.find(
        (event) => event.runId === runId && event.type === "RUN_ERROR",
      );
    while (!failure()) {
      if (Date.now() > deadline)
        throw new Error(
          `the run never failed: ${JSON.stringify(delivered.filter((event) => event.runId === runId))}`,
        );
      await Bun.sleep(10);
    }
    return {
      message: failure()?.message,
      code: failure()?.code,
      logged: logged.filter((line) => line.includes("model-provider-refused")),
    };
  } finally {
    log.mockRestore();
  }
}

const builtIn: RegisteredAgent = {
  id: "personal-assistant",
  name: "Personal Assistant",
  type: "built_in",
  systemPrompt: "Answer.",
};

/** A built-in Bot's run, to a provider answering with one refusal. */
function builtInRefusedWith(
  refusal: { status: number; body: unknown },
  vendor: "openai" | "anthropic" = "openai",
) {
  answer = refusal;
  if (vendor === "openai")
    process.env.OPENAI_BASE_URL = `http://127.0.0.1:${provider.port}/v1`;
  else process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${provider.port}/v1`;
  return runError(builtIn, {
    provider: vendor,
    defaultModel: vendor === "openai" ? "gpt-5.5" : "claude-sonnet-5-5",
  });
}

// The stub stands where a gateway would, so the provider can't be named: "Your model provider".
const UNNAMED = "Your model provider";

test.each([
  ["too many tools", OPENAI.tools, said.tools(UNNAMED)],
  ["a wrong key", OPENAI.key, said.key(UNNAMED)],
  ["no key", OPENAI.noKey, said.key(UNNAMED)],
  ["a rate limit", OPENAI.rate, said.rate(UNNAMED)],
  ["an unknown model", OPENAI.model, said.model(UNNAMED)],
  ["a conversation too long", OPENAI.context, said.tooLong(UNNAMED)],
  ["the provider down", OPENAI.down, said.down(UNNAMED)],
  ["anything else", OPENAI.other, said.other(UNNAMED)],
] as const)(
  "a built-in Bot refused for %s is told in words, and the provider's go to the log",
  async (_, refusal, sentence) => {
    const failure = await builtInRefusedWith(refusal);
    expect(failure.message).toBe(sentence);
    expect(failure.logged).toHaveLength(1);
    expect(failure.logged[0]).toContain(refusal.body.error.message);
  },
  20_000,
);

test("a built-in Bot out of quota keeps the billing sentence, not the rate limit's", async () => {
  const failure = await builtInRefusedWith(OPENAI.quota);
  expect(failure.message).toStartWith(
    "Your model provider didn't answer: the account is out of credit or has reached its spending limit.",
  );
  expect(failure.message).not.toContain("limiting how many requests");
}, 20_000);

test("a built-in Bot names Anthropic when Anthropic refuses", async () => {
  expect((await builtInRefusedWith(ANTHROPIC.key, "anthropic")).message).toBe(
    said.key("Anthropic"),
  );
  expect(
    (await builtInRefusedWith(ANTHROPIC.overloaded, "anthropic")).message,
  ).toBe(said.down("Anthropic"));
}, 30_000);

/** A Bot on a harness this deployment runs, which ends its run with `error`. */
function harnessRefusedWith(
  error: { message: string; code?: string },
  vendor: "openai" | "anthropic" = "openai",
) {
  harnessError = error;
  const endpoint = `http://127.0.0.1:${harness.port}/`;
  process.env.MANAGED_AGENT_TOKEN = "managed-agent-token";
  process.env.PICKED_HARNESS_URL = endpoint;
  const bot = registeredAgentFromRow({
    id: "picked-harness",
    name: "Personal Assistant",
    type: "remote_ag_ui",
    configuration: { endpoint },
    title: "Everyday life.",
    roleDescription: "Answer.",
  });
  if (bot?.type !== "remote_ag_ui") throw new Error("the Bot did not parse");
  // The deployment's token, as `runtime-agents.ts` gives every endpoint this deployment runs.
  bot.headers = { "x-openbot-agent-token": "managed-agent-token" };
  return runError(bot, {
    provider: vendor,
    defaultModel: vendor === "openai" ? "gpt-5.5" : "claude-sonnet-5-5",
  });
}

const REFUSED = "OPENBOT_MODEL_REFUSED";

test("the LangGraph harness's refusal seen on Desktop is told in words, from an image without the code too", async () => {
  const words =
    "Error code: 400 - Invalid 'tools': array too long. Expected an array with maximum length 128, but got an array with length 202 instead.";
  for (const error of [{ message: words, code: REFUSED }, { message: words }]) {
    const failure = await harnessRefusedWith(error);
    expect(failure.message).toBe(said.tools("OpenAI"));
    expect(failure.logged[0]).toContain(words);
  }
}, 20_000);

test("a harness on OpenAI's JS SDK, such as agent-bot, is told the same way", async () => {
  // The SDK's own text for the same 400, captured from openai 7.5.0.
  const failure = await harnessRefusedWith({
    message:
      "400 Invalid 'tools': array too long. Expected an array with maximum length 128, but got an array with length 202 instead.",
  });
  expect(failure.message).toBe(said.tools("OpenAI"));
}, 20_000);

// What agent-langgraph-agui sent for each of OpenAI's bodies above.
test.each([
  [
    "a rate limit",
    "Error code: 429 - Rate limit reached for gpt-5.5 in organization org-abc on tokens per min (TPM): Limit 30000, Used 30000, Requested 900. Please try again in 1.8s. Visit https://platform.openai.com/account/rate-limits to learn more.",
    said.rate("OpenAI"),
  ],
  [
    "an unknown model",
    "Error code: 404 - The model `gpt-9-imaginary` does not exist or you do not have access to it.",
    said.model("OpenAI"),
  ],
  [
    "a conversation too long",
    "Error code: 400 - This model's maximum context length is 128000 tokens. However, your messages resulted in 210345 tokens. Please reduce the length of the messages.",
    said.tooLong("OpenAI"),
  ],
  [
    "the provider down",
    "Error code: 500 - The server had an error while processing your request. Sorry about that!",
    said.down("OpenAI"),
  ],
  [
    "the provider overloaded",
    "Error code: 503 - The engine is currently overloaded, please try again later",
    said.down("OpenAI"),
  ],
  [
    "anything else",
    "Error code: 400 - Invalid value for 'temperature': expected a number between 0 and 2.",
    said.other("OpenAI"),
  ],
] as const)(
  "the LangGraph harness refused for %s is told in words",
  async (_, message, sentence) => {
    expect((await harnessRefusedWith({ message, code: REFUSED })).message).toBe(
      sentence,
    );
  },
  20_000,
);

test("a harness refused the key is told to check the key, not to sign in, with the code kept", async () => {
  // Both Python harnesses send this for a 401, whether the credential is a key or a sign-in.
  const failure = await harnessRefusedWith({
    message: "Sign in to your model provider again.",
    code: "OPENBOT_MODEL_AUTH_REQUIRED",
  });
  expect(failure.message).toBe(said.key("OpenAI"));
  // The desktop reads the code to ask for the credential again.
  expect(failure.code).toBe("OPENBOT_MODEL_AUTH_REQUIRED");
}, 20_000);

test("a harness's billing sentence is already in words and is left alone", async () => {
  const message =
    'OpenAI didn\'t answer: the account is out of credit or has reached its spending limit. Add credit or raise the limit with OpenAI, then try again. OpenAI said: "You exceeded your current quota."';
  expect(
    (await harnessRefusedWith({ message, code: "OPENBOT_MODEL_BILLING" }))
      .message,
  ).toBe(message);
}, 20_000);

// What agent-claude-sdk sends for Claude Code's own account of each refusal (test_provider_refusal.py).
test.each([
  [
    "a rate limit",
    "API Error: Request rejected (429) · This request would exceed the rate limit for your organization (0000) of 30,000 input tokens per minute. For details, refer to: https://docs.claude.com/en/api/rate-limits.",
    said.rate("Anthropic"),
  ],
  [
    "an unknown model",
    "There's an issue with the selected model (claude-opus-5[1m]). It may not exist or you may not have access to it.",
    said.model("Anthropic"),
  ],
  [
    "a prompt too long",
    "Prompt is too long · the request is ~210345 tokens (limit 200000) but this conversation is only ~1203 tokens",
    said.tooLong("Anthropic"),
  ],
  [
    "a request too large",
    "Request too large (max 32MB). Accumulated images and attachments in the conversation pushed the request over the limit.",
    said.tooLarge("Anthropic"),
  ],
  [
    "the API down",
    "API Error: 500 Internal server error. This is a server-side issue, usually temporary",
    said.down("Anthropic"),
  ],
  [
    "the API overloaded",
    "API Error: Repeated 529 Overloaded errors. The API is at capacity",
    said.down("Anthropic"),
  ],
] as const)(
  "the Claude Agent SDK harness refused for %s is told in words",
  async (_, message, sentence) => {
    expect(
      (await harnessRefusedWith({ message, code: REFUSED }, "anthropic"))
        .message,
    ).toBe(sentence);
  },
  20_000,
);

test("the Claude Agent SDK harness out of credit gets the billing sentence, naming Anthropic", async () => {
  const failure = await harnessRefusedWith(
    { message: "Credit balance is too low", code: REFUSED },
    "anthropic",
  );
  expect(failure.message).toStartWith(
    "Anthropic didn't answer: the account is out of credit or has reached its spending limit.",
  );
}, 20_000);

test("a Bot's own failure is not a provider's refusal, and keeps its words", async () => {
  for (const message of [
    "The model requested a tool that was not offered for this run.",
    "This Bot couldn't start, so it didn't answer. Send your message again, and restart OpenBot if it keeps happening.",
  ]) {
    const failure = await harnessRefusedWith({ message });
    expect(failure.message).toBe(message);
    expect(failure.logged).toHaveLength(0);
  }
}, 20_000);

test("a refusal with no particular reason says what the person can do, in each edition", async () => {
  const before = currentEdition();
  const words =
    "Error code: 400 - Invalid value for 'temperature': expected a number between 0 and 2.";
  /** The harness Bot's sentence, then the built-in Bot's, which stands its provider behind the stub. */
  const both = async () => {
    delete process.env.OPENAI_BASE_URL;
    const harness = await harnessRefusedWith({ message: words, code: REFUSED });
    const builtIn = await builtInRefusedWith(OPENAI.other);
    return [harness.message, builtIn.message];
  };
  try {
    // A team has an admin who runs OpenBot for everybody.
    setEdition("team");
    expect(await both()).toEqual([said.other("OpenAI"), said.other(UNNAMED)]);
    // The personal edition is one person on their own machine: no admin to ask.
    setEdition("personal");
    expect(await both()).toEqual([
      said.otherPersonal("OpenAI"),
      said.otherPersonal(UNNAMED),
    ]);
  } finally {
    setEdition(before);
  }
}, 30_000);
