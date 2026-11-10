import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";
import { fileURLToPath } from "node:url";
import { HttpAgent, type RunAgentInput } from "@ag-ui/client";
import { LLMock } from "@copilotkit/aimock";
import { of } from "rxjs";
import {
  buildAgents,
  type RegisteredAgent,
  type RuntimeModel,
  registeredAgentFromRow,
} from "../src/copilot";
import { createModelCatalogue } from "../src/model-catalogue";
import { loadTenantPackage } from "../src/tenant-package";

/*
 * A Bot knows the model it answers on, by the name the composer's model picker shows.
 *
 * Asked "which AI model and which agent framework do you run on", the starter on the LangGraph
 * harness named LangGraph (its standing role says "Powered by LangChain (LangGraph)") and said it
 * had no access to its model's name, while the picker under its answer read GPT-6.1 Terra. Every
 * Bot whose model this deployment chooses is now told it, on OpenBot's own harness, on the
 * LangGraph and Claude Agent SDK harnesses, on an API key and on a ChatGPT or Claude plan, and told
 * again when the person picks another model. Built through `buildAgents`, the path a person's run
 * takes, with the real catalogue answering the pick.
 */

const FIXTURES = `${import.meta.dir}/fixtures/model-listings`;
const modelsDev = await Bun.file(`${FIXTURES}/models-dev-api.json`).json();
const openAIListing = await Bun.file(`${FIXTURES}/openai-models.json`).json();
const anthropicListing = await Bun.file(
  `${FIXTURES}/anthropic-models.json`,
).json();

/** A Claude plan's own sign-in, which its listing is read with. */
const CLAUDE_PLAN_OAUTH = "synthetic-claude-plan-oauth-token";

/** The catalogue as the deployment builds it, reading the providers' own listings. */
function catalogueFor(
  model: RuntimeModel,
  environment: Record<string, string | undefined> = {},
) {
  return createModelCatalogue({
    model,
    apiKey: async () => "synthetic-key",
    environment,
    fetch: ((url: string | URL | Request, init?: RequestInit) => {
      const at = String(url);
      if (at === "https://models.dev/api.json")
        return Promise.resolve(Response.json(modelsDev));
      if (at.startsWith("https://api.openai.com/"))
        return Promise.resolve(Response.json(openAIListing));
      if (at.startsWith("https://api.anthropic.com/")) {
        // Anthropic takes a key or a plan's OAuth token, never OpenBot's harness token.
        const headers = (init?.headers ?? {}) as Record<string, string>;
        const accepted =
          headers["x-api-key"] === "synthetic-key" ||
          headers.authorization === `Bearer ${CLAUDE_PLAN_OAUTH}`;
        return Promise.resolve(
          accepted
            ? Response.json(anthropicListing)
            : Response.json(
                {
                  type: "error",
                  error: {
                    type: "authentication_error",
                    message: "Invalid bearer token",
                  },
                },
                { status: 401 },
              ),
        );
      }
      // A ChatGPT plan's listing, from its harness.
      return fetch(url, init);
    }) as typeof fetch,
  });
}

type Catalogue = ReturnType<typeof catalogueFor>;

/** What the composer's chip shows for a pick: the lookup `ModelPicker` makes, on what it reads. */
async function chipLabel(catalogue: Catalogue, picked?: string) {
  const read = await catalogue.read();
  const shown =
    read.models.find((model) => model.id === picked) ??
    read.models.find((model) => model.id === read.default);
  if (!shown) throw new Error("the picker shows nothing");
  return shown.label;
}

const told = (label: string) => `The AI model you are running on is ${label}.`;

/** The person's pick for the conversation, as `model-choice.ts` hands it to the catalogue. */
let saved: { model?: string; effort?: string } | null = null;

beforeEach(() => {
  saved = null;
});

