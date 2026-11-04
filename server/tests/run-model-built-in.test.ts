import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import type { BaseEvent, RunAgentInput } from "@ag-ui/client";
import { EventType } from "@ag-ui/client";
import { LLMock } from "@copilotkit/aimock";
import { buildAgents, type RuntimeModel } from "../src/copilot";

/*
 * A built-in Bot's run, end to end against a fake provider: the model the provider is asked for is
 * the one the person picked, when OpenBot offers it, and the deployment's otherwise.
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

async function bot(offered: readonly string[]) {
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
    undefined,
    async (id) => offered.includes(id),
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
  offered: readonly string[],
) {
  const agent = await bot(offered);
  const events: BaseEvent[] = [];
  await new Promise<void>((resolve, reject) => {
    agent.run(input(forwardedProps)).subscribe({
      next: (event) => events.push(event),
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
  await run({}, ["gpt-4o"]);
  expect(modelsAsked()).toEqual(["gpt-5.5"]);
});

test("a run asks the provider for the model the person picked", async () => {
  const events = await run({ openbotModel: "gpt-4o" }, ["gpt-4o"]);
  expect(modelsAsked()).toEqual(["gpt-4o"]);
  expect(events.some((event) => event.type === EventType.RUN_FINISHED)).toBe(
    true,
  );
});

test("a pick OpenBot does not offer is refused, and the provider is never asked", async () => {
  const events = await run({ openbotModel: "gpt-image-2" }, ["gpt-4o"]);
  expect(modelsAsked()).toEqual([]);
  expect(events.some((event) => event.type === EventType.RUN_FINISHED)).toBe(
    false,
  );
});
