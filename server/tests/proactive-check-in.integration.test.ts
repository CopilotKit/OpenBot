import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { randomUUID } from "node:crypto";
import {
  type BaseEvent,
  EventType,
  HttpAgent,
  type RunAgentInput,
} from "@ag-ui/client";
import { createTurnRunner, type RunnerLike } from "@openbot/toolkit/run-turn";
import { and, eq, inArray, sql } from "drizzle-orm";
import { Hono } from "hono";
import { Observable } from "rxjs";
import { createActivityStore } from "../src/activity/activity";
import { serverTurnAdmission } from "../src/agents/turn-admission";
import { createAuditStore } from "../src/audit";
import { createCredentialStore } from "../src/credentials";
import { createDatabase } from "../src/db/client";
import { agents, channels, users } from "../src/db/schema/core";
import { deliveryOutbox } from "../src/db/schema/delivery";
import { botLifecycle } from "../src/db/schema/lifecycle";
import { mcpServers, mcpTools } from "../src/db/schema/plugins";
import {
  proactivePeople,
  proactivePings,
  proactiveRuns,
  proactiveSettings,
  proactiveSuggestions,
} from "../src/db/schema/proactive";
import { botTasks } from "../src/db/schema/tasks";
import { workItems } from "../src/db/schema/work";
import { createDeliveryRouter } from "../src/delivery/router";
import { createDeliveryStore } from "../src/delivery/store";
import { createMemoryStore } from "../src/memory/store";
import { createPluginStore } from "../src/plugins/store";
import type { ProactiveAdmin, TaskService } from "../src/proactive/contracts";
import {
  createProactiveEngine,
  type ProactiveEngine,
} from "../src/proactive/engine";
import { proactiveInitiator } from "../src/proactive/restriction";
import { createProactiveRoutes } from "../src/proactive/routes";
import { createProactiveStore } from "../src/proactive/store";
import {
  ProactiveRefusedError,
  type ProactiveSetting,
} from "../src/proactive/types";
import { createWorkQueue } from "../src/work/queue";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * Check-ins and pings through the real path: real Postgres, the real proactive and delivery stores,
 * the real work queue and the real headless turn runner. The model is the only fake: a scripted
 * AG-UI agent that reads (the audit row a successful connector read writes) and calls the
 * check-in's tools as a model would.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = randomUUID().slice(0, 8);
const owner = `check-in-owner-${suite}`;
const inboxBot = `check-in-inbox-${suite}`;
const calendarBot = `check-in-calendar-${suite}`;
const mail = `check-in-mail-${suite}`;
const listMessages = `${mail}/list_messages`;
/** The name a model calls the read by, which the check-in maps back to its ref. */
const READ_TOOL = `mcp__${mail}__list_messages`;
const inboxChannel = `check-in-inbox-channel-${suite}`;
const calendarChannel = `check-in-calendar-channel-${suite}`;
const taskChannel = `check-in-task-channel-${suite}`;
const device = `check-in-device-${suite}`;

const auditStore = createAuditStore(database);
const plugins = createPluginStore({
  brokerProvider: "composio",
  database,
  auditStore,
  credentials: createCredentialStore(database),
  encryptionKey: Buffer.alloc(32, 7).toString("base64"),
  policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
  callVendor: async () => ({ text: "[]", isError: false }),
});
const store = createProactiveStore(database);
const memory = createMemoryStore(database);
const queue = createWorkQueue(database);
const deliveries = createDeliveryStore(database);
const router = createDeliveryRouter({
  store: deliveries,
  queue,
  owner: `delivery-${suite}`,
  authoriseScope: async () => true,
  runTurn: async () => ({ replyText: "" }),
  providers: {},
});
const activity = createActivityStore(database);

let inbox: ProactiveSetting;
let calendar: ProactiveSetting;
const FAR = new Date("2100-01-01T00:00:00Z");

beforeAll(async () => {
  await database
    .insert(users)
    .values({ id: owner, email: `${owner}@example.test` });
  await database.insert(agents).values([
    { id: inboxBot, name: "Inbox Bot", type: "built_in", configuration: {} },
    {
      id: calendarBot,
      name: "Calendar Bot",
      type: "built_in",
      configuration: {},
    },
  ]);
  await database.insert(channels).values(
    [inboxChannel, calendarChannel, taskChannel].map((id) => ({
      id,
      name: id,
      description: "",
    })),
  );
  await database.insert(mcpServers).values({
    id: mail,
    title: "Mail",
    vendor: "Fixture",
    url: "https://mail.example.test/mcp",
    provenance: "custom",
  });
  await database.insert(mcpTools).values({
    serverId: mail,
    name: "list_messages",
    vendorName: "list_messages",
    effect: "read",
    inputSchema: {},
  });
  await deliveries.registerDevice({
    id: device,
    ownerUserId: owner,
    token: `ExponentPushToken[checkin${suite}]`,
    projectId: randomUUID(),
    platform: "ios",
  });
  inbox = await store.create(
    owner,
    { agentId: inboxBot, channelId: inboxChannel },
    `inbox-thread-${suite}`,
  );
  calendar = await store.create(
    owner,
    { agentId: calendarBot, channelId: calendarChannel },
    `calendar-thread-${suite}`,
  );
});

/** Everything a test left behind, and every setting back to on, idle and not due. */
async function reset() {
  const settings = [inbox.id, calendar.id];
  const outbox = await database
    .select({ id: deliveryOutbox.id })
    .from(deliveryOutbox)
    .where(eq(deliveryOutbox.ownerUserId, owner));
  if (outbox.length)
    await database.delete(workItems).where(
      and(
        eq(workItems.kind, "delivery.outbound"),
        inArray(
          workItems.key,
          outbox.map((row) => row.id),
        ),
      ),
    );
  await database
    .delete(deliveryOutbox)
    .where(eq(deliveryOutbox.ownerUserId, owner));
  await database
    .delete(workItems)
    .where(
      and(
        eq(workItems.kind, "proactive.run"),
        inArray(sql<string>`${workItems.payload}->>'settingId'`, settings),
      ),
    );
  await database.delete(botTasks).where(eq(botTasks.ownerUserId, owner));
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
    .delete(botLifecycle)
    .where(eq(botLifecycle.ownerUserId, owner));
  await database
    .update(users)
    .set({ preferences: sql`${users.preferences} - 'proactive'` })
    .where(eq(users.id, owner));
  await database
    .update(proactiveSettings)
    .set({
      enabled: true,
      nextRunAt: FAR,
      lastRunAt: null,
      lastStatus: "idle",
      lastError: null,
    })
    .where(inArray(proactiveSettings.id, settings));
}
beforeEach(reset);

