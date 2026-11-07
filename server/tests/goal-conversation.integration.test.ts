import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { createAuditStore } from "../src/audit";
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
  responsibilities,
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
import { useGoalTools } from "../src/responsibilities/chat-tools";
import { createResponsibilityStore } from "../src/responsibilities/store";
import { createRoutineStore } from "../src/routines/store";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * A goal asked for in a conversation, from the Bot's tool to the goal on the Bot's Goals page.
 *
 * FOUND ON WINDOWS: asked for a goal, the Personal Assistant said it had no goals tool and set up a
 * routine instead. A goal's tools were only handed to a goal's own run; a conversation held the
 * Routines app, whose trigger tools asked for a goal's id from `list_goals`, a tool it never had.
 *
 * Real: PostgreSQL, the plugin store with the Routines app added and granted as boot does it for
 * every Bot, each call made through the store's own `callTool` (grant, policy, trail, transport),
 * and the goal and routine stores behind it. The goal store's target check stands in for the
 * server's, which reads the same membership through the channel store.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = randomUUID().slice(0, 8);
const OWNER = `goal-conversation-owner-${suite}`;
const BOT = `goal-conversation-assistant-${suite}`;
const CONVERSATIONS = [
  {
    id: `goal-conversation-releases-${suite}`,
    threadId: `goal-conversation-releases-thread-${suite}`,
    title: "CopilotKit OpenBot release tracking",
  },
  {
    id: `goal-conversation-other-${suite}`,
    threadId: `goal-conversation-other-thread-${suite}`,
    title: "Private sign-in on herokuapp login page",
  },
] as const;
const [ASKED_IN, OTHER] = CONVERSATIONS;

const pluginStore = createPluginStore({
  brokerProvider: "composio",
  database,
  auditStore: createAuditStore(database),
  credentials: {} as never,
  encryptionKey: "x".repeat(44),
  // Allowed, as a person who has not turned on Ask before acting has it.
  policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
});
const goalStore = createResponsibilityStore(database, {
  resolveTarget: async (ownerUserId, agentId, channelId) => {
    const [row] = await database
      .select({ threadId: intelligenceChannelMappings.threadId })
      .from(intelligenceChannelMappings)
      .innerJoin(
        channelAgents,
        and(
          eq(channelAgents.channelId, intelligenceChannelMappings.channelId),
          eq(channelAgents.agentId, agentId),
        ),
      )
      .where(
        and(
          eq(intelligenceChannelMappings.userId, ownerUserId),
          eq(intelligenceChannelMappings.channelId, channelId),
        ),
      );
    return row ? { threadId: row.threadId } : null;
  },
});
const ingested: unknown[] = [];
let routinesWereAdded = false;

const call = (tool: string, args: Record<string, unknown>, threadId?: string) =>
  pluginStore.callTool({
    ref: `${ALWAYS_ON_APP}/${tool}`,
    args,
    botId: BOT,
    actorId: OWNER,
    ...(threadId ? { threadId } : {}),
  });

