import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { randomUUID } from "node:crypto";
import type { Message } from "@ag-ui/client";
import { type ChatCompletionRequest, LLMock } from "@copilotkit/aimock";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  readSubagentResult,
  SUBAGENT_TOOL,
  type SubagentResult,
  subagentThreadId,
} from "@openbot/shared/subagent";
import type { RunnerLike } from "@openbot/toolkit/run-turn";
import { and, eq, inArray } from "drizzle-orm";
import { Observable } from "rxjs";
import { z } from "zod";
import { createActorAgentResolver } from "../src/agents/agent-resolver";
import { createSubagents, SUBAGENT_HANDED_BACK } from "../src/agents/subagent";
import { serverTurnAdmission } from "../src/agents/turn-admission";
import { createApprovalService } from "../src/approvals/service";
import { createApprovalStore } from "../src/approvals/store";
import { createAuditStore, PERSON_INITIATOR } from "../src/audit";
import { type RegisteredAgent, registeredAgentFromRow } from "../src/copilot";
import { createCredentialStore } from "../src/credentials";
import { createDatabase } from "../src/db/client";
import {
  agents,
  approvalPreferences,
  approvalRequests,
  mcpServers,
  mcpTools,
  pluginGrants,
  users,
  workItems,
} from "../src/db/schema";
import { createPluginStore } from "../src/plugins/store";
import { grantedTools, REFUSAL_MARKER } from "../src/plugins/tools";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * A Bot giving part of its work to a subagent, through the real path a person's chat turn takes: real
 * Postgres, the real resolver building the real built-in Bot, the real plugin store calling a real MCP
 * server (the official SDK) over the MCP transport, the real approval gate and store, and the real
 * headless turn runner a subagent runs as. A remote Bot is a real AG-UI endpoint over HTTP. The model
 * is the only fake: `@copilotkit/aimock`, scripted as a model would call the tools, behind a relay that
 * ends each response a moment after its last event, as a real provider does (see `NativeRunScope` in
 * toolkit/src/native-approval.ts for why that matters).
 *
 * The platform the turn runner drives is the narrow port it declares (`IntelligenceLike`,
 * `RunnerLike`), answered in memory the way the repo's other headless-turn tests answer it, and the
 * deployment is wired the way `server/src/index.ts` wires it.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = randomUUID().slice(0, 8);
const person = `subagent-person-${suite}`;
const botId = `subagent-bot-${suite}`;
const remoteId = `subagent-remote-${suite}`;
const SERVER = `notes_${suite}`;
const SEARCH = "search_notes";
const POST = "post_note";
/** On the same server, and never granted to the Bot. */
const UNGRANTED = "delete_everything";
const modelName = (tool: string) => `mcp__${SERVER}__${tool}`;
const ROLE = "Answer from the team's notes.";

/* ------------------------------------------------------------------------------------------------
 * The app: one MCP server process, built with the official SDK.
 * ---------------------------------------------------------------------------------------------- */

const vendorCalls: { tool: string; args: Record<string, unknown> }[] = [];
/** How many searches are being answered at once, and the most there ever were. */
const searching = { now: 0, most: 0, until: 1 };
/** A search that holds until the test lets it go. */
const slow = (() => {
  let reached = () => {};
  let release = () => {};
  let released = Promise.resolve();
  return {
    arm() {
      const arrived = new Promise<void>((resolve) => {
        reached = resolve;
      });
      released = new Promise<void>((resolve) => {
        release = resolve;
      });
      return arrived;
    },
    reached: () => reached(),
    released: () => released,
    release: () => release(),
  };
})();

async function waitFor(condition: () => boolean, ms = 3000) {
  const deadline = Date.now() + ms;
  while (!condition() && Date.now() < deadline) await Bun.sleep(10);
}

