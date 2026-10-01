import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { createActivityStore } from "../src/activity/activity";
import { HANDOFF_KIND } from "../src/agents/handoff";
import {
  BotPausedError,
  configureBotLifecycle,
  createBotLifecycleStore,
  guardBotTurn,
  isBotPaused,
  resetBotLifecycleForTests,
  resolveUpdateRoute,
} from "../src/agents/lifecycle";
import { createBotReset } from "../src/agents/lifecycle-reset";
import {
  createWakeUpStore,
  WAKE_UP_KIND,
  WAKE_UP_MAX_PENDING,
  WakeUpRefusedError,
  wakeUpTools,
} from "../src/agents/wake-up";
import { createDatabase } from "../src/db/client";
import { approvalRequests } from "../src/db/schema/approvals";
import {
  agents,
  channelAgents,
  channelMemberships,
  channels,
  users,
} from "../src/db/schema/core";
import { agentProfiles, routines } from "../src/db/schema/coworker";
import { memorySources, personalMemories } from "../src/db/schema/memory";
import { responsibilities } from "../src/db/schema/responsibilities";
import { workItems } from "../src/db/schema/work";
import { createRoutineRunner } from "../src/routines/runner";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * Pause, reset, Activity, attention, follow-ups and update routing against a real PostgreSQL.
 *
 * Every assertion that something was deleted or counted is paired with one that the other person's
 * identical data was not: "never touches other users' data" is the property, and a test that only
 * looks at the owner's rows cannot tell a scoped delete from a table-wide one.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `lifecycle-${randomUUID()}`;
const owner = `${prefix}-owner`;
const other = `${prefix}-other`;
const bot = `${prefix}-bot`;
const helper = `${prefix}-helper`;
const direct = `${prefix}-direct`;
const shared = `${prefix}-shared`;
const othersDirect = `${prefix}-others-direct`;

beforeAll(async () => {
  configureBotLifecycle({ database });
  await database.insert(users).values([
    { id: owner, email: `${owner}@example.test` },
    { id: other, email: `${other}@example.test` },
  ]);
  await database.insert(agents).values([
    { id: bot, name: "Lifecycle Bot", type: "built_in", configuration: {} },
    { id: helper, name: "Helper Bot", type: "built_in", configuration: {} },
  ]);
  await database.insert(agentProfiles).values(
    [bot, helper].map((agentId) => ({
      agentId,
      ownerUserId: owner,
      title: agentId,
      roleDescription: "Test",
      avatarSeed: agentId,
      visibility: "public" as const,
    })),
  );
  await database.insert(channels).values(
    [direct, shared, othersDirect].map((id) => ({
      id,
      name: id,
      description: "",
      lastMessage: "hello",
      lastMessageAt: new Date(),
      lastMessageAgentId: bot,
    })),
  );
  await database.insert(channelMemberships).values([
    { channelId: direct, userId: owner },
    { channelId: shared, userId: owner },
    { channelId: shared, userId: other },
    { channelId: othersDirect, userId: other },
  ]);
  await database.insert(channelAgents).values([
    { channelId: direct, agentId: bot },
    { channelId: shared, agentId: bot },
    { channelId: othersDirect, agentId: bot },
  ]);
  for (const person of [owner, other]) {
    await database.insert(routines).values({
      id: `${prefix}-routine-${person}`,
      ownerUserId: person,
      agentId: bot,
      channelId: person === owner ? direct : othersDirect,
      instruction: "Summarise the day",
      cron: "0 9 * * *",
      nextRunAt: new Date(Date.now() + 3_600_000),
    });
    await database.insert(responsibilities).values({
      id: `${prefix}-goal-${person}`,
      ownerUserId: person,
      agentId: bot,
      channelId: person === owner ? direct : othersDirect,
      threadId: `${prefix}-thread-${person}`,
      title: "Keep the build green",
      instruction: "Watch CI",
      successCriteria: "Green",
    });
    await database.insert(memorySources).values({
      id: `${prefix}-source-${person}`,
      ownerUserId: person,
      agentId: bot,
      toolRef: "docs/read",
      title: "Docs",
    });
    await database.insert(personalMemories).values([
      {
        id: `${prefix}-memory-${person}-1`,
        ownerUserId: person,
        sourceId: `${prefix}-source-${person}`,
        content: "Launch is Tuesday",
        provenance: "Docs",
      },
      // A memory of the person's own, from no source: not this Bot's, so a reset keeps it.
      {
        id: `${prefix}-memory-${person}-own`,
        ownerUserId: person,
        content: "Prefers mornings",
        provenance: "You",
      },
    ]);
  }
  await database.insert(workItems).values([
    {
      kind: HANDOFF_KIND,
      key: `${prefix}-hop-queued`,
      payload: {
        fromBotId: bot,
        toBotId: helper,
        actorId: owner,
        threadId: `${prefix}-thread-${owner}`,
        task: "Find the invoice",
        toName: "Helper Bot",
      },
    },
    {
      kind: HANDOFF_KIND,
      key: `${prefix}-hop-gave-up`,
      attempts: 5,
      payload: {
        fromBotId: bot,
        toBotId: helper,
        actorId: owner,
        threadId: `${prefix}-thread-${owner}`,
        task: "Check the contract",
      },
    },
    {
      kind: HANDOFF_KIND,
      key: `${prefix}-hop-others`,
      payload: {
        fromBotId: bot,
        toBotId: helper,
        actorId: other,
        threadId: `${prefix}-thread-${other}`,
        task: "Not yours",
      },
    },
    {
      kind: "person.question",
      key: `${prefix}-question`,
      payload: {
        actorId: owner,
        botId: bot,
        threadId: `${prefix}-thread-${owner}`,
        runId: "r1",
        question: "Which account?",
        mode: "completed_question",
        channelId: direct,
      },
    },
  ]);
  await database.insert(approvalRequests).values({
    id: `${prefix}-approval`,
    ownerUserId: owner,
    runId: "r1",
    toolCallId: "t1",
    actionDigest: "d",
    action: {
      actorId: owner,
      botId: bot,
      toolRef: "mail/send",
      effect: "send",
      scope: "once",
      args: {},
      runId: "r1",
      threadId: `${prefix}-thread-${owner}`,
      toolCallId: "t1",
      actionDigest: "d",
    },
  });
});

