import { afterAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { BuiltInAgent } from "@copilotkit/runtime/v2";
import { isThreadTitleRun } from "@openbot/toolkit/copilotkit/agents";
import type { GrantedTool } from "@openbot/toolkit/granted-tool";
import { EMPTY } from "rxjs";
import { z } from "zod";
import { buildAgents, standingRoleMessage } from "../src/copilot";

/*
 * FOUND IN THE BROWSER, on the two-organization end to end: one "please remember" wrote the memory four times, and one
 * "create a routine" raised two approval cards. A logging proxy in front of the Bot's endpoint showed why. For every new
 * conversation the CopilotKit runtime names the thread by running the SAME Bot again, with its own short prompt and
 * no tools ("Do not call tools"). OpenBot's middleware put the Bot's tools back on that run and executed what the
 * model called, so the naming run remembered the fact, or asked to create the routine, as well, and up to three
 * times, because the runtime retries a naming run whose answer is not a title.
 */

/** The runtime's naming prompt, as @copilotkit/runtime sends it (handlers/intelligence/thread-names). */
const RUNTIME_TITLE_PROMPT = [
  "You generate short, specific conversation titles.",
  'Return JSON only in this exact shape: {"title":"..."}',
  "The title must be 2 to 5 words.",
  "Use sentence case.",
  "No quotes.",
  "No emoji.",
  "No markdown characters or formatting.",
  "Do not use *, _, #, `, [, ], (, ), !, ~, >, or |.",
  "No trailing punctuation.",
  "No explanations.",
  "Do not call tools.",
].join("\n");

test("the runtime's naming prompt is still the one OpenBot recognises", () => {
  // Read from the installed runtime, so an upgrade that rewords it fails here rather than in a person's memory.
  const runtime = dirname(require.resolve("@copilotkit/runtime/v2"));
  const source = readFileSync(
    join(runtime, "runtime/handlers/intelligence/thread-names.mjs"),
    "utf8",
  );
  expect(source).toContain("You generate short, specific conversation titles.");
  expect(
    isThreadTitleRun({
      messages: [
        { id: "s", role: "system", content: RUNTIME_TITLE_PROMPT },
        { id: "u", role: "user", content: "Conversation: ..." },
      ],
    }),
  ).toBe(true);
  expect(
    isThreadTitleRun({
      messages: [{ id: "u", role: "user", content: "Remember my fruit" }],
    }),
  ).toBe(false);
});

/** A Bot endpoint whose model calls the Bot's tool whenever it is offered one, as gpt-4.1-mini did. */
const offered: string[][] = [];
const endpoint = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const input = (await request.json()) as {
      runId: string;
      threadId: string;
      tools?: { name: string }[];
      messages: { role: string }[];
    };
    const tools = (input.tools ?? []).map((tool) => tool.name);
    offered.push(tools);
    const answered = input.messages.some((message) => message.role === "tool");
    const events: Record<string, unknown>[] = [
      { type: "RUN_STARTED", threadId: input.threadId, runId: input.runId },
    ];
    if (tools.includes("remember_fact") && !answered) {
      events.push(
        {
          type: "TOOL_CALL_START",
          toolCallId: "call-1",
          toolCallName: "remember_fact",
        },
        {
          type: "TOOL_CALL_ARGS",
          toolCallId: "call-1",
          delta: '{"fact":"mango"}',
        },
        { type: "TOOL_CALL_END", toolCallId: "call-1" },
      );
    } else {
      events.push(
        { type: "TEXT_MESSAGE_START", messageId: "m-1", role: "assistant" },
        {
          type: "TEXT_MESSAGE_CONTENT",
          messageId: "m-1",
          delta: '{"title":"Favourite fruit"}',
        },
        { type: "TEXT_MESSAGE_END", messageId: "m-1" },
      );
    }
    events.push({
      type: "RUN_FINISHED",
      threadId: input.threadId,
      runId: input.runId,
    });
    return new Response(
      events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
      { headers: { "content-type": "text/event-stream" } },
    );
  },
});
afterAll(() => endpoint.stop(true));