function notesServer() {
  const mcp = new McpServer({ name: "notes", version: "1.0.0" });
  mcp.registerTool(
    SEARCH,
    {
      description: "Search the team's notes.",
      inputSchema: { query: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ query }) => {
      vendorCalls.push({ tool: SEARCH, args: { query } });
      searching.now += 1;
      searching.most = Math.max(searching.most, searching.now);
      if (query === "slow") {
        slow.reached();
        await slow.released();
      }
      // Held until as many searches as the test expects are in at once, so one at a time shows.
      await waitFor(() => searching.most >= searching.until);
      searching.now -= 1;
      return {
        content: [{ type: "text", text: `Found one note about ${query}.` }],
      };
    },
  );
  mcp.registerTool(
    POST,
    {
      description: "Post a note the whole team reads.",
      inputSchema: { text: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async ({ text }) => {
      vendorCalls.push({ tool: POST, args: { text } });
      return { content: [{ type: "text", text: "Posted." }] };
    },
  );
  return mcp;
}

let app: ReturnType<typeof Bun.serve> | undefined;

/* ------------------------------------------------------------------------------------------------
 * The model: aimock, scripted, behind a relay that ends each response as a real provider does.
 * ---------------------------------------------------------------------------------------------- */

const llm = new LLMock({ host: "127.0.0.1", port: 0 });
let relay: ReturnType<typeof Bun.serve> | undefined;
type Reply = {
  content?: string;
  toolCalls?: { name: string; arguments: string }[];
};
const requests: ChatCompletionRequest[] = [];
let script: (request: ChatCompletionRequest) => Reply | Promise<Reply> =
  () => ({
    content: "Done.",
  });

const text = (message: ChatCompletionRequest["messages"][number]) =>
  typeof message.content === "string"
    ? message.content
    : JSON.stringify(message.content);
/** A subagent's run starts from its framed task, which is the only thing it is told. */
const isSubagent = (request: ChatCompletionRequest) =>
  request.messages.some(
    (message) =>
      message.role === "user" && text(message).startsWith("You are a subagent"),
  );
const taskOf = (request: ChatCompletionRequest) =>
  /Task: (.*)/.exec(
    request.messages.map(text).find((line) => line.includes("Task: ")) ?? "",
  )?.[1] ?? "";
const toolResults = (request: ChatCompletionRequest) =>
  request.messages.filter((message) => message.role === "tool").map(text);
const offered = (request: ChatCompletionRequest) =>
  (request.tools ?? []).map((tool) => tool.function.name);
const subagentRequests = () => requests.filter(isSubagent);
const parentRequests = () => requests.filter((request) => !isSubagent(request));
const resultsIn = (request: ChatCompletionRequest | undefined) =>
  (request ? toolResults(request) : [])
    .map((content) => readSubagentResult(content))
    .filter((result): result is SubagentResult => result !== null);

const subagentCall = (task: string, answer = "One sentence.") => ({
  name: SUBAGENT_TOOL,
  arguments: JSON.stringify({ task, answer }),
});

const realFetch = globalThis.fetch;
let environmentBefore: Record<string, string | undefined> = {};

/* ------------------------------------------------------------------------------------------------
 * One deployment, wired the way `server/src/index.ts` wires it.
 * ---------------------------------------------------------------------------------------------- */

const approvalStore = createApprovalStore(database);
const approvalService = createApprovalService(approvalStore);
const plugins = createPluginStore({
  brokerProvider: "composio",
  database,
  auditStore: createAuditStore(database),
  credentials: createCredentialStore(database),
  encryptionKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
  approvalGate: approvalService.gate,
});

/** The threads the platform was asked for, and what each already holds. */
const threads = new Map<string, { userId: string; agentId: string }>();
const histories = new Map<string, Message[]>();
const released: string[] = [];
const stopped: string[] = [];
const intelligence = {
  getOrCreateThread: async (input: {
    threadId: string;
    userId: string;
    agentId: string;
  }) => {
    threads.set(input.threadId, {
      userId: input.userId,
      agentId: input.agentId,
    });
  },
  getThreadMessages: async ({ threadId }: { threadId: string }) => ({
    messages: (histories.get(threadId) ?? []).map((message) => ({
      id: message.id,
      role: message.role,
      content: "content" in message ? message.content : "",
    })),
  }),
  ɵacquireThreadLock: async () => undefined,
  ɵrenewThreadLock: async () => undefined,
  ɵcleanupThreadLock: async ({ threadId }: { threadId: string }) => {
    released.push(threadId);
  },
};
const runner: RunnerLike = {
  run: ({ agent, input }) =>
    new Observable((subscriber) => {
      agent
        .runAgent(input, { onEvent: ({ event }) => subscriber.next(event) })
        .then(
          () => subscriber.complete(),
          (error) => subscriber.error(error),
        );
    }),
  stop: async ({ threadId }) => {
    stopped.push(threadId);
    return true;
  },
};

const roster = new Map<string, RegisteredAgent>();
const subagents = createSubagents({
  turn: { admission: serverTurnAdmission, intelligence, runner },
  buildAgentFor: ({ ownerUserId, agentId, initiator, depth }) =>
    resolver.resolveAgentForActor({ id: ownerUserId, role: "user" }, agentId, {
      initiator,
      ...(depth ? { depth } : {}),
      subagent: true,
    }),
  withdrawApprovals: async (ownerUserId, runId) =>
    approvalStore.policy?.withdrawPending(
      ownerUserId,
      SUBAGENT_HANDED_BACK,
      (action) => action.runId === runId,
      { resume: false },
    ),
});
const resolver = createActorAgentResolver({
  loadAgents: async () => [...roster.values()],
  model: { provider: "openai", defaultModel: "gpt-5.5" },
  resolveModelApiKey: async () => "test-key",
  loadToolsForActor: (actorId, initiator) => (bot) =>
    grantedTools({
      store: plugins,
      botId: bot,
      actorId,
      ...(initiator ? { initiator } : {}),
    }),
  handoffForActor: (actorId, initiator, depth) => async (bot, input) => [
    subagents.toolForRun({
      actorId,
      botId: bot,
      threadId: input.threadId,
      initiator: initiator ?? PERSON_INITIATOR,
      ...(depth ? { depth } : {}),
    }),
  ],
});

/** The person's own chat turn: their message, in their conversation with the Bot. */
const parentThread = `subagent-parent-${suite}`;
async function ask(
  said: string,
  options: {
    bot?: string;
    history?: Message[];
    onAgent?: (agent: { abortRun(): void }) => void;
  } = {},
) {
  const { bot = botId, history = [], onAgent } = options;
  const agent = await resolver.resolveAgentForActor(
    { id: person, role: "user" },
    bot,
  );
  onAgent?.(agent);
  agent.threadId = parentThread;
  const messages: Message[] = [
    ...history,
    { id: randomUUID(), role: "user", content: said },
  ];
  histories.set(parentThread, messages);
  agent.setMessages(messages);
  return agent.runAgent({ runId: randomUUID() });
}

/* ------------------------------------------------------------------------------------------------
 * A remote Bot: a real AG-UI endpoint over HTTP, which hands two parts to subagents at once.
 * ---------------------------------------------------------------------------------------------- */

type AgUiRequest = {
  threadId: string;
  runId: string;
  messages: { role: string; content?: unknown }[];
  tools: { name: string }[];
};
const remoteRequests: AgUiRequest[] = [];
const remoteSubagents = { now: 0, most: 0 };
let endpoint: ReturnType<typeof Bun.serve> | undefined;

function sse(events: Record<string, unknown>[]) {
  return new Response(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}

/** One run that says one thing. */
function saying(body: AgUiRequest, words: string) {
  const run = { threadId: body.threadId, runId: body.runId };
  const messageId = randomUUID();
  return [
    { type: "RUN_STARTED", ...run },
    { type: "TEXT_MESSAGE_START", messageId, role: "assistant" },
    { type: "TEXT_MESSAGE_CONTENT", messageId, delta: words },
    { type: "TEXT_MESSAGE_END", messageId },
    { type: "RUN_FINISHED", ...run },
  ];
}

/* ------------------------------------------------------------------------------------------------
 * Setup and teardown.
 * ---------------------------------------------------------------------------------------------- */

beforeAll(async () => {
  llm.on({ predicate: () => true }, async (request) => {
    requests.push(request);
    return script(request);
  });
  const model = await llm.start();
  relay = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const answered = await realFetch(
        new URL(`${url.pathname}${url.search}`, model),
        {
          method: request.method,
          headers: request.headers,
          body: await request.text(),
        },
      );
      const body = answered.body?.getReader();
      return new Response(
        body
          ? new ReadableStream({
              async pull(controller) {
                const { done, value } = await body.read();
                if (!done) return controller.enqueue(value);
                // The connection ends a moment after the last event, as a real provider's does.
                await Bun.sleep(25);
                controller.close();
              },
            })
          : null,
        { status: answered.status, headers: answered.headers },
      );
    },
  });
  app = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      await notesServer().connect(transport);
      return transport.handleRequest(request);
    },
  });
  endpoint = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as AgUiRequest;
      remoteRequests.push(body);
      const asked = body.messages.map((message) =>
        typeof message.content === "string" ? message.content : "",
      );
      const task = asked.find((content) =>
        content.startsWith("You are a subagent"),
      );
      if (task) {
        // Held until both parts are being worked on at once, so running them one after another shows.
        remoteSubagents.now += 1;
        remoteSubagents.most = Math.max(
          remoteSubagents.most,
          remoteSubagents.now,
        );
        await waitFor(() => remoteSubagents.most >= 2);
        remoteSubagents.now -= 1;
        return sse(
          saying(body, `Remote answer: ${/Task: (.*)/.exec(task)?.[1]}`),
        );
      }
      if (body.messages.some((message) => message.role === "tool"))
        return sse(saying(body, "Both parts are done."));
      const run = { threadId: body.threadId, runId: body.runId };
      return sse([
        { type: "RUN_STARTED", ...run },
        ...["Part A", "Part B"].flatMap((part, index) => [
          {
            type: "TOOL_CALL_START",
            toolCallId: `remote-call-${index}`,
            toolCallName: SUBAGENT_TOOL,
            parentMessageId: "remote-message",
          },
          {
            type: "TOOL_CALL_ARGS",
            toolCallId: `remote-call-${index}`,
            delta: JSON.stringify({ task: part, answer: "One line." }),
          },
          { type: "TOOL_CALL_END", toolCallId: `remote-call-${index}` },
        ]),
        { type: "RUN_FINISHED", ...run },
      ]);
    },
  });

  environmentBefore = {
    OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  };
  process.env.OPENAI_BASE_URL = `http://127.0.0.1:${relay.port}/v1`;
  process.env.OPENAI_API_KEY = "test-key";

  await database
    .insert(users)
    .values({ id: person, email: `${person}@example.test`, name: "Dana" });
  await database
    .insert(agents)
    .values({ id: botId, name: "Notes", type: "built_in", configuration: {} });
  await database.insert(mcpServers).values({
    id: SERVER,
    title: "Notes",
    vendor: "Notes",
    url: `http://127.0.0.1:${app.port}/mcp`,
    provenance: "custom",
  });
  await database.insert(mcpTools).values([
    {
      serverId: SERVER,
      name: SEARCH,
      vendorName: SEARCH,
      description: "Search the team's notes.",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
      effect: "read",
      declaredRead: true,
    },
    {
      serverId: SERVER,
      name: POST,
      vendorName: POST,
      description: "Post a note the whole team reads.",
      inputSchema: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
      },
      effect: "write",
      destructive: true,
    },
    {
      serverId: SERVER,
      name: UNGRANTED,
      vendorName: UNGRANTED,
      description: "Delete every note.",
      inputSchema: { type: "object", properties: {} },
      effect: "write",
      destructive: true,
    },
  ]);
  await database.insert(pluginGrants).values(
    [SEARCH, POST].map((tool) => ({
      kind: "mcp" as const,
      ref: `${SERVER}/${tool}`,
      agentId: botId,
    })),
  );
  roster.set(botId, {
    id: botId,
    name: "Notes",
    type: "built_in",
    systemPrompt: ROLE,
  });
  const remote = registeredAgentFromRow({
    id: remoteId,
    name: "Remote Notes",
    type: "remote_ag_ui",
    configuration: { endpoint: `http://127.0.0.1:${endpoint.port}/ag-ui` },
    title: "Notes",
    roleDescription: ROLE,
  });
  if (!remote) throw new Error("The remote Bot did not register.");
  roster.set(remoteId, remote);
});

