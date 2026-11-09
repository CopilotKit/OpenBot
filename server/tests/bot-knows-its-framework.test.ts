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
import { HttpAgent, type RunAgentInput } from "@ag-ui/client";
import { LLMock } from "@copilotkit/aimock";
import { of } from "rxjs";
import { parseAgentInput } from "../src/agents/routes";
import {
  buildAgents,
  type RegisteredAgent,
  type RuntimeModel,
  registeredAgentFromRow,
} from "../src/copilot";
import { createModelCatalogue } from "../src/model-catalogue";

/*
 * A Bot is told the framework it runs on by what runs it, whatever its subtitle says.
 *
 * The subtitle is the person's to write. A Bot told only that could name its framework only while
 * the subtitle said "Powered by ...": one called "Everyday Work" on LangGraph, on the Claude Agent
 * SDK, or on OpenBot itself had nothing to go by. Each Bot here has that subtitle and is registered
 * from its row by `registeredAgentFromRow`, as the runtime loader does, then run through
 * `buildAgents`, the path a person's run takes.
 */

const SUBTITLE = "Everyday Work";
const FIXTURES = `${import.meta.dir}/fixtures/model-listings`;
const modelsDev = await Bun.file(`${FIXTURES}/models-dev-api.json`).json();
const openAIListing = await Bun.file(`${FIXTURES}/openai-models.json`).json();
const anthropicListing = await Bun.file(
  `${FIXTURES}/anthropic-models.json`,
).json();

const framework = (name: string) =>
  `The agent framework you run on is ${name}.`;
const ANY_FRAMEWORK = "The agent framework you run on is";
const model = (label: string) => `The AI model you are running on is ${label}.`;

function catalogueFor(runtime: RuntimeModel) {
  return createModelCatalogue({
    model: runtime,
    apiKey: async () => "synthetic-key",
    environment: {},
    fetch: ((url: string | URL | Request) => {
      const at = String(url);
      if (at === "https://models.dev/api.json")
        return Promise.resolve(Response.json(modelsDev));
      if (at.startsWith("https://api.anthropic.com/"))
        return Promise.resolve(Response.json(anthropicListing));
      return Promise.resolve(Response.json(openAIListing));
    }) as typeof fetch,
  });
}

function row(
  type: "built_in" | "remote_ag_ui",
  configuration: Record<string, unknown>,
) {
  return {
    id: "everyday",
    name: "Everyday",
    type,
    configuration,
    title: SUBTITLE,
    roleDescription: "Help with everyday work.",
  };
}

async function run(
  agent: RegisteredAgent,
  runtime: RuntimeModel,
  catalogue: ReturnType<typeof catalogueFor>,
) {
  const agents = await buildAgents(
    [agent],
    runtime,
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
    () => catalogue.choose(null),
  );
  const built = agents[agent.id]?.clone();
  if (!built) throw new Error("Bot missing");
  built.setMessages([
    {
      id: "q",
      role: "user",
      content: "Which AI model and which agent framework do you run on?",
    },
  ]);
  await built.runAgent();
}

describe("a Bot that runs on OpenBot", () => {
  const llm = new LLMock();
  const wire: string[] = [];
  let recorder: ReturnType<typeof Bun.serve> | undefined;
  const original = process.env.OPENAI_BASE_URL;

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
    llm.onMessage(/.*/, { content: "Answered." });
  });

  afterAll(async () => {
    if (original === undefined) delete process.env.OPENAI_BASE_URL;
    else process.env.OPENAI_BASE_URL = original;
    recorder?.stop(true);
    await llm.stop();
  });

  test("is told OpenBot and its model, with a subtitle that names neither", async () => {
    const agent = registeredAgentFromRow(
      row("built_in", { systemPrompt: "Help with everyday work." }),
    );
    if (!agent) throw new Error("the Bot does not register");
    const runtime: RuntimeModel = {
      provider: "openai",
      defaultModel: "gpt-5.5",
    };
    await run(agent, runtime, catalogueFor(runtime));
    const sent = wire.join("\n");
    expect(sent).toContain(framework("OpenBot"));
    expect(sent).toContain(model("GPT-6.1 Terra"));
  });
});

const PICKED = "http://agent-harness.test:4206";
const THEIRS = "https://their-agent.test/ag-ui";
const NAMES = [
  "PICKED_HARNESS_URL",
  "PICKED_HARNESS_IMAGE",
  "PICKED_HARNESS_SOURCE",
  "MANAGED_AGENT_TOKEN",
] as const;

