import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { TurnRunner } from "@openbot/toolkit/run-turn";
import { eq } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { createAgentProfileStore } from "../src/agents/profile-store";
import type { AgentActor } from "../src/agents/profile-types";
import type { AppVariables } from "../src/auth/guards";
import { createChannelStore } from "../src/channels/routes";
import { createThreadIdentity } from "../src/channels/thread-identity";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  channels,
  intelligenceChannelMappings,
  routines,
  users,
} from "../src/db/schema";
import { createRoutineRoutes } from "../src/routines/routes";
import { createRoutineRunner } from "../src/routines/runner";
import { createRoutineStore } from "../src/routines/store";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * New routine, from the Routines page, against a real PostgreSQL: the page's create writes through
 * the same store call a Bot's `create_routine` makes, the routine is listed where the Routines page
 * and the Bot's own Routines page read it, and Run now carries it out through the real runner.
 *
 * The model is the one thing not dialled: `runTurn` is the boundary where a turn would leave for
 * the Bot, so it answers here with what it was asked to do.
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

const testPrefix = `routine-from-page-${randomUUID()}`;
const createdUserIds: string[] = [];
const createdAgentIds: string[] = [];
const createdChannelIds: string[] = [];

afterEach(async () => {
  for (const userId of createdUserIds) {
    await database.delete(routines).where(eq(routines.ownerUserId, userId));
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

async function createUser(): Promise<AgentActor> {
  const id = `${testPrefix}-user-${randomUUID()}`;
  await database.insert(users).values({
    id,
    email: `${id}@example.test`,
    name: "Routine Page Test User",
  });
  createdUserIds.push(id);
  return { id, role: "user" };
}

async function createBot(owner: AgentActor, name: string) {
  const profile = await profileStore.create(owner, {
    name,
    title: "Sales Operations",
    roleDescription: "Summarise new leads.",
    visibility: "private",
  });
  createdAgentIds.push(profile.id);
  return profile.id;
}

async function createChannel(owner: AgentActor, agentIds: string[]) {
  const channel = await channelStore.create(owner, agentIds);
  createdChannelIds.push(channel.id);
  return channel;
}

/** The routines API as the browser reaches it, signed in as `owner`. */
function appFor(owner: AgentActor, runTurn: TurnRunner) {
  const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
    context,
    next,
  ) => {
    context.set("actor", {
      id: owner.id,
      email: `${owner.id}@example.test`,
      role: "user",
    } as AppVariables["actor"]);
    await next();
  };
  const app = new Hono<{ Variables: AppVariables }>();
  app.route(
    "/api/routines",
    createRoutineRoutes(store, requireUser, {
      runner: createRoutineRunner({
        routineStore: store,
        channelStore,
        runTurn,
      }),
    }),
  );
  return app;
}

function post(app: Hono<{ Variables: AppVariables }>, body: unknown) {
  return app.request("http://openbot.test/api/routines", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

type ListedRoutine = {
  id: string;
  agentId: string;
  schedule: string;
  timezone: string;
  instruction: string;
  title: string | null;
  channel: { id: string };
  enabled: boolean;
  lastRun: { status: string | null } | null;
};

async function listed(app: Hono<{ Variables: AppVariables }>) {
  const response = await app.request("http://openbot.test/api/routines");
  expect(response.status).toBe(200);
  return ((await response.json()) as { routines: ListedRoutine[] }).routines;
}

describe("New routine from the Routines page", () => {
  test("is created through the routine store, listed on both pages, and runs through the real runner", async () => {
    const owner = await createUser();
    const leadsBot = await createBot(owner, "Lead Desk");
    const otherBot = await createBot(owner, "Inbox Helper");
    const channel = await createChannel(owner, [leadsBot]);
    const turns: Parameters<TurnRunner>[0][] = [];
    const app = appFor(owner, async (turn) => {
      turns.push(turn);
      return { replyText: `Done: ${turn.instruction}` };
    });

    // What the form sends for "Every weekday at 9:00 AM", in the person's own time zone.
    const created = await post(app, {
      agentId: leadsBot,
      instruction: "Send me a summary of yesterday's new leads",
      title: "Morning leads",
      cron: "0 9 * * 1-5",
      timezone: "Europe/Madrid",
      channelId: channel.id,
    });
    expect(created.status).toBe(201);
    const { routine } = (await created.json()) as { routine: ListedRoutine };
    expect(routine).toMatchObject({
      agentId: leadsBot,
      title: "Morning leads",
      schedule: "Weekdays at 09:00",
      timezone: "Europe/Madrid",
      enabled: true,
      channel: { id: channel.id },
    });

    // The Routines page lists every routine; a Bot's page lists only that Bot's, from the same read.
    const all = await listed(app);
    expect(all.map((row) => row.id)).toEqual([routine.id]);
    expect(
      all.filter((row) => row.agentId === leadsBot).map((row) => row.id),
    ).toEqual([routine.id]);
    expect(all.filter((row) => row.agentId === otherBot)).toEqual([]);

    // Run now: the real runner, the real run row, the reply recorded in the conversation.
    const ran = await app.request(
      `http://openbot.test/api/routines/${routine.id}/run`,
      { method: "POST" },
    );
    expect(ran.status).toBe(202);
    const deadline = Date.now() + 10_000;
    let status: string | null = null;
    while (status !== "succeeded" && Date.now() < deadline) {
      const runs = await app.request(
        `http://openbot.test/api/routines/${routine.id}/runs`,
      );
      status =
        ((await runs.json()) as { runs: { status: string }[] }).runs[0]
          ?.status ?? null;
      if (status !== "succeeded")
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(status).toBe("succeeded");
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({
      ownerUserId: owner.id,
      agentId: leadsBot,
      routineId: routine.id,
      threadId: channel.threadId,
      instruction: "Send me a summary of yesterday's new leads",
    });
    expect((await listed(app))[0]?.lastRun?.status).toBe("succeeded");
    const [conversation] = await database
      .select({ lastMessage: channels.lastMessage })
      .from(channels)
      .where(eq(channels.id, channel.id));
    expect(conversation?.lastMessage).toBe(
      "Done: Send me a summary of yesterday's new leads",
    );
  });

  test("Every hour reads back in words", async () => {
    const owner = await createUser();
    const bot = await createBot(owner, "Ticket Watch");
    const channel = await createChannel(owner, [bot]);
    const app = appFor(owner, async () => ({ replyText: "ok" }));
    const created = await post(app, {
      agentId: bot,
      instruction: "Check for new urgent tickets",
      cron: "0 * * * *",
      timezone: "UTC",
      channelId: channel.id,
    });
    expect(created.status).toBe(201);
    expect(
      ((await created.json()) as { routine: ListedRoutine }).routine.schedule,
    ).toBe("Every hour");
  });

  test("refuses in words a person can act on, and creates nothing", async () => {
    const owner = await createUser();
    const stranger = await createUser();
    const bot = await createBot(owner, "Lead Desk");
    const otherBot = await createBot(owner, "Inbox Helper");
    const channel = await createChannel(owner, [bot]);
    const elsewhere = await createChannel(owner, [otherBot]);
    const strangersChannel = await createChannel(stranger, [
      await createBot(stranger, "Their Bot"),
    ]);
    const app = appFor(owner, async () => ({ replyText: "ok" }));
    const valid = {
      agentId: bot,
      instruction: "Send me the new leads",
      cron: "0 9 * * *",
      timezone: "UTC",
      channelId: channel.id,
    };

    const refusals: [unknown, string][] = [
      [{ ...valid, channelId: undefined }, "Choose a conversation"],
      [{ ...valid, instruction: "  " }, "Say what the Bot should do."],
      [{ ...valid, agentId: "" }, "Choose a Bot for this routine."],
      [{ ...valid, cron: "*/5 * * * *" }, "at most every 15 minutes"],
      // A conversation the Bot is not in, and somebody else's conversation, read the same.
      [{ ...valid, channelId: elsewhere.id }, "This Bot isn't in that"],
      [{ ...valid, channelId: strangersChannel.id }, "This Bot isn't in that"],
    ];
    for (const [body, words] of refusals) {
      const response = await post(app, body);
      expect(response.status).toBe(400);
      expect(((await response.json()) as { error: string }).error).toContain(
        words,
      );
    }
    expect(await listed(app)).toEqual([]);

    // And what one person creates, nobody else sees.
    expect((await post(app, valid)).status).toBe(201);
    const strangerApp = appFor(stranger, async () => ({ replyText: "ok" }));
    expect(await listed(strangerApp)).toEqual([]);
  });
});
