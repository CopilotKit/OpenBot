import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import {
  chooseOpenAIApi,
  normalizeModelBaseUrls,
  type RuntimeModel,
  resolveRuntimeAgents,
  runtimeModelForEnvironment,
} from "../src/copilot";
import { loadTenantPackage } from "../src/tenant-package";
import {
  type OpenAICompatibleEndpoint,
  startOpenAICompatibleEndpoint,
} from "./support/openai-compatible-endpoint";

/**
 * A built-in Bot whose model is reached through an `OPENAI_BASE_URL` that is not OpenAI's: a gateway or a proxy in
 * front of OpenAI (LiteLLM, Portkey, a company's own proxy), or a server that only speaks Chat Completions.
 *
 * The CopilotKit runtime 1.79 sends every `openai/...` model at such an address to Chat Completions, and there
 * `gpt-5.6-terra`, the model the built-in Bots run on by default, refuses function tools: every turn of every
 * built-in Bot behind a proxy failed with "Function tools with reasoning_effort are not supported for gpt-5.6-terra
 * in /v1/chat/completions". These run a Bot the way the server does (the boot steps `index.ts` takes, in its order,
 * then the Bot built and run with a tool, as the app offers its computer tools) against an endpoint that answers as
 * OpenAI does (support/openai-compatible-endpoint.ts), and read which API it was asked on and what the Bot said.
 */

const RESPONSES_ANSWER = "Answered on the Responses API.";
/** The tool the turn offers, as the app offers its computer tools, with whatever the runtime adds of its own. */
const OFFERED = expect.arrayContaining(["computer_snapshot"]);
const CHAT_ANSWER = "Answered on Chat Completions.";

/** What the runtime reads from the process environment, put back after every test. */
const VARIABLES = [
  "OPENAI_BASE_URL",
  "BOT_MODEL",
  "BOT_PROVIDER",
  "COPILOTKIT_OPENAI_API",
] as const;
const saved = Object.fromEntries(
  VARIABLES.map((name) => [name, process.env[name]]),
);
let endpoint: OpenAICompatibleEndpoint | undefined;
let packageModel: RuntimeModel;

beforeAll(async () => {
  packageModel = (
    await loadTenantPackage(
      new URL("../../examples/fintech", import.meta.url).pathname,
    )
  ).model;
});

