import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { randomUUID } from "node:crypto";
import type { BaseEvent } from "@ag-ui/client";
import { eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { mintRunAssertion } from "../src/agents/callback-token";
import { createApp } from "../src/app";
import { createAuditStore } from "../src/audit";
import { loadConfig } from "../src/config";
import {
  chooseOpenAIApi,
  normalizeModelBaseUrls,
  resolveRuntimeAgents,
  runtimeModelForEnvironment,
} from "../src/copilot";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  channelAgents,
  channelMemberships,
  channels,
  intelligenceChannelMappings,
  mcpServers,
  pluginGrants,
  routines,
  users,
} from "../src/db/schema";
import { useRoutineTools } from "../src/plugins/builtin-routines";
import {
  ALWAYS_ON_APP,
  ensureAlwaysOnApp,
  personalDefaultsDeps,
} from "../src/plugins/personal-defaults";
import { createPluginStore } from "../src/plugins/store";
import { grantedTools } from "../src/plugins/tools";
import { createRoutineStore } from "../src/routines/store";
import { loadTenantPackage } from "../src/tenant-package";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { testEnvironment } from "./support/environment";
import {
  type OpenAICompatibleEndpoint,
  startOpenAICompatibleEndpoint,
} from "./support/openai-compatible-endpoint";

/**
 * A routine asked for in a conversation, from the person's words to the row the sweep fires.
 *
 * Found on a vanilla install: a person in one of seven conversations with General Assistant typed
 * the sentence below. The Bot called its routine tool, which failed, and then put a "Choose a
 * channel" card in front of them with five options labelled "General Assistant, channel 1" to
 * "channel 5". The tool could not see which conversation it had been asked in, so the store found
 * seven candidates and refused; and it named them by the channel's name, which is only its Bots'
 * names, so the model had nothing better to label them with than a number.
 *
 * Real: PostgreSQL, the plugin store and the Routines app added and granted as the server does at
 * boot, the routine store behind it, and General Assistant built the way the server builds a
 * built-in Bot, calling a model endpoint over HTTP that answers in OpenAI's own recorded bytes. The
 * person's frontend tool is offered as the browser offers it. Nothing here touches Intelligence.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = randomUUID().slice(0, 8);
const OWNER = `routine-conversation-owner-${suite}`;
const BOT = `routine-conversation-general-assistant-${suite}`;

/**
 * The person's conversations with General Assistant, as the sidebar titled them on the install.
 *
 * Fixed ids rather than fresh ones, because they are what the model was handed and what it chose
 * by: the recorded answers carry them, so a replay only lines up with the same ids.
 */
const CONVERSATIONS = [
  {
    id: "routine-conversation-eks",
    threadId: "routine-conversation-eks-thread",
    title: "15-Minute EKS UTC Routine",
  },
  {
    id: "routine-conversation-reversal",
    threadId: "routine-conversation-reversal-thread",
    title: "Knowledge Bot String Reversal",
  },
  {
    id: "routine-conversation-kubectl",
    threadId: "routine-conversation-kubectl-thread",
    title: "Latest Stable kubectl Release",
  },
] as const;
const [ASKED_IN] = CONVERSATIONS;

/** What the person typed, word for word, in the run that found this. */
const PERSON =
  "Create a routine for me that runs every 15 minutes, starting as soon as possible, and each time replies with the current UTC time and the words 'routine check from EKS'. Use your routine tool.";

/**
 * The gallery's choice card, as the browser offers it to a run: `askChoice` from
 * app/src/components/gallery/decisions.tsx, its description and its schema as written there.
 */
const ASK_CHOICE = {
  name: "askChoice",
  description:
    "Ask the person to pick one of several options, and WAIT for their answer. Use when you cannot sensibly guess which one they meant. You are given the id of the option they chose.",
  parameters: z.toJSONSchema(
    z.object({
      title: z.string().describe("The question being asked"),
      summary: z
        .string()
        .optional()
        .describe("Any context the person needs to choose"),
      options: z
        .array(
          z.object({
            id: z
              .string()
              .describe("What comes back to you when this one is picked"),
            label: z.string(),
            description: z.string().optional(),
          }),
        )
        .describe("The options, in the order they should be offered"),
    }),
  ),
};

const auditStore = createAuditStore(database);
const pluginStore = createPluginStore({
  brokerProvider: "composio",
  database,
  auditStore,
  credentials: {} as never,
  encryptionKey: "x".repeat(44),
  // Allowed, as a person who has not turned on Ask before acting has it.
  policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
});
const routineStore = createRoutineStore(database);

const VARIABLES = [
  "OPENAI_BASE_URL",
  "BOT_MODEL",
  "BOT_PROVIDER",
  "COPILOTKIT_OPENAI_API",
] as const;
const saved = Object.fromEntries(
  VARIABLES.map((name) => [name, process.env[name]]),
);
let endpoint: OpenAICompatibleEndpoint | undefined;
/** Whether the Routines app was here before this file, so cleanup leaves the deployment as it was. */
let routinesWereAdded = false;

