import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { Hono, type MiddlewareHandler } from "hono";
import { createActivityStore } from "../src/activity/activity";
import { createAgentProfileStore } from "../src/agents/profile-store";
import type { AgentActor } from "../src/agents/profile-types";
import type { AppVariables } from "../src/auth/guards";
import { createChannelStore } from "../src/channels/routes";
import { createThreadIdentity } from "../src/channels/thread-identity";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  channelAgents,
  channels,
  intelligenceChannelMappings,
  responsibilities,
  routines,
  users,
} from "../src/db/schema";
import { callTool, useRoutineTools } from "../src/plugins/builtin-routines";
import { useGoalTools } from "../src/responsibilities/chat-tools";
import { createResponsibilityStore } from "../src/responsibilities/store";
import { createRoutineRoutes } from "../src/routines/routes";
import { createRoutineStore } from "../src/routines/store";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * A routine's title, from the person's words to the Routines page and the Bot page.
 *
 * Found on Windows: asked for "a daily routine called Morning briefing", the Bot said its routine
 * tool could not take a custom title, named the routine something of its own, and then printed
 * "Id: routine_34f7…" to the person. The tool had no title field, and every result labelled the
 * internal id the same way as the facts meant for the person.
 *
 * Real: PostgreSQL, the routine store behind the builtin Routines tools exactly as the server
 * installs it, the Routines page's own route, and the Bot page's Activity read.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const profileStore = createAgentProfileStore(
  database,
  new URL("https://managed.example.test/ag-ui"),
);
const channelStore = createChannelStore(
  database,
  profileStore,
  createThreadIdentity("test-deployment"),
);
const store = createRoutineStore(database);
const activity = createActivityStore(database);
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

const prefix = `routine-title-${randomUUID()}`;
const createdUserIds: string[] = [];
const createdAgentIds: string[] = [];
const createdChannelIds: string[] = [];

afterEach(async () => {
  useRoutineTools(null);
  useGoalTools(null);
  for (const userId of createdUserIds) {
    await database.delete(routines).where(eq(routines.ownerUserId, userId));
    await database
      .delete(responsibilities)
      .where(eq(responsibilities.ownerUserId, userId));
  }
  for (const channelId of createdChannelIds.splice(0)) {
    await database
      .delete(intelligenceChannelMappings)
      .where(eq(intelligenceChannelMappings.channelId, channelId));
    await database.delete(channels).where(eq(channels.id, channelId));
  }
  for (const agentId of createdAgentIds.splice(0)) {
    await database
      .delete(agentProfiles)
      .where(eq(agentProfiles.agentId, agentId));
    await database.delete(agents).where(eq(agents.id, agentId));
  }
  for (const userId of createdUserIds.splice(0)) {
    await database.delete(users).where(eq(users.id, userId));
  }
});

afterAll(async () => {
  await database.$client.close();
});

/** A person, a Bot, the one conversation they share, and the tools installed as the server does. */
async function setUp() {
  const id = `${prefix}-user-${randomUUID()}`;
  await database.insert(users).values({
    id,
    email: `${id}@example.test`,
    name: "Routine Title Test User",
  });
  createdUserIds.push(id);
  const owner: AgentActor = { id, role: "user" };
  const profile = await profileStore.create(owner, {
    name: "Briefer",
    title: "Briefings",
    roleDescription: "Write the morning briefing.",
    visibility: "private",
  });
  createdAgentIds.push(profile.id);
  const channel = await channelStore.create(owner, [profile.id]);
  createdChannelIds.push(channel.id);
  useRoutineTools(store);
  useGoalTools({
    store: goalStore,
    engine: { ingest: async () => ({ duplicate: false }) as never },
    conversationFor: store.conversationFor,
  });
  const connection = {
    url: "builtin://routines/",
    actorId: owner.id,
    botId: profile.id,
  };
  return { owner, agentId: profile.id, channel, connection };
}

/** The Routines page's read, through its own route, as the signed-in owner. */
async function routinesPage(owner: AgentActor) {
  const signedIn: MiddlewareHandler<{ Variables: AppVariables }> = async (
    context,
    next,
  ) => {
    context.set("actor", { ...owner, email: `${owner.id}@example.test` });
    await next();
  };
  const app = new Hono<{ Variables: AppVariables }>();
  app.route("/", createRoutineRoutes(store, signedIn));
  const response = await app.request("http://openbot.test/");
  expect(response.status).toBe(200);
  return (await response.json()) as {
    routines: Array<{ id: string; title: string | null; instruction: string }>;
  };
}