afterAll(async () => {
  resetBotLifecycleForTests();
  await database
    .delete(workItems)
    .where(sql`${workItems.key} like ${`%${prefix}%`}`);
  await database
    .delete(approvalRequests)
    .where(eq(approvalRequests.ownerUserId, owner));
  await database
    .delete(channels)
    .where(inArray(channels.id, [direct, shared, othersDirect]));
  await database.delete(agents).where(inArray(agents.id, [bot, helper]));
  await database.delete(users).where(inArray(users.id, [owner, other]));
});

describe("pause", () => {
  const lifecycle = createBotLifecycleStore(database);

  test("pausing is one person's, and a headless turn refuses to start", async () => {
    await lifecycle.pause(owner, bot);
    expect(await isBotPaused(owner, bot)).toBe(true);
    expect(await isBotPaused(other, bot)).toBe(false);
    await expect(
      guardBotTurn({ ownerUserId: owner, agentId: bot }),
    ).rejects.toBeInstanceOf(BotPausedError);
    await lifecycle.resume(owner, bot);
    expect(await isBotPaused(owner, bot)).toBe(false);
  });

  test("pausing stops the turn that is running", async () => {
    const signal = await guardBotTurn({ ownerUserId: owner, agentId: bot });
    const othersSignal = await guardBotTurn({
      ownerUserId: other,
      agentId: bot,
    });
    expect(signal.aborted).toBe(false);
    expect(await lifecycle.pause(owner, bot)).toBe(1);
    expect(signal.aborted).toBe(true);
    expect(othersSignal.aborted).toBe(false);
    await lifecycle.resume(owner, bot);
  });

  test("a routine firing for a paused Bot is skipped, never run", async () => {
    await lifecycle.pause(owner, bot);
    const finished: [string, string, string | undefined][] = [];
    let ran = false;
    const runner = createRoutineRunner({
      routineStore: {
        runContext: async () => ({
          routineId: "r",
          ownerUserId: owner,
          agentId: bot,
          channelId: direct,
          instruction: "x",
          enabled: true,
        }),
        finishRun: async (id: string, status: string, reason?: string) =>
          void finished.push([id, status, reason]),
      } as never,
      channelStore: {
        get: async () => ({ id: direct, threadId: "t" }),
        recordActivity: async () => {},
      } as never,
      runTurn: async () => {
        ran = true;
        return { replyText: "no" };
      },
    });
    await runner.run("run-1");
    expect(ran).toBe(false);
    expect(finished[0]?.[1]).toBe("skipped");
    await lifecycle.resume(owner, bot);
  });
});

