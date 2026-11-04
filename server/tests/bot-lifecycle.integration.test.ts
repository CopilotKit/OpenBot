import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { createActivityStore } from "../src/activity/activity";
import { HANDOFF_KIND } from "../src/agents/handoff";
import {
  BotPausedError,
  configureBotLifecycle,
  configuredPauses,
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
import { users } from "../src/db/schema/core";
import { workItems } from "../src/db/schema/work";
import { createRoutineRunner } from "../src/routines/runner";
import {
  removeBots,
  seedBot,
  storedPreferences,
  useTestConfiguration,
} from "./support/bots";
import {
  deleteConversation,
  purgeConversations,
  seedConversation,
  storedConversation,
} from "./support/conversations";
import { itemsOf, purgeSchedulesOf } from "./support/check-ins";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { useTestPolicy } from "./support/policy";
import { removeTestMemory, testMemory } from "./support/memory";
import {
  seedResponsibility,
  seedRoutine,
  testScheduleClient,
  useTestSchedules,
} from "./support/schedules";

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
/** Memory lives in Intelligence; these name what the tests seed there. */
const memory = testMemory(createDatabase(testDatabaseUrl(), TEST_POOL));
const ownMemoryId = new Map<string, string>();
const formedMemoryId = new Map<string, string>();
const bot = `${prefix}-bot`;
const helper = `${prefix}-helper`;
const direct = `${prefix}-direct`;
const shared = `${prefix}-shared`;
const othersDirect = `${prefix}-others-direct`;

/** A check-in setting as a person turning check-ins on makes one, in Intelligence. */
async function checkInSetting(input: {
  id: string;
  ownerUserId: string;
  channelId: string;
  threadId: string;
  enabled?: boolean;
}) {
  return (await useTestSchedules()).create("check-in-settings", {
    agentId: bot,
    focus: "",
    enabled: true,
    intervalMinutes: 60,
    nextRunAt: new Date(Date.now() + 3_600_000),
    lastRunAt: null,
    lastStatus: "idle",
    lastError: null,
    ...input,
  });
}

beforeAll(async () => {
  await useTestSchedules();
  await useTestPolicy();
  await useTestConfiguration();
  configureBotLifecycle({ pauses: configuredPauses });
  await database.insert(users).values([
    { id: owner, email: `${owner}@example.test` },
    { id: other, email: `${other}@example.test` },
  ]);
  for (const [id, name] of [
    [bot, "Lifecycle Bot"],
    [helper, "Helper Bot"],
  ] as const)
    await seedBot({
      id,
      name,
      type: "built_in",
      ownerUserId: owner,
      title: id,
      roleDescription: "Test",
      visibility: "public",
    });
  // Conversations live in Intelligence: each with the Bot in it, its last word the Bot's, unread.
  for (const [id, members] of [
    [direct, [owner]],
    [shared, [owner, other]],
    [othersDirect, [other]],
  ] as const)
    await seedConversation({
      id,
      name: id,
      description: "",
      lastMessage: "hello",
      lastMessageAt: new Date(),
      lastMessageAgentId: bot,
      agentIds: [bot],
      members: members.map((userId) => ({ userId, threadId: null })),
    });
  for (const person of [owner, other]) {
    await seedRoutine({
      id: `${prefix}-routine-${person}`,
      ownerUserId: person,
      agentId: bot,
      channelId: person === owner ? direct : othersDirect,
      instruction: "Summarise the day",
      nextRunAt: new Date(Date.now() + 3_600_000),
    });
    await seedResponsibility({
      id: `${prefix}-goal-${person}`,
      ownerUserId: person,
      agentId: bot,
      channelId: person === owner ? direct : othersDirect,
      threadId: `${prefix}-thread-${person}`,
      title: "Keep the build green",
      instruction: "Watch CI",
      successCriteria: "Green",
    });
    await memory.intelligence.createSource({
      id: `source-${randomUUID()}-${person === owner ? "owner" : "other"}`,
      userId: person,
      agentId: bot,
      connectorRef: "docs/read",
      title: "Docs",
    });
    const [source] = await memory.intelligence.sources({ userId: person });
    await memory.intelligence.importRecords(person, source?.id as string, [
      {
        externalId: "1",
        content: "Launch is Tuesday",
        contentDigest: "launch",
        provenance: "Docs",
      },
    ]);
    // A memory of the person's own, from no source: not this Bot's, so a reset keeps it.
    const own = await memory.intelligence.createMemory(person, {
      content: "Prefers mornings",
      provenance: "You",
      formedBy: "person",
    });
    ownMemoryId.set(person, own.id);
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
  await purgeConversations([direct, shared, othersDirect]);
  await removeBots([bot, helper]);
  await database
    .delete(users)
    .where(inArray(users.id, [owner, other, `${prefix}-chooser`]));
});

describe("pause", () => {
  const lifecycle = createBotLifecycleStore();

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

  test("a responsibility is standing work, and its run says what woke it", async () => {
    const client = testScheduleClient();
    const eventId = `${prefix}-event`;
    await client.create("responsibility-events", {
      id: eventId,
      ownerUserId: owner,
      source: "github",
      externalId: `${prefix}-push`,
      type: "push",
      payload: {},
    });
    const runId = `${prefix}-goal-run`;
    await client.create("responsibility-runs", {
      id: runId,
      responsibilityId: `${prefix}-goal-${owner}`,
      eventId,
      status: "queued",
      replyText: null,
      error: null,
      waiting: null,
      continuation: null,
      startedAt: null,
      finishedAt: null,
    });
    try {
      const result = await activity.forBot(owner, bot);
      expect(result.scheduled).toContainEqual(
        expect.objectContaining({
          id: `responsibility:${prefix}-goal-${owner}`,
          kind: "responsibility",
          status: "active",
          channelId: direct,
        }),
      );
      expect(result.scheduled).toContainEqual(
        expect.objectContaining({
          id: `responsibility-run:${runId}`,
          status: "queued",
          detail: "github/push",
        }),
      );
      expect(
        [...result.scheduled, ...result.inProgress, ...result.completed].some(
          (item) => item.id === `responsibility:${prefix}-goal-${other}`,
        ),
      ).toBe(false);
    } finally {
      await client.purge("responsibility-runs", runId);
      await client.purge("responsibility-events", eventId);
    }
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
  const lifecycle = createBotLifecycleStore();

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
    memory: memory.store,
    softDeleteChannel: async (_actor, channelId) => {
      softDeleted.push(channelId);
      await deleteConversation(channelId);
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
    const kept = await memory.intelligence.getMemory(
      owner,
      ownMemoryId.get(owner) as string,
    );
    expect(kept?.invalidatedAt).toBeNull();
    expect((await storedConversation(shared)).deletedAt).toBeNull();
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

  test("a reset also takes what the Bot formed, its research and the permissions it was given", async () => {
    for (const person of [owner, other]) {
      const formed = await memory.intelligence.createMemory(person, {
        content: "Owns the billing service",
        provenance: "Read from GitHub",
        formedBy: "agent",
        agentId: bot,
        reviewState: "unreviewed",
      });
      formedMemoryId.set(person, formed.id);
      await checkInSetting({
        id: `${prefix}-research-${person}`,
        ownerUserId: person,
        channelId: person === owner ? direct : othersDirect,
        threadId: `${prefix}-research-thread-${person}`,
      });
      await testScheduleClient().create("check-in-suggestions", {
        id: `${prefix}-suggestion-${person}`,
        ownerUserId: person,
        agentId: bot,
        settingId: `${prefix}-research-${person}`,
        runId: "run-1",
        title: "Review the PR",
        detail: "It waits on you",
        sourceApp: null,
        sourceRef: null,
        sourceLink: null,
        status: "open",
        dedupeKey: null,
        pingId: null,
        deliveredAt: null,
        resolvedAt: null,
      });
      const rules = await useTestPolicy();
      await rules.createApprovalRule({
        id: `${prefix}-allow-${person}`,
        ownerUserId: person,
        agentId: bot,
        tool: "mail/send",
        effect: "send",
        scope: "*",
        behaviour: "allow",
      });
      // A rule that makes the Bot ask first protects the person, so a reset leaves it.
      await rules.createApprovalRule({
        id: `${prefix}-ask-${person}`,
        ownerUserId: person,
        agentId: bot,
        tool: "files/delete",
        effect: "delete",
        scope: "*",
        behaviour: "ask",
      });
    }

    const plan = await reset.plan(owner, bot);
    expect(plan).toMatchObject({
      formedMemories: 1,
      backgroundResearch: 1,
      standingApprovals: 1,
    });
    expect(await reset.execute({ id: owner, role: "user" }, bot)).toEqual(plan);
    expect(await reset.plan(owner, bot)).toMatchObject({
      formedMemories: 0,
      backgroundResearch: 0,
      standingApprovals: 0,
    });

    const left = async (
      table: "memory" | "research" | "rules",
      person: string,
    ) =>
      table === "memory"
        ? memory.intelligence
            .getMemory(person, formedMemoryId.get(person) as string)
            .then((found) => (found ? [found] : []))
        : table === "research"
          ? itemsOf(person)
          : // As Intelligence holds them now, past this process's memory.
            (await useTestPolicy()).client
              .approvalRules({ ownerUserId: person })
              .then(({ items }) => items.map((rule) => ({ id: rule.id })));
    expect(await left("memory", owner)).toHaveLength(0);
    expect(await left("research", owner)).toHaveLength(0);
    expect((await left("rules", owner)).map((row) => row.id)).toEqual([
      `${prefix}-ask-${owner}`,
    ]);
    // The other person's identical rows survive.
    expect(await left("memory", other)).toHaveLength(1);
    expect(await left("research", other)).toHaveLength(1);
    expect(await left("rules", other)).toHaveLength(2);
    expect(await reset.plan(other, bot)).toMatchObject({
      formedMemories: 1,
      backgroundResearch: 1,
      standingApprovals: 1,
    });
  });

  // Turning a default off protects the person, so starting fresh keeps it off rather than handing
  // the Bot back what they took away (memory/defaults.ts adopts again on their next turn).
  test("a reset keeps the person's no to a default, and only the no", async () => {
    const person = `${prefix}-chooser`;
    await database
      .insert(users)
      .values({ id: person, email: `${person}@example.test` });
    await memory.intelligence.createSource({
      userId: person,
      connectorRef: "mail/search",
      title: "Mail",
      enabled: false,
    });
    await memory.intelligence.createSource({
      userId: person,
      agentId: bot,
      connectorRef: "calendar/list",
      title: "Calendar",
    });
    await checkInSetting({
      id: `${prefix}-off-research`,
      ownerUserId: person,
      channelId: direct,
      threadId: `${prefix}-off-research-thread`,
      enabled: false,
    });

    await reset.execute({ id: person, role: "user" }, bot);

    const declined = (await storedPreferences(person)).optOuts
      .filter((optOut) => optOut.botId === bot)
      .map((optOut) => ({ feature: optOut.feature, scope: optOut.scope }));
    expect(declined.sort((a, b) => a.feature.localeCompare(b.feature))).toEqual(
      [
        { feature: "memory_source", scope: "mail" },
        { feature: "proactive_research", scope: "" },
      ],
    );
    expect(await memory.intelligence.sources({ userId: person })).toEqual([]);
  });
});

afterAll(async () => {
  await removeTestMemory([owner, other, `${prefix}-chooser`]);
  await purgeSchedulesOf([owner, other, `${prefix}-chooser`]);
  await database.$client.close();
});