describe("a routine the person names", () => {
  test("keeps their title, and the Routines page and the Bot page show it", async () => {
    const { owner, agentId, connection } = await setUp();

    const result = await callTool(connection, "create_routine", {
      title: "Morning briefing",
      instruction: "Summarise my unread mail and today's meetings.",
      cron: "0 8 * * *",
      timezone: "UTC",
    });

    expect(result.isError).toBe(false);
    expect(result.text).toContain('"Morning briefing"');
    const [row] = await database
      .select()
      .from(routines)
      .where(eq(routines.ownerUserId, owner.id));
    expect(row?.title).toBe("Morning briefing");

    const page = await routinesPage(owner);
    expect(page.routines).toEqual([
      expect.objectContaining({
        id: row?.id,
        title: "Morning briefing",
        instruction: "Summarise my unread mail and today's meetings.",
      }),
    ]);

    const scheduled = (await activity.forBot(owner.id, agentId)).scheduled.find(
      (item) => item.id === `routine:${row?.id}`,
    );
    expect(scheduled?.title).toBe("Morning briefing");
  });

  test("can be renamed in their words, and the rest of it stays as it was", async () => {
    const { owner, connection } = await setUp();
    await callTool(connection, "create_routine", {
      title: "Morning briefing",
      instruction: "Summarise my unread mail.",
      cron: "0 8 * * *",
      timezone: "UTC",
    });
    const [created] = await database
      .select()
      .from(routines)
      .where(eq(routines.ownerUserId, owner.id));

    const result = await callTool(connection, "update_routine", {
      id: created?.id,
      title: "Inbox sweep",
    });

    expect(result.isError).toBe(false);
    expect(result.text).toContain('"Inbox sweep"');
    const [renamed] = await database
      .select()
      .from(routines)
      .where(eq(routines.id, created?.id ?? ""));
    expect(renamed).toMatchObject({
      title: "Inbox sweep",
      instruction: "Summarise my unread mail.",
      cron: "0 8 * * *",
    });
  });

  test("with no title is named by its instruction, as before", async () => {
    const { owner, agentId, connection } = await setUp();
    await callTool(connection, "create_routine", {
      instruction: "Summarise my unread mail.",
      cron: "0 8 * * *",
      timezone: "UTC",
    });

    const page = await routinesPage(owner);
    expect(page.routines[0]?.title).toBeNull();
    const scheduled = (await activity.forBot(owner.id, agentId)).scheduled.find(
      (item) => item.kind === "routine",
    );
    expect(scheduled?.title).toBe("Summarise my unread mail.");
  });

  test("a title past 100 characters is refused in a sentence, and nothing is created", async () => {
    const { owner, connection } = await setUp();
    const result = await callTool(connection, "create_routine", {
      title: "x".repeat(101),
      instruction: "Summarise my unread mail.",
      cron: "0 8 * * *",
    });

    expect(result).toMatchObject({
      isError: true,
      text: "A routine's title can be at most 100 characters.",
    });
    expect(
      await database
        .select()
        .from(routines)
        .where(eq(routines.ownerUserId, owner.id)),
    ).toEqual([]);
  });
});

/*
 * FOUND ON WINDOWS: asked to "make a goal to check the latest OpenBot release every morning and tell
 * me what changed", a Bot made the goal "Track OpenBot releases" and, with no title as its tool says,
 * a daily routine to run it. The Bot's page and Activity listed that routine by the sentence the Bot
 * wrote for the next turn: `Run the existing goal "Track OpenBot releases" and report its result in
 * this conversation.`
 */
describe("a routine a Bot makes to run one of its goals", () => {
  const instruction =
    "Run the existing goal \u201cTrack OpenBot releases\u201d and report its result in this conversation.";

  async function withGoal() {
    const setup = await setUp();
    const goal = await callTool(setup.connection, "create_goal", {
      title: "Track OpenBot releases",
      instruction: "Check the latest OpenBot release and say what changed.",
      successCriteria: "The person is told what changed in the latest release.",
      recurring: true,
    });
    expect(goal.isError).toBe(false);
    const [made] = await database
      .select({ id: responsibilities.id })
      .from(responsibilities)
      .where(eq(responsibilities.ownerUserId, setup.owner.id));
    if (!made) throw new Error("The goal was not made.");
    return { ...setup, goalId: made.id };
  }

  test("carries the goal's title, on the Routines page and under Scheduled", async () => {
    const { owner, agentId, connection, goalId } = await withGoal();

    const result = await callTool(connection, "create_routine", {
      instruction,
      goalId,
      cron: "0 8 * * *",
      timezone: "UTC",
    });

    expect(result.isError).toBe(false);
    expect(result.text).toContain('"Track OpenBot releases", instruction');
    const page = await routinesPage(owner);
    expect(page.routines).toEqual([
      expect.objectContaining({ title: "Track OpenBot releases", instruction }),
    ]);
    const scheduled = (await activity.forBot(owner.id, agentId)).scheduled;
    expect(scheduled.find((item) => item.kind === "routine")?.title).toBe(
      "Track OpenBot releases",
    );
    expect(scheduled.map((item) => item.title)).not.toContain(instruction);
  });

  test("keeps the title the person gave it", async () => {
    const { owner, connection, goalId } = await withGoal();

    await callTool(connection, "create_routine", {
      title: "Morning release check",
      instruction,
      goalId,
      cron: "0 8 * * *",
      timezone: "UTC",
    });

    expect((await routinesPage(owner)).routines[0]?.title).toBe(
      "Morning release check",
    );
  });

  test("runs no goal of another Bot's, and stays untitled", async () => {
    const { owner } = await withGoal();
    const other = await profileStore.create(owner, {
      name: "Other",
      title: "Other",
      roleDescription: "Something else.",
      visibility: "private",
    });
    createdAgentIds.push(other.id);
    const channel = await channelStore.create(owner, [other.id]);
    createdChannelIds.push(channel.id);

    await callTool(
      { url: "builtin://routines/", actorId: owner.id, botId: other.id },
      "create_routine",
      { instruction, cron: "0 8 * * *", timezone: "UTC" },
    );

    expect((await routinesPage(owner)).routines[0]?.title).toBeNull();
  });
});

describe("the routine's id", () => {
  test("is in every result for the tools, labelled as never for the person", async () => {
    const { owner, connection } = await setUp();
    const created = await callTool(connection, "create_routine", {
      title: "Morning briefing",
      instruction: "Summarise my unread mail.",
      cron: "0 8 * * *",
      timezone: "UTC",
    });
    const [row] = await database
      .select()
      .from(routines)
      .where(eq(routines.ownerUserId, owner.id));
    const listed = await callTool(connection, "list_routines", {});

    for (const result of [created, listed]) {
      expect(result.text).toContain(
        `id for your routine tools only, never shown to the person: ${row?.id}`,
      );
      // The bare label a Bot read straight out to the person.
      expect(result.text).not.toMatch(/(^|[^a-z ])id: routine_/i);
    }
  });
});