beforeEach(async () => {
  requests.length = 0;
  vendorCalls.length = 0;
  threads.clear();
  released.length = 0;
  stopped.length = 0;
  searching.now = 0;
  searching.most = 0;
  searching.until = 1;
  script = () => ({ content: "Done." });
  await database
    .delete(approvalPreferences)
    .where(eq(approvalPreferences.ownerUserId, person));
});

afterAll(async () => {
  try {
    await llm.stop();
    relay?.stop(true);
    app?.stop(true);
    endpoint?.stop(true);
  } finally {
    globalThis.fetch = realFetch;
    for (const [name, value] of Object.entries(environmentBefore)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
  const opened = await database
    .select({ id: approvalRequests.id })
    .from(approvalRequests)
    .where(eq(approvalRequests.ownerUserId, person));
  if (opened.length)
    await database.delete(workItems).where(
      and(
        eq(workItems.kind, "approval.resume"),
        inArray(
          workItems.key,
          opened.map((row) => row.id),
        ),
      ),
    );
  await database.delete(pluginGrants).where(eq(pluginGrants.agentId, botId));
  await database.delete(mcpTools).where(eq(mcpTools.serverId, SERVER));
  await database.delete(mcpServers).where(eq(mcpServers.id, SERVER));
  await database.delete(agents).where(eq(agents.id, botId));
  await database.delete(users).where(eq(users.id, person));
  await database.$client.close();
});

/* ------------------------------------------------------------------------------------------------
 * The cases.
 * ---------------------------------------------------------------------------------------------- */

describe("a Bot gives part of its work to a subagent", () => {
  test("the subagent is the same Bot, as the same person, with the same tools and nothing else; it starts from the task alone, and only its answer comes back", async () => {
    script = (request) => {
      if (isSubagent(request))
        return toolResults(request).length === 0
          ? {
              toolCalls: [
                {
                  name: modelName(SEARCH),
                  arguments: JSON.stringify({ query: "expenses" }),
                },
              ],
            }
          : { content: "Meals under $75 need no receipt." };
      return toolResults(request).length === 0
        ? {
            toolCalls: [
              subagentCall("Find what the notes say about expenses."),
            ],
          }
        : { content: "Meals under $75 need no receipt, says the policy." };
    };

    await ask("What is our expense rule?", {
      history: [
        { id: randomUUID(), role: "user", content: "My locker code is 4417." },
        { id: randomUUID(), role: "assistant", content: "Noted." },
      ],
    });

    const [sub] = subagentRequests();
    if (!sub) throw new Error("No subagent ran.");
    // The same Bot: its role and its granted tools, and none it was not granted.
    expect(
      text(sub.messages[0] ?? { role: "system", content: "" }),
    ).toStartWith(ROLE);
    expect(offered(sub)).toContain(modelName(SEARCH));
    expect(offered(sub)).toContain(modelName(POST));
    expect(offered(sub)).not.toContain(modelName(UNGRANTED));
    // No nesting, and no reaching past itself.
    for (const name of [SUBAGENT_TOOL, "message_bot", "ask_person"])
      expect(offered(sub)).not.toContain(name);
    // Its context is the task alone: none of the conversation it was started from.
    expect(
      sub.messages.filter((message) => message.role === "user"),
    ).toHaveLength(1);
    expect(JSON.stringify(sub.messages)).not.toContain("4417");
    expect(JSON.stringify(sub.messages)).not.toContain(
      "What is our expense rule?",
    );
    // A granted tool is callable: the call reached the app.
    expect(vendorCalls).toEqual([
      { tool: SEARCH, args: { query: "expenses" } },
    ]);

    // Its own thread, as the same person and the same Bot.
    const parentCall = parentRequests()[0]?.messages;
    const [answered] = resultsIn(parentRequests()[1]);
    if (!answered || !("answer" in answered))
      throw new Error("The parent was not handed an answer.");
    expect(threads.get(answered.threadId)).toEqual({
      userId: person,
      agentId: botId,
    });
    expect(answered.threadId).not.toBe(parentThread);
    expect(parentCall).toBeDefined();
    // Only the answer comes back: not the subagent's search, nor what the app returned.
    expect(answered).toMatchObject({
      answer: "Meals under $75 need no receipt.",
      steps: 1,
    });
    const back = JSON.stringify(parentRequests()[1]?.messages);
    expect(back).not.toContain("Found one note");
    expect(back).not.toContain(modelName(SEARCH));
    // The parent was offered the tool; the thread is the one the browser derives for the call.
    expect(offered(parentRequests()[0] as ChatCompletionRequest)).toContain(
      SUBAGENT_TOOL,
    );
    const callId = (parentRequests()[1]?.messages ?? [])
      .flatMap((message) => message.tool_calls ?? [])
      .find((call) => call.function.name === SUBAGENT_TOOL)?.id;
    expect(answered.threadId).toBe(
      await subagentThreadId(parentThread, callId ?? ""),
    );
    expect(released).toContain(answered.threadId);
  }, 30_000);

  test("subagents called in one step run at the same time, and the sixth in one answer is refused", async () => {
    searching.until = 5;
    script = (request) => {
      if (isSubagent(request))
        return toolResults(request).length === 0
          ? {
              toolCalls: [
                {
                  name: modelName(SEARCH),
                  arguments: JSON.stringify({ query: taskOf(request) }),
                },
              ],
            }
          : { content: `Answer for ${taskOf(request)}` };
      return toolResults(request).length === 0
        ? {
            toolCalls: [1, 2, 3, 4, 5, 6].map((part) =>
              subagentCall(`Part ${part}`),
            ),
          }
        : { content: "All parts are in." };
    };

    await ask("Do all six parts.");

    // Five searches were in at once; one at a time, the most would have been one.
    expect(searching.most).toBe(5);
    const back = parentRequests()[1];
    expect(
      resultsIn(back)
        .map((result) => "answer" in result && result.answer)
        .sort(),
    ).toEqual([1, 2, 3, 4, 5].map((part) => `Answer for Part ${part}`));
    const refused = (back ? toolResults(back) : []).filter((content) =>
      content.includes(REFUSAL_MARKER),
    );
    expect(refused).toHaveLength(1);
    expect(refused[0]).toContain("up to 5 subagents");
    expect(
      subagentRequests().filter((request) => toolResults(request).length === 0),
    ).toHaveLength(5);
  }, 30_000);

  test("an action that needs the person's yes is handed back with its request withdrawn, and the Bot asks for it in the conversation", async () => {
    await approvalStore.setEnabled(person, true);
    const note = { text: "The expense policy changed." };
    script = (request) => {
      if (isSubagent(request))
        return {
          toolCalls: [
            { name: modelName(POST), arguments: JSON.stringify(note) },
          ],
        };
      const [handed] = resultsIn(request);
      if (!handed)
        return { toolCalls: [subagentCall("Post a note about the change.")] };
      // The Bot does what was handed back itself, in the conversation, where the person is asked.
      return handed &&
        "handedBack" in handed &&
        toolResults(request).length === 1
        ? {
            toolCalls: [
              {
                name: handed.handedBack.tool,
                arguments: JSON.stringify(handed.handedBack.args),
              },
            ],
          }
        : { content: "Waiting for you." };
    };

    await ask("Tell the team the expense policy changed.");

    const [handed] = resultsIn(parentRequests()[1]);
    if (!handed || !("handedBack" in handed))
      throw new Error("Nothing was handed back.");
    expect(handed.handedBack).toMatchObject({
      tool: modelName(POST),
      args: note,
    });
    // Nothing was done, by either of them, while nobody had said yes.
    expect(vendorCalls).toEqual([]);

    const opened = await database
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.ownerUserId, person));
    const subagents = opened.filter(
      (row) => row.action.threadId === handed.threadId,
    );
    const conversation = opened.filter(
      (row) => row.action.threadId === parentThread,
    );
    // The subagent's request is withdrawn, so the person is not asked twice, and nothing resumes it.
    expect(subagents).toHaveLength(1);
    expect(subagents[0]).toMatchObject({
      status: "denied",
      result: { error: SUBAGENT_HANDED_BACK },
    });
    const resumed = await database
      .select()
      .from(workItems)
      .where(
        and(
          eq(workItems.kind, "approval.resume"),
          eq(workItems.key, subagents[0]?.id ?? ""),
        ),
      );
    expect(resumed).toEqual([]);
    // The person is asked once, in their own conversation, through the ordinary approval.
    expect(conversation).toHaveLength(1);
    expect(conversation[0]).toMatchObject({
      status: "pending",
      action: { toolRef: `${SERVER}/${POST}` },
    });
  }, 30_000);

  test("stopping the Bot's turn stops the subagent it is waiting on", async () => {
    const reached = slow.arm();
    script = (request) => {
      if (isSubagent(request))
        return toolResults(request).length === 0
          ? {
              toolCalls: [
                {
                  name: modelName(SEARCH),
                  arguments: JSON.stringify({ query: "slow" }),
                },
              ],
            }
          : { content: "Too late." };
      return toolResults(request).length === 0
        ? { toolCalls: [subagentCall("Search slowly.")] }
        : { content: "Done." };
    };
    let parent: { abortRun(): void } | undefined;
    const turn = ask("Search slowly.", {
      onAgent: (agent) => {
        parent = agent;
      },
    }).catch(() => undefined);
    await reached;
    const sub = [...threads.keys()].find((id) => id !== parentThread);
    parent?.abortRun();
    await turn;
    slow.release();
    await Bun.sleep(100);

    expect(sub).toBeDefined();
    // The subagent's own run was stopped, and its conversation given back.
    expect(stopped).toContain(sub as string);
    expect(released).toContain(sub as string);
    // It never went on to answer.
    expect(
      subagentRequests().filter((request) => toolResults(request).length > 0),
    ).toEqual([]);
  }, 30_000);

  test("a remote AG-UI agent calls it like any granted tool and gets the answers through the middleware", async () => {
    remoteRequests.length = 0;
    remoteSubagents.now = 0;
    remoteSubagents.most = 0;

    await ask("Split this in two.", { bot: remoteId });

    const [first] = remoteRequests;
    expect(first?.tools.map((tool) => tool.name)).toContain(SUBAGENT_TOOL);
    const subs = remoteRequests.filter((body) =>
      body.messages.some(
        (message) =>
          typeof message.content === "string" &&
          message.content.startsWith("You are a subagent"),
      ),
    );
    // Both parts ran on OpenBot, at the same time, as the same remote Bot with no nesting.
    expect(subs).toHaveLength(2);
    expect(remoteSubagents.most).toBe(2);
    for (const body of subs)
      expect(body.tools.map((tool) => tool.name)).not.toContain(SUBAGENT_TOOL);
    // And the remote Bot was handed the answers, and only the answers.
    const last = remoteRequests.at(-1);
    const answers = (last?.messages ?? [])
      .filter((message) => message.role === "tool")
      .map((message) => readSubagentResult(String(message.content)))
      .map((result) => (result && "answer" in result ? result.answer : null));
    expect(answers.sort()).toEqual([
      "Remote answer: Part A",
      "Remote answer: Part B",
    ]);
  }, 30_000);
});