afterAll(async () => {
  await reset();
  await database.delete(users).where(eq(users.id, owner));
  await database
    .delete(agents)
    .where(inArray(agents.id, [inboxBot, calendarBot]));
  await database
    .delete(channels)
    .where(inArray(channels.id, [inboxChannel, calendarChannel, taskChannel]));
  await database.delete(mcpServers).where(eq(mcpServers.id, mail));
  await database.$client.close();
});

/* ------------------------------------------------------------------------------------------------
 * The scripted model.
 * ---------------------------------------------------------------------------------------------- */

function lifecycle(input: RunAgentInput, body: BaseEvent[]): BaseEvent[] {
  return [
    {
      type: EventType.RUN_STARTED,
      threadId: input.threadId,
      runId: input.runId,
    },
    ...body,
    {
      type: EventType.RUN_FINISHED,
      threadId: input.threadId,
      runId: input.runId,
    },
  ] as BaseEvent[];
}
function toolCall(name: string, args: unknown, id: string): BaseEvent[] {
  return [
    {
      type: EventType.TOOL_CALL_START,
      toolCallId: id,
      toolCallName: name,
      parentMessageId: `m-${id}`,
    },
    {
      type: EventType.TOOL_CALL_ARGS,
      toolCallId: id,
      delta: JSON.stringify(args),
    },
    { type: EventType.TOOL_CALL_END, toolCallId: id },
  ] as BaseEvent[];
}
function reply(text: string): BaseEvent[] {
  return [
    {
      type: EventType.TEXT_MESSAGE_START,
      messageId: "reply",
      role: "assistant",
    },
    { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "reply", delta: text },
    { type: EventType.TEXT_MESSAGE_END, messageId: "reply" },
  ] as BaseEvent[];
}

/** The audit row a successful connector read writes for this check-in: the read, as it happens. */
async function readMail(runId: string) {
  await auditStore.insert({
    eventType: "mcp.call_succeeded",
    targetType: "mcp_tool",
    targetId: listMessages,
    actorUserId: owner,
    initiator: proactiveInitiator(runId),
    payload: {},
  });
}

/**
 * What the model does in one check-in: its first answer, then its answer once the tools it called
 * have answered. Every check-in's turn ends with one line, as the instruction asks.
 */
type Model = (
  input: RunAgentInput,
  afterTools: boolean,
) => Promise<BaseEvent[]>;

const quiet: Model = async () => reply("Looked at the inbox. Nothing new.");

type Call = { name: string; args: Record<string, unknown> };

/** A model that reads the mail, then makes these calls, then says what it looked at. */
function calling(
  calls: Call[],
  options: { read?: boolean; afterTools?: () => Promise<void> } = {},
): Model {
  return async (input, afterTools) => {
    if (afterTools) {
      await options.afterTools?.();
      return reply("Read the inbox since the last check-in.");
    }
    if (options.read !== false) await readMail(input.runId);
    return calls.flatMap((call, index) =>
      toolCall(call.name, call.args, `${input.runId}-${index}`),
    );
  };
}
const raise = (title: string, detail: string, extra = {}): Call => ({
  name: "suggest_next_step",
  args: { title, detail, sourceTool: READ_TOOL, ...extra },
});

/** What the tools answered in a check-in, by the model's call order. */
function answers(requests: RunAgentInput[]): string[] {
  const last = requests.at(-1);
  return (last?.messages ?? [])
    .filter((message) => message.role === "tool")
    .map((message) => String(message.content));
}

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

/**
 * One replica's engine, over the shared database, with the scripted model. `requests` is every call
 * the model received; `turns` every check-in turn started.
 */
function replica(
  options: {
    model?: Model;
    admin?: ProactiveAdmin;
    tasks?: Pick<TaskService, "startFromItem">;
    readableApps?: (ownerUserId: string, agentId: string) => Promise<string[]>;
    denied?: string[];
    reachable?: boolean;
  } = {},
) {
  const requests: RunAgentInput[] = [];
  const turns: { threadId: string; instruction: string; runId?: string }[] = [];
  let engine: ProactiveEngine | undefined;
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
    buildAgentFor: async () =>
      new HttpAgent({
        agentId: "bot",
        url: "https://agent.example/ag-ui",
        fetch: async (_url, init) => {
          const input = JSON.parse(String(init?.body)) as RunAgentInput;
          requests.push(input);
          const afterTools = input.messages.some(
            (message) => message.role === "tool",
          );
          const events = lifecycle(
            input,
            await (options.model ?? quiet)(input, afterTools),
          );
          return new Response(
            events
              .map((event) => `data: ${JSON.stringify(event)}\n\n`)
              .join(""),
            { headers: { "content-type": "text/event-stream" } },
          );
        },
      }),
    toolsForTurn: (input) => (engine as ProactiveEngine).toolsForTurn(input),
  });
  engine = createProactiveEngine({
    store,
    memory,
    queue,
    owner: `replica-${randomUUID()}`,
    runTurn: async (input) => {
      turns.push(input);
      return turn(input);
    },
    resolveScope: async (ownerUserId, channelId, agentId) =>
      options.reachable !== false &&
      ownerUserId === owner &&
      [inboxChannel, calendarChannel].includes(channelId)
        ? { ownerUserId, channelId, agentId, threadId: `${channelId}-thread` }
        : null,
    notify: (scope, input) => router.notify(scope, input),
    ...(options.admin ? { admin: options.admin } : {}),
    ...(options.tasks ? { tasks: options.tasks } : {}),
    ...(options.readableApps ? { readableApps: options.readableApps } : {}),
    catalogue: plugins,
    deniedToolNames: async () => options.denied ?? [],
    mintThreadId: () => `check-in-thread-${randomUUID()}`,
  });
  return { engine, requests, turns };
}