describe("a Bot at an address", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const name of NAMES) saved[name] = process.env[name];
    process.env.PICKED_HARNESS_URL = PICKED;
    delete process.env.PICKED_HARNESS_SOURCE;
    process.env.MANAGED_AGENT_TOKEN = "managed-token";
  });

  afterEach(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  /** The standing role one run of the Bot at `endpoint` is sent. */
  async function standingRole(
    configuration: Record<string, unknown>,
    runtime: RuntimeModel,
  ): Promise<string> {
    const agent = registeredAgentFromRow(row("remote_ag_ui", configuration));
    if (agent?.type !== "remote_ag_ui")
      throw new Error("the Bot does not register");
    // What the runtime loader adds for an address this deployment runs.
    if (configuration.endpoint === PICKED)
      agent.headers = { "x-openbot-agent-token": "managed-token" };
    const requests: RunAgentInput[] = [];
    const sent = spyOn(HttpAgent.prototype, "run").mockImplementation(
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
      await run(agent, runtime, catalogueFor(runtime));
    } finally {
      sent.mockRestore();
    }
    const role = requests[0]?.messages[0];
    return role?.role === "system" && typeof role.content === "string"
      ? role.content
      : "";
  }

  test.each([
    [
      "ghcr.io/copilotkit/openbot-agent-langgraph-agui@sha256:0123",
      "LangChain",
      { provider: "openai", defaultModel: "gpt-5.5" },
      "GPT-6.1 Terra",
    ],
    [
      "127.0.0.1:5050/openbot-agent-claude-sdk:sha-4d17",
      "Claude Agent SDK",
      { provider: "anthropic", defaultModel: "claude-sonnet-4-5" },
      "Claude Sonnet 5.5",
    ],
  ] as const)(
    "the harness picked in setup, %s, is told its framework and its model, with a subtitle that names neither",
    async (image, name, runtime, label) => {
      process.env.PICKED_HARNESS_IMAGE = image;
      const role = await standingRole({ endpoint: PICKED }, runtime);
      expect(role).toContain(`You are Everyday, ${SUBTITLE}.`);
      expect(role).toContain(framework(name));
      expect(role).toContain(model(label));
    },
  );

  test("an agent somebody runs is told the framework they named when they connected it", async () => {
    const role = await standingRole(
      { endpoint: THEIRS, harness: "crewai" },
      { provider: "openai", defaultModel: "gpt-5.5" },
    );
    expect(role).toContain(framework("CrewAI"));
    // Its model is its own, which OpenBot cannot name.
    expect(role).not.toContain("The AI model you are running on");
  });

  test("an agent connected with no framework named is told none rather than a guess", async () => {
    const role = await standingRole(
      { endpoint: THEIRS },
      { provider: "openai", defaultModel: "gpt-5.5" },
    );
    expect(role).not.toContain(ANY_FRAMEWORK);
  });

  test("a harness somebody brought themselves is not named by the image setup would have run", async () => {
    process.env.PICKED_HARNESS_IMAGE =
      "ghcr.io/copilotkit/openbot-agent-langgraph-agui@sha256:0123";
    process.env.PICKED_HARNESS_SOURCE = "byo";
    const role = await standingRole(
      { endpoint: PICKED },
      { provider: "openai", defaultModel: "gpt-5.5" },
    );
    expect(role).not.toContain(ANY_FRAMEWORK);
  });
});

describe("the framework New Bot sends", () => {
  const input = {
    name: "Research",
    title: SUBTITLE,
    roleDescription: "Research things.",
    visibility: "private",
  };

  test("is kept, by its id, for an agent at an address", () => {
    expect(
      parseAgentInput({ ...input, endpoint: THEIRS, harness: "crewai" }),
    ).toMatchObject({ ok: true, value: { harness: "crewai" } });
  });

  test("is not kept for a Bot that runs here, which runs on OpenBot", () => {
    const parsed = parseAgentInput({ ...input, harness: "crewai" });
    expect(parsed.ok).toBe(true);
    expect(parsed.ok && parsed.value).not.toHaveProperty("harness");
  });

  test("is refused when OpenBot doesn't know it, or names no framework", () => {
    for (const harness of ["not-a-framework", "byo-url", 7])
      expect(
        parseAgentInput({ ...input, endpoint: THEIRS, harness }),
      ).toMatchObject({ ok: false });
  });
});
