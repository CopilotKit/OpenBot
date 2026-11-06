import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { HttpAgent, type RunAgentInput } from "@ag-ui/client";
import { of } from "rxjs";
import { buildAgents, type RuntimeModel } from "../src/copilot";
import { createModelCatalogue } from "../src/model-catalogue";

/*
 * The model and effort reach the harness that answers: a built-in Bot on a ChatGPT plan, through the
 * plan's harness, and the harness picked in setup when a person talks to it directly. Both are sent
 * `forwardedProps.openbotModel`, decided on the server from the plan's own listing.
 *
 * The plan case is the failure that started this: the harness was left to run `BOT_MODEL=gpt-5.5`,
 * which a ChatGPT plan refuses ("not supported when using Codex with a ChatGPT account"), so every
 * message failed.
 */

const MODELS_DEV = `${import.meta.dir}/fixtures/model-listings/models-dev-api.json`;

/**
 * The plan's harness: `GET /models` answers what the ChatGPT plan offers, in the shape
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
            {
              id: "gpt-6.1-terra",
              label: "GPT-6.1 Terra",
              efforts: ["low", "medium", "high", "xhigh"],
              default_effort: "medium",
              priority: 1,
            },
            {
              id: "gpt-6.1-sol",
              label: "GPT-6.1 Sol",
              efforts: ["low", "medium", "high", "xhigh"],
              default_effort: "medium",
              priority: 2,
            },
            {
              id: "gpt-6-luna",
              label: "GPT-6 Luna",
              efforts: ["low", "medium", "high"],
              default_effort: "low",
              priority: 3,
            },
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

async function planBot(saved: { model?: string; effort?: string } | null) {
  const harness = planHarness();
  const model: RuntimeModel = {
    provider: "openai",
    // What the deployment was configured with, and what the plan refuses.
    defaultModel: "gpt-5.5",
    plan: {
      provider: "chatgpt",
      endpoint: new URL(`http://127.0.0.1:${harness.server.port}/`),
      token: "managed-token",
    },
  };
  const modelsDev = await Bun.file(MODELS_DEV).json();
  const catalogue = createModelCatalogue({
    model,
    apiKey: async () => null,
    environment: {},
    fetch: ((url: string | URL | Request, init?: RequestInit) =>
      String(url) === "https://models.dev/api.json"
        ? Promise.resolve(Response.json(modelsDev))
        : fetch(url, init)) as typeof fetch,
  });
  const agents = await buildAgents(
    [
      {
        id: "assistant",
        name: "Assistant",
        type: "built_in",
        systemPrompt: "Answer briefly.",
      },
    ],
    model,
    null,
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
  const agent = agents.assistant?.clone();
  if (!agent) throw new Error("Bot missing");
  agent.setMessages([{ id: "q", role: "user", content: "Hello" }]);
  return { agent, harness };
}

test("a built-in Bot on a ChatGPT plan tells the plan's harness a model the plan offers, never the configured gpt-5.5", async () => {
  const { agent, harness } = await planBot(null);
  try {
    await agent.runAgent();
    expect(harness.runs).toHaveLength(1);
    expect(harness.runs[0]?.forwardedProps).toMatchObject({
      openbotModelOnly: true,
      openbotModel: { model: "gpt-6.1-terra" },
    });
    expect(JSON.stringify(harness.runs[0]?.forwardedProps)).not.toContain(
      "gpt-5.5",
    );
    expect(agent.messages.at(-1)).toMatchObject({ content: "Hi." });
  } finally {
    harness.server.stop(true);
  }
});

test("a person's model and effort on a plan reach its harness", async () => {
  const { agent, harness } = await planBot({
    model: "gpt-6-luna",
    effort: "high",
  });
  try {
    await agent.runAgent();
    expect(harness.runs[0]?.forwardedProps).toMatchObject({
      openbotModel: { model: "gpt-6-luna", reasoningEffort: "high" },
    });
  } finally {
    harness.server.stop(true);
  }
});

const PICKED = "http://agent-harness.test:4206";
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const name of [
    "PICKED_HARNESS_URL",
    "PICKED_HARNESS_IMAGE",
    "PICKED_HARNESS_SOURCE",
    "MANAGED_AGENT_TOKEN",
  ])
    saved[name] = process.env[name];
  process.env.PICKED_HARNESS_URL = PICKED;
  process.env.PICKED_HARNESS_IMAGE =
    "ghcr.io/copilotkit/openbot-agent-langgraph-agui@sha256:0123";
  delete process.env.PICKED_HARNESS_SOURCE;
  process.env.MANAGED_AGENT_TOKEN = "managed-token";
});

afterEach(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

async function remoteRuns(
  endpoint: string,
  forwardedProps: Record<string, unknown>,
) {
  const requests: RunAgentInput[] = [];
  const run = spyOn(HttpAgent.prototype, "run").mockImplementation((input) => {
    requests.push(input);
    return of(
      { type: "RUN_STARTED", threadId: input.threadId, runId: input.runId },
      { type: "RUN_FINISHED", threadId: input.threadId, runId: input.runId },
    ) as never;
  });
  try {
    const agents = await buildAgents(
      [
        {
          id: "picked-harness",
          name: "LangGraph",
          type: "remote_ag_ui",
          endpoint,
          headers: { "x-openbot-agent-token": "managed-token" },
          standingMessage: {
            id: "standing-role:picked-harness",
            role: "system",
            content: "Answer questions.",
          },
        },
      ],
      { provider: "openai", defaultModel: "gpt-6.1-terra" },
      "key",
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
      async () => ({ model: "gpt-6.1-sol", effort: "xhigh", listed: true }),
    );
    const agent = agents["picked-harness"];
    if (!agent) throw new Error("Bot missing");
    agent.messages = [{ id: "q", role: "user", content: "Hello" }];
    await agent.runAgent({ forwardedProps });
    return requests;
  } finally {
    run.mockRestore();
  }
}

test("the harness picked in setup is told the person's model and effort", async () => {
  const requests = await remoteRuns(PICKED, {});
  expect(requests[0]?.forwardedProps).toMatchObject({
    openbotModel: { model: "gpt-6.1-sol", reasoningEffort: "xhigh" },
  });
});

test("a model the browser names is never what the harness is told", async () => {
  const requests = await remoteRuns(PICKED, {
    openbotModel: { model: "gpt-6-astra", reasoningEffort: "max" },
  });
  expect(requests[0]?.forwardedProps).toMatchObject({
    openbotModel: { model: "gpt-6.1-sol", reasoningEffort: "xhigh" },
  });
});

test("a Bot on someone else's framework picks its own model and is told nothing", async () => {
  const requests = await remoteRuns("https://their-bot.test/ag-ui", {
    openbotModel: { model: "gpt-6-astra" },
  });
  expect(requests[0]?.forwardedProps).not.toHaveProperty("openbotModel");
});

test("a harness somebody brought themselves is told nothing", async () => {
  process.env.PICKED_HARNESS_SOURCE = "byo";
  const requests = await remoteRuns(PICKED, {});
  expect(requests[0]?.forwardedProps).not.toHaveProperty("openbotModel");
});