/* ------------------------------------------------------------------------------------------------
 * Reading what happened.
 * ---------------------------------------------------------------------------------------------- */

const due = (setting: ProactiveSetting) =>
  database
    .update(proactiveSettings)
    .set({ nextRunAt: new Date(Date.now() - 1_000) })
    .where(eq(proactiveSettings.id, setting.id));
const runsOf = (setting: ProactiveSetting) => store.runs(setting.id);
const itemsOf = () =>
  database
    .select()
    .from(proactiveSuggestions)
    .where(eq(proactiveSuggestions.ownerUserId, owner))
    .orderBy(proactiveSuggestions.createdAt);
const pingsOf = () =>
  database
    .select()
    .from(proactivePings)
    .where(eq(proactivePings.ownerUserId, owner))
    .orderBy(proactivePings.createdAt);
const outboxOf = () =>
  database
    .select()
    .from(deliveryOutbox)
    .where(eq(deliveryOutbox.ownerUserId, owner));
const slotOf = async () =>
  (
    await database
      .select()
      .from(proactivePeople)
      .where(eq(proactivePeople.ownerUserId, owner))
  )[0] ?? null;
/** The person's slot, taken `minutesAgo` minutes ago. */
async function pingedMinutesAgo(minutesAgo: number) {
  const at = new Date(Date.now() - minutesAgo * 60_000);
  await database
    .insert(proactivePeople)
    .values({ ownerUserId: owner, lastPingedAt: at })
    .onConflictDoUpdate({
      target: proactivePeople.ownerUserId,
      set: { lastPingedAt: at },
    });
}
/** An open item as an earlier check-in left it. */
async function openItem(
  setting: ProactiveSetting,
  title: string,
  extra: Partial<typeof proactiveSuggestions.$inferInsert> = {},
) {
  return store.addSuggestion({
    ownerUserId: owner,
    agentId: setting.agentId,
    settingId: setting.id,
    runId: `earlier-${randomUUID()}`,
    title,
    detail: `${title}. They asked this morning.`,
    sourceApp: "Mail",
    sourceRef: listMessages,
    sourceLink: null,
    ...extra,
  });
}
/** An item the person hid `days` days ago. */
async function hiddenDaysAgo(
  setting: ProactiveSetting,
  title: string,
  days: number,
) {
  const item = await openItem(setting, title);
  await database
    .update(proactiveSuggestions)
    .set({
      status: "dismissed",
      resolvedAt: new Date(Date.now() - days * 86_400_000),
    })
    .where(eq(proactiveSuggestions.id, item.id));
  return item;
}
async function seedRuns(
  setting: ProactiveSetting,
  runs: {
    outcome: "quiet" | "raised" | "failed" | "skipped";
    hoursAgo: number;
  }[],
) {
  if (!runs.length) return;
  await database.insert(proactiveRuns).values(
    runs.map((run) => {
      const startedAt = new Date(Date.now() - run.hoursAgo * 3_600_000);
      return {
        id: randomUUID(),
        settingId: setting.id,
        ownerUserId: owner,
        agentId: setting.agentId,
        trigger: "schedule" as const,
        outcome: run.outcome,
        skipReason: run.outcome === "skipped" ? ("busy" as const) : null,
        startedAt,
        finishedAt: new Date(startedAt.getTime() + 30_000),
      };
    }),
  );
}
const afterOf = (instruction: string | undefined) =>
  Number(instruction?.match(/after:(\d+)/)?.[1] ?? Number.NaN);

/* ------------------------------------------------------------------------------------------------
 * The tests.
 * ---------------------------------------------------------------------------------------------- */