test("naming a thread runs a remote Bot with none of its tools, and executes nothing", async () => {
  let executed = 0;
  const remember: GrantedTool = {
    name: "remember_fact",
    ref: "memory/remember_fact",
    description: "Store a personal fact.",
    parameters: z.object({ fact: z.string() }),
    execute: async () => {
      executed += 1;
      return "stored";
    },
  };
  const agents = await buildAgents(
    [
      {
        id: "remote-bot",
        name: "Remote Bot",
        type: "remote_ag_ui",
        endpoint: `http://127.0.0.1:${endpoint.port}/ag-ui`,
        standingMessage: standingRoleMessage({
          id: "remote-bot",
          name: "Remote Bot",
          title: "Assistant",
          roleDescription: "Help.",
        }),
      },
    ],
    { provider: "openai", defaultModel: "gpt-4.1-mini" },
    null,
    undefined,
    async () => [remember],
  );
  const bot = agents["remote-bot"];
  if (!bot) throw new Error("Expected the remote Bot");

  // What the runtime does to name a thread: a clone, its own two messages, a fresh thread, no tools.
  const naming = bot.clone();
  naming.setMessages([
    { id: "s", role: "system", content: RUNTIME_TITLE_PROMPT },
    {
      id: "u",
      role: "user",
      content:
        "Conversation:\n\nuser: Please remember my favourite fruit is mango.\n\nGenerate a short title.",
    },
  ]);
  naming.threadId = "naming-thread";
  offered.length = 0;
  await naming.runAgent({ tools: [], context: [], forwardedProps: {} });

  expect(executed).toBe(0);
  expect(offered).toEqual([[]]);

  // An ordinary run still gets the Bot's tools and runs them: the guard is for naming only.
  const run = bot.clone();
  run.setMessages([
    {
      id: "u2",
      role: "user",
      content: "Please remember my favourite fruit is mango.",
    },
  ]);
  run.threadId = "conversation-thread";
  offered.length = 0;
  await run.runAgent({ tools: [], context: [], forwardedProps: {} });
  expect(executed).toBe(1);
  expect(offered[0]).toContain("remember_fact");
});

test("naming a thread runs a built-in Bot without its tools", async () => {
  const agents = await buildAgents(
    [
      {
        id: "built-bot",
        name: "Built Bot",
        type: "built_in",
        systemPrompt: "Help.",
      },
    ],
    { provider: "openai", defaultModel: "gpt-4.1-mini" },
    "sk-not-dialled",
    undefined,
    async () => [
      {
        name: "remember_fact",
        ref: "memory/remember_fact",
        description: "Store a personal fact.",
        parameters: z.object({ fact: z.string() }),
        execute: async () => "stored",
      },
    ],
  );
  const bot = agents["built-bot"];
  if (!bot) throw new Error("Expected the built-in Bot");
  const seen: unknown[] = [];
  const original = BuiltInAgent.prototype.run;
  BuiltInAgent.prototype.run = function (this: BuiltInAgent) {
    // What the model would be offered on this run: the agent's configured tools. No model is dialled.
    seen.push(
      Object.keys(
        ((this as unknown as { config?: { tools?: unknown } }).config?.tools ??
          {}) as object,
      ).length,
    );
    return EMPTY;
  };
  try {
    const naming = bot.clone();
    naming.setMessages([
      { id: "s", role: "system", content: RUNTIME_TITLE_PROMPT },
      { id: "u", role: "user", content: "Conversation: ..." },
    ]);
    naming.threadId = "naming-thread";
    await naming
      .runAgent({ tools: [], context: [], forwardedProps: {} })
      .catch(() => undefined);
  } finally {
    BuiltInAgent.prototype.run = original;
  }
  expect(seen.length).toBeGreaterThan(0);
  expect(seen.every((count) => count === 0)).toBe(true);
});
