import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { BaseEvent, RunAgentInput } from "@ag-ui/client";
import { LLMock } from "@copilotkit/aimock";
import { MCPMock } from "@copilotkit/aimock/mcp";
import { SUBAGENT_TOOL } from "@openbot/shared/subagent";
import type { GrantedTool } from "@openbot/toolkit/granted-tool";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { createAuditStore } from "../src/audit";
import type { ActionPolicy } from "../src/computer/policy";
import { buildAgents, type RuntimeModel } from "../src/copilot";
import { createDatabase } from "../src/db/client";
import { agents, mcpServers, mcpTools, pluginGrants } from "../src/db/schema";
import {
  ALREADY_FETCHED,
  MAX_APP_CALLS_AT_ONCE,
} from "../src/plugins/run-calls";
import { createPluginStore } from "../src/plugins/store";
import { grantedTools } from "../src/plugins/tools";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * A Bot's app calls come back: a burst runs a few at a time, a read asked twice is answered once,
 * and a read that meets a passing failure is tried again before the Bot hears of it.
 *
 * Found live: a Bot planning a cycle sent 20 lookups at once to its tracker, and the tail of the
 * burst is what an app answers with timeouts and 429s. The real path end to end: the built-in agent
 * and the AI SDK, a model speaking OpenAI's protocol (aimock), the plugin store with its grant,
 * policy and audit, and a real MCP server over HTTP (aimock's MCPMock) behind a door that can answer
 * 503 the way an overloaded app does.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = randomUUID().slice(0, 8);
const botId = `tool_calls_${suite}`;
const serverId = `tracker_${suite}`;
const ACTOR = "planner@openbot.test";
const model: RuntimeModel = { provider: "openai", defaultModel: "gpt-5.5" };
const policy: ActionPolicy = { mode: "enforce", deny: [], allow: ["true"] };

const store = createPluginStore({
  brokerProvider: "composio",
  database,
  auditStore: createAuditStore(database),
  // The tracker needs no credential, so the vault is never read.
  credentials: { readSecret: async () => null } as unknown as Parameters<
    typeof createPluginStore
  >[0]["credentials"],
  encryptionKey: "x".repeat(44),
  policy: () => policy,
});

const tracker = new MCPMock();
/** Each search the tracker answered, by query, and how many were being answered at once at most. */
const searched: string[] = [];
const commented: string[] = [];
let inFlight = 0;
let peak = 0;
/** Queries the door in front of the tracker answers 503 to once, as an overloaded app does. */
const overloadedOnce = new Set<string>();
let door: ReturnType<typeof Bun.serve>;

const objectSchema = (properties: Record<string, unknown>) => ({
  type: "object",
  properties,
  required: Object.keys(properties),
});

beforeAll(async () => {
  await database
    .insert(agents)
    .values({ id: botId, name: botId, type: "remote_ag_ui", configuration: {} })
    .onConflictDoNothing();

  const searchSchema = objectSchema({ query: { type: "string" } });
  const commentSchema = objectSchema({
    issue: { type: "string" },
    text: { type: "string" },
  });
  tracker.addTool({
    name: "search_issues",
    description: "Search issues by keyword.",
    inputSchema: searchSchema,
  });
  tracker.addTool({
    name: "post_comment",
    description: "Comment on an issue.",
    inputSchema: commentSchema,
  });
  tracker.onToolCall("search_issues", async (args) => {
    const query = String((args as { query?: string }).query);
    inFlight++;
    peak = Math.max(peak, inFlight);
    await Bun.sleep(120);
    inFlight--;
    searched.push(query);
    return `Issue EGG-${query.length} matches ${query}.`;
  });
  tracker.onToolCall("post_comment", async (args) => {
    commented.push(String((args as { text?: string }).text));
    return "Commented.";
  });
  const upstream = await tracker.start();

  door = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = request.method === "POST" ? await request.text() : undefined;
      for (const marker of overloadedOnce) {
        if (body?.includes('"tools/call"') && body.includes(marker)) {
          overloadedOnce.delete(marker);
          return new Response("Service Unavailable", { status: 503 });
        }
      }
      const headers = new Headers(request.headers);
      headers.delete("host");
      return fetch(new URL(new URL(request.url).pathname, upstream), {
        method: request.method,
        headers,
        body,
      });
    },
  });

  await database
    .insert(mcpServers)
    .values({
      id: serverId,
      title: "Tracker",
      vendor: "tracker",
      url: `http://127.0.0.1:${door.port}`,
      provenance: "custom",
    })
    .onConflictDoNothing();
  await database
    .insert(mcpTools)
    .values([
      {
        serverId,
        name: "search_issues",
        vendorName: "search_issues",
        description: "Search issues by keyword.",
        inputSchema: searchSchema,
        effect: "read",
      },
      {
        serverId,
        name: "post_comment",
        vendorName: "post_comment",
        description: "Comment on an issue.",
        inputSchema: commentSchema,
        effect: "write",
      },
    ])
    .onConflictDoNothing();
  await store.grant("mcp", `${serverId}/search_issues`, botId, ACTOR);
  await store.grant("mcp", `${serverId}/post_comment`, botId, ACTOR);
});