describe("a check-in", () => {
  test("that finds nothing writes one quiet run row and nothing else: no item, no ping, no delivery, no second turn", async () => {
    // Hourly unless the person chose otherwise.
    expect(inbox.intervalMinutes).toBe(60);
    await due(inbox);
    const { engine, requests, turns } = replica({ model: quiet });
    await engine.sweep();

    const runs = await runsOf(inbox);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      outcome: "quiet",
      trigger: "schedule",
      itemsRaised: 0,
      skipReason: null,
    });
    expect(runs[0]?.finishedAt).toBeInstanceOf(Date);
    // A thread of its own, never the setting's.
    expect(runs[0]?.threadId).toStartWith("check-in-thread-");
    expect(turns.map((entry) => entry.threadId)).toEqual([
      runs[0]?.threadId as string,
    ]);
    expect(requests).toHaveLength(1);
    expect(await itemsOf()).toEqual([]);
    expect(await pingsOf()).toEqual([]);
    expect(await outboxOf()).toEqual([]);
    expect(await slotOf()).toBeNull();
    // Due again an interval later, not sooner.
    const [after] = await database
      .select()
      .from(proactiveSettings)
      .where(eq(proactiveSettings.id, inbox.id));
    expect(after?.nextRunAt.getTime()).toBeGreaterThan(
      Date.now() + 55 * 60_000,
    );
    expect(after?.lastStatus).toBe("succeeded");
  });

  test("a model asking for a write tool is refused, while what it raises is kept with its source and pinged", async () => {
    await due(inbox);
    const { engine, requests } = replica({
      denied: [`mcp__${mail}__send_message`],
      model: calling([
        { name: `mcp__${mail}__send_message`, args: { to: "dana" } },
        raise(
          "Reply to Dana about Friday",
          "Dana asked whether Friday's review still stands.\n\nNext: confirm the time.",
          { sourceLink: "https://mail.example.test/m/1" },
        ),
      ]),
    });
    await engine.sweep();

    expect(requests[0]?.tools.map((tool) => tool.name)).toEqual([
      "suggest_next_step",
      "clear_next_step",
      "form_memory",
    ]);
    const [refusal, raised] = answers(requests);
    expect(refusal).toStartWith("Refused.");
    expect(raised).toContain("suggested");
    const [item] = await itemsOf();
    expect(item).toMatchObject({
      agentId: inboxBot,
      title: "Reply to Dana about Friday",
      sourceApp: "Mail",
      sourceRef: listMessages,
      sourceLink: "https://mail.example.test/m/1",
      dedupeKey: "reply to dana about friday",
      status: "open",
    });
    expect((await runsOf(inbox))[0]).toMatchObject({
      outcome: "raised",
      itemsRaised: 1,
      reads: 1,
    });
    const [ping] = await pingsOf();
    expect(ping).toMatchObject({ itemCount: 1 });
    expect(ping?.text).toBe(
      [
        "One thing needs you",
        "• Inbox Bot: Reply to Dana about Friday. Dana asked whether Friday's review still stands. (from Mail)",
        "Start or hide it in OpenBot.",
      ].join("\n"),
    );
    expect(ping?.pushBody).toBe(
      "One thing needs you: Reply to Dana about Friday",
    );
    expect(ping?.offeredAt).toBeInstanceOf(Date);
    expect(item?.pingId).toBe(ping?.id as string);
    // Until delivery takes pings itself, one notification through the Bot's conversation.
    const outbox = await outboxOf();
    expect(outbox.map((row) => [row.transport, row.dedupeKey])).toEqual([
      ["push", `reply:ping:${ping?.id}:device:${device}`],
    ]);
    expect(outbox[0]?.channelId).toBe(inboxChannel);
  });

  test("a memory is formed only from a read the check-in actually made", async () => {
    await due(inbox);
    const content = `Leads the billing migration ${suite}`;
    const { engine, requests } = replica({
      model: calling([
        {
          name: "form_memory",
          args: { content, sourceTool: `mcp__${mail}__create_draft` },
        },
        { name: "form_memory", args: { content, sourceTool: READ_TOOL } },
      ]),
    });
    await engine.sweep();
    const [unread, formed] = answers(requests);
    expect(unread).toStartWith("Refused.");
    expect(formed).not.toStartWith("Refused.");
    const [row] = (await memory.list(owner)).filter(
      (entry) => entry.content === content,
    );
    expect(row).toMatchObject({
      formedBy: "bot",
      formedByAgentId: inboxBot,
      sourceApp: "Mail",
      sourceRef: listMessages,
      reviewState: "unreviewed",
    });
    await memory.remove(owner, row?.id as string);
  });
});

describe("the gates, before any model call", () => {
  test("a person who turned check-ins off is never claimed, and a Run now is skipped as off_person", async () => {
    await database
      .update(users)
      .set({
        preferences: sql`${users.preferences} || '{"proactive":"off"}'::jsonb`,
      })
      .where(eq(users.id, owner));
    await due(inbox);
    const { engine, requests } = replica();
    await engine.sweep();
    expect(await runsOf(inbox)).toEqual([]);
    // Not claimed, so it is still due the moment they turn check-ins back on.
    expect((await store.get(owner, inbox.id)).nextRunAt.getTime()).toBeLessThan(
      Date.now(),
    );
    expect((await engine.runNow(owner, inbox.id)).queued).toBe(true);
    await engine.sweep();
    expect(await runsOf(inbox)).toMatchObject([
      { outcome: "skipped", skipReason: "off_person", trigger: "run_now" },
    ]);
    expect(requests).toEqual([]);
  });

  test("a Bot the person paused is never claimed, and a Run now is skipped as paused", async () => {
    await database
      .insert(botLifecycle)
      .values({ ownerUserId: owner, agentId: inboxBot, pausedAt: new Date() });
    await due(inbox);
    const { engine, requests } = replica();
    await engine.sweep();
    expect(await runsOf(inbox)).toEqual([]);
    await engine.runNow(owner, inbox.id);
    await engine.sweep();
    expect(await runsOf(inbox)).toMatchObject([
      { outcome: "skipped", skipReason: "paused" },
    ]);
    expect(requests).toEqual([]);
  });

  test("an admin who turned check-ins off skips every check-in as off_admin", async () => {
    await due(inbox);
    const asked: string[] = [];
    const { engine, requests } = replica({
      admin: {
        proactiveAllowed: async (person) => {
          asked.push(person);
          return false;
        },
        proactiveDailyRuns: async () => 24,
      },
    });
    await engine.sweep();
    expect(await runsOf(inbox)).toMatchObject([
      { outcome: "skipped", skipReason: "off_admin" },
    ]);
    expect(asked).toContain(owner);
    expect(requests).toEqual([]);
  });

  test("a Bot that used its day's check-ins is skipped as capped: 24 a day by default, skipped ones not counted", async () => {
    await seedRuns(inbox, [
      ...Array.from({ length: 23 }, (_, index) => ({
        outcome: "quiet" as const,
        hoursAgo: index + 0.5,
      })),
      { outcome: "skipped", hoursAgo: 1 },
      { outcome: "quiet", hoursAgo: 25 },
    ]);
    await due(inbox);
    const first = replica();
    await first.engine.sweep();
    // 23 in the last day, so this one runs: the 24th.
    expect(first.requests).toHaveLength(1);
    await due(inbox);
    const second = replica();
    await second.engine.sweep();
    expect(second.requests).toEqual([]);
    expect((await runsOf(inbox))[0]).toMatchObject({
      outcome: "skipped",
      skipReason: "capped",
    });
    // An admin's own number for this Bot wins.
    await due(inbox);
    const raised = replica({
      admin: {
        proactiveAllowed: async () => true,
        proactiveDailyRuns: async (agentId) => (agentId === inboxBot ? 30 : 1),
      },
    });
    await raised.engine.sweep();
    expect(raised.requests).toHaveLength(1);
  });

  test("a conversation the person can no longer reach is skipped as unreachable", async () => {
    await due(inbox);
    const { engine, requests } = replica({ reachable: false });
    await engine.sweep();
    expect(await runsOf(inbox)).toMatchObject([
      { outcome: "skipped", skipReason: "unreachable" },
    ]);
    expect((await store.get(owner, inbox.id)).lastStatus).toBe("error");
    expect(requests).toEqual([]);
  });

  test("a Bot that can read none of the person's apps is skipped as no_sources, and the model is never called", async () => {
    await due(inbox);
    const asked: string[] = [];
    const nothing = replica({
      readableApps: async (person, agentId) => {
        asked.push(`${person}:${agentId}`);
        return [];
      },
    });
    await nothing.engine.sweep();
    expect(await runsOf(inbox)).toMatchObject([
      { outcome: "skipped", skipReason: "no_sources" },
    ]);
    expect(asked).toEqual([`${owner}:${inboxBot}`]);
    expect(nothing.requests).toEqual([]);
    await due(inbox);
    const mailOnly = replica({ readableApps: async () => [listMessages] });
    await mailOnly.engine.sweep();
    expect(mailOnly.requests).toHaveLength(1);
  });

  test("a check-in already running is skipped as busy, and one a stopped replica left running is closed after its lease", async () => {
    const stuck = randomUUID();
    await database.insert(proactiveRuns).values({
      id: stuck,
      settingId: inbox.id,
      ownerUserId: owner,
      agentId: inboxBot,
      trigger: "schedule",
    });
    await due(inbox);
    const busy = replica();
    await busy.engine.sweep();
    expect(busy.requests).toEqual([]);
    expect(
      (await runsOf(inbox)).map((run) => [run.outcome, run.skipReason]),
    ).toContainEqual(["skipped", "busy"]);

    // Eleven minutes on, the replica that started it is plainly gone.
    await database
      .update(proactiveRuns)
      .set({ startedAt: new Date(Date.now() - 11 * 60_000) })
      .where(eq(proactiveRuns.id, stuck));
    await due(inbox);
    const next = replica();
    await next.engine.sweep();
    const runs = await runsOf(inbox);
    expect(runs.find((run) => run.id === stuck)).toMatchObject({
      outcome: "failed",
    });
    expect(runs[0]).toMatchObject({ outcome: "quiet" });
    expect(next.requests).toHaveLength(1);
  });
});

