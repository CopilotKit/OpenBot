import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { randomUUID } from "node:crypto";
import { type ChatCompletionRequest, LLMock } from "@copilotkit/aimock";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createTurnRunner, type RunnerLike } from "@openbot/toolkit/run-turn";
import { and, eq, inArray, sql } from "drizzle-orm";
import { Observable } from "rxjs";
import { z } from "zod";
import { createActorAgentResolver } from "../src/agents/agent-resolver";
import { createAgentProfileStore } from "../src/agents/profile-store";
import type { AgentActor } from "../src/agents/profile-types";
import { serverTurnAdmission } from "../src/agents/turn-admission";
import { createApprovedActionExecutor } from "../src/approvals/execute";
import { createApprovalResumeTick } from "../src/approvals/resume-sweep";
import { createApprovalService } from "../src/approvals/service";
import { createApprovalStore } from "../src/approvals/store";
import { createAuditStore, PERSON_INITIATOR } from "../src/audit";
import { createChannelStore } from "../src/channels/routes";
import { createThreadIdentity } from "../src/channels/thread-identity";
import type { RegisteredAgent } from "../src/copilot";
import { createCredentialStore, encryptSecret } from "../src/credentials";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  approvalRequests,
  channelMemberships,
  channels,
  credentials,
  mcpServers,
  mcpTools,
  mcpUserCredentials,
  pluginGrants,
  proactiveSettings,
  proactiveSuggestions,
  users,
  workItems,
} from "../src/db/schema";
import { createPluginStore } from "../src/plugins/store";
import {
  grantedTools,
  REFUSAL_MARKER,
  vendorAnswer,
} from "../src/plugins/tools";
import {
  createPrivateShareCheck,
  PRIVATE_SHARE_TOOL_REF,
} from "../src/proactive/private-share";
import { createProactiveStore } from "../src/proactive/store";
import type { ResponsibilityStore } from "../src/responsibilities/types";
import { createTaskRunner } from "../src/tasks/runner";
import { createTaskStore } from "../src/tasks/store";
import { createTaskTurn } from "../src/tasks/turn";
import { createWorkQueue } from "../src/work/queue";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * A task started from a check-in, working with the apps the person connected: it reads their own
 * app without asking, and asks once, Allow once or Deny, before anything else. Driven through the
 * real path a Start takes: real Postgres, the real task runner and work queue, the real turn runner
 * building the real built-in Bot, the real plugin store calling a real MCP server (the official SDK)
 * over the MCP transport, and the real approval gate, private-share check, resume sweep and
 * approved-action executor. The model is the only fake: `@copilotkit/aimock`, scripted as a model
 * would call the tools.
 *
 * THE MODEL'S CONNECTION ENDS AS A REAL PROVIDER'S DOES, a moment after its last event, through a
 * relay in front of the mock. The mock alone closes its response with the last event, and that
 * difference is the whole of how a Bot's tool calls lost their conversation in a real deployment
 * while every test passed: see `openRunOf` in toolkit/src/native-approval.ts.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = randomUUID().slice(0, 8);
/** 32 zero bytes in base64: a real AES-256 key, because the vault is opened for Notion's grant. */
const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const NOTION = "notion";
const EXA = "exa";
/** A request the person was sent, behind a tool Notion has not had reviewed: its server says it reads. */
const GET_REQUEST = "notion-get-request";
/** A reviewed Notion write, and a send to other people. */
const COMMENT = "notion-create-comment";
/** Web search on the deployment's own access: a read in chat, and nobody's own account. */
const SEARCH = "web_search_exa";
const ref = (server: string, tool: string) => `${server}/${tool}`;
const modelName = (server: string, tool: string) => `mcp__${server}__${tool}`;
const refreshToken = `refresh-${suite}`;

const profileStore = createAgentProfileStore(
  database,
  new URL("https://managed.example.test/ag-ui"),
);
const channelStore = createChannelStore(
  database,
  profileStore,
  createThreadIdentity("test-deployment"),
);
const proactive = createProactiveStore(database);
const queue = createWorkQueue(database);
const approvalStore = createApprovalStore(database);
const approvalService = createApprovalService(approvalStore);
const taskStore = createTaskStore(database);
const actorFor = async (id: string): Promise<AgentActor> => ({
  id,
  role: "user",
});