async function builtInBot(
  model: RuntimeModel,
  catalogue: Catalogue,
  bot: RegisteredAgent = {
    id: "assistant",
    name: "Personal Assistant",
    type: "built_in",
    systemPrompt: "Help with everyday life.",
  },
) {
  const agents = await buildAgents(
    [bot],
    model,
    model.plan ? null : "synthetic-key",
    undefined,
    async () => [],
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    () => catalogue.choose(saved),
  );
  const agent = agents[bot.id]?.clone();
  if (!agent) throw new Error("Bot missing");
  agent.setMessages([
    {
      id: "q",
      role: "user",
      content: "Which AI model and which agent framework do you run on?",
    },
  ]);
  await agent.runAgent();
}

describe("a Bot on OpenBot's own harness, on an API key", () => {
  const llm = new LLMock();
  /** Every request body as it went to the provider. */
  const wire: string[] = [];
  let recorder: ReturnType<typeof Bun.serve> | undefined;
  const original = {
    OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
    ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
  };

  beforeAll(async () => {
    const upstream = await llm.start();
    recorder = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const body = await request.text();
        if (body) wire.push(body);
        const url = new URL(request.url);
        const headers = new Headers(request.headers);
        headers.delete("host");
        return fetch(`${upstream}${url.pathname}${url.search}`, {
          method: request.method,
          headers,
          ...(body ? { body } : {}),
        });
      },
    });
    process.env.OPENAI_BASE_URL = `http://127.0.0.1:${recorder.port}`;
    process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${recorder.port}/v1`;
    llm.onMessage(/.*/, { content: "Answered." });
  });

  afterAll(async () => {
    for (const [name, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    recorder?.stop(true);
    await llm.stop();
  });

  beforeEach(() => {
    wire.length = 0;
  });

  test.each([
    ["openai", "gpt-5.5", "GPT-6.1 Terra", "gpt-6.1-sol", "GPT-6.1 Sol"],
    [
      "anthropic",
      "claude-sonnet-4-5",
      "Claude Sonnet 5.5",
      "claude-opus-5-5",
      "Claude Opus 5.5",
    ],
  ] as const)(
    "on %s, the prompt names the model the chip shows, and the next one after a change",
    async (provider, configured, first, picked, second) => {
      const model: RuntimeModel = { provider, defaultModel: configured };
      const catalogue = catalogueFor(model);
      expect(await chipLabel(catalogue)).toBe(first);

      await builtInBot(model, catalogue);
      expect(wire.join("\n")).toContain(told(first));

      wire.length = 0;
      saved = { model: picked };
      expect(await chipLabel(catalogue, picked)).toBe(second);
      await builtInBot(model, catalogue);
      const sent = wire.join("\n");
      expect(sent).toContain(told(second));
      expect(sent).not.toContain(first);
    },
  );

  /*
   * The starter that ships in the personal edition runs here, and its subtitle says so ("Powered
   * by OpenBot"). A Bot on LangGraph is told its framework in its standing role; one here was told
   * only its name, so asked which framework it ran on it had nothing to go by. Read from the package
   * and through `registeredAgentFromRow`, as the runtime loader reads it back from its row.
   */
  test("the personal starter names the framework its subtitle names, and the model the chip shows", async () => {
    const picked = process.env.PICKED_HARNESS_URL;
    delete process.env.PICKED_HARNESS_URL;
    try {
      const { agents } = await loadTenantPackage(
        fileURLToPath(new URL("../../examples/personal", import.meta.url)),
      );
      const starter = agents.find((agent) => agent.id === "personal-assistant");
      if (!starter) throw new Error("the personal package ships no starter");
      expect(starter.title).toContain("Powered by OpenBot");
      const registered = registeredAgentFromRow(starter);
      if (!registered) throw new Error("the starter does not register");

      const model: RuntimeModel = {
        provider: "openai",
        defaultModel: "gpt-5.5",
      };
      const catalogue = catalogueFor(model);
      await builtInBot(model, catalogue, registered);
      const sent = wire.join("\n");
      expect(sent).toContain(
        `You are Personal Assistant, a Bot in OpenBot. ${starter.title}`,
      );
      expect(sent).toContain(told(await chipLabel(catalogue)));
    } finally {
      if (picked !== undefined) process.env.PICKED_HARNESS_URL = picked;
    }
  });
});

/**
 * A plan's harness: `GET /models` answers what a ChatGPT plan offers, in the shape
 * agent-langgraph-agui answers it, and a run answers one line of text.
 */
function planHarness() {
  const runs: RunAgentInput[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      if (request.headers.get("x-openbot-agent-token") !== "managed-token")
        return Response.json({ error: "unauthorised" }, { status: 401 });
      if (
        request.method === "GET" &&
        new URL(request.url).pathname === "/models"
      )
        return Response.json({
          object: "list",
          data: [
            { id: "gpt-6.1-terra", label: "GPT-6.1 Terra", priority: 1 },
            { id: "gpt-6.1-sol", label: "GPT-6.1 Sol", priority: 2 },
            { id: "gpt-6-luna", label: "GPT-6 Luna", priority: 3 },
          ],
        });
      const body = (await request.json()) as RunAgentInput;
      runs.push(body);
      const events = [
        { type: "RUN_STARTED", threadId: body.threadId, runId: body.runId },
        { type: "TEXT_MESSAGE_START", messageId: "reply", role: "assistant" },
        { type: "TEXT_MESSAGE_CONTENT", messageId: "reply", delta: "Hi." },
        { type: "TEXT_MESSAGE_END", messageId: "reply" },
        { type: "RUN_FINISHED", threadId: body.threadId, runId: body.runId },
      ];
      return new Response(
        events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  return { server, runs };
}

/** The instructions the plan's harness was handed for its last run. */
function instructions(runs: RunAgentInput[]): string {
  return (runs.at(-1)?.context ?? []).map((entry) => entry.value).join("\n");
}

describe("a Bot on OpenBot's own harness, on a plan", () => {
  test.each([
    [
      "chatgpt",
      "openai",
      "gpt-5.5",
      "GPT-6.1 Terra",
      "gpt-6-luna",
      "GPT-6 Luna",
    ],
    [
      "claude",
      "anthropic",
      "claude-sonnet-4-5",
      "Claude Sonnet 5.5",
      "claude-haiku-5-5",
      "Claude Haiku 5.5",
    ],
  ] as const)(
    "on a %s plan, the plan's harness is handed the model the chip shows, and the next one after a change",
    async (plan, provider, configured, first, picked, second) => {
      const harness = planHarness();
      try {
        const model: RuntimeModel = {
          provider,
          defaultModel: configured,
          plan: {
            provider: plan,
            endpoint: new URL(`http://127.0.0.1:${harness.server.port}/`),
            token: "managed-token",
          },
        };
        const catalogue = catalogueFor(
          model,
          plan === "claude"
            ? { CLAUDE_CODE_OAUTH_TOKEN: CLAUDE_PLAN_OAUTH }
            : {},
        );
        expect(await chipLabel(catalogue)).toBe(first);

        await builtInBot(model, catalogue);
        expect(instructions(harness.runs)).toContain(told(first));

        saved = { model: picked };
        expect(await chipLabel(catalogue, picked)).toBe(second);
        await builtInBot(model, catalogue);
        expect(instructions(harness.runs)).toContain(told(second));
        expect(instructions(harness.runs)).not.toContain(first);
      } finally {
        harness.server.stop(true);
      }
    },
  );
});