describe("the window", () => {
  test("the first check-in reads the last day; after a quiet or raised one, since it started; after a failed one, a day", async () => {
    const dayBack = () => Math.floor((Date.now() - 86_400_000) / 1000);

    await due(inbox);
    const first = replica();
    await first.engine.sweep();
    expect(
      Math.abs(afterOf(first.turns[0]?.instruction) - dayBack()),
    ).toBeLessThan(5);
    expect(first.turns[0]?.instruction).toContain(
      "the last day, because no earlier check-in finished",
    );
    const [quietRun] = await runsOf(inbox);

    await due(inbox);
    const second = replica({
      model: calling([
        raise("Send the venue deposit", "The hold ends Friday."),
      ]),
    });
    await second.engine.sweep();
    expect(afterOf(second.turns[0]?.instruction)).toBe(
      Math.floor((quietRun?.startedAt.getTime() ?? 0) / 1000),
    );
    expect(second.turns[0]?.instruction).toContain("when you last checked in");
    const [raisedRun] = await runsOf(inbox);
    expect(raisedRun?.outcome).toBe("raised");

    await due(inbox);
    const third = replica();
    await third.engine.sweep();
    expect(afterOf(third.turns[0]?.instruction)).toBe(
      Math.floor((raisedRun?.startedAt.getTime() ?? 0) / 1000),
    );

    // A check-in whose turn fails leaves the next one reading the whole last day again.
    await due(inbox);
    const failing = replica({
      model: async () => {
        throw new Error("model went away");
      },
    });
    await failing.engine.sweep();
    expect((await runsOf(inbox))[0]).toMatchObject({ outcome: "failed" });
    expect((await store.get(owner, inbox.id)).lastStatus).toBe("error");
    await due(inbox);
    const after = replica();
    await after.engine.sweep();
    expect(
      Math.abs(afterOf(after.turns[0]?.instruction) - dayBack()),
    ).toBeLessThan(5);
  });
});