afterAll(async () => {
  await database.delete(pluginGrants).where(eq(pluginGrants.agentId, botId));
  await database.delete(mcpTools).where(eq(mcpTools.serverId, serverId));
  await database.delete(mcpServers).where(eq(mcpServers.id, serverId));
  await database.delete(agents).where(eq(agents.id, botId));
  door.stop(true);
  await tracker.stop();
  await database.$client.close();
});

type Call = { name: string; args: Record<string, unknown> };
type AbstractAgentLike = Pick<import("@ag-ui/client").AbstractAgent, "run">;
let named: (name: string) => string = (name) => name;

/** One run of a built-in Bot holding the tracker, on a model that asks for `steps` in turn. */
async function run(steps: Call[][]) {
  const llm = new LLMock({ host: "127.0.0.1", port: 0 });
  let step = 0;
  llm.on({ predicate: () => true }, () => {
    const calls = steps[step++];
    return calls
      ? {
          toolCalls: calls.map((call) => ({
            name: named(call.name),
            arguments: JSON.stringify(call.args),
          })),
        }
      : { content: "Done." };
  });
  const original = process.env.OPENAI_BASE_URL;
  process.env.OPENAI_BASE_URL = `${await llm.start()}/v1`;
  // The model calls a tool by the name the Bot is offered it under, which carries its app.
  const offered = (await grantedTools({ store, botId, actorId: ACTOR })).map(
    (tool) => tool.name,
  );
  named = (name) => offered.find((tool) => tool.endsWith(`__${name}`)) ?? name;
  try {
    const built = await buildAgents(
      [{ id: botId, name: "Planner", type: "built_in", systemPrompt: "Plan." }],
      model,
      "synthetic-fixture-key",
      undefined,
      async () => grantedTools({ store, botId, actorId: ACTOR }),
    );
    const agent = built[botId]?.clone();
    if (!agent) throw new Error("The planner was not built.");
    const input: RunAgentInput = {
      threadId: `thread-${randomUUID()}`,
      runId: `run-${randomUUID()}`,
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
    return calls.map((id) => answers.get(id) ?? "");
  } finally {
    if (original === undefined) delete process.env.OPENAI_BASE_URL;
    else process.env.OPENAI_BASE_URL = original;
    await llm.stop();
  }
}

const search = (query: string): Call => ({
  name: "search_issues",
  args: { query },
});

test("20 lookups sent at once run a few at a time, and every one is answered", async () => {
  searched.length = 0;
  peak = 0;
  const queries = Array.from({ length: 20 }, (_, index) => `topic ${index}`);

  const answers = await run([queries.map(search)]);

  expect(answers).toHaveLength(20);
  for (const [index, query] of queries.entries())
    expect(answers[index]).toContain(`matches ${query}.`);
  expect(searched.toSorted()).toEqual(queries.toSorted());
  expect(peak).toBeLessThanOrEqual(MAX_APP_CALLS_AT_ONCE);
}, 30_000);

test("a read asked for again in the run is answered from the first, and a write is done each time", async () => {
  searched.length = 0;
  commented.length = 0;
  const comment: Call = {
    name: "post_comment",
    args: { issue: "EGG-1", text: "Ranked first" },
  };

  const answers = await run([
    [search("Monaco"), search("Monaco"), comment, comment],
    [{ name: "search_issues", args: { query: "Monaco" } }],
  ]);

  // The tracker was asked once; both repeats carry its answer, marked as already fetched.
  expect(searched).toEqual(["Monaco"]);
  const [first, second, , , third] = answers;
  expect(first).toContain("matches Monaco.");
  expect(first).not.toContain(ALREADY_FETCHED);
  for (const repeat of [second, third]) {
    expect(repeat).toContain(ALREADY_FETCHED);
    expect(repeat).toContain("matches Monaco.");
  }
  // A write asked twice is done twice: whether that was meant is the Bot's to know.
  expect(commented).toEqual(["Ranked first", "Ranked first"]);
}, 30_000);

test("a read the app answers 503 to is tried again before the Bot hears of it, and a write is not", async () => {
  searched.length = 0;
  commented.length = 0;
  overloadedOnce.add("flaky read");
  overloadedOnce.add("flaky write");
  const tools = await grantedTools({ store, botId, actorId: ACTOR });
  const read = tools.find((tool) => tool.name.endsWith("search_issues"));
  const write = tools.find((tool) => tool.name.endsWith("post_comment"));
  if (!read || !write) throw new Error("The tracker's tools were not granted.");

  expect(await read.execute({ query: "flaky read" })).toContain(
    "matches flaky read.",
  );
  expect(searched).toEqual(["flaky read"]);

  const wrote = await write.execute({ issue: "EGG-2", text: "flaky write" });
  expect(wrote).toContain("That tool could not be called");
  expect(commented).toEqual([]);
}, 30_000);

test("a subagent's lookups share the run's few-at-a-time, so two of them never double it", async () => {
  searched.length = 0;
  peak = 0;
  const llm = new LLMock({ host: "127.0.0.1", port: 0 });
  const userText = (request: {
    messages: { role: string; content?: unknown }[];
  }) =>
    String(
      request.messages.find((message) => message.role === "user")?.content ??
        "",
    );
  const answered = (request: { messages: { role: string }[] }) =>
    request.messages.some((message) => message.role === "tool");
  llm.on({ predicate: () => true }, (request) => {
    if (answered(request)) return { content: "Done." };
    const part = /^part (\w+)$/.exec(userText(request))?.[1];
    // Each part, as a subagent, sends ten lookups at once.
    if (part)
      return {
        toolCalls: Array.from({ length: 10 }, (_, index) => ({
          name: named("search_issues"),
          arguments: JSON.stringify({ query: `${part} ${index}` }),
        })),
      };
    // The run itself splits the work in two, at the same time, as a Bot does with run_subagent.
    return {
      toolCalls: ["one", "two"].map((part) => ({
        name: SUBAGENT_TOOL,
        arguments: JSON.stringify({ part }),
      })),
    };
  });
  const original = process.env.OPENAI_BASE_URL;
  process.env.OPENAI_BASE_URL = `${await llm.start()}/v1`;
  const offered = (await grantedTools({ store, botId, actorId: ACTOR })).map(
    (tool) => tool.name,
  );
  named = (name) => offered.find((tool) => tool.endsWith(`__${name}`)) ?? name;
  const loadTools = async () => grantedTools({ store, botId, actorId: ACTOR });
  const bot = {
    id: botId,
    name: "Planner",
    type: "built_in" as const,
    systemPrompt: "Plan.",
  };
  const runOnce = async (agent: AbstractAgentLike, text: string) =>
    new Promise<void>((resolve, reject) =>
      agent
        .run({
          threadId: `thread-${randomUUID()}`,
          runId: `run-${randomUUID()}`,
          messages: [{ id: "user", role: "user", content: text }],
          tools: [],
          context: [],
          state: {},
          forwardedProps: {},
        })
        .subscribe({ next: () => {}, error: reject, complete: resolve }),
    );
  /*
   * A subagent: the same Bot built afresh and run on its part, from inside the run's own tool call,
   * which is how `agents/subagent.ts` starts one.
   */
  const splitWork: GrantedTool = {
    name: SUBAGENT_TOOL,
    ref: `bot/${SUBAGENT_TOOL}`,
    description: "Hand one part to a subagent.",
    parameters: z.object({ part: z.string() }),
    concurrent: true,
    execute: async (args) => {
      const built = await buildAgents(
        [bot],
        model,
        "synthetic-fixture-key",
        undefined,
        loadTools,
      );
      const child = built[botId]?.clone();
      if (!child) throw new Error("The subagent was not built.");
      await runOnce(child, `part ${(args as { part: string }).part}`);
      return "Part done.";
    },
  };
  try {
    const built = await buildAgents(
      [bot],
      model,
      "synthetic-fixture-key",
      undefined,
      loadTools,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      async () => [splitWork],
    );
    const agent = built[botId]?.clone();
    if (!agent) throw new Error("The planner was not built.");
    await runOnce(agent, "Plan the cycle.");
  } finally {
    if (original === undefined) delete process.env.OPENAI_BASE_URL;
    else process.env.OPENAI_BASE_URL = original;
    await llm.stop();
  }

  expect(searched).toHaveLength(20);
  expect(peak).toBeLessThanOrEqual(MAX_APP_CALLS_AT_ONCE);
}, 30_000);