/* ------------------------------------------------------------------------------------------------
 * The apps: one MCP server process answering as Notion and as Exa, built with the official SDK.
 * ---------------------------------------------------------------------------------------------- */

/** Every tool call the server carried out, in order. Notion answers only the person's own token. */
const vendorCalls: { tool: string; args: unknown }[] = [];

function notionServer() {
  const mcp = new McpServer({ name: "notion", version: "1.0.0" });
  mcp.registerTool(
    GET_REQUEST,
    {
      description: "Read one request someone sent the person, by its id.",
      inputSchema: { id: z.string() },
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async ({ id }) => {
      vendorCalls.push({ tool: GET_REQUEST, args: { id } });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              id,
              from: "Sam",
              text: "Can you send the spec by Friday?",
            }),
          },
        ],
      };
    },
  );
  mcp.registerTool(
    COMMENT,
    {
      description: "Reply on a request with a comment the sender reads.",
      inputSchema: { page_id: z.string(), text: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async (args) => {
      vendorCalls.push({ tool: COMMENT, args });
      return { content: [{ type: "text", text: "Comment posted." }] };
    },
  );
  return mcp;
}
function exaServer() {
  const mcp = new McpServer({ name: "exa", version: "1.0.0" });
  mcp.registerTool(
    SEARCH,
    {
      description: "Search the web.",
      inputSchema: { query: z.string() },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      vendorCalls.push({ tool: SEARCH, args });
      return {
        content: [{ type: "text", text: "Spec templates, three results." }],
      };
    },
  );
  return mcp;
}

let apps: ReturnType<typeof Bun.serve> | undefined;
async function answerMcp(request: Request, server: McpServer) {
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  return transport.handleRequest(request);
}

/* ------------------------------------------------------------------------------------------------
 * The model: aimock, scripted, behind a relay that ends each response as a real provider does.
 * ---------------------------------------------------------------------------------------------- */

const llm = new LLMock({ host: "127.0.0.1", port: 0 });
let relay: ReturnType<typeof Bun.serve> | undefined;
/** What the model does next, given the conversation it was sent. */
let script: (request: ChatCompletionRequest) => {
  content?: string;
  toolCalls?: { name: string; arguments: string }[];
} = () => ({ content: "Done." });
const lastAsk = (request: ChatCompletionRequest) => {
  const asked = request.messages.filter((message) => message.role === "user");
  const content = asked.at(-1)?.content;
  return typeof content === "string" ? content : JSON.stringify(content);
};
/** How many tool results follow the person's last message. */
const answeredSinceAsk = (request: ChatCompletionRequest) => {
  const last = request.messages.findLastIndex(
    (message) => message.role === "user",
  );
  return request.messages
    .slice(last + 1)
    .filter((message) => message.role === "tool").length;
};

const realFetch = globalThis.fetch;
let environmentBefore: Record<string, string | undefined> = {};

beforeAll(async () => {
  llm.on({ predicate: () => true }, (request) => script(request));
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
  apps = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/notion/mcp") {
        if (
          request.headers.get("authorization") !==
          `Bearer access-for-${refreshToken}`
        )
          return new Response("Unauthorized", { status: 401 });
        return answerMcp(request, notionServer());
      }
      if (url.pathname === "/exa/mcp") return answerMcp(request, exaServer());
      return new Response("Not found", { status: 404 });
    },
  });
  const appsAt = `http://127.0.0.1:${apps.port}`;
  // The vendors' pinned hosts, answered by the local server; everything else goes where it was sent.
  const local = new Map([
    ["https://mcp.notion.com/mcp", `${appsAt}/notion/mcp`],
    ["https://mcp.exa.ai/mcp", `${appsAt}/exa/mcp`],
  ]);
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const target = String(input instanceof Request ? input.url : input);
    const answeredAt = local.get(target);
    if (!answeredAt) return realFetch(input, init);
    return input instanceof Request
      ? realFetch(new Request(answeredAt, input), init)
      : realFetch(answeredAt, init);
  }) as typeof fetch;

  environmentBefore = {
    OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  };
  process.env.OPENAI_BASE_URL = `http://127.0.0.1:${relay.port}/v1`;
  process.env.OPENAI_API_KEY = "test-key";
  await fixtures.install();
});

/* ------------------------------------------------------------------------------------------------
 * The person's connections and grants, borrowed rows put back afterwards.
 * ---------------------------------------------------------------------------------------------- */