describe("what a check-in may raise", () => {
  test("an item without a source read in this check-in is refused", async () => {
    await due(inbox);
    const { engine, requests } = replica({
      model: calling(
        [
          raise("Reply to Dana", "Dana asked about Friday."),
          {
            name: "suggest_next_step",
            args: { title: "Reply to Sam", detail: "Sam asked for the spec." },
          },
        ],
        { read: false },
      ),
    });
    await engine.sweep();
    const [unread, unsourced] = answers(requests);
    expect(unread).toStartWith("Refused.");
    expect(unread).toContain("needs a source");
    expect(unsourced).toStartWith("Refused.");
    expect(await itemsOf()).toEqual([]);
    expect((await runsOf(inbox))[0]).toMatchObject({ outcome: "quiet" });
  });

  test("repeats are refused by title or link against open items, open tasks and what was hidden in 30 days; hidden 31 days ago may return", async () => {
    const open = await openItem(
      inbox,
      "Reply to Rosa about the glaze substitute",
    );
    await openItem(inbox, "Answer the supplier", {
      sourceLink: "https://Mail.example.test/m/7/",
    });
    await database.insert(botTasks).values({
      id: randomUUID(),
      ownerUserId: owner,
      agentId: inboxBot,
      channelId: taskChannel,
      title: "Book the kiln technician",
      origin: "check_in",
    });
    await hiddenDaysAgo(inbox, "Renew the market stall", 29);
    await hiddenDaysAgo(inbox, "Order more clay", 31);
    const started = await openItem(inbox, "Pay the studio rent");
    await store.resolveSuggestion(owner, started.id, "started");
    // Another Bot's open item is not this Bot's repeat.
    await openItem(calendar, "Confirm the class schedule");

    await due(inbox);
    const { engine, requests, turns } = replica({
      model: calling([
        raise("reply to Rosa about the glaze  substitute.", "Again."),
        raise("A different wording", "Same mail.", {
          sourceLink: "https://mail.example.test/m/7",
        }),
        raise("book the kiln technician!", "Again."),
        raise("Renew the market stall", "Again."),
        raise("Order more clay", "The bags ran out this week."),
        raise("Confirm the class schedule", "Students asked."),
      ]),
    });
    await engine.sweep();

    const instruction = turns[0]?.instruction ?? "";
    expect(instruction).toContain(
      `- "Reply to Rosa about the glaze substitute" (id: ${open.id})`,
    );
    expect(instruction).toContain(
      'They already have tasks open for these. Do not raise them again:\n- "Book the kiln technician"',
    );
    expect(instruction).toContain(
      'They hid these in the last 30 days. Do not raise these, or things like them:\n- "Renew the market stall" (from Mail)',
    );
    expect(instruction).not.toContain("Order more clay");
    expect(instruction).toContain(
      'They started these in the last 30 days, so this is the kind of thing they act on:\n- "Pay the studio rent"',
    );
    expect(instruction).not.toContain("Confirm the class schedule");

    const results = answers(requests);
    expect(
      results.slice(0, 4).every((text) => text.startsWith("Refused.")),
    ).toBe(true);
    expect(results[0]).toContain("already raised and still open");
    expect(results[1]).toContain('"Answer the supplier" is already raised');
    expect(results[2]).toContain("already have a task");
    expect(results[3]).toContain("They hid");
    expect(results[4]).toContain("suggested");
    expect(results[5]).toContain("suggested");
    const raised = (await itemsOf()).filter(
      (item) => item.agentId === inboxBot && item.status === "open",
    );
    expect(raised.map((item) => item.title).sort()).toEqual([
      "Answer the supplier",
      "Confirm the class schedule",
      "Order more clay",
      "Reply to Rosa about the glaze substitute",
    ]);
  });

  test("two check-ins racing for one Bot cannot both open the same item", async () => {
    const elsewhere = createDatabase(testDatabaseUrl(), TEST_POOL);
    try {
      const other = createProactiveStore(elsewhere);
      const item = (title: string) => ({
        ownerUserId: owner,
        agentId: inboxBot,
        settingId: inbox.id,
        runId: randomUUID(),
        title,
        detail: "Sam asked for the spec.",
        sourceApp: "Mail",
        sourceRef: listMessages,
        sourceLink: null,
      });
      const results = await Promise.allSettled([
        store.addSuggestion(item("Reply to Sam")),
        other.addSuggestion(item("reply to sam.")),
      ]);
      expect(
        results.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(1);
      const [refused] = results.filter(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected",
      );
      expect(refused?.reason).toBeInstanceOf(ProactiveRefusedError);
      expect(await itemsOf()).toHaveLength(1);
    } finally {
      await elsewhere.$client.close();
    }
  });

  test("clear_next_step clears only this setting's open items", async () => {
    const mine = await openItem(inbox, "Reply to Dana");
    const theirs = await openItem(calendar, "Move the standup");
    const decided = await openItem(inbox, "Archive old threads");
    await store.resolveSuggestion(owner, decided.id, "dismissed");
    await due(inbox);
    const clear = (suggestionId: string) => ({
      name: "clear_next_step",
      args: { suggestionId, why: "Dana answered it herself." },
    });
    const { engine, requests } = replica({
      model: calling([
        clear(theirs.id),
        clear(decided.id),
        clear("not-an-item"),
        clear(mine.id),
      ]),
    });
    await engine.sweep();
    const results = answers(requests);
    expect(
      results.slice(0, 3).every((text) => text.startsWith("Refused.")),
    ).toBe(true);
    expect(results[3]).toContain(mine.id);
    const byId = new Map((await itemsOf()).map((item) => [item.id, item]));
    expect(byId.get(mine.id)?.status).toBe("superseded");
    expect(byId.get(theirs.id)?.status).toBe("open");
    expect(byId.get(decided.id)?.status).toBe("dismissed");
    // Clearing is not raising.
    expect((await runsOf(inbox))[0]).toMatchObject({ outcome: "quiet" });
  });
});

describe("the ping", () => {
  test("two replicas finishing check-ins for two Bots of one person together send exactly one ping, folding both Bots' items", async () => {
    // Both check-ins have raised their item before either finishes, as when they end in the same second.
    let arrived = 0;
    let release: () => void = () => {};
    const together = new Promise<void>((resolve) => {
      release = resolve;
    });
    const meet = async () => {
      arrived += 1;
      if (arrived === 2) release();
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        together,
        new Promise((_, reject) => {
          timer = setTimeout(
            () =>
              reject(new Error("The other replica never ran its check-in.")),
            10_000,
          );
        }),
      ]).finally(() => clearTimeout(timer));
    };
    // Whichever replica claims whichever Bot's check-in, each Bot raises its own item.
    const byBot: Record<string, Model> = {
      [inboxBot]: calling(
        [raise("Reply to Dana about Friday", "Dana asked about Friday.")],
        { afterTools: meet },
      ),
      [calendarBot]: calling(
        [raise("Move the standup", "The room is double-booked tomorrow.")],
        { afterTools: meet },
      ),
    };
    const model: Model = async (input, afterTools) => {
      const [run] = await database
        .select({ agentId: proactiveRuns.agentId })
        .from(proactiveRuns)
        .where(eq(proactiveRuns.id, input.runId));
      return (byBot[run?.agentId ?? ""] ?? quiet)(input, afterTools);
    };
    const first = replica({ model });
    const second = replica({ model });
    await first.engine.runNow(owner, inbox.id);
    await second.engine.runNow(owner, calendar.id);
    await Promise.all([first.engine.sweep(), second.engine.sweep()]);

    expect(first.turns).toHaveLength(1);
    expect(second.turns).toHaveLength(1);
    const pings = await pingsOf();
    expect(pings).toHaveLength(1);
    const [ping] = pings;
    expect(ping?.itemCount).toBe(2);
    expect(ping?.text).toStartWith("2 things need you\n");
    expect(ping?.text).toContain(
      "• Inbox Bot: Reply to Dana about Friday. Dana asked about Friday. (from Mail)",
    );
    expect(ping?.text).toContain(
      "• Calendar Bot: Move the standup. The room is double-booked tomorrow. (from Mail)",
    );
    expect(ping?.text).toEndWith("Start or hide them in OpenBot.");
    expect((await itemsOf()).every((item) => item.pingId === ping?.id)).toBe(
      true,
    );
    expect(await outboxOf()).toHaveLength(1);
    expect((await slotOf())?.lastPingedAt).toBeInstanceOf(Date);
  });

  test("an item raised within the hour waits, listed at once; when the hour passes the next pass sends one ping folding everything waiting", async () => {
    await pingedMinutesAgo(20);
    await due(inbox);
    await replica({
      model: calling([raise("Reply to Dana", "Dana asked about Friday.")]),
    }).engine.sweep();
    await due(calendar);
    await replica({
      model: calling([raise("Move the standup", "The room is taken.")]),
    }).engine.sweep();
    expect(await pingsOf()).toEqual([]);
    expect(await outboxOf()).toEqual([]);
    // Waiting, and already on the person's list.
    expect(
      (await store.suggestions(owner)).map((item) => [item.title, item.pingId]),
    ).toEqual([
      ["Move the standup", null],
      ["Reply to Dana", null],
    ]);

    // Another pass inside the hour sends nothing.
    await replica().engine.sweep();
    expect(await pingsOf()).toEqual([]);

    await pingedMinutesAgo(61);
    const pass = replica();
    await pass.engine.sweep();
    const [ping] = await pingsOf();
    expect(ping?.itemCount).toBe(2);
    expect(await outboxOf()).toHaveLength(1);
    // The pass is not a check-in: no model call.
    expect(pass.requests).toEqual([]);
    await replica().engine.sweep();
    expect(await pingsOf()).toHaveLength(1);
  });

  test("a ping written but never offered (the replica stopped after its commit) is offered by a later pass, once", async () => {
    await openItem(inbox, "Reply to Dana");
    // The replica took the slot and wrote the ping, then stopped before delivery.
    const ping = await store.pings.take(owner);
    expect(ping?.items.map((item) => item.agentName)).toEqual(["Inbox Bot"]);
    expect(await outboxOf()).toEqual([]);

    // Too fresh to be another replica's business yet.
    await replica().engine.sweep();
    expect(await outboxOf()).toEqual([]);

    await database
      .update(proactivePings)
      .set({ createdAt: new Date(Date.now() - 2 * 60_000) })
      .where(eq(proactivePings.id, ping?.pingId as string));
    await replica().engine.sweep();
    expect(await outboxOf()).toHaveLength(1);
    expect((await pingsOf())[0]?.offeredAt).toBeInstanceOf(Date);
    await replica().engine.sweep();
    expect(await outboxOf()).toHaveLength(1);

    // Offered again all the same (a replica that stopped after delivery, before marking it): still one send.
    await database
      .update(proactivePings)
      .set({ offeredAt: null })
      .where(eq(proactivePings.id, ping?.pingId as string));
    await replica().engine.sweep();
    expect(await outboxOf()).toHaveLength(1);
    expect(await pingsOf()).toHaveLength(1);
  });

  test("items started, hidden or cleared before the ping are not in it", async () => {
    const kept = await openItem(inbox, "Reply to Dana");
    const started = await openItem(inbox, "Pay the rent");
    const hidden = await openItem(inbox, "Archive old threads");
    const cleared = await openItem(inbox, "Answer the supplier");
    await store.resolveSuggestion(owner, started.id, "started");
    await store.resolveSuggestion(owner, hidden.id, "dismissed");
    await store.clearSuggestion(inbox.id, cleared.id);

    await replica().engine.sweep();
    const [ping] = await pingsOf();
    expect(ping?.itemCount).toBe(1);
    expect(ping?.text).toContain("Reply to Dana");
    for (const title of [
      "Pay the rent",
      "Archive old threads",
      "Answer the supplier",
    ])
      expect(ping?.text).not.toContain(title);
    const byId = new Map((await itemsOf()).map((item) => [item.id, item]));
    expect(byId.get(kept.id)?.pingId).toBe(ping?.id as string);
    expect(byId.get(hidden.id)?.pingId).toBeNull();
  });

  test("a Bot set to notify nothing never holds the slot: its items stay listed and are never pinged", async () => {
    await database
      .insert(botLifecycle)
      .values({ ownerUserId: owner, agentId: inboxBot, notify: "none" });
    await openItem(inbox, "Reply to Dana");
    await replica().engine.sweep();
    expect(await pingsOf()).toEqual([]);
    expect((await slotOf())?.lastPingedAt ?? null).toBeNull();
    expect(await store.suggestions(owner)).toHaveLength(1);

    await openItem(calendar, "Move the standup");
    await replica().engine.sweep();
    const [ping] = await pingsOf();
    expect(ping?.itemCount).toBe(1);
    expect(ping?.text).toContain("Calendar Bot: Move the standup");
    expect(ping?.text).not.toContain("Reply to Dana");
  });

  test("nobody is pinged while they or an admin have check-ins turned off", async () => {
    await openItem(inbox, "Reply to Dana");
    await replica({
      admin: {
        proactiveAllowed: async () => false,
        proactiveDailyRuns: async () => 24,
      },
    }).engine.sweep();
    expect(await pingsOf()).toEqual([]);

    await database
      .update(users)
      .set({
        preferences: sql`${users.preferences} || '{"proactive":"off"}'::jsonb`,
      })
      .where(eq(users.id, owner));
    await replica().engine.sweep();
    expect(await pingsOf()).toEqual([]);
    expect(await outboxOf()).toEqual([]);
  });

  test("the ping lists five items, then how many more, and the push line stays short", async () => {
    const titles = Array.from(
      { length: 7 },
      (_, index) =>
        `Reply to the thread about the quarterly plan, part ${index + 1}`,
    );
    for (const title of titles) await openItem(inbox, title);
    const ping = await store.pings.take(owner);
    const lines = ping?.text.split("\n") ?? [];
    expect(lines[0]).toBe("7 things need you");
    expect(lines.filter((line) => line.startsWith("• "))).toHaveLength(5);
    expect(lines).toContain("and 2 more");
    expect(Array.from(ping?.pushBody ?? "").length).toBeLessThanOrEqual(200);
    expect(ping?.pushBody).toStartWith(`7 things need you: ${titles[0]}; `);
    expect(ping?.pushBody).toEndWith("…");
  });
});