afterEach(async () => {
  for (const name of VARIABLES) {
    const value = saved[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  await endpoint?.stop();
  endpoint = undefined;
});

/** Boot as `index.ts` does with this environment, build the General Assistant, and run one turn with a tool. */
async function oneTurn(
  options: { model?: string; api?: string; responsesApi?: boolean } = {},
) {
  endpoint = startOpenAICompatibleEndpoint({
    responsesApi: options.responsesApi ?? true,
  });
  for (const name of VARIABLES) delete process.env[name];
  process.env.OPENAI_BASE_URL = endpoint.baseUrl;
  if (options.model) process.env.BOT_MODEL = options.model;
  if (options.api) process.env.COPILOTKIT_OPENAI_API = options.api;

  normalizeModelBaseUrls();
  const model = runtimeModelForEnvironment(packageModel);
  chooseOpenAIApi(model);

  const agents = await resolveRuntimeAgents(
    async () => [
      {
        id: "general-assistant",
        name: "General Assistant",
        type: "built_in" as const,
        systemPrompt: "Be helpful.",
      },
    ],
    model,
    async () => "synthetic-model-key",
  );
  const agent = agents["general-assistant"]?.clone();
  if (!agent) throw new Error("buildAgents returned no General Assistant");
  agent.addMessage({
    id: "proxy-turn",
    role: "user",
    content: "What page is your browser on?",
  });
  let failure: string | undefined;
  await agent
    .runAgent({
      tools: [
        {
          name: "computer_snapshot",
          description: "Read the page your browser is on.",
          parameters: { type: "object", properties: {} },
        },
      ],
    })
    .catch((error: unknown) => {
      failure = error instanceof Error ? error.message : String(error);
    });
  const last = agent.messages.at(-1);
  return {
    model: model.defaultModel,
    requests: endpoint.requests,
    answer: last?.role === "assistant" ? last.content : undefined,
    failure,
  };
}

describe("a built-in Bot behind a gateway in front of OpenAI", () => {
  test("on the package's own model, gpt-5.6-terra, it answers through the Responses API", async () => {
    const turn = await oneTurn();
    expect(turn.model).toBe("gpt-5.6-terra");
    expect(turn.failure).toBeUndefined();
    expect(turn.requests).toEqual([
      { api: "responses", model: "gpt-5.6-terra", tools: OFFERED },
    ]);
    expect(turn.answer).toBe(RESPONSES_ANSWER);
  });

  // OpenAI's catalogue on 2026-10-28: tools only on the Responses API, or the model not served on Chat Completions.
  test.each([
    "gpt-5.6-sol",
    "gpt-6-astra",
    "gpt-6.1-terra",
    "gpt-5-pro",
    "gpt-5.5-pro",
    "o3-pro",
    "gpt-5.3-codex",
    // A gateway's own name for it: LiteLLM and OpenRouter publish OpenAI's models under `openai/`.
    "openai/gpt-5.6-terra",
  ])(
    "on %s, a model OpenAI serves tools for only on the Responses API, it answers there",
    async (model) => {
      const turn = await oneTurn({ model });
      expect(turn.failure).toBeUndefined();
      expect(turn.requests).toEqual([
        { api: "responses", model, tools: OFFERED },
      ]);
      expect(turn.answer).toBe(RESPONSES_ANSWER);
    },
  );

  test.each(["gpt-5.5", "gpt-5.4-mini", "openai/gpt-5.5"])(
    "on %s, which takes tools on Chat Completions, it keeps the runtime's choice",
    async (model) => {
      const turn = await oneTurn({ model });
      expect(turn.failure).toBeUndefined();
      expect(turn.requests).toEqual([{ api: "chat", model, tools: OFFERED }]);
      expect(turn.answer).toBe(CHAT_ANSWER);
    },
  );
});

describe("a built-in Bot on a server that only speaks Chat Completions", () => {
  test.each(["qwen3:8b", "llama3.1:8b", "openai/gpt-oss-20b"])(
    "on %s it is asked on Chat Completions, as before",
    async (model) => {
      const turn = await oneTurn({ model, responsesApi: false });
      expect(turn.failure).toBeUndefined();
      expect(turn.requests).toEqual([{ api: "chat", model, tools: OFFERED }]);
      expect(turn.answer).toBe(CHAT_ANSWER);
    },
  );
});

describe("an operator who chose the API", () => {
  test("COPILOTKIT_OPENAI_API=chat stands, even for a model that refuses tools there", async () => {
    const turn = await oneTurn({ model: "gpt-5.6-terra", api: "chat" });
    expect(turn.requests).toEqual([
      { api: "chat", model: "gpt-5.6-terra", tools: OFFERED },
    ]);
    expect(turn.failure).toContain(
      "Function tools with reasoning_effort are not supported for gpt-5.6-terra",
    );
  });

  test("COPILOTKIT_OPENAI_API=responses stands for a model Chat Completions would take", async () => {
    const turn = await oneTurn({ model: "gpt-5.5", api: "responses" });
    expect(turn.requests).toEqual([
      { api: "responses", model: "gpt-5.5", tools: OFFERED },
    ]);
    expect(turn.answer).toBe(RESPONSES_ANSWER);
  });
});

test("on OpenAI itself nothing is set: the runtime already calls the Responses API there", () => {
  const environment: Record<string, string | undefined> = {};
  expect(
    chooseOpenAIApi(
      { provider: "openai", defaultModel: "gpt-5.6-terra" },
      environment,
    ),
  ).toBeUndefined();
  expect(environment.COPILOTKIT_OPENAI_API).toBeUndefined();
});