const people: string[] = [];
const bots: string[] = [];

const fixtures = (() => {
  const createdServers: string[] = [];
  const createdTools: { serverId: string; name: string }[] = [];
  const createdCredentials: string[] = [];
  let notionClientBefore: string | null | undefined;

  async function server(row: typeof mcpServers.$inferInsert) {
    const inserted = await database
      .insert(mcpServers)
      .values(row)
      .onConflictDoNothing()
      .returning({ id: mcpServers.id });
    if (inserted.length) createdServers.push(row.id);
  }
  async function tool(row: typeof mcpTools.$inferInsert) {
    const inserted = await database
      .insert(mcpTools)
      .values({ vendorName: row.name, inputSchema: {}, ...row })
      .onConflictDoNothing()
      .returning({ name: mcpTools.name });
    if (inserted.length)
      createdTools.push({ serverId: row.serverId, name: row.name });
  }
  async function secret(
    row: Omit<typeof credentials.$inferInsert, "encryptedValue">,
    value: string,
  ) {
    const [stored] = await database
      .insert(credentials)
      .values({ ...row, encryptedValue: await encryptSecret(KEY, value) })
      .returning({ id: credentials.id });
    if (!stored) throw new Error("credential was not stored");
    createdCredentials.push(stored.id);
    return stored.id;
  }
  return {
    async install() {
      await server({
        id: NOTION,
        title: "Notion",
        vendor: "Notion",
        url: "https://mcp.notion.com/mcp",
        provenance: "first-party",
      });
      await server({
        id: EXA,
        title: "Exa Search",
        vendor: "Exa",
        url: "https://mcp.exa.ai/mcp",
        provenance: "first-party",
      });
      const [notion] = await database
        .select({ credentialId: mcpServers.credentialId })
        .from(mcpServers)
        .where(eq(mcpServers.id, NOTION));
      notionClientBefore = notion?.credentialId ?? null;
      const client = await secret(
        {
          kind: "mcp_oauth_client",
          provider: NOTION,
          keyId: `oauth-client-tasks-${suite}`,
          metadata: { clientId: `client-${suite}` },
        },
        JSON.stringify({ clientId: `client-${suite}`, clientSecret: "" }),
      );
      await database
        .update(mcpServers)
        .set({ credentialId: client })
        .where(eq(mcpServers.id, NOTION));
      // As a refresh records them from the server's own labels.
      await tool({ serverId: NOTION, name: GET_REQUEST, declaredRead: true });
      await tool({
        serverId: NOTION,
        name: COMMENT,
        effect: "write",
        destructive: true,
      });
      await tool({ serverId: EXA, name: SEARCH, declaredRead: true });
    },
    /** This person's own Notion account, and the Bot's grants. */
    async connect(owner: string, botId: string) {
      const grantToken = await secret(
        {
          kind: "mcp_user_token",
          provider: NOTION,
          keyId: owner,
          metadata: {},
        },
        refreshToken,
      );
      await database.insert(mcpUserCredentials).values({
        serverId: NOTION,
        userId: owner,
        credentialId: grantToken,
        scope: "",
      });
      await database.insert(pluginGrants).values(
        [ref(NOTION, GET_REQUEST), ref(NOTION, COMMENT), ref(EXA, SEARCH)].map(
          (granted) => ({
            kind: "mcp" as const,
            ref: granted,
            agentId: botId,
          }),
        ),
      );
    },
    async remove() {
      await database
        .delete(mcpUserCredentials)
        .where(inArray(mcpUserCredentials.userId, people));
      if (notionClientBefore !== undefined)
        await database
          .update(mcpServers)
          .set({ credentialId: notionClientBefore })
          .where(eq(mcpServers.id, NOTION));
      for (const created of createdTools)
        await database
          .delete(mcpTools)
          .where(
            and(
              eq(mcpTools.serverId, created.serverId),
              eq(mcpTools.name, created.name),
            ),
          );
      if (createdServers.length)
        await database
          .delete(mcpServers)
          .where(inArray(mcpServers.id, createdServers));
      if (createdCredentials.length)
        await database
          .delete(credentials)
          .where(inArray(credentials.id, createdCredentials));
    },
  };
})();