/** General Assistant, built as the server builds a built-in Bot, holding what the server grants it. */
async function generalAssistantAgainst(baseUrl: string) {
  for (const name of VARIABLES) delete process.env[name];
  process.env.OPENAI_BASE_URL = baseUrl;
  normalizeModelBaseUrls();
  const packageModel = (
    await loadTenantPackage(
      new URL("../../examples/fintech", import.meta.url).pathname,
    )
  ).model;
  const model = runtimeModelForEnvironment(packageModel);
  chooseOpenAIApi(model);
  const built = await resolveRuntimeAgents(
    async () => [
      {
        id: BOT,
        name: "General Assistant",
        type: "built_in" as const,
        systemPrompt:
          "You are a helpful general assistant. Give clear, concise, and accurate answers.",
      },
    ],
    model,
    async () => "synthetic-model-key",
    undefined,
    // The loader index.ts hands every run: the Bot's grants, called as the person asking.
    (botId) => grantedTools({ store: pluginStore, botId, actorId: OWNER }),
  );
  const agent = built[BOT];
  if (!agent) throw new Error("General Assistant was not built.");
  return agent;
}

/** One run of the person's message in `threadId`, with the browser's choice card on offer. */
async function ask(threadId: string) {
  const agent = await generalAssistantAgainst(endpoint?.baseUrl ?? "");
  agent.threadId = threadId;
  agent.setMessages([{ id: `person-${suite}`, role: "user", content: PERSON }]);
  const events: BaseEvent[] = [];
  await agent.runAgent(
    { runId: `run-${randomUUID()}`, tools: [ASK_CHOICE] },
    { onEvent: ({ event }) => void events.push(event) },
  );
  return events;
}

/** The answer a tool gave, as the model was sent it on the request after the call. */
function toolOutputs(conversation: unknown): string[] {
  if (!Array.isArray(conversation)) return [];
  return conversation
    .filter(
      (item): item is { type: string; output: unknown } =>
        typeof item === "object" &&
        item !== null &&
        item.type === "function_call_output",
    )
    .map((item) =>
      typeof item.output === "string"
        ? item.output
        : JSON.stringify(item.output),
    );
}

/** The arguments the run streamed for each call of one tool, joined and parsed. */
function argumentsOf(events: BaseEvent[], toolName: string): unknown[] {
  const started = events.filter(
    (event): event is BaseEvent & { toolCallId: string } =>
      event.type === "TOOL_CALL_START" &&
      (event as { toolCallName?: string }).toolCallName === toolName,
  );
  return started.map((start) =>
    JSON.parse(
      events
        .filter(
          (event) =>
            event.type === "TOOL_CALL_ARGS" &&
            (event as { toolCallId?: string }).toolCallId === start.toolCallId,
        )
        .map((event) => (event as { delta?: string }).delta ?? "")
        .join(""),
    ),
  );
}

async function routinesOfOwner() {
  return await database
    .select()
    .from(routines)
    .where(eq(routines.ownerUserId, OWNER));
}

async function clean() {
  await database.delete(routines).where(eq(routines.ownerUserId, OWNER));
  const ids = CONVERSATIONS.map((conversation) => conversation.id);
  await database
    .delete(intelligenceChannelMappings)
    .where(inArray(intelligenceChannelMappings.channelId, ids));
  await database.delete(channels).where(inArray(channels.id, ids));
  await database.delete(pluginGrants).where(eq(pluginGrants.agentId, BOT));
  await database.delete(agentProfiles).where(eq(agentProfiles.agentId, BOT));
  await database.delete(agents).where(eq(agents.id, BOT));
  await database.delete(users).where(eq(users.id, OWNER));
}

beforeEach(async () => {
  await clean();
  await database.insert(users).values({
    id: OWNER,
    email: `${OWNER}@example.test`,
    name: "Routine Conversation Test User",
  });
  await database.insert(agents).values({
    id: BOT,
    name: "General Assistant",
    type: "built_in",
    configuration: {
      systemPrompt:
        "You are a helpful general assistant. Give clear, concise, and accurate answers.",
    },
  });
  await database.insert(agentProfiles).values({
    agentId: BOT,
    title: "",
    roleDescription: "",
    avatarSeed: BOT,
    visibility: "private",
  });
  // Seven conversations on the install; three are enough to be several. Every one is NAMED after its
  // Bot, as every channel is, and titled by what was said in it, newest first.
  for (const [index, conversation] of CONVERSATIONS.entries()) {
    const at = new Date(Date.now() - (index + 1) * 60_000);
    await database.insert(channels).values({
      id: conversation.id,
      name: "General Assistant",
      description: "",
      summary: conversation.title,
      summaryAt: at,
      lastMessage: "Done.",
      lastMessageAt: at,
      lastMessageAgentId: BOT,
    });
    await database
      .insert(channelMemberships)
      .values({ channelId: conversation.id, userId: OWNER });
    await database
      .insert(channelAgents)
      .values({ channelId: conversation.id, agentId: BOT });
    await database.insert(intelligenceChannelMappings).values({
      userId: OWNER,
      channelId: conversation.id,
      threadId: conversation.threadId,
    });
  }
  // Routines, added and given to this Bot exactly as boot does it for every Bot.
  routinesWereAdded =
    routinesWereAdded ||
    Boolean(await pluginStore.serverAddress(ALWAYS_ON_APP));
  await ensureAlwaysOnApp(pluginStore, {
    ...personalDefaultsDeps(database),
    bots: async () => [BOT],
  });
  useRoutineTools(routineStore);
});

