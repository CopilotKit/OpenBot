import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import type { BaseEvent, RunAgentInput } from "@ag-ui/client";
import { EventType } from "@ag-ui/client";
import { LLMock } from "@copilotkit/aimock";
import {
  ASKED_RUN,
  buildAgents,
  isAskedRun,
  type RuntimeModel,
} from "../src/copilot";
import type { RunChoice } from "../src/model-catalogue";

/*
 * A built-in Bot's run, end to end against a fake provider: the model the provider is asked for is
 * the person's saved pick for the conversation, and the deployment's otherwise. Never one the
 * request itself names.
 */

const model: RuntimeModel = { provider: "openai", defaultModel: "gpt-5.5" };
const llm = new LLMock();
let originalBase: string | undefined;
let originalAnthropicBase: string | undefined;
let originalApi: string | undefined;

/*
 * Every request exactly as it went on the wire. aimock answers each one faithfully but records a
 * body normalized to one shape, which drops what only the Responses API and Anthropic carry
 * (`reasoning`, `output_config`); this pass-through in front of it keeps the original.
 */
const wire: Record<string, unknown>[] = [];
let recorder: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  originalBase = process.env.OPENAI_BASE_URL;
  originalAnthropicBase = process.env.ANTHROPIC_BASE_URL;
  originalApi = process.env.COPILOTKIT_OPENAI_API;
  const upstream = await llm.start();
  recorder = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = await request.text();
      if (body) wire.push(JSON.parse(body) as Record<string, unknown>);
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
  const url = `http://127.0.0.1:${recorder.port}`;
  process.env.OPENAI_BASE_URL = url;
  // The Anthropic SDK appends only `/messages`; OpenBot's own base always ends in its version.
  process.env.ANTHROPIC_BASE_URL = `${url}/v1`;
  llm.onMessage(/.*/, { content: "Answered." });
});

afterAll(async () => {
  for (const [name, value] of [
    ["OPENAI_BASE_URL", originalBase],
    ["ANTHROPIC_BASE_URL", originalAnthropicBase],
    ["COPILOTKIT_OPENAI_API", originalApi],
  ] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  recorder?.stop(true);
  await llm.stop();
});

beforeEach(() => {
  llm.clearRequests();
  wire.length = 0;
});

/** A pick as the server records it: a bare id is a listed model with no effort. */
type Picked = string | RunChoice | undefined;

async function bot(
  picked: Picked,
  holdsTools?: typeof isAskedRun,
  deployment: RuntimeModel = model,
) {
  const agents = await buildAgents(
    [
      {
        id: "assistant",
        name: "Assistant",
        type: "built_in",
        systemPrompt: "Answer briefly.",
      },
    ],
    deployment,
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
    // recordToolLimitRefusal
    undefined,
    holdsTools,
    async () =>
      typeof picked === "string" ? { model: picked, listed: true } : picked,
  );
  if (!agents.assistant) throw new Error("Bot missing");
  return agents.assistant.clone();
}

function input(forwardedProps: Record<string, unknown>): RunAgentInput {
  return {
    threadId: `thread-${crypto.randomUUID()}`,
    runId: `run-${crypto.randomUUID()}`,
    messages: [{ id: "user", role: "user", content: "Hello" }],
    tools: [],
    context: [],
    state: {},
    forwardedProps,
  };
}

async function run(
  forwardedProps: Record<string, unknown>,
  picked: Picked,
  holdsTools?: typeof isAskedRun,
  deployment: RuntimeModel = model,
) {
  const agent = await bot(picked, holdsTools, deployment);
  const events: BaseEvent[] = [];
  await new Promise<void>((resolve, reject) => {
    agent.run(input(forwardedProps)).subscribe({
      next: (event: BaseEvent) => events.push(event),
      error: reject,
      complete: resolve,
    });
  }).catch(() => undefined);
  return events;
}

function modelsAsked(): string[] {
  return llm
    .getRequests()
    .map((entry) => (entry.body as { model?: unknown } | null)?.model)
    .filter((asked): asked is string => typeof asked === "string");
}

test("a run with no pick asks the provider for the deployment's model", async () => {
  await run({}, undefined);
  expect(modelsAsked()).toEqual(["gpt-5.5"]);
});

test("a run asks the provider for the model the person picked", async () => {
  const events = await run({}, "gpt-4o");
  expect(modelsAsked()).toEqual(["gpt-4o"]);
  expect(events.some((event) => event.type === EventType.RUN_FINISHED)).toBe(
    true,
  );
});

test("a model the request names is not the one asked for", async () => {
  await run({ openbotModel: "gpt-4o", model: "openai/gpt-4o" }, undefined);
  expect(modelsAsked()).toEqual(["gpt-5.5"]);
});

/*
 * The runtime's own runs (naming the conversation, suggestions) are built with none of the Bot's
 * tools, and still answer on the conversation's model: the gate judged and recorded that one.
 */
test("a run the runtime makes for itself asks for the picked model too", async () => {
  await run({}, "gpt-4o", isAskedRun);
  expect(modelsAsked()).toEqual(["gpt-4o"]);
});

test("a run somebody asked for, on a request map that holds tools, asks for the pick", async () => {
  await run({ [ASKED_RUN]: true }, "gpt-4o", isAskedRun);
  expect(modelsAsked()).toEqual(["gpt-4o"]);
});

/** What each request the fake provider received asked for, as it went on the wire. */
function bodies(): Record<string, unknown>[] {
  return wire;
}

/*
 * The thinking effort a person picked reaches the provider in the spelling each API takes, and no
 * effort is sent when none was picked, so the model thinks on its own default.
 */
test("Chat Completions (any OpenAI-compatible endpoint, Google's and xAI's included) is sent reasoning_effort", async () => {
  await run({}, { model: "grok-4.7", effort: "xhigh", listed: true });
  expect(bodies()).toHaveLength(1);
  expect(bodies()[0]?.model).toBe("grok-4.7");
  expect(bodies()[0]?.reasoning_effort).toBe("xhigh");
});

test("no effort picked, none sent", async () => {
  await run({}, { model: "gpt-6.1-terra", listed: true });
  expect(bodies()[0]?.model).toBe("gpt-6.1-terra");
  expect(bodies()[0]).not.toHaveProperty("reasoning_effort");
  expect(bodies()[0]).not.toHaveProperty("reasoning");
});

test("the Responses API is sent reasoning.effort", async () => {
  process.env.COPILOTKIT_OPENAI_API = "responses";
  try {
    await run({}, { model: "gpt-6.1-terra", effort: "max", listed: true });
  } finally {
    delete process.env.COPILOTKIT_OPENAI_API;
  }
  expect(bodies()[0]?.model).toBe("gpt-6.1-terra");
  expect(bodies()[0]?.reasoning).toMatchObject({ effort: "max" });
});

test("Anthropic is sent output_config.effort", async () => {
  await run(
    {},
    { model: "claude-sonnet-5-5", effort: "low", listed: true },
    undefined,
    { provider: "anthropic", defaultModel: "claude-sonnet-4-6" },
  );
  expect(bodies()[0]?.model).toBe("claude-sonnet-5-5");
  expect(bodies()[0]?.output_config).toMatchObject({ effort: "low" });
});