describe("Activity and attention", () => {
  const activity = createActivityStore(database);

  test("sections hold the owner's work and nobody else's", async () => {
    const result = await activity.forBot(owner, bot);
    const all = [
      ...result.inProgress,
      ...result.scheduled,
      ...result.completed,
    ];
    expect(all.some((item) => item.title === "Not yours")).toBe(false);
    expect(
      result.scheduled.some(
        (item) => item.kind === "routine" && item.channelId === direct,
      ),
    ).toBe(true);
    expect(
      result.scheduled.some(
        (item) => item.kind === "handoff" && item.stoppable,
      ),
    ).toBe(true);
    expect(
      result.inProgress.some(
        (item) => item.kind === "approval" && item.needsYou,
      ),
    ).toBe(true);
    expect(
      result.inProgress.some(
        (item) => item.kind === "question" && item.channelId === direct,
      ),
    ).toBe(true);
    expect(
      result.inProgress.some(
        (item) => item.kind === "handoff" && item.status === "failed",
      ),
    ).toBe(true);
  });

  test("attention counts what waits on this person", async () => {
    const [row] = (await activity.attention(owner)).filter(
      (entry) => entry.agentId === bot,
    );
    expect(row).toMatchObject({
      questions: 1,
      approvals: 1,
      handoffs: 1,
      unread: 2,
    });
    const [others] = (await activity.attention(other)).filter(
      (entry) => entry.agentId === bot,
    );
    expect(others).toMatchObject({ questions: 0, approvals: 0, unread: 2 });
  });

  test("stopping a delegated task finishes only that person's hop", async () => {
    expect(
      await activity.stopHandoff(other, bot, `${prefix}-hop-queued`),
    ).toBeNull();
    const stopped = await activity.stopHandoff(
      owner,
      bot,
      `${prefix}-hop-queued`,
    );
    expect(stopped?.toBotId).toBe(helper);
    const result = await activity.forBot(owner, bot);
    expect(
      result.completed.find((item) => item.id === `${prefix}-hop-queued`)
        ?.status,
    ).toBe("stopped");
  });
});

describe("follow-ups", () => {
  const wakeUps = createWakeUpStore(database);

  test("are bounded in time and in number, and cancellable", async () => {
    await expect(
      wakeUps.schedule({
        ownerUserId: owner,
        agentId: bot,
        reason: "too soon",
        dueAt: new Date(Date.now() + 1_000),
      }),
    ).rejects.toBeInstanceOf(WakeUpRefusedError);
    await expect(
      wakeUps.schedule({
        ownerUserId: owner,
        agentId: bot,
        reason: "too late",
        dueAt: new Date(Date.now() + 8 * 24 * 3_600_000),
      }),
    ).rejects.toBeInstanceOf(WakeUpRefusedError);

    const [tool] = wakeUpTools({
      store: wakeUps,
      ownerUserId: owner,
      agentId: bot,
    });
    const answers: string[] = [];
    for (let i = 0; i <= WAKE_UP_MAX_PENDING; i += 1)
      answers.push(
        await tool!.execute({ reason: `check ${i}`, in_minutes: 60 }),
      );
    expect(answers.filter((a) => a.startsWith("Refused."))).toHaveLength(1);

    const scheduled = (
      await createActivityStore(database).forBot(owner, bot)
    ).scheduled.filter((item) => item.kind === "follow_up");
    expect(scheduled).toHaveLength(WAKE_UP_MAX_PENDING);
    expect(scheduled.every((item) => item.cancellable)).toBe(true);

    expect(await wakeUps.cancel(other, bot, scheduled[0]!.id)).toBe(false);
    expect(await wakeUps.cancel(owner, bot, scheduled[0]!.id)).toBe(true);
    expect(await wakeUps.cancel(owner, bot, scheduled[0]!.id)).toBe(false);
  });
});

