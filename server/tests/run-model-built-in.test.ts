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

/*
 * A built-in Bot's run, end to end against a fake provider: the model the provider is asked for is
 * the person's saved pick for the conversation, and the deployment's otherwise. Never one the
 * request itself names.
 */

const model: RuntimeModel = { provider: "openai", defaultModel: "gpt-5.5" };
const llm = new LLMock();
let originalBase: string | undefined;

beforeAll(async () => {
  originalBase = process.env.OPENAI_BASE_URL;
  process.env.OPENAI_BASE_URL = await llm.start();
  llm.onMessage(/.*/, { content: "Answered." });
});

afterAll(async () => {
  if (originalBase === undefined) delete process.env.OPENAI_BASE_URL;
  else process.env.OPENAI_BASE_URL = originalBase;
  await llm.stop();
});

beforeEach(() => llm.clearRequests());

async function bot(picked: string | undefined, holdsTools?: typeof isAskedRun) {
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
    async () => picked,
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
  picked: string | undefined,
  holdsTools?: typeof isAskedRun,
) {
  const agent = await bot(picked, holdsTools);
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
