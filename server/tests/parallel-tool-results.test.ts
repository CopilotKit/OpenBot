import { expect, test } from "bun:test";
import type { BaseEvent, RunAgentInput } from "@ag-ui/client";
import { LLMock } from "@copilotkit/aimock";
import type { GrantedTool } from "@openbot/toolkit/granted-tool";
import { z } from "zod";
import { buildAgents, type RuntimeModel } from "../src/copilot";

/*
 * A built-in Bot that sends 20 lookups in one step gets 20 answers, each its own, however long each
 * takes; a lookup that fails comes back as an error naming the failure, never as nothing.
 *
 * Found live: a Bot sent 20 lookups at once and 9 of them, the slowest, reached the next turn as
 * "This call produced no result". The server was not where they were lost (the conversation on screen
 * was; see app/tests/parallel-answers-send.test.tsx), and this holds it to that: the real built-in
 * agent and AI SDK, a model that speaks OpenAI's protocol (aimock), and tools that answer late.
 */

const model: RuntimeModel = { provider: "openai", defaultModel: "gpt-5.5" };
const LOOKUPS = 20;
/** The one lookup whose app refuses, to see that a failure is answered too. */
const FAILING = 7;

test("every one of 20 parallel lookups is answered, in its own words, slowest last", async () => {
  const llm = new LLMock({ host: "127.0.0.1", port: 0 });
  let steps = 0;
  llm.on({ predicate: () => true }, () => {
    steps++;
    return steps === 1
      ? {
          toolCalls: Array.from({ length: LOOKUPS }, (_, index) => ({
            name: "mcp__tracker__search_issues",
            arguments: JSON.stringify({ query: `keyword ${index}` }),
          })),
        }
      : { content: "Every lookup answered." };
  });
  const original = process.env.OPENAI_BASE_URL;
  process.env.OPENAI_BASE_URL = `${await llm.start()}/v1`;
  try {
    const finished: string[] = [];
    const granted: GrantedTool[] = [
      {
        ref: "tracker/search_issues",
        name: "mcp__tracker__search_issues",
        description: "Search issues by keyword.",
        parameters: z.object({ query: z.string() }),
        execute: async (args) => {
          const { query } = args as { query: string };
          const index = Number(query.split(" ")[1]);
          // The later in the batch, the longer it takes: the shape of the step found live.
          await Bun.sleep(index * 40);
          finished.push(query);
          if (index === FAILING)
            throw new Error("The tracker refused the search: rate limited.");
          return `Found EGG-${500 + index} for ${query}`;
        },
      },
    ];
    const agents = await buildAgents(
      [
        {
          id: "planner",
          name: "Planner",
          type: "built_in",
          systemPrompt: "Plan the cycle.",
        },
      ],
      model,
      "synthetic-fixture-key",
      undefined,
      async () => granted,
    );
    const agent = agents.planner?.clone();
    if (!agent) throw new Error("The planner Bot was not built.");
    const input: RunAgentInput = {
      threadId: "parallel-lookups-thread",
      runId: "parallel-lookups-run",
      messages: [{ id: "user", role: "user", content: "Plan the cycle." }],
      tools: [],
      context: [],
      state: {},
      forwardedProps: {},
    };
    const events: BaseEvent[] = [];
    await new Promise<void>((resolve, reject) =>
      agent.run(input).subscribe({
        next: (event: BaseEvent) => events.push(event),
        error: reject,
        complete: resolve,
      }),
    );

    const calls = events.flatMap((event) =>
      event.type === "TOOL_CALL_START"
        ? [(event as unknown as { toolCallId: string }).toolCallId]
        : [],
    );
    const answers = new Map(
      events.flatMap((event) => {
        if (event.type !== "TOOL_CALL_RESULT") return [];
        const { toolCallId, content } = event as unknown as {
          toolCallId: string;
          content: string;
        };
        return [[toolCallId, content] as const];
      }),
    );
    expect(calls).toHaveLength(LOOKUPS);
    expect(finished).toHaveLength(LOOKUPS);
    // Each call has exactly its own answer, in the order the calls were made.
    expect(calls.map((id) => answers.get(id))).toEqual(
      Array.from({ length: LOOKUPS }, (_, index) =>
        index === FAILING
          ? "Error: The tracker refused the search: rate limited."
          : JSON.stringify(`Found EGG-${500 + index} for keyword ${index}`),
      ),
    );
    // And the run went on to answer once every lookup had.
    expect(String(events.at(-1)?.type)).toBe("RUN_FINISHED");
    expect(steps).toBe(2);
  } finally {
    if (original === undefined) delete process.env.OPENAI_BASE_URL;
    else process.env.OPENAI_BASE_URL = original;
    await llm.stop();
  }
});