describe("update routing", () => {
  const lifecycle = createBotLifecycleStore(database);

  test("per-Bot notify and per-kind transports decide what leaves the web", async () => {
    let route = await resolveUpdateRoute({
      ownerUserId: owner,
      agentId: bot,
      kind: "reply",
    });
    expect(route.allows("push")).toBe(true);

    await lifecycle.setRouting(owner, "question", ["slack"]);
    route = await resolveUpdateRoute({
      ownerUserId: owner,
      agentId: bot,
      kind: "question",
    });
    expect(route.allows("slack")).toBe(true);
    expect(route.allows("push")).toBe(false);

    await lifecycle.setNotify(owner, bot, "needs_input");
    expect(
      (
        await resolveUpdateRoute({
          ownerUserId: owner,
          agentId: bot,
          kind: "reply",
        })
      ).notify,
    ).toBe(false);
    expect(
      (
        await resolveUpdateRoute({
          ownerUserId: owner,
          agentId: bot,
          kind: "approval",
        })
      ).allows("sms"),
    ).toBe(true);

    await lifecycle.setNotify(owner, bot, "none");
    expect(
      (
        await resolveUpdateRoute({
          ownerUserId: owner,
          agentId: bot,
          kind: "question",
        })
      ).allows("slack"),
    ).toBe(false);
    // Somebody else's preferences are untouched.
    expect(
      (
        await resolveUpdateRoute({
          ownerUserId: other,
          agentId: bot,
          kind: "question",
        })
      ).allows("push"),
    ).toBe(true);
    await lifecycle.setNotify(owner, bot, "all");
    await lifecycle.setRouting(owner, "question", "all");
  });
});

describe("reset", () => {
  const softDeleted: string[] = [];
  const reset = createBotReset({
    database,
    softDeleteChannel: async (_actor, channelId) => {
      softDeleted.push(channelId);
      await database
        .update(channels)
        .set({ deletedAt: new Date() })
        .where(eq(channels.id, channelId));
    },
  });

  test("the notice counts per kind, and the reset deletes only the owner's", async () => {
    const plan = await reset.plan(owner, bot);
    expect(plan).toMatchObject({
      conversations: 1,
      sharedConversationsKept: 1,
      memorySources: 1,
      memories: 1,
      routines: 1,
      responsibilities: 1,
    });
    expect(plan.followUps).toBeGreaterThan(0);

    const deleted = await reset.execute({ id: owner, role: "user" }, bot);
    expect(deleted).toEqual(plan);
    expect(softDeleted).toEqual([direct]);
    expect(await reset.plan(owner, bot)).toMatchObject({
      conversations: 0,
      memories: 0,
      routines: 0,
      responsibilities: 0,
      followUps: 0,
    });

    // The other person's identical data survives, and so does the owner's own memory.
    expect(await reset.plan(other, bot)).toMatchObject({
      conversations: 1,
      memories: 1,
      routines: 1,
      responsibilities: 1,
    });
    const kept = await database
      .select({ id: personalMemories.id })
      .from(personalMemories)
      .where(
        and(
          eq(personalMemories.ownerUserId, owner),
          eq(personalMemories.id, `${prefix}-memory-${owner}-own`),
        ),
      );
    expect(kept).toHaveLength(1);
    const [sharedRow] = await database
      .select({ deletedAt: channels.deletedAt })
      .from(channels)
      .where(eq(channels.id, shared));
    expect(sharedRow?.deletedAt).toBeNull();
    const remaining = await database
      .select({ key: workItems.key })
      .from(workItems)
      .where(
        and(
          eq(workItems.kind, WAKE_UP_KIND),
          sql`${workItems.finishedAt} is null`,
          sql`${workItems.payload}->>'ownerUserId' = ${owner}`,
        ),
      );
    expect(remaining).toHaveLength(0);
  });
});