afterEach(async () => {
  useRoutineTools(null);
  for (const name of VARIABLES) {
    const value = saved[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  await endpoint?.stop();
  endpoint = undefined;
});

afterAll(async () => {
  await clean();
  if (!routinesWereAdded)
    await database.delete(mcpServers).where(eq(mcpServers.id, ALWAYS_ON_APP));
  await database.$client.end({ timeout: 5 });
});

describe("a routine asked for in a conversation", () => {
  test("is made for that conversation, with no question about where it posts", async () => {
    endpoint = startOpenAICompatibleEndpoint({
      responses: [
        "routine-asked-in-conversation-1.sse",
        "routine-asked-in-conversation-2.sse",
      ],
    });

    const events = await ask(ASKED_IN.threadId);

    const made = await routinesOfOwner();
    expect(made).toHaveLength(1);
    expect(made[0]).toMatchObject({
      agentId: BOT,
      channelId: ASKED_IN.id,
      cron: "*/15 * * * *",
      enabled: true,
    });
    // The model was told it is set, and where, by the title the person sees in the sidebar.
    const answers = toolOutputs(endpoint.conversations[1]);
    expect(answers).toHaveLength(1);
    expect(answers[0]).toContain("That routine is set:");
    expect(answers[0]).toContain(`in "${ASKED_IN.title}"`);
    expect(answers[0]).not.toContain("General Assistant");
    // And nobody is asked where to post it.
    expect(argumentsOf(events, "askChoice")).toEqual([]);
    expect(events.some((event) => event.type === "RUN_ERROR")).toBe(false);
  });
});

describe("a routine asked for by a Bot running its own loop", () => {
  test("is made for the conversation its signed run is in", async () => {
    // The other door to the same store: a framework Bot calls back over HTTP, and the conversation
    // it is in arrives in the run assertion this deployment signed for it, never in the arguments.
    const config = loadConfig(
      testEnvironment({ AGENT_TOOL_TOKEN: "deployment-wide-agent-token" }),
    );
    const parameters = new Array(createApp.length) as unknown as Parameters<
      typeof createApp
    >;
    parameters[0] = config;
    parameters[14] = pluginStore;

    const response = await createApp(...parameters).request(
      "http://openbot.local/api/agent-tools/call",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-openbot-agent-token": "deployment-wide-agent-token",
        },
        body: JSON.stringify({
          name: "mcp__routines__create_routine",
          args: {
            instruction:
              "Reply with the current UTC time and the words 'routine check from EKS'.",
            cron: "*/15 * * * *",
          },
          run: mintRunAssertion(
            {
              botId: BOT,
              actorId: OWNER,
              runId: `run-${suite}`,
              threadId: ASKED_IN.threadId,
            },
            config.keyEncryptionKey,
          ),
        }),
      },
    );

    expect(response.status).toBe(200);
    const answer = (await response.json()) as {
      text: string;
      isError: boolean;
    };
    expect(answer.isError).toBe(false);
    expect(answer.text).toContain(`in "${ASKED_IN.title}"`);
    const made = await routinesOfOwner();
    expect(made.map((routine) => routine.channelId)).toEqual([ASKED_IN.id]);
  });
});

describe("a routine asked for where there is no conversation", () => {
  test("asks which conversation, offering each by the title the sidebar shows", async () => {
    endpoint = startOpenAICompatibleEndpoint({
      responses: [
        "routine-asked-without-conversation-1.sse",
        "routine-asked-without-conversation-2.sse",
      ],
    });

    // The direct chat with a Bot runs on a thread this deployment keeps no conversation for.
    const events = await ask(`routine-conversation-direct-chat-${suite}`);

    expect(await routinesOfOwner()).toEqual([]);
    // What the model was handed to ask with: every conversation by its title and its id, and never
    // by the channel's name, which is General Assistant for all of them.
    const answers = toolOutputs(endpoint.conversations[1]);
    expect(answers).toHaveLength(1);
    for (const conversation of CONVERSATIONS)
      expect(answers[0]).toContain(
        `"${conversation.title}" (id: ${conversation.id})`,
      );
    expect(answers[0]).not.toContain("General Assistant");
    // What OpenAI's model did with it, recorded: the choice card, one option per conversation,
    // labelled with its title and answering with its id.
    const [question] = argumentsOf(events, "askChoice") as {
      options: { id: string; label: string }[];
    }[];
    expect(
      question?.options.map((option) => [option.id, option.label]),
    ).toEqual(
      CONVERSATIONS.map((conversation) => [
        conversation.id,
        conversation.title,
      ]),
    );
  });
});