describe("Start and Hide", () => {
  test("Start makes the item a task, once; a task that could not be opened leaves it open; Hide is remembered", async () => {
    const item = await openItem(inbox, "Reply to Dana");
    // Without the tasks module, Start is refused and the item stays as it was.
    await expect(replica().engine.start(owner, item.id)).rejects.toBeInstanceOf(
      ProactiveRefusedError,
    );
    expect((await store.suggestion(owner, item.id)).status).toBe("open");

    const opened: string[] = [];
    let failNext = true;
    const { engine } = replica({
      tasks: {
        startFromItem: async ({ ownerUserId, item: started }) => {
          if (failNext) {
            failNext = false;
            throw new Error("The conversation could not be made.");
          }
          opened.push(`${ownerUserId}:${started.id}:${started.title}`);
          return { id: `task-${started.id}`, channelId: taskChannel };
        },
      },
    });
    await expect(engine.start(owner, item.id)).rejects.toThrow(
      "The conversation could not be made.",
    );
    expect((await store.suggestion(owner, item.id)).status).toBe("open");

    const result = await engine.start(owner, item.id);
    expect(result.task).toEqual({
      id: `task-${item.id}`,
      channelId: taskChannel,
    });
    expect(result.suggestion.status).toBe("started");
    expect(opened).toEqual([`${owner}:${item.id}:Reply to Dana`]);
    await expect(engine.start(owner, item.id)).rejects.toBeInstanceOf(
      ProactiveRefusedError,
    );
    expect(opened).toHaveLength(1);

    const other = await openItem(inbox, "Archive old threads");
    expect((await engine.dismiss(owner, other.id)).status).toBe("dismissed");
    expect(await store.suggestions(owner)).toEqual([]);
  });
});