/* ------------------------------------------------------------------------------------------------
 * One deployment, wired the way `server/src/index.ts` wires it.
 * ---------------------------------------------------------------------------------------------- */

const plugins = createPluginStore({
  brokerProvider: "composio",
  database,
  auditStore: createAuditStore(database),
  credentials: createCredentialStore(database),
  encryptionKey: KEY,
  policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
  approvalGate: approvalService.gate,
  privateShareCheck: createPrivateShareCheck({ approvals: approvalStore }),
  exchangeRefreshToken: async ({ refreshToken: spent }) => ({
    accessToken: `access-for-${spent}`,
  }),
});

const roster = new Map<string, RegisteredAgent>();
const resolver = createActorAgentResolver({
  loadAgents: async () => [...roster.values()],
  model: { provider: "openai", defaultModel: "gpt-5.5" },
  resolveModelApiKey: async () => "test-key",
  loadToolsForActor: (actorId, initiator) => (botId) =>
    grantedTools({
      store: plugins,
      botId,
      actorId,
      ...(initiator ? { initiator } : {}),
    }),
});

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
  stop: async () => true,
};

/** The approval continuation runner, as index.ts builds it. */
const runTurn = createTurnRunner({
  admission: serverTurnAdmission,
  intelligence: {
    getOrCreateThread: async () => undefined,
    getThreadMessages: async () => ({ messages: [] }),
    ɵacquireThreadLock: async () => undefined,
    ɵrenewThreadLock: async () => undefined,
    ɵcleanupThreadLock: async () => undefined,
  },
  runner,
  buildAgentFor: ({ ownerUserId, agentId, initiator }) =>
    resolver.resolveAgentForActor({ id: ownerUserId, role: "user" }, agentId, {
      initiator,
    }),
});

const scopeFor = async (
  ownerUserId: string,
  channelId: string,
  agentId: string,
) => {
  const actor = await actorFor(ownerUserId);
  const [channel, bot] = await Promise.all([
    channelStore.get(actor, channelId),
    profileStore.get(actor, agentId),
  ]);
  return channel?.active && bot && channel.agentIds.includes(agentId)
    ? { ownerUserId, channelId, agentId, threadId: channel.threadId }
    : null;
};

const tasks = createTaskRunner({
  database,
  store: taskStore,
  channels: channelStore,
  actorFor,
  queue,
  owner: `tasks-apps-${suite}-worker`,
  scopeFor,
  runTask: createTaskTurn({ channels: channelStore, actorFor, runTurn }),
  retryMs: 0,
});

const resumeApproval = createApprovalResumeTick({
  approvalQueue: queue,
  approvalOwner: `tasks-apps-${suite}-approval`,
  approvalService,
  executeApprovedAction: createApprovedActionExecutor({
    sourceFor: async () => ({}),
    gate: approvalService.gate,
    computerTools: async () => [],
    hostTools: () => [],
    callTool: (input) => plugins.callTool(input),
    credentialActorFor: async (actorId) => actorId,
    coordinationCall: async () => null,
    answer: vendorAnswer,
    privateShareToolRef: PRIVATE_SHARE_TOOL_REF,
    refusalMarker: REFUSAL_MARKER,
    personInitiator: PERSON_INITIATOR,
  }),
  database,
  // Read only for a responsibility's waiting run, which these turns never are.
  responsibilityStore: {} as ResponsibilityStore,
  groupConversations: { continueWaiting: (_approvalId, run) => run() },
  approvalContinuationRunner: runTurn,
  channelStore,
  actorFor,
  notify: async () => undefined,
});

/* ------------------------------------------------------------------------------------------------
 * A person, their Bot holding the apps, and an item a check-in raised.
 * ---------------------------------------------------------------------------------------------- */