async function clean() {
  await database
    .delete(responsibilities)
    .where(eq(responsibilities.ownerUserId, OWNER));
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
  ingested.length = 0;
  await database.insert(users).values({
    id: OWNER,
    email: `${OWNER}@example.test`,
    name: "Goal Conversation Test User",
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
  for (const [index, conversation] of CONVERSATIONS.entries()) {
    const at = new Date(Date.now() - (index + 1) * 60_000);
    await database.insert(channels).values({
      id: conversation.id,
      name: "Personal Assistant",
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
  const routineStore = createRoutineStore(database);
  useRoutineTools(routineStore);
  useGoalTools({
    store: goalStore,
    engine: {
      ingest: async (event) => {
        ingested.push(event);
        return { duplicate: false } as never;
      },
    },
    conversationFor: routineStore.conversationFor,
  });
});

afterAll(async () => {
  useRoutineTools(null);
  useGoalTools(null);
  await clean();
  if (!routinesWereAdded)
    await database.delete(mcpServers).where(eq(mcpServers.id, ALWAYS_ON_APP));
  await database.$client.end({ timeout: 5 });
});

describe("a goal asked for in a conversation", () => {
  test("every Bot holds the goal tools beside its routine tools", async () => {
    const held = (
      await grantedTools({ store: pluginStore, botId: BOT, actorId: OWNER })
    ).map((tool) => tool.name);
    for (const name of [
      "create_goal",
      "list_goals",
      "update_goal",
      "run_goal",
      "pause_goal",
      "resume_goal",
      "complete_goal",
    ])
      expect(held).toContain(`mcp__${ALWAYS_ON_APP}__${name}`);
    expect(held).toContain(`mcp__${ALWAYS_ON_APP}__create_routine`);
    // Progress is recorded by the run working on a goal, never from a conversation.
    expect(held).not.toContain(`mcp__${ALWAYS_ON_APP}__report_goal_progress`);
  });

  test("is made in the conversation it was asked in, listed, run, paused and completed", async () => {
    const made = await call(
      "create_goal",
      {
        title: "Watch OpenBot releases",
        instruction:
          "Check github.com/CopilotKit/OpenBot/releases and report any tag newer than the last one.",
        successCriteria: "The person hears about each new release.",
        // As a live model sent them for "this conversation" and "no events".
        channelId: "",
        subscriptions: [],
      },
      ASKED_IN.threadId,
    );
    expect(made.isError).toBe(false);
    expect(made.text).toContain("That goal is set.");
    expect(made.text).toContain("no schedule of its own");

    const goals = await database
      .select()
      .from(responsibilities)
      .where(eq(responsibilities.ownerUserId, OWNER));
    expect(goals).toHaveLength(1);
    const [goal] = goals;
    expect(goal).toMatchObject({
      agentId: BOT,
      channelId: ASKED_IN.id,
      threadId: ASKED_IN.threadId,
      title: "Watch OpenBot releases",
      status: "active",
      subscriptions: [],
    });

    const listed = await call("list_goals", {}, ASKED_IN.threadId);
    expect(listed.isError).toBe(false);
    expect(listed.text).toContain(goal?.id ?? "missing");

    // A field left blank in a change is left as it was.
    const changed = await call("update_goal", {
      id: goal?.id,
      patch: { title: "Watch every OpenBot release", instruction: "" },
    });
    expect(changed.isError).toBe(false);
    expect(await goalStore.get(OWNER, goal?.id ?? "")).toMatchObject({
      title: "Watch every OpenBot release",
      instruction: goal?.instruction,
    });

    expect((await call("run_goal", { id: goal?.id })).isError).toBe(false);
    expect(ingested).toEqual([
      expect.objectContaining({
        ownerUserId: OWNER,
        responsibilityId: goal?.id,
        source: "manual",
      }),
    ]);

    expect((await call("pause_goal", { id: goal?.id })).isError).toBe(false);
    expect((await goalStore.get(OWNER, goal?.id ?? "")).status).toBe("paused");
    expect((await call("complete_goal", { id: goal?.id })).isError).toBe(false);
    expect((await goalStore.get(OWNER, goal?.id ?? "")).status).toBe(
      "completed",
    );
  });

  test("goes to another conversation they share only when it is named", async () => {
    const made = await call(
      "create_goal",
      {
        title: "Watch sign-ins",
        instruction: "Check the sign-in page still loads.",
        successCriteria: "It loads.",
        channelId: OTHER.id,
      },
      ASKED_IN.threadId,
    );
    expect(made.isError).toBe(false);
    const [goal] = await database
      .select()
      .from(responsibilities)
      .where(eq(responsibilities.ownerUserId, OWNER));
    expect(goal?.channelId).toBe(OTHER.id);
  });

  test("with no conversation to go on, the Bot is told the ones to ask about", async () => {
    const made = await call("create_goal", {
      title: "Watch OpenBot releases",
      instruction: "Check the releases page.",
      successCriteria: "Each new release is reported.",
    });
    expect(made.isError).toBe(true);
    expect(made.text).toContain(ASKED_IN.title);
    expect(made.text).toContain(OTHER.title);
    expect(
      await database
        .select()
        .from(responsibilities)
        .where(eq(responsibilities.ownerUserId, OWNER)),
    ).toEqual([]);
  });

  test("another person's goal is not this Bot's to touch", async () => {
    const theirs = await call("pause_goal", { id: randomUUID() });
    expect(theirs.isError).toBe(true);
    expect(theirs.text).toContain("This goal could not be found.");
  });
});