describe("what needs the person", () => {
  test("attention counts each Bot's open items, and names the person's newest ping", async () => {
    await openItem(inbox, "Reply to Dana");
    await openItem(inbox, "Answer the supplier");
    const hidden = await openItem(calendar, "Move the standup");
    await store.resolveSuggestion(owner, hidden.id, "dismissed");
    expect(await activity.lastPing(owner)).toBeNull();
    const counts = await activity.attention(owner);
    expect(counts.find((row) => row.agentId === inboxBot)?.items).toBe(2);
    expect(counts.find((row) => row.agentId === calendarBot)).toBeUndefined();

    const ping = await store.pings.take(owner);
    expect(await activity.lastPing(owner)).toBe(ping?.pingId as string);
  });
});

describe("the item routes", () => {
  function routes(engine: ProactiveEngine) {
    const requireUser = async (
      context: { set: (key: string, value: unknown) => void },
      next: () => Promise<void>,
    ) => {
      context.set("actor", { id: owner, email: `${owner}@example.test` });
      await next();
    };
    return new Hono().route(
      "/api/proactive",
      createProactiveRoutes(store, engine, requireUser as never),
    );
  }

  test("settings say whether an admin left check-ins on; items carry their source and ping; Start answers with the task", async () => {
    const admin = (allowed: boolean): ProactiveAdmin => ({
      proactiveAllowed: async () => allowed,
      proactiveDailyRuns: async () => 24,
    });
    const off = routes(replica({ admin: admin(false) }).engine);
    expect(
      await (await off.request("http://t/api/proactive/settings")).json(),
    ).toMatchObject({ allowed: false });

    const item = await openItem(inbox, "Reply to Dana", {
      sourceLink: "https://mail.example.test/m/1",
    });
    const ping = await store.pings.take(owner);
    const app = routes(
      replica({
        admin: admin(true),
        tasks: {
          startFromItem: async ({ item: started }) => ({
            id: `task-${started.id}`,
            channelId: taskChannel,
          }),
        },
      }).engine,
    );
    const settings = (await (
      await app.request("http://t/api/proactive/settings")
    ).json()) as { allowed: boolean; settings: { id: string }[] };
    expect(settings.allowed).toBe(true);
    expect(settings.settings.map((row) => row.id).sort()).toEqual(
      [inbox.id, calendar.id].sort(),
    );

    const { suggestions } = (await (
      await app.request("http://t/api/proactive/suggestions")
    ).json()) as { suggestions: Record<string, unknown>[] };
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]).toMatchObject({
      id: item.id,
      title: "Reply to Dana",
      sourceApp: "Mail",
      sourceRef: listMessages,
      sourceLink: "https://mail.example.test/m/1",
      pingId: ping?.pingId,
      status: "open",
    });
    expect(suggestions[0]).not.toHaveProperty("dedupeKey");

    const started = await app.request(
      `http://t/api/proactive/suggestions/${item.id}/start`,
      { method: "POST" },
    );
    expect(started.status).toBe(200);
    expect(await started.json()).toMatchObject({
      suggestion: { id: item.id, status: "started" },
      task: { id: `task-${item.id}`, channelId: taskChannel },
    });
    const again = await app.request(
      `http://t/api/proactive/suggestions/${item.id}/start`,
      { method: "POST" },
    );
    expect(again.status).toBe(400);
  });
});