async function seed() {
  const id = `tasks-apps-${suite}-${randomUUID()}`;
  await database
    .insert(users)
    .values({ id, email: `${id}@example.test`, name: "Task Apps Person" });
  people.push(id);
  const owner = await actorFor(id);
  const bot = await profileStore.create(owner, {
    name: "Assistant",
    title: "Requests",
    roleDescription: "Answer what people ask of the person.",
    visibility: "private",
  });
  bots.push(bot.id);
  roster.set(bot.id, {
    id: bot.id,
    name: "Assistant",
    type: "built_in",
    systemPrompt: "Answer what people ask of the person.",
  });
  await fixtures.connect(id, bot.id);
  const own = await channelStore.direct(owner, bot.id);
  const settingId = randomUUID();
  await database.insert(proactiveSettings).values({
    id: settingId,
    ownerUserId: id,
    agentId: bot.id,
    channelId: own.id,
    threadId: `tasks-apps-${suite}-check-ins-${randomUUID()}`,
  });
  const [item] = await database
    .insert(proactiveSuggestions)
    .values({
      id: randomUUID(),
      ownerUserId: id,
      agentId: bot.id,
      settingId,
      runId: `tasks-apps-${suite}-run`,
      title: "Reply to Sam about the spec",
      detail: "Sam asked for the spec by Friday.",
      sourceApp: "Notion",
      sourceRef: ref(NOTION, GET_REQUEST),
      sourceLink: "https://www.notion.so/r-1",
    })
    .returning();
  if (!item) throw new Error("No item.");
  return { owner, botId: bot.id, own, item };
}

async function start(owner: AgentActor, itemId: string) {
  const item = await proactive.resolveSuggestion(owner.id, itemId, "started");
  const task = await tasks.startFromItem({ ownerUserId: owner.id, item });
  await tasks.idle();
  return task;
}

const pendingFor = (owner: string) =>
  database
    .select()
    .from(approvalRequests)
    .where(
      and(
        eq(approvalRequests.ownerUserId, owner),
        eq(approvalRequests.status, "pending"),
      ),
    );

async function allowOnce(owner: string, id: string) {
  await approvalService.decide(owner, id, "allow_once");
  for (let tick = 0; tick < 10; tick += 1) {
    await resumeApproval();
    if ((await approvalStore.get(owner, id)).status === "completed") return;
  }
  throw new Error("The approval was never carried out.");
}

const callsOf = (tool: string) =>
  vendorCalls.filter((call) => call.tool === tool);

beforeEach(() => {
  vendorCalls.length = 0;
  script = () => ({ content: "Done." });
});

