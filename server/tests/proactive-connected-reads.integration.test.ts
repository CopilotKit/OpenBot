import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { randomUUID } from "node:crypto";
import { LLMock } from "@copilotkit/aimock";
import { PROVENANCE_GUIDANCE } from "@openbot/shared/bot-prompt";
import type { ChatCompletionRequest } from "@copilotkit/aimock";
import { createTurnRunner, type RunnerLike } from "@openbot/toolkit/run-turn";
import { and, eq, inArray, sql } from "drizzle-orm";
import { Observable } from "rxjs";
import { createActorAgentResolver } from "../src/agents/agent-resolver";
import { serverTurnAdmission } from "../src/agents/turn-admission";
import type { ApprovalCandidate } from "../src/approvals/types";
import { type AuditInitiator, createAuditStore } from "../src/audit";
import type { ActionPolicy } from "../src/computer/policy";
import { type RegisteredAgent, registeredAgentFromRow } from "../src/copilot";
import { createCredentialStore, encryptSecret } from "../src/credentials";
import { createDatabase } from "../src/db/client";
import { auditEvents } from "../src/db/schema";
import { agents, channels, credentials, users } from "../src/db/schema/core";
import {
  brokeredConnections,
  mcpServers,
  mcpTools,
  mcpUserCredentials,
  pluginGrants,
} from "../src/db/schema/plugins";
import {
  proactivePeople,
  proactivePings,
  proactiveRuns,
  proactiveSettings,
  proactiveSuggestions,
} from "../src/db/schema/proactive";
import { workItems } from "../src/db/schema/work";
import { createMemoryStore } from "../src/memory/store";
import {
  CustomServerRefusedError,
  createPluginStore,
  PluginRefusedError,
} from "../src/plugins/store";
import { grantedTools } from "../src/plugins/tools";
import { createProactiveEngine } from "../src/proactive/engine";
import {
  guardProactiveCallback,
  proactiveInitiator,
  restrictToolsForRun,
} from "../src/proactive/restriction";
import { checkInToolsFor, createCheckInScope } from "../src/proactive/scope";
import { createProactiveStore } from "../src/proactive/store";
import { type ProactiveSetting, SKIPPED_BECAUSE } from "../src/proactive/types";
import { createWorkQueue } from "../src/work/queue";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * A check-in reads what the person connected with their own account, through the tools that say
 * they only read, and nothing else. Driven through the real path: real Postgres, the real plugin
 * store and its catalogue, the real tool loader and dispatcher (`grantedTools`, `callTool`, with the
 * vendor's network call stood in for at `callVendor`), the real restriction and scope, the real
 * agent resolver building the real built-in Bot, the real turn runner and the real check-in engine.
 * The model is the only fake: `@copilotkit/aimock`, answering the built-in Bot's own requests the
 * way a model would, and recording what it was offered.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = randomUUID().slice(0, 8);
/** 32 zero bytes in base64: a real AES-256 key, because the vault is opened for Notion's grant. */
const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const allowEverything = (): ActionPolicy => ({
  mode: "enforce",
  deny: [],
  allow: ["true"],
});

const owner = `connected-owner-${suite}`;
const desk = `connected-desk-${suite}`;
const harness = `connected-harness-${suite}`;
const unconnected = `connected-none-${suite}`;
const tasker = `connected-tasker-${suite}`;
const botIds = [desk, harness, unconnected, tasker];
const channelOf = (bot: string) => `${bot}-channel`;

/** Notion: the person's own grant, an MCP server, and the tools as a refresh records them. */
const NOTION = "notion";
const notionDigest = `notion-digest-${suite}`; // readOnlyHint, on no reviewed list
const notionDraft = `notion-draft-${suite}`; // no label at all
const notionErase = `notion-erase-${suite}`; // destructiveHint
/** The same tools on a server an admin added by URL, on one token for everybody. */
const NOTES = `notes-${suite}`;
/** A Composio app the person connected with their own account. */
const MAIL = `composio-mail-${suite}`;
const MAIL_APP = `mail-${suite}`;
/** Web search on this deployment's own key. */
const EXA = "exa-authenticated";
/** A server added under the id OpenBot's memory tools are spelled with. */
const MEMORY = "memory";
/** An Arcade app the person connected, on a deployment that runs Arcade. */
const TASKS = `arcade-tasks-${suite}`;
const TASKS_APP = `Tasks${suite}`;

const modelName = (ref: string) => `mcp__${ref.replace("/", "__")}`;
const ref = (server: string, tool: string) => `${server}/${tool}`;

const auditStore = createAuditStore(database);
const store = createProactiveStore(database);
const memory = createMemoryStore(database);
const queue = createWorkQueue(database);

/** What reached a vendor, and what the approval gate was asked, in order. */
const vendorCalls: { url: string; token?: string; tool: string }[] = [];
const gateAsked: { toolRef: string; effect: string }[] = [];
/** Every dial at a Bot's own endpoint. A check-in must make none. */
const endpointDials: string[] = [];

function pluginStoreFor(brokerProvider: "composio" | "arcade") {
  return createPluginStore({
    brokerProvider,
    database,
    auditStore,
    credentials: createCredentialStore(database),
    encryptionKey: KEY,
    policy: allowEverything,
    approvalGate: async (candidate: ApprovalCandidate) => {
      gateAsked.push({ toolRef: candidate.toolRef, effect: candidate.effect });
      return undefined;
    },
    callVendor: async (connection, toolName) => {
      vendorCalls.push({
        url: connection.url,
        ...(connection.token ? { token: connection.token } : {}),
        tool: toolName,
      });
      return {
        text: JSON.stringify([{ subject: "Quarterly numbers due Friday" }]),
        isError: false,
      };
    },
    // Notion's token endpoint: the person's refresh token buys an access token named after it.
    exchangeRefreshToken: async ({ refreshToken }) => ({
      accessToken: `access-for-${refreshToken}`,
    }),
  });
}
const plugins = pluginStoreFor("composio");

/* ------------------------------------------------------------------------------------------------
 * The scripted model, behind the OpenAI-compatible address the built-in Bot calls.
 * ---------------------------------------------------------------------------------------------- */

const llm = new LLMock({ host: "127.0.0.1", port: 7492 });
/** What the model reads with in this test, by the name it is offered, and what it then raises. */
let script: { read?: string; title?: string } = {};
/** Every request the model received. */
let asked: ChatCompletionRequest[] = [];
const offeredIn = (request: ChatCompletionRequest | undefined) =>
  (request?.tools ?? []).map((tool) => tool.function.name);
const connectorsOffered = (request: ChatCompletionRequest | undefined) =>
  offeredIn(request)
    .filter((name) => name.startsWith("mcp__"))
    .sort();
const textOf = (content: unknown) =>
  typeof content === "string" ? content : JSON.stringify(content);

let environmentBefore: Record<string, string | undefined> = {};

beforeAll(async () => {
  environmentBefore = {
    OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  };
  llm.on({ predicate: () => true }, (request) => {
    asked.push(request);
    const results = request.messages.filter(
      (message) => message.role === "tool",
    );
    if (
      results.some((message) => textOf(message.content).includes("suggested"))
    )
      return { content: "Looked at what is new. One thing needs them." };
    const read = script.read;
    if (!read || !offeredIn(request).includes(read))
      return { content: "Looked at what is new. Nothing needs them." };
    if (results.length === 0)
      return { toolCalls: [{ name: read, arguments: "{}" }] };
    return {
      toolCalls: [
        {
          name: "suggest_next_step",
          arguments: JSON.stringify({
            title: script.title ?? "Send the quarterly numbers",
            detail: "They are due on Friday and nobody has sent them yet.",
            sourceTool: read,
          }),
        },
      ],
    };
  });
  process.env.OPENAI_BASE_URL = await llm.start();
  process.env.OPENAI_API_KEY = "test-key";

  await database
    .insert(users)
    .values({ id: owner, email: `${owner}@example.test` });
  await database.insert(agents).values([
    { id: desk, name: "Desk Bot", type: "built_in", configuration: {} },
    {
      id: harness,
      name: "Harness Bot",
      type: "remote_ag_ui",
      configuration: {},
    },
    {
      id: unconnected,
      name: "Lookout Bot",
      type: "built_in",
      configuration: {},
    },
    { id: tasker, name: "Task Bot", type: "built_in", configuration: {} },
  ]);
  await database
    .insert(channels)
    .values(
      botIds.map((bot) => ({ id: channelOf(bot), name: bot, description: "" })),
    );
  await fixtures.install();
});

beforeEach(async () => {
  script = {};
  asked = [];
  vendorCalls.length = 0;
  gateAsked.length = 0;
  endpointDials.length = 0;
  await database
    .delete(proactiveSuggestions)
    .where(eq(proactiveSuggestions.ownerUserId, owner));
  await database
    .delete(proactivePings)
    .where(eq(proactivePings.ownerUserId, owner));
  await database
    .delete(proactivePeople)
    .where(eq(proactivePeople.ownerUserId, owner));
  await database
    .delete(proactiveRuns)
    .where(eq(proactiveRuns.ownerUserId, owner));
  await database
    .update(proactiveSettings)
    .set({ nextRunAt: FAR, lastRunAt: null, lastStatus: "idle" })
    .where(eq(proactiveSettings.ownerUserId, owner));
});

afterAll(async () => {
  try {
    await llm.stop();
  } finally {
    for (const [name, value] of Object.entries(environmentBefore)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
  const settings = await database
    .select({ id: proactiveSettings.id })
    .from(proactiveSettings)
    .where(eq(proactiveSettings.ownerUserId, owner));
  if (settings.length)
    await database.delete(workItems).where(
      and(
        eq(workItems.kind, "proactive.run"),
        inArray(
          sql<string>`${workItems.payload}->>'settingId'`,
          settings.map((setting) => setting.id),
        ),
      ),
    );
  await fixtures.remove();
  await database.delete(users).where(eq(users.id, owner));
  await database.delete(agents).where(inArray(agents.id, botIds));
  await database
    .delete(channels)
    .where(inArray(channels.id, botIds.map(channelOf)));
  await database.$client.close();
});

/* ------------------------------------------------------------------------------------------------
 * The apps, the person's own connections, and what each Bot holds.
 * ---------------------------------------------------------------------------------------------- */

const FAR = new Date("2100-01-01T00:00:00Z");

const fixtures = (() => {
  /** Rows this suite found already there, so it puts back exactly what it borrowed. */
  const createdServers: string[] = [];
  const createdTools: { serverId: string; name: string }[] = [];
  const createdCredentials: string[] = [];
  let notionClientBefore: string | null = null;

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
  const grant = (agentId: string, refs: string[]) =>
    database
      .insert(pluginGrants)
      .values(refs.map((granted) => ({ kind: "mcp", ref: granted, agentId })))
      .onConflictDoNothing();

  return {
    async install() {
      // Notion, as the person connected it: the deployment's client, and the person's own grant.
      await server({
        id: NOTION,
        title: "Notion",
        vendor: "Notion",
        url: "https://mcp.notion.com/mcp",
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
          keyId: `oauth-client-connected-${suite}`,
          metadata: { clientId: `client-${suite}` },
        },
        JSON.stringify({ clientId: `client-${suite}`, clientSecret: "" }),
      );
      await database
        .update(mcpServers)
        .set({ credentialId: client })
        .where(eq(mcpServers.id, NOTION));
      const grantToken = await secret(
        {
          kind: "mcp_user_token",
          provider: NOTION,
          keyId: owner,
          metadata: {},
        },
        `refresh-${suite}`,
      );
      await database.insert(mcpUserCredentials).values({
        serverId: NOTION,
        userId: owner,
        credentialId: grantToken,
        scope: "",
      });

      // The same three tools, labelled as a refresh records them, on Notion and on the admin's.
      await server({
        id: NOTES,
        title: "Team Notes",
        vendor: "Acme",
        url: "https://notes.example.test/mcp",
        provenance: "custom",
      });
      for (const serverId of [NOTION, NOTES]) {
        await tool({ serverId, name: notionDigest, declaredRead: true });
        await tool({ serverId, name: notionDraft });
        await tool({
          serverId,
          name: notionErase,
          effect: "write",
          destructive: true,
        });
      }

      // Mail at Composio, which the person connected with their own account.
      await server({
        id: MAIL,
        title: "Mail",
        vendor: "Composio",
        url: `composio://${MAIL_APP}`,
        provenance: "composio",
        authScheme: "OAUTH2",
        accountMode: "personal",
      });
      await tool({ serverId: MAIL, name: "MAIL_FETCH_EMAILS", effect: "read" });
      await tool({ serverId: MAIL, name: "MAIL_SEND_EMAIL", effect: "write" });
      await database.insert(brokeredConnections).values({
        provider: "composio",
        app: MAIL_APP,
        holder: "person",
        userId: owner,
        vendorUserId: owner,
      });

      // Tasks at Arcade, connected the same way, on a deployment that runs Arcade.
      await server({
        id: TASKS,
        title: "Tasks",
        vendor: "Arcade",
        url: `arcade://${TASKS_APP}`,
        provenance: "arcade",
        authScheme: "OAUTH2",
        accountMode: "personal",
      });
      await tool({ serverId: TASKS, name: "ListTasks", effect: "read" });
      await tool({ serverId: TASKS, name: "CreateTask", effect: "write" });
      await database.insert(brokeredConnections).values({
        provider: "arcade",
        app: TASKS_APP,
        holder: "person",
        userId: owner,
        vendorUserId: owner,
      });

      // Web search on the deployment's own key: a reviewed read, and nobody's own account.
      await server({
        id: EXA,
        title: "Exa Search (API key)",
        vendor: "Exa",
        url: "https://mcp.exa.ai/mcp",
        provenance: "first-party",
      });
      await tool({ serverId: EXA, name: "web_search_exa" });

      // A server sitting under the memory tools' own id, as a hand edit or an older build left it.
      await server({
        id: MEMORY,
        title: "Memory",
        vendor: "Acme",
        url: "https://memory.example.test/mcp",
        provenance: "custom",
      });
      await tool({
        serverId: MEMORY,
        name: "recall_personal_memory",
        declaredRead: true,
      });

      await grant(desk, [
        ref(NOTION, notionDigest),
        ref(NOTION, notionDraft),
        ref(NOTION, notionErase),
        ref(NOTES, notionDigest),
        ref(MAIL, "MAIL_FETCH_EMAILS"),
        ref(MAIL, "MAIL_SEND_EMAIL"),
        ref(EXA, "web_search_exa"),
        ref(MEMORY, "recall_personal_memory"),
      ]);
      await grant(harness, [
        ref(MAIL, "MAIL_FETCH_EMAILS"),
        ref(MAIL, "MAIL_SEND_EMAIL"),
      ]);
      // Everything this Bot holds is reached with somebody else's credential.
      await grant(unconnected, [
        ref(NOTES, notionDigest),
        ref(NOTES, notionDraft),
        ref(EXA, "web_search_exa"),
      ]);
      await grant(tasker, [ref(TASKS, "ListTasks"), ref(TASKS, "CreateTask")]);
    },

    async remove() {
      await database
        .delete(pluginGrants)
        .where(inArray(pluginGrants.agentId, botIds));
      await database
        .delete(brokeredConnections)
        .where(eq(brokeredConnections.userId, owner));
      await database
        .delete(mcpUserCredentials)
        .where(eq(mcpUserCredentials.userId, owner));
      // The client pointer back before its credential goes: the column is a foreign key.
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

const roster: RegisteredAgent[] = [
  {
    id: desk,
    name: "Desk Bot",
    type: "built_in",
    systemPrompt: "You keep the person's desk in order.",
  },
  {
    id: unconnected,
    name: "Lookout Bot",
    type: "built_in",
    systemPrompt: "You keep watch.",
  },
  {
    id: tasker,
    name: "Task Bot",
    type: "built_in",
    systemPrompt: "You keep track of tasks.",
  },
  registeredAgentFromRow({
    id: harness,
    name: "Harness Bot",
    type: "remote_ag_ui",
    configuration: { endpoint: "http://127.0.0.1:7495/ag-ui" },
    title: "Planner",
    roleDescription: "Plans the person's week.",
  }) as RegisteredAgent,
];

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

function deployment(pluginStore: ReturnType<typeof pluginStoreFor>) {
  const scope = createCheckInScope({
    catalogue: pluginStore,
    ownConnections: (userId) => pluginStore.ownConnections(userId),
  });
  const load =
    (actorId: string, initiator?: AuditInitiator) => (botId: string) =>
      grantedTools({
        store: pluginStore,
        botId,
        actorId,
        ...(initiator ? { initiator } : {}),
      });
  let skillNarrowingAsked = 0;
  const resolver = createActorAgentResolver({
    loadAgents: async () => roster,
    model: { provider: "openai", defaultModel: "gpt-5.5" },
    resolveModelApiKey: async () => "test-key",
    loadToolsForActor: (actorId, initiator) =>
      restrictToolsForRun(initiator, actorId, load(actorId, initiator), scope),
    selectionForActor: () => {
      skillNarrowingAsked += 1;
      return {
        loadSkills: async () => [],
        choose: async () => {
          throw new Error("a check-in never narrows its tools");
        },
      };
    },
    // A Bot's own endpoint, which a check-in must never reach.
    agentFetch: (async (input: RequestInfo | URL) => {
      endpointDials.push(String(input instanceof Request ? input.url : input));
      return new Response("the endpoint was dialled", { status: 503 });
    }) as typeof fetch,
  });
  let engine: ReturnType<typeof createProactiveEngine> | undefined;
  const turn = createTurnRunner({
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
      resolver.resolveAgentForActor(
        { id: ownerUserId, role: "user" },
        agentId,
        {
          initiator,
        },
      ),
    toolsForTurn: (input) =>
      (engine as ReturnType<typeof createProactiveEngine>).toolsForTurn(input),
  });
  engine = createProactiveEngine({
    store,
    memory,
    queue,
    owner: `connected-${randomUUID()}`,
    runTurn: turn,
    resolveScope: async (ownerUserId, channelId, agentId) =>
      ownerUserId === owner && channelId === channelOf(agentId)
        ? { ownerUserId, channelId, agentId, threadId: `${channelId}-thread` }
        : null,
    attention: { notifyAttention: async () => {} },
    ...checkInToolsFor((ownerUserId) => load(ownerUserId), scope),
    catalogue: pluginStore,
    mintThreadId: () => `connected-thread-${randomUUID()}`,
  });
  return {
    engine,
    scope,
    resolver,
    skillNarrowingAsked: () => skillNarrowingAsked,
  };
}

const settings = new Map<string, ProactiveSetting>();
async function settingFor(bot: string) {
  const existing = settings.get(bot);
  if (existing) return existing;
  const setting = await store.create(
    owner,
    { agentId: bot, channelId: channelOf(bot) },
    `${bot}-thread`,
  );
  settings.set(bot, setting);
  return setting;
}
/** One check-in for this Bot, as the sweep runs it. */
async function checkIn(
  bot: string,
  at: ReturnType<typeof deployment> = composio,
) {
  const setting = await settingFor(bot);
  await database
    .update(proactiveSettings)
    .set({ nextRunAt: new Date(Date.now() - 1_000) })
    .where(eq(proactiveSettings.id, setting.id));
  await at.engine.sweep();
  return setting;
}
const itemsOf = (bot: string) =>
  database
    .select()
    .from(proactiveSuggestions)
    .where(
      and(
        eq(proactiveSuggestions.ownerUserId, owner),
        eq(proactiveSuggestions.agentId, bot),
      ),
    );
/** The check-in's message as the model received it. */
const instructionIn = (request: ChatCompletionRequest | undefined) =>
  (request?.messages ?? [])
    .filter((message) => message.role === "user")
    .map((message) => textOf(message.content))
    .join("\n");

const composio = deployment(plugins);

/* ------------------------------------------------------------------------------------------------
 * The cases.
 * ---------------------------------------------------------------------------------------------- */

describe("a check-in reads what the person connected, through the tools that say they only read", () => {
  test("Notion, connected with the person's own account: its read-only tool is read, its unlabeled and destructive tools are never offered, and chat still asks first", async () => {
    script = { read: modelName(ref(NOTION, notionDigest)) };
    const setting = await checkIn(desk);

    // Offered: the reads of the two apps the person connected. Not the unlabeled or destructive
    // Notion tools, not Mail's send, not the admin's notes, not web search on the deployment's key,
    // and not a server sitting under the memory tools' id.
    expect(connectorsOffered(asked[0])).toEqual(
      [
        modelName(ref(MAIL, "MAIL_FETCH_EMAILS")),
        modelName(ref(NOTION, notionDigest)),
      ].sort(),
    );
    expect(offeredIn(asked[0])).toEqual(
      expect.arrayContaining([
        "suggest_next_step",
        "clear_next_step",
        "form_memory",
      ]),
    );

    // Read through the dispatcher, on the person's own grant, and judged as the read it says it is.
    expect(vendorCalls).toEqual([
      {
        url: "https://mcp.notion.com/mcp",
        token: `access-for-refresh-${suite}`,
        tool: notionDigest,
      },
    ]);
    expect(gateAsked).toEqual([
      { toolRef: ref(NOTION, notionDigest), effect: "read" },
    ]);
    const [item] = await itemsOf(desk);
    expect(item).toMatchObject({
      title: "Send the quarterly numbers",
      sourceApp: "Notion",
      sourceRef: ref(NOTION, notionDigest),
      status: "open",
    });
    expect((await store.runs(setting.id))[0]).toMatchObject({
      outcome: "raised",
      reads: 1,
    });

    // Chat is unchanged: the server's read-only label is not believed there, so the person's own
    // turn asks before the same tool, as it always did.
    const listed = (await plugins.listServers()).find(
      (server) => server.id === NOTION,
    );
    expect(
      listed?.tools.find((tool) => tool.name === notionDigest),
    ).toMatchObject({ effect: "write", labelledRead: true });
    gateAsked.length = 0;
    await plugins.callTool({
      ref: ref(NOTION, notionDigest),
      args: {},
      botId: desk,
      actorId: owner,
    });
    expect(gateAsked).toEqual([
      { toolRef: ref(NOTION, notionDigest), effect: "write" },
    ]);
  });

  test("the instruction names what the person connected and asks its one question, with nothing about mail or a calendar", async () => {
    await checkIn(desk);
    const instruction = instructionIn(asked[0]);
    expect(instruction).toContain(
      "Your one question: is there something your person needs to do that they probably don't know about yet?",
    );
    expect(instruction).toMatch(
      /Look for it in what they have connected: (Mail, Notion|Notion, Mail)\./,
    );
    for (const wording of [
      "in:inbox",
      "after:",
      "Gmail",
      "calendar",
      "Team Notes",
      "Exa",
    ])
      expect(instruction).not.toContain(wording);
    expect(instruction).toContain(
      "If something needs doing, raise it as a next step for them instead of doing it.",
    );
    // Every connected read is offered: a check-in never narrows its tools by skill.
    expect(composio.skillNarrowingAsked()).toBe(0);
  });

  test("the same tools on a server an admin connected for everybody are not read, and a Bot holding only those is skipped, saying so", async () => {
    const pressed = await composio.engine.runNow(
      owner,
      (await settingFor(unconnected)).id,
    );
    expect(pressed).toEqual({
      queued: false,
      skipped: "no_sources",
      why: SKIPPED_BECAUSE.no_sources,
    });
    expect(SKIPPED_BECAUSE.no_sources).toBe(
      "Nothing to check: this Bot can't read anything you've connected. Connect an app with your own account.",
    );
    expect(asked).toEqual([]);

    // Reached any other way, the dispatcher refuses a check-in's call there too, and says so.
    await expect(
      plugins.callTool({
        ref: ref(NOTES, notionDigest),
        args: {},
        botId: unconnected,
        actorId: owner,
        initiator: proactiveInitiator(`direct-${suite}`),
      }),
    ).rejects.toBeInstanceOf(PluginRefusedError);
    expect(vendorCalls).toEqual([]);
    const [refusal] = await database
      .select({ payload: auditEvents.payload })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.eventType, "mcp.call_rejected"),
          eq(auditEvents.targetId, ref(NOTES, notionDigest)),
          sql`${auditEvents.payload} ->> 'bot' = ${unconnected}`,
        ),
      );
    expect(refusal?.payload).toMatchObject({ refusal: "check_in_not_a_read" });
  });

  test("a Bot on another framework checks in on OpenBot's own runner, as itself, with the person's tools, and its endpoint is never called", async () => {
    script = {
      read: modelName(ref(MAIL, "MAIL_FETCH_EMAILS")),
      title: "Answer the supplier",
    };
    await checkIn(harness);

    expect(endpointDials).toEqual([]);
    expect(connectorsOffered(asked[0])).toEqual([
      modelName(ref(MAIL, "MAIL_FETCH_EMAILS")),
    ]);
    // The role it is sent at its endpoint, as the instructions OpenBot's own runner gives a model.
    const system = (asked[0]?.messages ?? [])
      .filter((message) => message.role !== "user" && message.role !== "tool")
      .map((message) => textOf(message.content))
      .join("\n");
    expect(system).toContain("You are Harness Bot, Planner.");
    expect(system).toContain("Plans the person's week.");
    // Said once: the guidance its standing role ends with is the guidance OpenBot gives every Bot.
    expect(system.split(PROVENANCE_GUIDANCE)).toHaveLength(2);
    expect(vendorCalls.map((call) => call.tool)).toEqual(["MAIL_FETCH_EMAILS"]);
    const [item] = await itemsOf(harness);
    expect(item).toMatchObject({
      agentId: harness,
      title: "Answer the supplier",
      sourceApp: "Mail",
    });

    // A person's own turn with the same Bot still goes to its endpoint, as it always did.
    const chat = await composio.resolver.resolveAgentForActor(
      { id: owner, role: "user" },
      harness,
      { initiator: { kind: "person" } },
    );
    await chat
      .runAgent({
        runId: `chat-${suite}`,
      })
      .catch(() => undefined);
    expect(endpointDials).toHaveLength(1);
  });

  test("an Arcade app the person connected is read through its read-only label, and its other tools are not offered", async () => {
    const arcade = deployment(pluginStoreFor("arcade"));
    script = { read: modelName(ref(TASKS, "ListTasks")) };
    await checkIn(tasker, arcade);
    expect(connectorsOffered(asked[0])).toEqual([
      modelName(ref(TASKS, "ListTasks")),
    ]);
    expect(vendorCalls.map((call) => call.tool)).toEqual(["ListTasks"]);
    expect((await itemsOf(tasker))[0]).toMatchObject({ sourceApp: "Tasks" });
  });
});

describe("the memory tools' own id", () => {
  test("no server can be added under it", async () => {
    await expect(
      plugins.addCustomServer({
        id: MEMORY,
        title: "Memory",
        url: "https://memory.example.test/mcp",
        by: owner,
      }),
    ).rejects.toBeInstanceOf(CustomServerRefusedError);
  });

  test("a server already sitting there is not the person's memory to a check-in", async () => {
    const reads = await composio.scope(owner, desk);
    expect(reads.has(ref(MEMORY, "recall_personal_memory"))).toBe(false);
    const run = { initiator: proactiveInitiator(`memory-${suite}`) };
    expect(
      (
        await guardProactiveCallback(
          {
            name: ref(MEMORY, "recall_personal_memory"),
            botId: desk,
            actorId: owner,
            run,
          },
          composio.scope,
        )
      )?.text,
    ).toStartWith("Refused.");
    // The person's own memory, by the name OpenBot gives it, still reads.
    expect(
      await guardProactiveCallback(
        {
          name: "recall_personal_memory",
          botId: desk,
          actorId: owner,
          run,
        },
        composio.scope,
      ),
    ).toBeNull();
  });
});