const PICKED = "http://agent-harness.test:4206";
const environment: Record<string, string | undefined> = {};

describe("a Bot on a harness this deployment runs", () => {
  beforeEach(() => {
    for (const name of [
      "PICKED_HARNESS_URL",
      "PICKED_HARNESS_IMAGE",
      "PICKED_HARNESS_SOURCE",
      "MANAGED_AGENT_TOKEN",
    ])
      environment[name] = process.env[name];
    process.env.PICKED_HARNESS_URL = PICKED;
    delete process.env.PICKED_HARNESS_SOURCE;
    process.env.MANAGED_AGENT_TOKEN = "managed-token";
  });

  afterEach(() => {
    for (const [name, value] of Object.entries(environment)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  /** The standing role each run of the Bot at `endpoint` was sent, in order. */
  async function standingRoles(
    endpoint: string,
    framework: string,
    model: RuntimeModel,
    catalogue: Catalogue,
    picks: (typeof saved)[],
  ): Promise<string[]> {
    const requests: RunAgentInput[] = [];
    const run = spyOn(HttpAgent.prototype, "run").mockImplementation(
      (input) => {
        requests.push(input);
        return of(
          { type: "RUN_STARTED", threadId: input.threadId, runId: input.runId },
          {
            type: "RUN_FINISHED",
            threadId: input.threadId,
            runId: input.runId,
          },
        ) as never;
      },
    );
    try {
      for (const pick of picks) {
        saved = pick;
        const agents = await buildAgents(
          [
            {
              id: "picked-harness",
              name: "Personal Assistant",
              type: "remote_ag_ui",
              endpoint,
              headers: { "x-openbot-agent-token": "managed-token" },
              standingMessage: {
                id: "standing-role:picked-harness",
                role: "system",
                content: `You are Personal Assistant, Everyday life. Powered by ${framework}.`,
              },
            },
          ],
          model,
          "synthetic-key",
          undefined,
          async () => [],
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          () => catalogue.choose(saved),
        );
        const agent = agents["picked-harness"];
        if (!agent) throw new Error("Bot missing");
        agent.messages = [
          {
            id: "q",
            role: "user",
            content: "Which AI model and which agent framework do you run on?",
          },
        ];
        await agent.runAgent();
      }
      return requests.map((request) => {
        const role = request.messages[0];
        return role?.role === "system" && typeof role.content === "string"
          ? role.content
          : "";
      });
    } finally {
      run.mockRestore();
    }
  }

  test.each([
    [
      "ghcr.io/copilotkit/openbot-agent-langgraph-agui@sha256:0123",
      "LangChain",
      { provider: "openai", defaultModel: "gpt-5.5" },
      "GPT-6.1 Terra",
      "gpt-6.1-sol",
      "GPT-6.1 Sol",
    ],
    [
      "ghcr.io/copilotkit/openbot-agent-claude-sdk:latest",
      "Claude Agent SDK",
      { provider: "anthropic", defaultModel: "claude-sonnet-4-5" },
      "Claude Sonnet 5.5",
      "claude-opus-5-5",
      "Claude Opus 5.5",
    ],
  ] as const)(
    "%s names its framework and the model the chip shows, and the next one after a change",
    async (image, framework, model, first, picked, second) => {
      process.env.PICKED_HARNESS_IMAGE = image;
      const catalogue = catalogueFor(model);
      expect(await chipLabel(catalogue)).toBe(first);
      expect(await chipLabel(catalogue, picked)).toBe(second);

      const [before, after] = await standingRoles(
        PICKED,
        framework,
        model,
        catalogue,
        [null, { model: picked }],
      );
      expect(before).toContain(`Powered by ${framework}.`);
      expect(before).toContain(told(first));
      expect(after).toContain(told(second));
      expect(after).not.toContain(first);
    },
  );

  test("a harness somebody brought themselves picks its own model, so none is named", async () => {
    process.env.PICKED_HARNESS_IMAGE =
      "ghcr.io/copilotkit/openbot-agent-langgraph-agui@sha256:0123";
    process.env.PICKED_HARNESS_SOURCE = "byo";
    const model: RuntimeModel = { provider: "openai", defaultModel: "gpt-5.5" };
    const [role] = await standingRoles(
      PICKED,
      "LangChain",
      model,
      catalogueFor(model),
      [null],
    );
    expect(role).not.toContain("The AI model you are running on");
  });

  test("a Bot on someone else's framework picks its own model, so none is named", async () => {
    process.env.PICKED_HARNESS_IMAGE =
      "ghcr.io/copilotkit/openbot-agent-langgraph-agui@sha256:0123";
    const model: RuntimeModel = { provider: "openai", defaultModel: "gpt-5.5" };
    const [role] = await standingRoles(
      "https://their-bot.test/ag-ui",
      "Mastra",
      model,
      catalogueFor(model),
      [null],
    );
    expect(role).not.toContain("The AI model you are running on");
  });
});
