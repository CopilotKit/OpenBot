import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { AuditInitiator } from "../src/audit";
import { createAuditStore } from "../src/audit";
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
  mcpServers,
  pluginGrants,
  users,
} from "../src/db/schema";
import {
  ALWAYS_ON_APP,
  ensureAlwaysOnApp,
  personalDefaultsDeps,
} from "../src/plugins/personal-defaults";
import { createPluginStore } from "../src/plugins/store";
import { grantedTools } from "../src/plugins/tools";
import { withoutGoalCopiesInGoalRun } from "../src/responsibilities/chat-tools";
import { responsibilityTools } from "../src/responsibilities/tools";
import { loadTenantPackage } from "../src/tenant-package";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import {
  type OpenAICompatibleEndpoint,
  startOpenAICompatibleEndpoint,
} from "./support/openai-compatible-endpoint";

/**
 * The tools a goal's own run puts in front of the model, one per job.
 *
 * FOUND AFTER #1159: Routines began carrying a goal's tools for conversations, and every Bot holds
 * Routines, so a goal's run was sent its own `create_goal` and `mcp__routines__create_goal` beside
 * it, and so on for each goal tool: two tools for one job, under two names and two descriptions.
 *
 * Real: PostgreSQL, the Routines app added and granted as boot does it, the Bot built the way the
 * server builds a built-in Bot with the loader the server hands a run, and the request the model
 * endpoint received. The goal's own tools ride the run as the headless runner sends them.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = randomUUID().slice(0, 8);
const OWNER = `goal-run-tools-owner-${suite}`;
const BOT = `goal-run-tools-assistant-${suite}`;
const GOAL_RUN: AuditInitiator = {
  kind: "responsibility",
  id: `goal-${suite}`,
};
const CONVERSATION: AuditInitiator = { kind: "person" };

const pluginStore = createPluginStore({
  brokerProvider: "composio",
  database,
  auditStore: createAuditStore(database),
  credentials: {} as never,
  encryptionKey: "x".repeat(44),
  policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
});

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
let routinesWereAdded = false;

/** The goal's own tools, as the headless runner sends them with the run. */
const goalRunTools = responsibilityTools({
  store: {} as never,
  engine: {} as never,
  ownerUserId: OWNER,
  agentId: BOT,
  channelId: "goal-conversation",
  responsibilityRunId: "goal-run",
}).map((tool) => ({
  name: tool.name,
  description: tool.description,
  parameters: z.toJSONSchema(tool.parameters),
}));

/** What the model was sent in one run of the Bot, started as `initiator`. */
async function toolsSentFor(initiator: AuditInitiator, runTools: unknown[]) {
  endpoint = startOpenAICompatibleEndpoint();
  for (const name of VARIABLES) delete process.env[name];
  process.env.OPENAI_BASE_URL = endpoint.baseUrl;
  normalizeModelBaseUrls();
  const packageModel = (
    await loadTenantPackage(
      new URL("../../examples/personal", import.meta.url).pathname,
    )
  ).model;
  const model = runtimeModelForEnvironment(packageModel);
  chooseOpenAIApi(model);
  const built = await resolveRuntimeAgents(
    async () => [
      {
        id: BOT,
        name: "Personal Assistant",
        type: "built_in" as const,
        systemPrompt: "You are a personal assistant.",
      },
    ],
    model,
    async () => "synthetic-model-key",
    undefined,
    // The loader index.ts hands the agent resolver, for a run started as `initiator`.
    withoutGoalCopiesInGoalRun(initiator, (botId) =>
      grantedTools({ store: pluginStore, botId, actorId: OWNER, initiator }),
    ),
  );
  const agent = built[BOT];
  if (!agent) throw new Error("The Bot was not built.");
  agent.threadId = `thread-${randomUUID()}`;
  agent.setMessages([
    { id: `person-${suite}`, role: "user", content: "Work on the goal." },
  ]);
  await agent.runAgent({
    runId: `run-${randomUUID()}`,
    tools: runTools as never,
  });
  const [request] = endpoint.requests;
  if (!request) throw new Error("The model was never asked.");
  return request.tools;
}

/** A tool's job: its name without the app it came through (`mcp__<app>__<tool>`). */
function jobOf(name: string) {
  const parts = name.split("__");
  return parts[0] === "mcp" && parts.length >= 3
    ? parts.slice(2).join("__")
    : name;
}

async function clean() {
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
    name: "Goal Run Tools Test User",
  });
  await database.insert(agents).values({
    id: BOT,
    name: "Personal Assistant",
    type: "built_in",
    configuration: { systemPrompt: "You are a personal assistant." },
  });
  await database.insert(agentProfiles).values({
    agentId: BOT,
    title: "",
    roleDescription: "",
    avatarSeed: BOT,
    visibility: "private",
  });
  routinesWereAdded =
    routinesWereAdded ||
    Boolean(await pluginStore.serverAddress(ALWAYS_ON_APP));
  await ensureAlwaysOnApp(pluginStore, {
    ...personalDefaultsDeps(database),
    bots: async () => [BOT],
  });
});

afterEach(async () => {
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

describe("a goal's own run", () => {
  test("is sent one tool for each job, its own goal tools and none of Routines' copies", async () => {
    const sent = await toolsSentFor(GOAL_RUN, goalRunTools);
    const jobs = sent.map(jobOf);
    const twice = jobs.filter((job, index) => jobs.indexOf(job) !== index);
    expect(twice).toEqual([]);
    for (const name of [
      "create_goal",
      "list_goals",
      "update_goal",
      "report_goal_progress",
      "run_goal",
      "pause_goal",
      "resume_goal",
      "complete_goal",
    ])
      expect(sent).toContain(name);
    expect(sent).not.toContain(`mcp__${ALWAYS_ON_APP}__create_goal`);
    // The rest of Routines stays: a goal's run can still set up a routine or a trigger.
    expect(sent).toContain(`mcp__${ALWAYS_ON_APP}__create_routine`);
    expect(sent).toContain(`mcp__${ALWAYS_ON_APP}__create_trigger`);
  });

  test("a conversation keeps Routines' goal tools, the only ones it has", async () => {
    const sent = await toolsSentFor(CONVERSATION, []);
    expect(sent).toContain(`mcp__${ALWAYS_ON_APP}__create_goal`);
    expect(sent).toContain(`mcp__${ALWAYS_ON_APP}__list_goals`);
    expect(sent).not.toContain("create_goal");
  });
});