afterAll(async () => {
  await tasks.idle();
  try {
    await llm.stop();
    relay?.stop(true);
    apps?.stop(true);
  } finally {
    globalThis.fetch = realFetch;
    for (const [name, value] of Object.entries(environmentBefore)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
  const theirs = await database
    .select({ id: channelMemberships.channelId })
    .from(channelMemberships)
    .where(inArray(channelMemberships.userId, people));
  const approvals = await database
    .select({ id: approvalRequests.id })
    .from(approvalRequests)
    .where(inArray(approvalRequests.ownerUserId, people));
  await database
    .delete(workItems)
    .where(
      sql`${workItems.payload}->>'ownerUserId' in ${people} or (${workItems.kind} = 'approval.resume' and ${workItems.key} in ${approvals.length ? approvals.map((row) => row.id) : [""]})`,
    );
  if (theirs.length)
    await database.delete(channels).where(
      inArray(
        channels.id,
        theirs.map((row) => row.id),
      ),
    );
  await database
    .delete(pluginGrants)
    .where(inArray(pluginGrants.agentId, bots));
  await fixtures.remove();
  await database.delete(users).where(inArray(users.id, people));
  await database
    .delete(agentProfiles)
    .where(inArray(agentProfiles.agentId, bots));
  await database.delete(agents).where(inArray(agents.id, bots));
  await database.$client.close();
});

/* ------------------------------------------------------------------------------------------------
 * The cases.
 * ---------------------------------------------------------------------------------------------- */

describe("a task works with the apps the person connected", () => {
  test("it reads their own app without asking, asks once before a send, and Allow once sends it once; a later turn there asks the same way", async () => {
    const { owner, item } = await seed();
    // The deployment's default: Ask before making changes off, and the person never turned it on.
    expect(await approvalStore.enabled(owner.id)).toBe(false);
    script = (request) => {
      const answered = answeredSinceAsk(request);
      if (lastAsk(request).startsWith("Also thank Sam"))
        return answered === 0
          ? {
              toolCalls: [
                {
                  name: modelName(NOTION, COMMENT),
                  arguments: JSON.stringify({
                    page_id: "r-1",
                    text: "Thanks for the reminder, Sam.",
                  }),
                },
              ],
            }
          : { content: "I thanked Sam." };
      if (answered === 0)
        return {
          toolCalls: [
            {
              name: modelName(NOTION, GET_REQUEST),
              arguments: JSON.stringify({ id: "r-1" }),
            },
          ],
        };
      if (answered === 1)
        return {
          toolCalls: [
            {
              name: modelName(NOTION, COMMENT),
              arguments: JSON.stringify({
                page_id: "r-1",
                text: "Friday works for the spec.",
              }),
            },
          ],
        };
      return { content: "I replied to Sam that Friday works." };
    };

    const task = await start(owner, item.id);

    // The person's own app, read with a tool its server says only reads: no question asked.
    expect(callsOf(GET_REQUEST)).toEqual([
      { tool: GET_REQUEST, args: { id: "r-1" } },
    ]);
    // The send did not go, and waits on one card: Allow once or Deny, with what it would send.
    expect(callsOf(COMMENT)).toEqual([]);
    const waiting = await pendingFor(owner.id);
    expect(waiting).toHaveLength(1);
    expect(waiting[0]?.action).toMatchObject({
      toolRef: ref(NOTION, COMMENT),
      args: { page_id: "r-1", text: "Friday works for the spec." },
      threadId: (await taskStore.get(owner.id, task.id)).threadId,
      policy: { behaviour: "ask", source: "task" },
    });
    expect(await taskStore.get(owner.id, task.id)).toMatchObject({
      status: "needs_input",
    });

    await allowOnce(owner.id, waiting[0]?.id ?? "");
    // Sent once, and the conversation carried on to the Bot's answer.
    expect(callsOf(COMMENT)).toEqual([
      {
        tool: COMMENT,
        args: { page_id: "r-1", text: "Friday works for the spec." },
      },
    ]);
    expect(await taskStore.get(owner.id, task.id)).toMatchObject({
      status: "ready_for_review",
      next: "I replied to Sam that Friday works.",
    });
    expect(await pendingFor(owner.id)).toEqual([]);

    // The person carries on in the task's conversation, a turn of their own: it asks the same way.
    const { threadId } = await taskStore.get(owner.id, task.id);
    await expect(
      runTurn({
        ownerUserId: owner.id,
        routineId: `tasks-apps-${suite}-reply`,
        agentId: item.agentId,
        threadId: threadId ?? "",
        instruction: "Also thank Sam for the reminder.",
        userMessage: {
          id: randomUUID(),
          role: "user",
          content: "Also thank Sam for the reminder.",
        },
        initiator: PERSON_INITIATOR,
      }),
    ).rejects.toThrow("This action is waiting for your approval.");
    expect(callsOf(COMMENT)).toHaveLength(1);
    expect(
      (await pendingFor(owner.id)).map((request) => [
        request.action.toolRef,
        request.action.policy?.source,
      ]),
    ).toEqual([[ref(NOTION, COMMENT), "task"]]);
  });

  test("it asks before a read that is not of the person's own app, which the person's own conversation still runs as chat always has", async () => {
    const { owner, botId, own, item } = await seed();
    script = (request) =>
      answeredSinceAsk(request) === 0
        ? {
            toolCalls: [
              {
                name: modelName(EXA, SEARCH),
                arguments: JSON.stringify({ query: "spec template" }),
              },
            ],
          }
        : { content: "Here are three spec templates." };

    const task = await start(owner, item.id);

    expect(callsOf(SEARCH)).toEqual([]);
    expect(
      (await pendingFor(owner.id)).map((request) => [
        request.action.toolRef,
        request.action.policy?.source,
      ]),
    ).toEqual([[ref(EXA, SEARCH), "task"]]);
    expect((await taskStore.get(owner.id, task.id)).status).toBe("needs_input");

    // The same search in the person's own conversation with the Bot: a read, run without asking.
    const answer = await runTurn({
      ownerUserId: owner.id,
      routineId: `tasks-apps-${suite}-own`,
      agentId: botId,
      threadId: own.threadId,
      instruction: "Find a spec template.",
      userMessage: {
        id: randomUUID(),
        role: "user",
        content: "Find a spec template.",
      },
      initiator: PERSON_INITIATOR,
    });
    expect(answer.replyText).toBe("Here are three spec templates.");
    expect(callsOf(SEARCH)).toEqual([
      { tool: SEARCH, args: { query: "spec template" } },
    ]);
    expect(await pendingFor(owner.id)).toHaveLength(1);
  });
});
