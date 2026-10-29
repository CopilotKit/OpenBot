import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";
import { randomUUID } from "node:crypto";
import {
  frameTaskBrief,
  frameTaskInput,
  frameTaskReply,
  readTaskBrief,
  readTaskFrame,
  TASK_REPLY_LINE,
} from "@openbot/shared/task-brief";
import type { TaskReplyContext } from "@openbot/shared/task-reply";
import { ThreadLockBusyError } from "@openbot/toolkit/lease";
import type { TurnRunner } from "@openbot/toolkit/run-turn";
import { and, eq, inArray, sql } from "drizzle-orm";
import { createAgentProfileStore } from "../src/agents/profile-store";
import type { AgentActor } from "../src/agents/profile-types";
import { createPersonResponseTick } from "../src/approvals/person-response-sweep";
import {
  createApprovalQuestions,
  type PersonQuestion,
  questionResponseMessage,
} from "../src/approvals/questions";
import { createAuditStore } from "../src/audit";
import type { AuthenticatedActor } from "../src/auth/guards";
import {
  loadAttachmentForTurn,
  markAttachmentsSent,
} from "../src/channels/attachments";
import { createChannelStore } from "../src/channels/routes";
import { createThreadIdentity } from "../src/channels/thread-identity";
import { createCredentialStore } from "../src/credentials";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  approvalRequests,
  attachments,
  channels,
  intelligenceChannelMappings,
  pluginGrants,
  skills,
  tasks,
  users,
  workItems,
} from "../src/db/schema";
import { createPluginStore } from "../src/plugins/store";
import {
  createProactiveEngine,
  PROACTIVE_RUN_KIND,
  PROACTIVE_TASK_KIND,
  type ProactiveScope,
} from "../src/proactive/engine";
import { createProactiveRoutes } from "../src/proactive/routes";
import { createProactiveStore } from "../src/proactive/store";
import {
  ProactiveNotFoundError,
  ProactiveRefusedError,
} from "../src/proactive/types";
import { createResponsibilityStore } from "../src/responsibilities/store";
import { createTaskReplyContext } from "../src/tasks/reply-context";
import { createTaskRoutes } from "../src/tasks/routes";
import { createTaskStore } from "../src/tasks/store";
import { createTaskThreads, createTaskTurn } from "../src/tasks/threads";
import { builtInBots, START_TASK_TOOL, taskTools } from "../src/tasks/tools";
import type { TaskRecord } from "../src/tasks/types";
import {
  createWorkQueue,
  type SerialOrder,
  type WorkItem,
  type WorkQueue,
} from "../src/work/queue";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * A task is work a Bot does in a conversation of its own, so the conversation it was asked in
 * stays one thread. These run
 * against PostgreSQL: the conversation is a real channel, and what a task is doing is read from the
 * real work queue, approval inbox and question queue.
 */

// Keep production kinds visible to status readers and first-day transactions, while every SQL
// queue claim uses this file's private table. Other integration files keep their public queue.
const queueSchema = `task_threads_${randomUUID().replaceAll("-", "_")}`;
const databaseUrl = new URL(testDatabaseUrl());
databaseUrl.searchParams.set("search_path", `${queueSchema},public`);
const database = createDatabase(databaseUrl.toString(), TEST_POOL);
const engines = new Set<ReturnType<typeof createProactiveEngine>>();
const profileStore = createAgentProfileStore(
  database,
  new URL("https://managed.example.test/ag-ui"),
);
const channelStore = createChannelStore(
  database,
  profileStore,
  createThreadIdentity("test-deployment"),
);
const taskStore = createTaskStore(database);
const proactiveStore = createProactiveStore(database);
const prefix = `task-threads-${randomUUID()}`;
const owner: AgentActor = { id: `${prefix}-owner`, role: "user" };
const other: AgentActor = { id: `${prefix}-other`, role: "user" };
let bot = "";

const actorFor = async (id: string): Promise<AgentActor> => ({
  id,
  role: "user",
});
const scopeFor = async (
  ownerUserId: string,
  channelId: string,
  agentId: string,
): Promise<ProactiveScope | null> => {
  const channel = await channelStore.get(
    await actorFor(ownerUserId),
    channelId,
  );
  return channel?.agentIds.includes(agentId)
    ? { ownerUserId, channelId, agentId, threadId: channel.threadId }
    : null;
};
/**
 * What each task's conversation was told about being busy, by thread. Recorded rather than sent:
 * an announcement reads the conversation's work list and notifies, and on a two-connection pool a
 * burst of them alongside the engine's own reads trips Bun's SQL client, which then decodes one
 * statement's rows with another's column types and stops answering. One real announcement is
 * exercised on its own, below.
 */
const busySignals: { threadId: string; busy: boolean }[] = [];
const threads = createTaskThreads({
  database,
  store: taskStore,
  channels: {
    create: channelStore.create,
    signalBusy: async (threadId, busy) => {
      busySignals.push({ threadId, busy });
    },
  },
  actorFor,
  scopeFor,
});

/**
 * The queue in memory, so a task started here is only ever claimed by this file's engine: the shared
 * test database can hold other files' queued work, which a real claim would pick up instead.
 */
function memoryQueue() {
  const items = new Map<
    string,
    WorkItem & { finished: boolean; claimed: boolean; lastError?: string }
  >();
  const queue = {
    offer: async (item: {
      kind: string;
      key: string;
      payload?: Record<string, unknown>;
    }) => {
      const id = `${item.kind}:${item.key}`;
      if (items.has(id)) return "already";
      items.set(id, {
        kind: item.kind,
        key: item.key,
        payload: item.payload ?? {},
        attempts: 0,
        finished: false,
        claimed: false,
      });
      return "queued";
    },
    claim: async ({
      kind,
      maxAttempts = 5,
    }: {
      kind: string;
      maxAttempts?: number;
    }) => {
      const due = [...items.values()].find(
        (item) =>
          item.kind === kind &&
          !item.finished &&
          !item.claimed &&
          item.attempts < maxAttempts,
      );
      if (!due) return [];
      due.claimed = true;
      due.attempts += 1;
      return [{ ...due }];
    },
    renew: async () => true,
    finish: async ({ kind, key }: { kind: string; key: string }) => {
      const item = items.get(`${kind}:${key}`);
      if (item) item.finished = true;
      return true;
    },
    release: async ({
      kind,
      key,
      reason,
    }: {
      kind: string;
      key: string;
      reason?: string;
    }) => {
      const item = items.get(`${kind}:${key}`);
      if (item) {
        item.claimed = false;
        if (reason !== undefined) item.lastError = reason;
      }
      return true;
    },
    purge: async () => 0,
  };
  return { queue: queue as unknown as WorkQueue, items };
}

type Started = {
  scope: ProactiveScope;
  runId: string;
  text: string;
  acceptedReply?: { id: string; text: string };
  final: boolean;
} & TaskReplyContext;

/** An engine on the memory queue. `turn` is each task turn's outcome; by default it succeeds. */
function engineFor(
  turn: (
    started: Started,
    signal: AbortSignal,
  ) => Promise<void> = async () => {},
  durable?: WorkQueue,
  replyContext?: ReturnType<typeof createTaskReplyContext>,
) {
  const memory = memoryQueue();
  const queue = durable ?? memory.queue;
  const items = memory.items;
  const started: Started[] = [];
  const engine = createProactiveEngine({
    acceptReplyContext: replyContext?.accept,
    store: {
      ...proactiveStore,
      // Task-only sweeps must not admit other tests' shared research schedules.
      claimDue: async () => [],
    },
    memory: {
      formMemory: async () => ({ id: "m", duplicate: false, forgotten: false }),
    },
    queue,
    owner: "worker",
    runTurn: async () => {
      throw new Error("No research runs here.");
    },
    resolveScope: scopeFor,
    notify: async () => undefined,
    tasks: threads,
    startTask: async (scope, input) => {
      const run = {
        scope,
        runId: input.runId,
        text: input.text,
        ...(input.acceptedReply ? { acceptedReply: input.acceptedReply } : {}),
        final: input.final,
        ...(input.attachmentIds ? { attachmentIds: input.attachmentIds } : {}),
        ...(input.skillIds ? { skillIds: input.skillIds } : {}),
      };
      started.push(run);
      await turn(run, input.signal);
    },
    catalogue: { listServers: async () => [] },
    mintThreadId: () => `${prefix}-research-thread`,
    taskRetryMs: 0,
  });
  engines.add(engine);
  return { engine, items, started };
}

const chatOf = () => channelStore.direct(owner, bot);

/** A message's words: a string, or the text parts of structured content. */
const textIn = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content
          .flatMap((part) =>
            part?.type === "text" && typeof part.text === "string"
              ? [part.text]
              : [],
          )
          .join("\n")
      : "";

/**
 * A claim on a queue whose kinds carry a test's own prefix, so its rows are only ever this test's.
 * The order a task's turns are claimed under names its kinds, so it is renamed to match; its groups
 * are read the same way, by the task a payload names.
 */
function prefixedClaim(
  input: Parameters<WorkQueue["claim"]>[0],
  prefix: string,
): Parameters<WorkQueue["claim"]>[0] {
  const { serialBy } = input;
  const order: string | SerialOrder | undefined =
    serialBy === undefined || typeof serialBy === "string"
      ? serialBy
      : {
          ...serialBy,
          name: prefix + serialBy.name,
          kinds: Object.fromEntries(
            Object.entries(serialBy.kinds).map(([kind, cap]) => [
              prefix + kind,
              cap,
            ]),
          ),
        };
  return {
    ...input,
    kind: prefix + input.kind,
    ...(order === undefined ? {} : { serialBy: order }),
  };
}

/** One of the person's suggestions from the Bot, as research leaves one, ready to Start. */
async function suggestionFor(title: string, detail = "") {
  const chat = await chatOf();
  const setting =
    (await proactiveStore.list(owner.id)).find((row) => row.agentId === bot) ??
    (await proactiveStore.create(
      owner.id,
      { agentId: bot, channelId: chat.id, enabled: false },
      chat.threadId,
    ));
  return proactiveStore.addSuggestion({
    ownerUserId: owner.id,
    agentId: bot,
    settingId: setting.id,
    runId: `run-${randomUUID()}`,
    title,
    detail,
    sourceApp: null,
    sourceRef: null,
    sourceLink: null,
  });
}

/** A turn for this task on the real queue, in whatever state the test needs. */
async function turnFor(
  taskId: string,
  state: Partial<typeof workItems.$inferInsert> = {},
  key = `task:${taskId}`,
) {
  await database.insert(workItems).values({
    kind: PROACTIVE_TASK_KIND,
    key,
    payload: { ownerUserId: owner.id, taskId, text: "Prepare the notes." },
    ...state,
  });
  return and(eq(workItems.kind, PROACTIVE_TASK_KIND), eq(workItems.key, key));
}

beforeAll(async () => {
  await database.execute(sql`create schema ${sql.identifier(queueSchema)}`);
  await database.execute(sql`
    create table ${sql.identifier(queueSchema)}.work_items
    (like public.work_items including all)
  `);
  await database.insert(users).values([
    { id: owner.id, email: `${owner.id}@example.test` },
    { id: other.id, email: `${other.id}@example.test` },
  ]);
  bot = (
    await profileStore.create(owner, {
      name: "Assistant",
      title: "Works in the background",
      roleDescription: "Works for one person.",
      visibility: "private",
    })
  ).id;
});

afterEach(async () => {
  // Settle immediate turns and retries before removing even unfinished status-only fixtures.
  await Promise.all([...engines].map((engine) => engine.idle()));
  engines.clear();
  await database.execute(
    sql`truncate ${sql.identifier(queueSchema)}.work_items`,
  );
});

afterAll(async () => {
  try {
    const mine = await database
      .select({ id: channels.id })
      .from(channels)
      .innerJoin(
        intelligenceChannelMappings,
        eq(intelligenceChannelMappings.channelId, channels.id),
      )
      .where(inArray(intelligenceChannelMappings.userId, [owner.id, other.id]));
    if (mine.length > 0)
      await database.delete(channels).where(
        inArray(
          channels.id,
          mine.map((row) => row.id),
        ),
      );
    await database.delete(users).where(inArray(users.id, [owner.id, other.id]));
    await database.delete(agentProfiles).where(eq(agentProfiles.agentId, bot));
    await database.delete(agents).where(eq(agents.id, bot));
  } finally {
    try {
      await database.execute(
        sql`drop schema if exists ${sql.identifier(queueSchema)} cascade`,
      );
    } finally {
      await database.$client.close();
    }
  }
});

describe("a task asked for", () => {
  test("has no cap: every call opens another task in another conversation", async () => {
    const { engine, started } = engineFor();
    const opened = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        engine.startAsked(owner.id, bot, {
          title: `Task ${index}`,
          instruction: `Do thing ${index}`,
        }),
      ),
    );
    await engine.idle();
    expect(new Set(opened.map((task) => task.channelId)).size).toBe(12);
    expect(started).toHaveLength(12);
  });

  test("Chat's conversation with the Bot stays Chat's, however recently a task ran", async () => {
    const chat = await chatOf();
    const { engine } = engineFor();
    const task = await engine.startAsked(owner.id, bot, {
      title: "Prepare notes for the Hearth & Co visit",
      instruction: "Prepare notes for the Hearth & Co visit.",
    });
    await engine.idle();
    await channelStore.recordActivity(owner, task.channelId, {
      text: "Here are the notes.",
      agentId: bot,
      at: new Date(Date.now() + 60_000),
    });
    expect((await chatOf()).id).toBe(chat.id);

    // The roster still lists it, marked, so the app can keep it out of Chat and the menu.
    const page = await channelStore.list(owner, { limit: 200 });
    expect(page.channels.find((row) => row.id === task.channelId)?.taskId).toBe(
      task.id,
    );
    expect(page.channels.find((row) => row.id === chat.id)?.taskId).toBeNull();
    // Research's defaults never adopt a task's conversation as the person's own.
    expect(await taskStore.isTaskConversation(owner.id, task.channelId)).toBe(
      true,
    );
    expect(await taskStore.isTaskConversation(owner.id, chat.id)).toBe(false);
    expect(await taskStore.isTaskConversation(other.id, task.channelId)).toBe(
      false,
    );
  });
});

describe("Start on a suggestion", () => {
  test("opens a task in a conversation of its own instead of running in Chat", async () => {
    const chat = await chatOf();
    const setting =
      (await proactiveStore.list(owner.id)).find(
        (row) => row.agentId === bot,
      ) ??
      (await proactiveStore.create(
        owner.id,
        { agentId: bot, channelId: chat.id, enabled: false },
        chat.threadId,
      ));
    const add = (title: string) =>
      proactiveStore.addSuggestion({
        ownerUserId: owner.id,
        agentId: bot,
        settingId: setting.id,
        runId: `run-${randomUUID()}`,
        title,
        detail: "Ravi publishes in 7 days.\n\nNext: Reply to Ravi.",
        sourceApp: "Gmail",
        sourceRef: null,
        sourceLink: "https://mail.google.com/mail/u/0/#inbox/n26",
      });
    const fromTasks = await add("Triage the order-form report");
    const another = await add("Answer Sam about Friday off");
    const { engine, started } = engineFor();

    const { suggestion, task } = await engine.start(owner.id, fromTasks.id);
    await engine.idle();
    expect(suggestion.status).toBe("started");
    const record = await taskStore.get(owner.id, task.id);
    expect(record).toMatchObject({
      origin: "suggestion",
      suggestionId: fromTasks.id,
      title: "Triage the order-form report",
      why: "Ravi publishes in 7 days.",
      sourceApp: "Gmail",
      sourceLink: "https://mail.google.com/mail/u/0/#inbox/n26",
    });
    expect(record.channelId).not.toBe(chat.id);
    expect(started).toHaveLength(1);
    expect(started[0]?.scope.channelId).toBe(record.channelId);
    expect(readTaskBrief(started[0]?.text ?? "")).toContain(
      "Triage the order-form report",
    );

    // Started once: a second Start is refused and opens nothing.
    await expect(engine.start(owner.id, fromTasks.id)).rejects.toThrow(
      "already started",
    );
    // Somebody else's suggestion is no suggestion at all.
    await expect(engine.start(other.id, another.id)).rejects.toBeInstanceOf(
      ProactiveNotFoundError,
    );
    expect((await proactiveStore.suggestion(owner.id, another.id)).status).toBe(
      "open",
    );

    // Nobody else's Start touched it: it still opens a task of its own.
    const second = await engine.start(owner.id, another.id);
    await engine.idle();
    expect(second.task.channelId).not.toBe(record.channelId);
    expect(started).toHaveLength(2);
  });
});

describe("Start, through the routes", () => {
  test("answers with the suggestion and the task it opened, and reads a suggestion whatever its status", async () => {
    const { engine, started } = engineFor();
    const routes = createProactiveRoutes(
      proactiveStore,
      engine,
      async (context, next) => {
        context.set("actor", {
          id: context.req.header("x-person") ?? owner.id,
        } as AuthenticatedActor);
        await next();
      },
    );
    const suggestion = await suggestionFor(
      "Reply to Ravi about the deadline",
      "Ravi publishes in 7 days.\n\nNext: Reply to Ravi.",
    );
    const read = (person = owner.id) =>
      routes.request(`/suggestions/${suggestion.id}`, {
        headers: { "x-person": person },
      });
    expect(
      ((await (await read()).json()) as { suggestion: { status: string } })
        .suggestion.status,
    ).toBe("open");

    const response = await routes.request(
      `/suggestions/${suggestion.id}/start`,
      {
        method: "POST",
      },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      suggestion: { id: string; status: string };
      task: { id: string; channelId: string; title: string };
    };
    await engine.idle();
    expect(body.suggestion).toMatchObject({
      id: suggestion.id,
      status: "started",
    });
    expect(body.task.title).toBe("Reply to Ravi about the deadline");
    expect((await taskStore.get(owner.id, body.task.id)).suggestionId).toBe(
      suggestion.id,
    );
    expect(started.map((run) => run.scope.channelId)).toEqual([
      body.task.channelId,
    ]);
    // Started, it is still the person's to read, and still nobody else's.
    expect(
      ((await (await read()).json()) as { suggestion: { status: string } })
        .suggestion.status,
    ).toBe("started");
    expect((await read(other.id)).status).toBe(404);
  });
});

describe("while a task's turn runs", () => {
  test("its conversation is working on it, for as long as the turn holds its lease, and only for its person", async () => {
    const task = await threads.open({
      ownerUserId: owner.id,
      agentId: bot,
      title: `Working ${randomUUID()}`,
      why: null,
      origin: "asked",
      suggestionId: null,
      sourceApp: null,
      sourceLink: null,
    });
    const conversation = await channelStore.get(owner, task.channelId);
    const thread = {
      id: task.channelId,
      threadId: conversation?.threadId ?? "",
    };
    const workOf = async (actor = owner) =>
      (await channelStore.workIn(actor, [thread])).get(task.channelId) ?? [];
    // Queued, nothing runs in the conversation yet.
    const where = await turnFor(task.id);
    expect(await workOf()).toEqual([]);
    await database
      .update(workItems)
      .set({
        attempts: 1,
        claimedBy: "worker",
        leaseUntil: sql`now() + interval '1 minute'`,
      })
      .where(where);
    expect(await workOf()).toEqual([
      {
        kind: "task",
        key: `task:${task.id}`,
        taskId: task.id,
        botId: bot,
        botName: "Assistant",
        since: expect.any(Date),
      },
    ]);
    // Another person reading the same conversation's id hears nothing of it.
    expect(await workOf(other)).toEqual([]);
    // Its lease run out, or its turn finished: nothing is running.
    await database
      .update(workItems)
      .set({ leaseUntil: sql`now() - interval '1 second'` })
      .where(where);
    expect(await workOf()).toEqual([]);
  });

  test("its conversation is told it is no longer busy once the turn is off the queue, and its work list says so", async () => {
    const { engine, items } = engineFor();
    const task = await engine.startAsked(owner.id, bot, {
      title: "Prepare the notes",
      instruction: "Prepare the notes.",
    });
    await engine.idle();
    const scope = await threads.scope(owner.id, task.id);
    // Said after the turn was finished on the queue, never before.
    expect(items.get(`${PROACTIVE_TASK_KIND}:task:${task.id}`)?.finished).toBe(
      true,
    );
    expect(busySignals).toContainEqual({
      threadId: scope?.threadId ?? "",
      busy: false,
    });

    // The real announcement, on its own: the turn is finished, so the list it carries is empty.
    const real = createTaskThreads({
      database,
      store: taskStore,
      channels: channelStore,
      actorFor,
      scopeFor,
    });
    await real.settled?.(owner.id, task.id);
    expect(
      (
        await channelStore.workIn(owner, [
          { id: task.channelId, threadId: scope?.threadId ?? "" },
        ])
      ).get(task.channelId),
    ).toBeUndefined();
  });
});

describe("status", () => {
  async function freshTask() {
    const opened = await threads.open({
      ownerUserId: owner.id,
      agentId: bot,
      title: `Status ${randomUUID()}`,
      why: null,
      origin: "asked",
      suggestionId: null,
      sourceApp: null,
      sourceLink: null,
    });
    const conversation = await channelStore.get(owner, opened.channelId);
    return { id: opened.id, threadId: conversation?.threadId ?? "" };
  }
  const statusOf = async (id: string) =>
    (await taskStore.get(owner.id, id)).status;

  async function acceptedAnswer() {
    const task = await freshTask();
    await turnFor(task.id, { finishedAt: new Date() });
    const questionId = `${prefix}-answered-${randomUUID()}`;
    const question = {
      ownerUserId: owner.id,
      actorId: owner.id,
      botId: bot,
      threadId: task.threadId,
      runId: `task-${task.id}`,
      question: "Which deck?",
      mode: "completed_question",
    };
    await database.insert(workItems).values({
      kind: "person.question",
      key: questionId,
      payload: question,
    });
    // Persist through the real acceptance path, then advance only this turn's ledger below.
    const queue: WorkQueue = {
      ...createWorkQueue(database),
      claim: async () => [],
    };
    const { engine } = engineFor(async () => {}, queue);
    const messageId = randomUUID();
    await engine.reply(owner.id, task.id, { reply: "Use A", messageId });
    await engine.idle();
    const where = and(
      eq(workItems.kind, PROACTIVE_TASK_KIND),
      eq(workItems.key, `task:${task.id}:reply:${messageId}`),
    );
    return { task, questionId, question, where, engine };
  }

  test("question-card responses stay working, fail once, and retry the accepted answer", async () => {
    const task = await freshTask();
    const unrelated = await freshTask();
    await turnFor(task.id, { finishedAt: new Date() });
    await turnFor(unrelated.id, { finishedAt: new Date() });
    const { channelId } = (await taskStore.locate(owner.id, task.id))!;
    const key = `${prefix}-question-response-${randomUUID()}`;
    const question: PersonQuestion = {
      actorId: owner.id,
      botId: bot,
      channelId,
      threadId: task.threadId,
      runId: `task-${task.id}`,
      question:
        "Which day works after preparing the notes, reviewing the deck, and confirming every attendee can join? ".repeat(
          3,
        ),
      mode: "completed_question",
    };
    const response = "Friday";
    const message = questionResponseMessage(
      question,
      response,
      `person-response:${key}`,
    );
    const queue = createWorkQueue(database);
    await queue.offer({ kind: "person.question", key, payload: question });
    await channelStore.recordActivity(owner, channelId, {
      text: question.question,
      agentId: bot,
      at: new Date(),
    });
    await createApprovalQuestions(database, async () => {}).respond(
      owner.id,
      key,
      response,
    );
    expect(await statusOf(task.id)).toBe("working");
    expect(await statusOf(unrelated.id)).toBe("ready_for_review");
    await queue.claim({
      kind: "person.response",
      owner: "answerer",
      leaseMs: 60_000,
      maxAttempts: 1,
    });
    expect(await statusOf(task.id)).toBe("working");
    await queue.release({
      kind: "person.response",
      key,
      owner: "answerer",
      delayMs: 0,
      reason: "fetch failed",
    });
    expect(await taskStore.get(owner.id, task.id)).toMatchObject({
      status: "failed",
      failure: "a service didn't answer",
    });
    const taskTurn = createTaskTurn({
      actorFor,
      channels: channelStore,
      runTurn: async (input) => {
        if (input.userMessage?.role !== "user")
          throw new Error("Task user message is missing");
        return { replyText: "The deck is ready." };
      },
    });
    const { engine, started } = engineFor(
      async ({ scope, ...input }, signal) => {
        await taskTurn(scope, { ...input, signal });
      },
      queue,
    );
    await engine.again(owner.id, task.id);
    await engine.idle();
    expect({ started, status: await statusOf(task.id) }).toMatchObject({
      started: [
        {
          text: message.content,
          acceptedReply: { id: message.id, text: response },
        },
      ],
      status: "ready_for_review",
    });
  });

  test("question-card answers execute before later task composer replies", async () => {
    const task = await freshTask();
    await turnFor(task.id, { finishedAt: new Date() });
    const queue = createWorkQueue(database);
    const key = randomUUID();
    const question: PersonQuestion = {
      actorId: owner.id,
      botId: bot,
      threadId: task.threadId,
      runId: `task-${task.id}`,
      question: "Deck?",
      mode: "completed_question",
    };
    await queue.offer({ kind: "person.question", key, payload: question });
    const questions = createApprovalQuestions(database, async () => {});
    await questions.respond(owner.id, key, "Pottery.");
    const starts: string[] = [];
    const { engine } = engineFor(async ({ text }) => {
      starts.push(text);
    }, queue);
    const reply = { reply: "Use revised.", messageId: randomUUID() };
    const replyKey = `task:${task.id}:reply:${reply.messageId}`;
    const answer = "In response to your question: Deck?\n\nPottery.";
    await engine.reply(owner.id, task.id, reply);
    const rows = sql`
      select kind, key, attempts, finished_at is not null as finished,
        coalesce(lease_until > now(), false) as live, last_error as error
      from work_items where kind in ('person.response', 'proactive.task')
        and key in (${key}, ${replyKey}) order by created_at, key
    `;
    expect([...(await database.execute(rows))]).toMatchObject([
      { kind: "person.response", key, attempts: 0, finished: false },
      { kind: PROACTIVE_TASK_KIND, key: replyKey },
    ]);
    await engine.idle();
    await engine.sweep();
    expect(starts).toEqual([]);
    const entered = Promise.withResolvers<void>();
    const held = Promise.withResolvers<void>();
    const answering = createPersonResponseTick({
      approvalQueue: queue,
      personResponseOwner: "answerer",
      authoriseQuestion: async () => {},
      approvalContinuationRunner: async (input) => {
        starts.push(textIn(input.userMessage?.content));
        entered.resolve();
        await held.promise;
        return { replyText: "" };
      },
      responsibilityStore: createResponsibilityStore(database, {
        resolveTarget: async () => null,
      }),
      responsibilityAnswerTurn: () => {
        throw new Error("Unexpected responsibility");
      },
      sourceForCoordinationRun: async () => null,
      channelStore,
      actorFor,
      notify: async () => {},
    })();
    try {
      await Promise.race([entered.promise, answering]);
      await engine.sweep();
      const running = [...(await database.execute(rows))];
      expect({ starts, work: running }).toMatchObject({
        starts: [answer],
        work: [
          { attempts: 1, live: true, finished: false, error: null },
          { attempts: 0 },
        ],
      });
    } finally {
      held.resolve();
      await answering;
    }
    await engine.sweep();
    const finished = [...(await database.execute(rows))];
    expect({ starts, work: finished }).toMatchObject({
      starts: [answer, reply.reply],
      work: [
        { attempts: 1, finished: true, error: null },
        { attempts: 1, finished: true, error: null },
      ],
    });
  });

  test("an exhausted accepted answer exposes its failure and remains recoverable through Try again", async () => {
    const { task, questionId, where, engine } = await acceptedAnswer();
    expect(await statusOf(task.id)).toBe("working");
    await database.update(workItems).set({ attempts: 1 }).where(where);
    expect(await statusOf(task.id)).toBe("working");
    await database
      .update(workItems)
      .set({
        attempts: 2,
        claimedBy: "worker",
        leaseUntil: sql`now() + interval '1 minute'`,
      })
      .where(where);
    expect(await statusOf(task.id)).toBe("working");
    const failedAt = new Date();
    await database
      .update(workItems)
      .set({
        attempts: 2,
        claimedBy: null,
        leaseUntil: null,
        lastError: "fetch failed",
        updatedAt: failedAt,
      })
      .where(where);
    const routes = createTaskRoutes(
      taskStore,
      async (context, next) => {
        context.set("actor", {
          id: owner.id,
          email: `${owner.id}@example.test`,
          role: "user",
        });
        await next();
      },
      { retry: engine },
    );
    const failed = (await (await routes.request(`/${task.id}`)).json()) as {
      task: TaskRecord;
    };
    expect(failed.task).toMatchObject({
      status: "failed",
      failure: "a service didn't answer",
      failedAt: failedAt.toISOString(),
      answeredQuestionIds: [questionId],
    });
    const listed = (await (await routes.request("/")).json()) as {
      tasks: TaskRecord[];
    };
    expect(listed.tasks.find((row) => row.id === task.id)).toEqual(failed.task);
    // The failed run did not finish the question; the accepted answer is what the read knows.
    expect(
      await database
        .select({ finishedAt: workItems.finishedAt })
        .from(workItems)
        .where(
          and(
            eq(workItems.kind, "person.question"),
            eq(workItems.key, questionId),
          ),
        ),
    ).toEqual([{ finishedAt: null }]);
    const response = await routes.request(`/${task.id}/again`, {
      method: "POST",
    });
    await engine.idle();
    expect(response.status).toBe(200);
    expect(
      ((await response.json()) as { task: TaskRecord }).task,
    ).toMatchObject({
      status: "working",
      failure: null,
      failedAt: null,
      answeredQuestionIds: [questionId],
    });
    await database
      .update(workItems)
      .set({ attempts: 1, finishedAt: new Date() })
      .where(
        and(
          eq(workItems.kind, PROACTIVE_TASK_KIND),
          eq(workItems.key, `task:${task.id}:again:2`),
        ),
      );
    expect((await taskStore.get(owner.id, task.id)).status).toBe(
      "ready_for_review",
    );
  });

  test("a new question keeps priority over an accepted answer while working and after exhaustion", async () => {
    const { task, question, where } = await acceptedAnswer();
    const newId = `${prefix}-new-${randomUUID()}`;
    await database.insert(workItems).values({
      kind: "person.question",
      key: newId,
      payload: question,
    });
    expect(await statusOf(task.id)).toBe("needs_input");
    await database
      .update(workItems)
      .set({ attempts: 2, lastError: "fetch failed" })
      .where(where);
    expect(await taskStore.get(owner.id, task.id)).toMatchObject({
      status: "needs_input",
      failure: null,
      failedAt: null,
    });
    await taskStore.answerQuestions(owner.id, [newId]);
    expect(await statusOf(task.id)).toBe("failed");
  });

  test("pending approval keeps priority over an accepted answer while working and after exhaustion", async () => {
    const { task, where } = await acceptedAnswer();
    const approvalId = `${prefix}-answer-approval-${randomUUID()}`;
    await database.insert(approvalRequests).values({
      id: approvalId,
      ownerUserId: owner.id,
      runId: `task-${task.id}`,
      toolCallId: "send",
      actionDigest: "digest",
      action: {
        actorId: owner.id,
        botId: bot,
        threadId: task.threadId,
        runId: `task-${task.id}`,
        toolCallId: "send",
        actionDigest: "digest",
        toolRef: "gmail/send",
        effect: "write",
        scope: "recipient@example.test",
        args: {},
      },
    });
    expect(await statusOf(task.id)).toBe("needs_input");
    await database
      .update(workItems)
      .set({ attempts: 2, lastError: "fetch failed" })
      .where(where);
    expect(await statusOf(task.id)).toBe("needs_input");
    await database
      .update(approvalRequests)
      .set({ status: "completed" })
      .where(eq(approvalRequests.id, approvalId));
    expect(await statusOf(task.id)).toBe("failed");
  });

  test("a legacy answer without a snapshot never hides an unknown pending question", async () => {
    const { task, where } = await acceptedAnswer();
    await database
      .update(workItems)
      .set({ payload: sql`${workItems.payload} - 'questionIds'` })
      .where(where);
    expect(await statusOf(task.id)).toBe("needs_input");
    await database
      .update(workItems)
      .set({ attempts: 2, lastError: "fetch failed" })
      .where(where);
    expect(await statusOf(task.id)).toBe("needs_input");
  });

  test("carries the run's own next step: the Bot's last sentence, the person's reply quoted, never the ask", async () => {
    const opened = await threads.open({
      ownerUserId: owner.id,
      agentId: bot,
      title: `Next ${randomUUID()}`,
      why: null,
      origin: "asked",
      suggestionId: null,
      sourceApp: null,
      sourceLink: null,
    });
    const nextOf = async () => (await taskStore.get(owner.id, opened.id)).next;
    expect(await nextOf()).toBeNull();
    const at = Date.now();
    // The ask the turn starts on is the task, not a step.
    await channelStore.recordActivity(
      owner,
      opened.channelId,
      { text: "Draft a reply to Danny.", agentId: null, at: new Date(at) },
      { id: `task-${opened.id}:input` },
    );
    expect(await nextOf()).toBeNull();
    await channelStore.recordActivity(owner, opened.channelId, {
      text: "I drafted the reply. **Send the reply to Danny?** It tells him Friday works.",
      agentId: bot,
      at: new Date(at + 1_000),
    });
    expect(await nextOf()).toBe("Send the reply to Danny?");
    await channelStore.recordActivity(owner, opened.channelId, {
      text: "Make it shorter",
      agentId: null,
      at: new Date(at + 2_000),
    });
    expect(await nextOf()).toBe("“Make it shorter”");
    // Read the same way on the list.
    expect(
      (await taskStore.list(owner.id)).find((task) => task.id === opened.id)
        ?.next,
    ).toBe("“Make it shorter”");
  });

  test("a finished reply asks for input, and queued replies clear that question while working", async () => {
    const task = await freshTask();
    const where = await turnFor(task.id);
    await database
      .update(workItems)
      .set({ finishedAt: new Date() })
      .where(where);
    const located = await taskStore.locate(owner.id, task.id);
    await channelStore.recordActivity(owner, located!.channelId, {
      text: "Here is the draft.\n\nWhich one should I use? 🙂",
      agentId: bot,
      at: new Date(),
    });
    expect(await statusOf(task.id)).toBe("needs_input");
    expect((await taskStore.get(owner.id, task.id)).next).toContain(
      "Which one",
    );
    await database.insert(workItems).values({
      kind: PROACTIVE_TASK_KIND,
      key: `reply-${task.id}`,
      payload: {
        taskId: task.id,
        ownerUserId: owner.id,
        reply: "Use A",
        messageId: "reply-a",
      },
    });
    expect(await statusOf(task.id)).toBe("working");
  });

  async function resolvedReply() {
    const task = await freshTask();
    const queue: WorkQueue = {
      ...createWorkQueue(database),
      claim: async () => [],
    };
    const { engine } = engineFor(async () => {}, queue);
    const input = { reply: "Prepare the first draft", messageId: randomUUID() };
    await engine.reply(owner.id, task.id, input);
    await engine.idle();
    const taskTurns = and(
      eq(workItems.kind, PROACTIVE_TASK_KIND),
      sql`${workItems.payload}->>'taskId' = ${task.id}`,
    );
    await database
      .update(workItems)
      .set({ attempts: 1, finishedAt: sql`now()` })
      .where(taskTurns);
    const located = await taskStore.locate(owner.id, task.id);
    await channelStore.recordActivity(owner, located!.channelId, {
      text: "Should I send the old draft?",
      agentId: bot,
      at: new Date(),
    });
    const resolved = await taskStore.resolve(owner.id, task.id);
    expect(resolved.status).toBe("resolved");
    const accepted = () => database.select().from(workItems).where(taskTurns);
    return {
      task,
      queue,
      engine,
      input,
      resolved,
      accepted,
      taskTurns,
      channelId: located!.channelId,
    };
  }

  test("new durable work after resolution exposes its final question", async () => {
    const text = "Should I send the revised draft?";
    const { task, engine, accepted, taskTurns, channelId } =
      await resolvedReply();
    await engine.reply(owner.id, task.id, {
      reply: "Revise it",
      messageId: randomUUID(),
    });
    await engine.idle();
    expect(await accepted()).toHaveLength(2);
    const queued = await taskStore.get(owner.id, task.id);
    expect(
      (await accepted()).find((row) => row.finishedAt === null),
    ).toMatchObject({
      attempts: 0,
    });
    await database
      .update(workItems)
      .set({ finishedAt: sql`now()` })
      .where(taskTurns);
    // Accepted work supersedes completion, but cannot resurrect the old dismissed question.
    const withoutNewOutput = await taskStore.get(owner.id, task.id);
    await channelStore.recordActivity(owner, channelId, {
      text,
      agentId: bot,
      at: new Date(),
    });
    const expected = { status: "needs_input", resolvedAt: null, next: text };
    expect(await taskStore.get(owner.id, task.id)).toMatchObject(expected);
    expect(queued).toMatchObject({ status: "working", resolvedAt: null });
    expect(withoutNewOutput).toMatchObject({
      status: "ready_for_review",
      resolvedAt: null,
    });
    expect(
      (await taskStore.list(owner.id)).find((row) => row.id === task.id),
    ).toMatchObject(expected);
  });

  test("resolution keeps an unanswered final question dismissed without new durable work", async () => {
    const { task, resolved, accepted } = await resolvedReply();
    expect(await accepted()).toHaveLength(1);
    expect(await taskStore.get(owner.id, task.id)).toMatchObject({
      status: "resolved",
      resolvedAt: resolved.resolvedAt,
    });
  });

  test("replaying an accepted reply after resolution neither accepts new work nor reopens it", async () => {
    const { task, engine, input, resolved, accepted } = await resolvedReply();
    await engine.reply(owner.id, task.id, input);
    await engine.idle();
    expect(await accepted()).toHaveLength(1);
    expect(await taskStore.get(owner.id, task.id)).toMatchObject({
      status: "resolved",
      resolvedAt: resolved.resolvedAt,
    });
  });

  test("rejected reply context neither accepts new work nor reopens a resolved task", async () => {
    const { task, engine, resolved, accepted } = await resolvedReply();
    await expect(
      engine.reply(owner.id, task.id, {
        reply: "Use this file",
        messageId: randomUUID(),
        attachmentIds: [randomUUID()],
      }),
    ).rejects.toThrow("Files and skills are unavailable for this task.");
    expect(await accepted()).toHaveLength(1);
    expect(await taskStore.get(owner.id, task.id)).toMatchObject({
      status: "resolved",
      resolvedAt: resolved.resolvedAt,
    });
  });

  test("a refused reply offer neither accepts new work nor reopens a resolved task", async () => {
    const { task, queue, resolved, accepted } = await resolvedReply();
    const refused = engineFor(async () => {}, {
      ...queue,
      offer: (input) =>
        queue.offer({
          ...input,
          atMost: { keyPrefix: `task:${task.id}:reply:`, max: 0 },
        }),
    });
    await refused.engine.reply(owner.id, task.id, {
      reply: "Revise it",
      messageId: randomUUID(),
    });
    await refused.engine.idle();
    expect(await accepted()).toHaveLength(1);
    expect(await taskStore.get(owner.id, task.id)).toMatchObject({
      status: "resolved",
      resolvedAt: resolved.resolvedAt,
    });
  });

  test("is worked out from the queue, the approval inbox and the question queue, never stored", async () => {
    const task = await freshTask();
    // Opened, and its turn not queued yet: just started.
    expect(await statusOf(task.id)).toBe("working");

    // Its turn, queued and then running: working.
    const where = await turnFor(task.id);
    expect(await statusOf(task.id)).toBe("working");
    await database
      .update(workItems)
      .set({
        attempts: 1,
        claimedBy: "worker",
        leaseUntil: sql`now() + interval '5 minutes'`,
      })
      .where(where);
    expect(await statusOf(task.id)).toBe("working");
    // Finished: the run wrote its reply, so there is something to read.
    await database
      .update(workItems)
      .set({ finishedAt: new Date(), claimedBy: null, leaseUntil: null })
      .where(where);
    expect(await statusOf(task.id)).toBe("ready_for_review");

    // Its reply stopped for Allow once: needs input.
    const approvalId = `${prefix}-approval-${randomUUID()}`;
    await database.insert(approvalRequests).values({
      id: approvalId,
      ownerUserId: owner.id,
      runId: `task-${task.id}`,
      toolCallId: "send",
      actionDigest: "digest",
      action: {
        threadId: task.threadId,
        botId: bot,
        toolRef: "google-workspace/gmail_send_reply",
      } as never,
    });
    expect(await statusOf(task.id)).toBe("needs_input");

    // Allowed: carried on, so working; done, so ready to read.
    await database
      .update(approvalRequests)
      .set({ status: "approved", decision: "allow_once" })
      .where(eq(approvalRequests.id, approvalId));
    await database.insert(workItems).values({
      kind: "approval.resume",
      key: approvalId,
      payload: { ownerUserId: owner.id, approvalId },
    });
    expect(await statusOf(task.id)).toBe("working");
    await database
      .update(workItems)
      .set({ finishedAt: new Date() })
      .where(
        and(
          eq(workItems.kind, "approval.resume"),
          eq(workItems.key, approvalId),
        ),
      );
    await database
      .update(approvalRequests)
      .set({ status: "completed" })
      .where(eq(approvalRequests.id, approvalId));
    expect(await statusOf(task.id)).toBe("ready_for_review");

    // A question its Bot asked in its conversation: needs input until answered.
    const question = `${prefix}-question-${randomUUID()}`;
    await database.insert(workItems).values({
      kind: "person.question",
      key: question,
      payload: {
        actorId: owner.id,
        botId: bot,
        threadId: task.threadId,
        question: "Which glaze?",
      },
    });
    expect(await statusOf(task.id)).toBe("needs_input");
    await database
      .update(workItems)
      .set({ finishedAt: new Date() })
      .where(
        and(eq(workItems.kind, "person.question"), eq(workItems.key, question)),
      );

    // Marked done: resolved. Something waiting on the person still shows over it.
    await taskStore.resolve(owner.id, task.id);
    expect(await statusOf(task.id)).toBe("resolved");
    await taskStore.reopen(owner.id, task.id);
    expect(await statusOf(task.id)).toBe("ready_for_review");

    // Nothing about status is a column.
    const [row] = await database
      .select()
      .from(tasks)
      .where(eq(tasks.id, task.id));
    expect(Object.keys(row ?? {})).not.toContain("status");
  });

  test("another person's pending approval on the same thread id is not this task's", async () => {
    const task = await freshTask();
    await turnFor(task.id, { attempts: 1, finishedAt: new Date() });
    await database.insert(approvalRequests).values({
      id: `${prefix}-theirs-${randomUUID()}`,
      ownerUserId: other.id,
      runId: "theirs",
      toolCallId: "send",
      actionDigest: "digest",
      action: { threadId: task.threadId, botId: bot } as never,
    });
    expect(await statusOf(task.id)).toBe("ready_for_review");
  });
});

describe("/api/tasks", () => {
  const routes = createTaskRoutes(taskStore, async (context, next) => {
    context.set("actor", {
      id: context.req.header("x-person") ?? owner.id,
    } as AuthenticatedActor);
    await next();
  });
  const call = (person: string, path: string, method = "GET") =>
    routes.request(path, { method, headers: { "x-person": person } });

  test("lists the person's own tasks, newest first, and resolves and reopens them", async () => {
    const first = await threads.open({
      ownerUserId: owner.id,
      agentId: bot,
      title: "Older",
      why: null,
      origin: "asked",
      suggestionId: null,
      sourceApp: null,
      sourceLink: null,
    });
    await Bun.sleep(5);
    const second = await threads.open({
      ownerUserId: owner.id,
      agentId: bot,
      title: "Newer",
      why: null,
      origin: "asked",
      suggestionId: null,
      sourceApp: null,
      sourceLink: null,
    });
    const listed = (await (await call(owner.id, "/")).json()) as {
      tasks: TaskRecord[];
    };
    const ids = listed.tasks.map((task) => task.id);
    expect(ids.indexOf(second.id)).toBeLessThan(ids.indexOf(first.id));
    expect(listed.tasks.every((task) => typeof task.status === "string")).toBe(
      true,
    );

    // Each names its conversation's thread, which its approvals and questions carry.
    const conversation = await channelStore.get(owner, second.channelId);
    expect(listed.tasks.find((task) => task.id === second.id)?.threadId).toBe(
      conversation?.threadId ?? "missing",
    );

    await turnFor(second.id, { attempts: 1, finishedAt: new Date() });
    const resolved = (await (
      await call(owner.id, `/${second.id}/resolve`, "POST")
    ).json()) as { task: TaskRecord };
    expect(resolved.task.status).toBe("resolved");
    expect(resolved.task.resolvedAt).not.toBeNull();
    const reopened = (await (
      await call(owner.id, `/${second.id}/reopen`, "POST")
    ).json()) as { task: TaskRecord };
    expect(reopened.task.status).toBe("ready_for_review");
    expect(reopened.task.resolvedAt).toBeNull();
  });

  test("another person's task is the same as no task", async () => {
    const mine = await threads.open({
      ownerUserId: owner.id,
      agentId: bot,
      title: "Mine",
      why: null,
      origin: "asked",
      suggestionId: null,
      sourceApp: null,
      sourceLink: null,
    });
    expect((await call(other.id, `/${mine.id}`)).status).toBe(404);
    expect((await call(other.id, `/${mine.id}/resolve`, "POST")).status).toBe(
      404,
    );
    expect((await call(other.id, `/${mine.id}/reopen`, "POST")).status).toBe(
      404,
    );
    const theirs = (await (await call(other.id, "/")).json()) as {
      tasks: TaskRecord[];
    };
    expect(theirs.tasks).toEqual([]);
    expect((await taskStore.get(owner.id, mine.id)).resolvedAt).toBeNull();
  });
});

describe("a task whose turn fails", () => {
  async function opened(title = `Failing ${randomUUID()}`) {
    const task = await threads.open({
      ownerUserId: owner.id,
      agentId: bot,
      title,
      why: null,
      origin: "asked",
      suggestionId: null,
      sourceApp: null,
      sourceLink: null,
    });
    return task;
  }
  const read = (id: string, store = taskStore) => store.get(owner.id, id);

  test("reads Working while its one retry is due, then Failed with the reason in plain words, never Ready for review", async () => {
    const task = await opened();
    // The first run threw: let go with its reason, and due once more.
    const where = await turnFor(task.id, {
      attempts: 1,
      lastError: "fetch failed",
    });
    expect((await read(task.id)).status).toBe("working");
    // A restart cut the first run off: the lease ran out, so the retry is due.
    await database
      .update(workItems)
      .set({
        lastError: null,
        claimedBy: "gone",
        leaseUntil: sql`now() - interval '1 second'`,
      })
      .where(where);
    expect((await read(task.id)).status).toBe("working");
    // The retry running.
    await database
      .update(workItems)
      .set({
        attempts: 2,
        claimedBy: "worker",
        leaseUntil: sql`now() + interval '3 minutes'`,
      })
      .where(where);
    expect((await read(task.id)).status).toBe("working");
    // The retry threw too: out of runs, so it failed, and says why without the error itself.
    await database
      .update(workItems)
      .set({
        claimedBy: null,
        leaseUntil: null,
        lastError: "The routine's turn was stopped after 300s.",
      })
      .where(where);
    const failed = await read(task.id);
    expect(failed.status).toBe("failed");
    expect(failed.failure).toBe("the run took longer than 5 minutes");
    expect(failed.failedAt).not.toBeNull();

    // Marked done, it is done; reopened, it is failed again.
    expect((await taskStore.resolve(owner.id, task.id)).status).toBe(
      "resolved",
    );
    // Its failure stays on the record while it is done, so a reply can still run it.
    expect((await taskStore.resolve(owner.id, task.id)).failure).toBe(
      "the run took longer than 5 minutes",
    );
    expect((await taskStore.reopen(owner.id, task.id)).status).toBe("failed");

    // Try again's turn is the newest, so it counts: working, then ready once it finished.
    const again = await turnFor(task.id, {}, `task:${task.id}:again:1`);
    expect((await read(task.id)).status).toBe("working");
    await database
      .update(workItems)
      .set({ attempts: 1, finishedAt: new Date() })
      .where(again);
    const done = await read(task.id);
    expect(done.status).toBe("ready_for_review");
    expect(done.failure).toBeNull();
    expect(done.failedAt).toBeNull();
  });

  test("whose last run a restart cut off fails, saying so, at the moment its lease ran out", async () => {
    const task = await opened();
    const expired = new Date(Date.now() - 60_000);
    // The first run threw and left its error; the second was cut off, and that is what is said.
    await turnFor(task.id, {
      attempts: 2,
      claimedBy: "gone",
      leaseUntil: expired,
      lastError: "fetch failed",
      updatedAt: new Date(Date.now() - 4 * 60_000),
    });
    expect(await read(task.id)).toMatchObject({
      status: "failed",
      failure: "the run was cut off partway through",
      failedAt: expired.toISOString(),
    });
  });

  test("whose turn never reached the queue fails to start, once it should have", async () => {
    const task = await opened();
    expect((await read(task.id)).status).toBe("working");
    const later = createTaskStore(database, {
      now: () => new Date(Date.now() + 2 * 60_000),
    });
    expect(await read(task.id, later)).toMatchObject({
      status: "failed",
      failure: "it never started",
    });
  });

  test("stays Failed whatever is said in its conversation, until a turn of its own finishes", async () => {
    const task = await opened();
    await turnFor(task.id, { attempts: 2, lastError: "fetch failed" });
    await channelStore.recordActivity(
      owner,
      task.channelId,
      {
        text: "I couldn't finish this: a service didn't answer.",
        agentId: bot,
        at: new Date(),
      },
      { id: `task-${task.id}-x:failed` },
    );
    // A Bot answer from the browser is not the task's turn: it may not have had the task at all.
    await channelStore.recordActivity(owner, task.channelId, {
      text: "Try it with the other glaze.",
      agentId: null,
      at: new Date(Date.now() + 1_000),
    });
    await channelStore.recordActivity(owner, task.channelId, {
      text: "Evening. Here's what's in your inbox.",
      agentId: bot,
      at: new Date(Date.now() + 2_000),
    });
    expect((await read(task.id)).status).toBe("failed");
    // Its own turn finishing is.
    const again = await turnFor(task.id, {}, `task:${task.id}:again:1`);
    await database
      .update(workItems)
      .set({ attempts: 1, finishedAt: new Date() })
      .where(again);
    expect((await read(task.id)).status).toBe("ready_for_review");
  });

  test("runs once more after throwing, and the second run is its last", async () => {
    const { engine, items, started } = engineFor(async () => {
      throw new Error("The routine's turn was stopped after 300s.");
    });
    const task = await engine.startAsked(owner.id, bot, {
      title: "Prepare notes for the Hearth & Co visit",
      instruction: "Prepare notes for the Hearth & Co visit.",
    });
    await engine.idle();
    expect(started.map((run) => run.final)).toEqual([false, true]);
    expect(started[0]?.runId).toBe(`task-${task.id}`);
    // The retry is a run of its own, so it never collides with the first in the conversation.
    expect(started[1]?.runId).toStartWith(`task-${task.id}-`);
    expect(started[1]?.runId).not.toBe(started[0]?.runId);
    expect(started[1]?.text).toBe(started[0]?.text);
    // Out of runs: unfinished on the queue, with its reason, which is what reads as Failed.
    expect(
      items.get(`${PROACTIVE_TASK_KIND}:task:${task.id}`)?.payload,
    ).toMatchObject({ runs: 2 });
    expect(items.get(`${PROACTIVE_TASK_KIND}:task:${task.id}`)).toMatchObject({
      attempts: 2,
      finished: false,
      lastError: "The routine's turn was stopped after 300s.",
    });
  });

  test("whose first run a restart cut off is picked up by the sweep, as its last run", async () => {
    const task = await opened();
    const { engine, items, started } = engineFor();
    // Claimed once by a process that died: its lease has run out.
    items.set(`${PROACTIVE_TASK_KIND}:task:${task.id}`, {
      kind: PROACTIVE_TASK_KIND,
      key: `task:${task.id}`,
      payload: {
        ownerUserId: owner.id,
        taskId: task.id,
        text: "Go on.",
        runs: 2,
      },
      attempts: 1,
      finished: false,
      claimed: false,
    });
    await engine.sweep();
    expect(started).toHaveLength(1);
    expect(started[0]?.final).toBe(true);
    expect(started[0]?.runId).toStartWith(`task-${task.id}-`);
    expect(started[0]?.text).toBe(frameTaskBrief("Go on."));
    expect(items.get(`${PROACTIVE_TASK_KIND}:task:${task.id}`)?.finished).toBe(
      true,
    );
  });

  test("a turn from before retries is never run a second time, and stays failed", async () => {
    const task = await opened();
    const { engine, items, started } = engineFor();
    // Failed once, when one failure was final, and left unfinished.
    items.set(`${PROACTIVE_TASK_KIND}:task:${task.id}`, {
      kind: PROACTIVE_TASK_KIND,
      key: `task:${task.id}`,
      payload: { ownerUserId: owner.id, taskId: task.id, text: "Go on." },
      attempts: 1,
      finished: false,
      claimed: false,
    });
    await engine.sweep().catch(() => undefined);
    expect(started).toHaveLength(0);
    expect(items.get(`${PROACTIVE_TASK_KIND}:task:${task.id}`)).toMatchObject({
      attempts: 2,
      finished: false,
      lastError: "This turn failed before it could be tried again.",
    });
  });

  test("a research run that throws in the sweep does not hold back a task's turn", async () => {
    const task = await opened();
    const { engine, items, started } = engineFor();
    items.set(`${PROACTIVE_RUN_KIND}:broken`, {
      kind: PROACTIVE_RUN_KIND,
      key: "broken",
      payload: {},
      attempts: 0,
      finished: false,
      claimed: false,
    });
    items.set(`${PROACTIVE_TASK_KIND}:task:${task.id}`, {
      kind: PROACTIVE_TASK_KIND,
      key: `task:${task.id}`,
      payload: {
        ownerUserId: owner.id,
        taskId: task.id,
        text: "Go on.",
        runs: 2,
      },
      attempts: 0,
      finished: false,
      claimed: false,
    });
    await expect(engine.sweep()).rejects.toThrow();
    expect(started).toHaveLength(1);
    expect(items.get(`${PROACTIVE_TASK_KIND}:task:${task.id}`)?.finished).toBe(
      true,
    );
  });

  test("a reply on a failed task is Try again: the person's own message, with the ask beside it for the model", async () => {
    const task = await opened();
    await turnFor(task.id, { attempts: 2, lastError: "fetch failed" });
    const { engine, items, started } = engineFor();
    await engine.again(owner.id, task.id, {
      reply: "Use the Oat Satin glaze.",
      messageId: "reply-0123456789",
    });
    await engine.idle();
    expect(started).toHaveLength(1);
    expect(started[0]?.text).toBe(
      frameTaskReply("Prepare the notes.", "Use the Oat Satin glaze."),
    );
    // Their bubble is their words, under the id the browser already drew it with.
    expect(readTaskBrief(started[0]?.text ?? "")).toBe(
      "Use the Oat Satin glaze.",
    );
    expect(started[0]?.runId).toBe("reply-0123456789");
    expect(
      items.get(`${PROACTIVE_TASK_KIND}:task:${task.id}:again:1`)?.payload,
    ).toMatchObject({
      reply: "Use the Oat Satin glaze.",
      again: true,
      runs: 2,
    });
  });

  test.each(["Review the blue ledger.", ""])(
    "Try again preserves the exhausted reply envelope for text %j",
    async (text) => {
      const task = await opened();
      const questionId = `accepted-question-${randomUUID()}`;
      const futureQuestionId = `future-question-${randomUUID()}`;
      const question = {
        ownerUserId: owner.id,
        actorId: owner.id,
        channelId: task.channelId,
        mode: "completed_question",
      };
      await database.insert(workItems).values({
        kind: "person.question",
        key: questionId,
        payload: question,
      });
      const envelope = {
        text,
        reply: text || "Sent attachments",
        attachmentIds: ["12345678-1234-4123-8123-123456789abc"],
        skillIds: ["review-blue-ledger"],
        followup: true,
        questionIds: [questionId],
      };
      const messageId = `accepted-reply-${randomUUID()}`;
      await turnFor(task.id, {
        payload: {
          ownerUserId: owner.id,
          taskId: task.id,
          ...envelope,
          messageId,
          runs: 2,
        },
        attempts: 2,
        lastError: "Failed before input persistence",
      });
      expect(await taskStore.failedTurn(owner.id, task.id)).toEqual({
        ask: envelope,
        turns: 1,
      });
      let attempts = 0;
      const { engine, items, started } = engineFor(async () => {
        if (++attempts === 1) {
          await database.insert(workItems).values({
            kind: "person.question",
            key: futureQuestionId,
            payload: question,
          });
          throw new Error("Retry before delivering the preserved input");
        }
      });
      await engine.again(owner.id, task.id);
      await engine.idle();
      expect(
        items.get(`${PROACTIVE_TASK_KIND}:task:${task.id}:again:1`)?.payload,
      ).toEqual({
        ownerUserId: owner.id,
        taskId: task.id,
        ...envelope,
        again: true,
        runs: 2,
      });
      expect(started).toHaveLength(2);
      for (const run of started) {
        expect(run).toMatchObject({
          text,
          attachmentIds: envelope.attachmentIds,
          skillIds: envelope.skillIds,
        });
        expect(run.runId).not.toBe(messageId);
      }
      expect(started[0]!.runId).not.toBe(started[1]!.runId);
      expect(await taskStore.pendingQuestions(owner.id, task.id)).toEqual([
        futureQuestionId,
      ]);
    },
  );

  test.each(["asked", "suggestion"])(
    "successive initial %s corrections survive absent model history",
    async (origin) => {
      let failing = true;
      const persisted: unknown[] = [];
      const received: string[] = [];
      const taskTurn = createTaskTurn({
        actorFor,
        channels: channelStore,
        runTurn: async (input) => {
          if (failing) throw new Error("Failed before history persistence");
          received.push(input.instruction);
          persisted.push(input.userMessage);
          return { replyText: "" };
        },
      });
      const { engine, started } = engineFor(
        async ({ scope, ...input }, signal) => {
          await taskTurn(scope, { ...input, signal });
        },
        createWorkQueue(database),
      );
      const suggestion =
        origin === "suggestion" ? await suggestionFor("Draft the email") : null;
      const task = suggestion
        ? (await engine.start(owner.id, suggestion.id)).task
        : await engine.startAsked(owner.id, bot, {
            title: "Draft the email",
            instruction: "Draft the email",
          });
      await engine.idle();
      await engine.again(owner.id, task.id, { reply: "Write it in French" });
      await engine.idle();
      const { ask } = await taskStore.failedTurn(owner.id, task.id);
      expect(ask).toMatchObject({
        reply: "Write it in French",
        ...(suggestion
          ? { suggestionId: suggestion.id }
          : { text: "Draft the email" }),
      });
      expect({ persisted, attempts: started.length }).toEqual({
        persisted: [],
        attempts: 4,
      });
      failing = false;
      const messageId = randomUUID();
      await engine.again(owner.id, task.id, {
        reply: "Use a formal tone",
        messageId,
      });
      await engine.idle();
      expect(
        received.map((text) =>
          text.match(/Draft the email|Write it in French|Use a formal tone/g),
        ),
      ).toEqual([
        ["Draft the email", "Write it in French", "Use a formal tone"],
      ]);
      expect({
        final: started.slice(4),
        identities: new Set(started.map((run) => run.runId)).size,
      }).toMatchObject({
        final: [{ runId: messageId, scope: { channelId: task.channelId } }],
        identities: 5,
      });
    },
  );

  test("successive corrections preserve failed followup context and display only the latest reply", async () => {
    const task = await opened();
    const questionId = `accepted-question-${randomUUID()}`;
    const context = {
      attachmentIds: ["12345678-1234-4123-8123-123456789abc"],
      skillIds: ["review-blue-ledger"],
      followup: true,
      questionIds: [questionId],
    };
    await database.insert(workItems).values({
      kind: "person.question",
      key: questionId,
      payload: {
        ownerUserId: owner.id,
        actorId: owner.id,
        channelId: task.channelId,
        mode: "completed_question",
      },
    });
    const original = "Review the blue ledger.";
    await turnFor(task.id, {
      payload: {
        ownerUserId: owner.id,
        taskId: task.id,
        text: original,
        reply: original,
        ...context,
        runs: 2,
      },
      attempts: 2,
      lastError: "fetch failed",
    });
    const { engine, started } = engineFor(async () => {
      throw new Error("fetch failed");
    }, createWorkQueue(database));
    const corrections = [
      "Use the revised totals.",
      `Use October's exchange rate. Keep this quote:\n\n${TASK_REPLY_LINE}\n\nQuoted example.`,
    ];
    const earlier = [original];
    for (const [index, reply] of corrections.entries()) {
      const messageId = `revised-reply-${index}`;
      await engine.again(owner.id, task.id, { reply, messageId });
      await engine.idle();
      expect(started).toHaveLength((index + 1) * 2);
      expect(started[index * 2]!.runId).toBe(messageId);
      const failed = await taskStore.failedTurn(owner.id, task.id);
      expect(failed).toMatchObject({
        ask: { ...context, reply },
        turns: index + 2,
      });
      for (const run of started.slice(index * 2)) {
        expect(run).toMatchObject({
          attachmentIds: context.attachmentIds,
          skillIds: context.skillIds,
        });
        for (const text of earlier) expect(run.text).toContain(text);
        expect(readTaskBrief(run.text)).toBe(reply);
      }
      earlier.push(reply);
    }
    expect(await taskStore.pendingQuestions(owner.id, task.id)).toEqual([]);
  });

  test("accepted replies keep one identity across retries and Try again, including equal-text corrections", async () => {
    const task = await opened();
    const reply = "Use October's exchange rate.";
    const messages: { id: string; role: string; content?: unknown }[] = [
      {
        id: "initial",
        role: "user",
        content: frameTaskBrief("Prepare the notes."),
      },
    ];
    const received: Parameters<TurnRunner>[0][] = [];
    const context = replyContextForTest();
    const taskTurn = createTaskTurn({
      actorFor,
      channels: channelStore,
      replyContext: context,
      runTurn: async (input) => {
        if (input.userMessage?.role !== "user")
          throw new Error("Task user message is missing");
        received.push(input);
        messages.push(input.userMessage);
        throw new Error("fetch failed");
      },
    });
    const { engine, started } = engineFor(
      async ({ scope, ...input }, signal) => {
        await taskTurn(scope, { ...input, signal });
      },
      createWorkQueue(database),
      context,
    );
    await engine.reply(owner.id, task.id, { reply, messageId: "accepted-a" });
    await engine.idle();
    await engine.again(owner.id, task.id);
    await engine.idle();
    await engine.again(owner.id, task.id, { reply, messageId: "accepted-b" });
    await engine.idle();
    expect(new Set(started.map((run) => run.runId)).size).toBe(6);
    expect(started[0]?.runId).toBe("accepted-a");
    expect(started[4]?.runId).toBe("accepted-b");
    expect(started.map((run) => run.acceptedReply?.id)).toEqual([
      "accepted-a",
      "accepted-a",
      "accepted-a",
      "accepted-a",
      "accepted-b",
      "accepted-b",
    ]);
    expect(
      messages
        .filter((message) => message.role === "user")
        .slice(1)
        .map((message) => readTaskFrame(String(message.content))?.inputId),
    ).toEqual(started.map((run) => run.acceptedReply?.id));
    const quoted = frameTaskBrief("quoted task text");
    await engine.reply(owner.id, task.id, {
      reply: quoted,
      messageId: "accepted-quote",
    });
    await engine.idle();
    const quotedInputs = messages
      .filter((message) => message.role === "user")
      .slice(-2);
    for (const message of quotedInputs)
      expect(readTaskBrief(String(message.content))).toBe(quoted);
    const file = await attachmentForTask(task.channelId);
    await engine.reply(owner.id, task.id, {
      reply: "",
      messageId: "accepted-file",
      attachmentIds: [file.id],
    });
    await engine.idle();
    const fileInputs = received.slice(-2);
    expect(
      fileInputs.map((input) => {
        const content = input.userMessage?.content;
        const text = Array.isArray(content)
          ? content.flatMap((part) => (part.type === "text" ? [part.text] : []))
          : [content];
        return readTaskFrame(String(text[0] ?? ""))?.inputId;
      }),
    ).toEqual(["accepted-file", "accepted-file"]);
    const document = {
      type: "document",
      source: {
        type: "url",
        value: `/api/attachments/${file.id}`,
        mimeType: "text/plain",
      },
      metadata: { attachmentId: file.id, filename: "notes.txt" },
    };
    expect(
      fileInputs.map((input) => {
        const content = input.userMessage?.content;
        return Array.isArray(content)
          ? content.filter((part) => part.type !== "text")
          : content;
      }),
    ).toEqual([[document], [document]]);
    expect(fileInputs.map((input) => input.instruction)).toEqual(["", ""]);
  });

  test("marked done after failing, it keeps its failure, and a reply runs it and makes it not done", async () => {
    const task = await opened();
    await turnFor(task.id, { attempts: 2, lastError: "fetch failed" });
    const done = await taskStore.resolve(owner.id, task.id);
    expect(done).toMatchObject({
      status: "resolved",
      failure: "a service didn't answer",
    });
    expect(done.failedAt).not.toBeNull();
    const queue = createWorkQueue(database);
    const { engine, started } = engineFor(async () => {}, queue);
    await engine.again(owner.id, task.id, { reply: "Please do it now." });
    await engine.idle();
    expect(started).toHaveLength(1);
    expect((await taskStore.get(owner.id, task.id)).resolvedAt).toBeNull();
    // Done and never failed has nothing to try again.
    const fine = await opened();
    await turnFor(fine.id, { attempts: 1, finishedAt: new Date() });
    await taskStore.resolve(owner.id, fine.id);
    await expect(engine.again(owner.id, fine.id)).rejects.toThrow(
      "Only a task that couldn't finish can be tried again.",
    );
  });

  test("a refused Try again offer preserves the failed task's completion", async () => {
    const task = await opened();
    await turnFor(task.id, { attempts: 2, lastError: "fetch failed" });
    const done = await taskStore.resolve(owner.id, task.id);
    const queue = createWorkQueue(database);
    const { engine } = engineFor(async () => {}, {
      ...queue,
      offer: (input) =>
        queue.offer({
          ...input,
          atMost: { keyPrefix: `task:${task.id}:again:`, max: 0 },
        }),
    });
    await expect(engine.again(owner.id, task.id)).rejects.toThrow(
      "This task is already being tried again.",
    );
    const turns = await database
      .select()
      .from(workItems)
      .where(sql`${workItems.payload}->>'taskId' = ${task.id}`);
    expect(turns).toHaveLength(1);
    const [persisted] = await database
      .select({ resolvedAt: tasks.resolvedAt })
      .from(tasks)
      .where(eq(tasks.id, task.id));
    expect(persisted?.resolvedAt?.toISOString() ?? null).toBe(done.resolvedAt);
    const expected = { status: "resolved", resolvedAt: done.resolvedAt };
    const detail = await taskStore.get(owner.id, task.id);
    const listed = (await taskStore.list(owner.id)).find(
      (row) => row.id === task.id,
    );
    expect([detail, listed]).toMatchObject([expected, expected]);
  });

  test("a turn shaped as main queued it, from before tasks and retries, opens nothing and never runs again", async () => {
    const { engine, items, started } = engineFor();
    const suggestionId = `${prefix}-main-suggestion-${randomUUID()}`;
    // Main's Start: keyed by the suggestion, no task, no run count, failed once and left.
    items.set(`${PROACTIVE_TASK_KIND}:${suggestionId}`, {
      kind: PROACTIVE_TASK_KIND,
      key: suggestionId,
      payload: { ownerUserId: owner.id, suggestionId },
      attempts: 1,
      finished: false,
      claimed: false,
    });
    const tasksBefore = await database
      .select({ id: tasks.id })
      .from(tasks)
      .where(eq(tasks.ownerUserId, owner.id));
    await engine.sweep().catch(() => undefined);
    const tasksAfter = await database
      .select({ id: tasks.id })
      .from(tasks)
      .where(eq(tasks.ownerUserId, owner.id));
    expect(tasksAfter).toHaveLength(tasksBefore.length);
    expect(started).toHaveLength(0);
    expect(items.get(`${PROACTIVE_TASK_KIND}:${suggestionId}`)).toMatchObject({
      attempts: 2,
      finished: false,
      lastError: "This turn failed before it could be tried again.",
    });
  });

  test("Try again runs it once more in its own conversation, and only when it failed", async () => {
    const task = await opened();
    await turnFor(task.id, { attempts: 2, lastError: "fetch failed" });
    const { engine, items, started } = engineFor();

    // Somebody else's task is no task.
    await expect(engine.again(other.id, task.id)).rejects.toThrow(
      "Couldn't find that task.",
    );
    // Pressed twice at once, it is one run, and the second is told so rather than answered as done.
    const both = await Promise.allSettled([
      engine.again(owner.id, task.id),
      engine.again(owner.id, task.id),
    ]);
    expect(both.map((outcome) => outcome.status).sort()).toEqual([
      "fulfilled",
      "rejected",
    ]);
    expect(
      both.find((outcome) => outcome.status === "rejected")?.reason,
    ).toBeInstanceOf(ProactiveRefusedError);
    await engine.idle();
    expect(started).toHaveLength(1);
    expect(started[0]?.scope.channelId).toBe(task.channelId);
    expect(started[0]?.text).toBe(frameTaskBrief("Prepare the notes."));
    expect(started[0]?.runId).toStartWith(`task-${task.id}-`);
    expect(started[0]?.final).toBe(false);
    expect(
      items.get(`${PROACTIVE_TASK_KIND}:task:${task.id}:again:1`)?.finished,
    ).toBe(true);

    // One that did not fail has nothing to try again.
    const fine = await opened();
    await turnFor(fine.id, { attempts: 1, finishedAt: new Date() });
    await expect(engine.again(owner.id, fine.id)).rejects.toThrow(
      "Only a task that couldn't finish can be tried again.",
    );
  });

  test("Try again is served to the task's owner, for a failed task only", async () => {
    const task = await opened();
    await turnFor(task.id, { attempts: 2, lastError: "fetch failed" });
    const fine = await opened();
    await turnFor(fine.id, { attempts: 1, finishedAt: new Date() });
    const { engine, started } = engineFor();
    const routes = createTaskRoutes(
      taskStore,
      async (context, next) => {
        context.set("actor", {
          id: context.req.header("x-person") ?? owner.id,
        } as AuthenticatedActor);
        await next();
      },
      { retry: engine },
    );
    const again = (person: string, id: string) =>
      routes.request(`/${id}/again`, {
        method: "POST",
        headers: { "x-person": person },
      });

    expect((await again(other.id, task.id)).status).toBe(404);
    const refused = await again(owner.id, fine.id);
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: string }).error).toBe(
      "Only a task that couldn't finish can be tried again.",
    );
    const tooLong = await routes.request(`/${task.id}/again`, {
      method: "POST",
      headers: { "x-person": owner.id, "content-type": "application/json" },
      body: JSON.stringify({ reply: "x".repeat(4001) }),
    });
    expect(tooLong.status).toBe(400);
    const badId = await routes.request(`/${task.id}/again`, {
      method: "POST",
      headers: { "x-person": owner.id, "content-type": "application/json" },
      body: JSON.stringify({ reply: "Hi", messageId: "<script>" }),
    });
    expect(badId.status).toBe(400);
    const accepted = await routes.request(`/${task.id}/again`, {
      method: "POST",
      headers: { "x-person": owner.id, "content-type": "application/json" },
      body: JSON.stringify({
        reply: "Use the Oat Satin glaze.",
        messageId: "reply-route-0001",
      }),
    });
    expect(accepted.status).toBe(200);
    expect(((await accepted.json()) as { task: TaskRecord }).task.id).toBe(
      task.id,
    );
    await engine.idle();
    expect(started).toHaveLength(1);
    expect(readTaskBrief(started[0]?.text ?? "")).toBe(
      "Use the Oat Satin glaze.",
    );
    expect(started[0]?.runId).toBe("reply-route-0001");
    // And with no body, as the button sends it.
    const fresh = await opened();
    await turnFor(fresh.id, { attempts: 2, lastError: "fetch failed" });
    expect((await again(owner.id, fresh.id)).status).toBe(200);
    await engine.idle();
    expect(readTaskBrief(started[1]?.text ?? "")).toBe("Prepare the notes.");
  });
});

describe("start_task", () => {
  test("opens the task with a conversation of its own and starts exactly one turn there", async () => {
    const chat = await chatOf();
    const { engine, items, started } = engineFor();
    const [tool] = await taskTools({
      actorId: owner.id,
      botId: bot,
      initiator: { kind: "person" },
      start: ({ ownerUserId, agentId, task }) =>
        engine.startAsked(ownerUserId, agentId, task),
      builtIn: async () => true,
    });
    if (tool?.name !== START_TASK_TOOL)
      throw new Error(`${START_TASK_TOOL} is not held`);

    const instruction =
      "Draft a reply to Rosa saying we'll take Oat Satin instead of the discontinued glaze.";
    const result = JSON.parse(
      await tool.execute({
        title: "Draft a reply to Rosa about Oat Satin",
        instruction,
        why: "She needs an answer before Friday's firing.",
        source: "Gmail",
      }),
    ) as { taskId: string; channelId: string; title: string };
    await engine.idle();

    expect(result.title).toBe("Draft a reply to Rosa about Oat Satin");
    const task = await taskStore.get(owner.id, result.taskId);
    expect(task).toMatchObject({
      botId: bot,
      channelId: result.channelId,
      origin: "asked",
      why: "She needs an answer before Friday's firing.",
      sourceApp: "Gmail",
      suggestionId: null,
      resolvedAt: null,
    });
    // Its own conversation, with the Bot alone, and not the one it was asked in.
    expect(task.channelId).not.toBe(chat.id);
    const conversation = await channelStore.get(owner, task.channelId);
    expect(conversation?.agentIds).toEqual([bot]);

    // One turn, in that conversation, with the ask as the person's message under the task frame.
    expect(started).toHaveLength(1);
    expect(started[0]?.scope).toEqual({
      ownerUserId: owner.id,
      channelId: task.channelId,
      agentId: bot,
      threadId: conversation?.threadId ?? "",
    });
    expect(started[0]?.runId).toBe(`task-${task.id}`);
    expect(started[0]?.text).toBe(frameTaskBrief(instruction));
    expect(readTaskBrief(started[0]?.text ?? "")).toBe(instruction);
    expect(items.get(`${PROACTIVE_TASK_KIND}:task:${task.id}`)?.finished).toBe(
      true,
    );
  });

  test("refuses what it cannot start, and starts nothing", async () => {
    const { engine, started } = engineFor();
    const [tool] = await taskTools({
      actorId: owner.id,
      botId: bot,
      initiator: { kind: "person" },
      start: ({ ownerUserId, agentId, task }) =>
        engine.startAsked(ownerUserId, agentId, task),
      builtIn: async () => true,
    });
    for (const args of [
      {},
      { title: "No instruction" },
      { title: "x".repeat(161), instruction: "Do it." },
      { title: "Linked", instruction: "Do it.", link: "javascript:alert(1)" },
      { title: "Extra", instruction: "Do it.", runAs: "someone-else" },
    ])
      expect(await tool?.execute(args)).toStartWith("Refused.");
    await engine.idle();
    expect(started).toEqual([]);
  });

  test("is offered only to a Bot OpenBot runs itself, never to one behind a remote agent framework", async () => {
    const builtInStore = createAgentProfileStore(database, undefined);
    const builtIn = await builtInStore.create(owner, {
      name: "In the box",
      title: "Runs here",
      roleDescription: "Works for one person.",
      visibility: "private",
      systemPrompt: "You work for one person.",
    });
    try {
      const isBuiltIn = builtInBots(database);
      const held = async (botId: string) =>
        (
          await taskTools({
            actorId: owner.id,
            botId,
            initiator: { kind: "person" },
            start: async () => {
              throw new Error("Never started here.");
            },
            builtIn: isBuiltIn,
          })
        ).map((tool) => tool.name);
      expect(await held(builtIn.id)).toEqual([START_TASK_TOOL]);
      // This file's Bot runs at an AG-UI endpoint, as a remote agent framework's does.
      expect(await held(bot)).toEqual([]);
      expect(await held("no-such-bot")).toEqual([]);
    } finally {
      await database
        .delete(agentProfiles)
        .where(eq(agentProfiles.agentId, builtIn.id));
      await database.delete(agents).where(eq(agents.id, builtIn.id));
    }
  });
});

describe("the + on Tasks", () => {
  function plus() {
    const { engine, started } = engineFor();
    const routes = createTaskRoutes(
      taskStore,
      async (context, next) => {
        context.set("actor", {
          id: context.req.header("x-person") ?? owner.id,
        } as AuthenticatedActor);
        await next();
      },
      {
        intake: {
          start: (ownerUserId, agentId, task) =>
            engine.startAsked(ownerUserId, agentId, task),
        },
      },
    );
    const post = (path: string, body: unknown, person = owner.id) =>
      routes.request(path, {
        method: "POST",
        headers: { "content-type": "application/json", "x-person": person },
        body: JSON.stringify(body),
      });
    return { engine, started, post };
  }

  test("Start now opens a task in a conversation of its own and starts it, titled from its first sentence", async () => {
    const chat = await chatOf();
    const { engine, started, post } = plus();
    const instruction =
      "Find a time for coffee with Sam next week.\nHe prefers mornings.";
    const response = await post("/", { botId: bot, instruction });
    expect(response.status).toBe(201);
    const { task } = (await response.json()) as { task: TaskRecord };
    await engine.idle();

    expect(task).toMatchObject({
      botId: bot,
      title: "Find a time for coffee with Sam next week",
      origin: "asked",
      suggestionId: null,
      resolvedAt: null,
    });
    expect(task.channelId).not.toBe(chat.id);
    const conversation = await channelStore.get(owner, task.channelId);
    expect(task.threadId).toBe(conversation?.threadId ?? "missing");
    // One turn, in its conversation, carrying the whole ask.
    expect(started).toHaveLength(1);
    expect(started[0]?.scope.channelId).toBe(task.channelId);
    expect(started[0]?.text).toBe(frameTaskBrief(instruction));
    expect((await taskStore.list(owner.id)).map((row) => row.id)).toContain(
      task.id,
    );
  });

  test("a title the person gives is kept", async () => {
    const { engine, post } = plus();
    const response = await post("/", {
      botId: bot,
      title: "Coffee with Sam",
      instruction: "Find a time for coffee with Sam next week.",
    });
    const { task } = (await response.json()) as { task: TaskRecord };
    await engine.idle();
    expect(task.title).toBe("Coffee with Sam");
  });

  test("an empty ask, or no Bot, is refused with what to do", async () => {
    const { post } = plus();
    const empty = await post("/", { botId: bot, instruction: "   " });
    expect(empty.status).toBe(400);
    expect(((await empty.json()) as { error: string }).error).toContain(
      "Say what your Bot should do",
    );
    const noBot = await post("/", { instruction: "Do a thing" });
    expect(noBot.status).toBe(400);
    expect(((await noBot.json()) as { error: string }).error).toBe(
      "Choose one of your Bots.",
    );
    const extra = await post("/", {
      botId: bot,
      instruction: "Do a thing",
      runAs: "someone-else",
    });
    expect(extra.status).toBe(400);
  });

  test("a Bot the person cannot reach is the same as no Bot", async () => {
    const { started, post } = plus();
    const before = (await taskStore.list(other.id)).length;
    const response = await post(
      "/",
      { botId: bot, instruction: "Read their mail" },
      other.id,
    );
    expect(response.status).toBe(404);
    expect(((await response.json()) as { error: string }).error).toBe(
      "Couldn't find that Bot. Reload the page.",
    );
    expect(started).toHaveLength(0);
    expect(await taskStore.list(other.id)).toHaveLength(before);
  });

  test("without anywhere to start a task, the + is not served", async () => {
    const routes = createTaskRoutes(taskStore, async (context, next) => {
      context.set("actor", { id: owner.id } as AuthenticatedActor);
      await next();
    });
    const response = await routes.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ botId: bot, instruction: "Do a thing" }),
    });
    expect(response.status).toBe(404);
  });
});

test("durable task workers leave other test namespaces untouched", async () => {
  const key = `${prefix}-foreign-reply`;
  const settingId = `${prefix}-foreign-setting`;
  // Another integration file's pending fixture must never be leased or rejected here.
  await database.execute(sql`
    insert into public.work_items (kind, key, payload, run_at)
    values (
      ${PROACTIVE_TASK_KIND}, ${key},
      jsonb_build_object(
        'taskId', ${key}::text, 'ownerUserId', ${owner.id}::text,
        'reply', 'Use A', 'messageId', 'reply-a'
      ),
      now() - interval '1 hour'
    )
  `);
  const { engine, started } = engineFor(
    async () => {},
    createWorkQueue(database),
  );
  try {
    // Queue isolation must also leave another owner's due scheduler input untouched.
    await database.execute(sql`
      insert into public.proactive_settings
        (id, owner_user_id, agent_id, channel_id, thread_id, enabled, next_run_at)
      values (
        ${settingId}, ${other.id}, ${bot}, ${settingId}, ${settingId}, true,
        now() - interval '1 hour'
      )
    `);
    const readSetting = () =>
      database.execute(sql`
      select to_jsonb(setting) as snapshot, enabled and next_run_at <= now() as due
      from public.proactive_settings as setting where id = ${settingId}
    `);
    const [settingBefore] = await readSetting();
    expect(settingBefore?.due).toBe(true);
    const task = await engine.startAsked(owner.id, bot, {
      title: "Isolated worker",
      instruction: "Only run this test's task.",
    });
    await engine.idle();
    await engine.sweep();
    await engine.idle();
    expect(started).toHaveLength(1);
    expect(started[0]?.scope.channelId).toBe(task.channelId);
    const [untouched] = await database.execute(sql`
      select attempts, claimed_by, finished_at, last_error
      from public.work_items where kind = ${PROACTIVE_TASK_KIND} and key = ${key}
    `);
    expect(untouched).toEqual({
      attempts: 0,
      claimed_by: null,
      finished_at: null,
      last_error: null,
    });
    const [settingAfter] = await readSetting();
    expect(settingAfter?.snapshot).toEqual(settingBefore?.snapshot);
  } finally {
    await engine.idle();
    await database.execute(sql`
      delete from public.work_items where kind = ${PROACTIVE_TASK_KIND} and key = ${key}
    `);
    await database.execute(sql`
      delete from public.proactive_settings where id = ${settingId} and owner_user_id = ${other.id}
    `);
  }
});

test("two task reply requests persist behind a running turn and a restarted worker delivers both once", async () => {
  const actual = createWorkQueue(database);
  const prefixKind = `reply-test-${randomUUID()}:`;
  // Keep this engine isolated from other integration files while exercising the real SQL queue.
  const queue: WorkQueue = {
    offer: (input) => actual.offer({ ...input, kind: prefixKind + input.kind }),
    claim: async (input) =>
      (await actual.claim(prefixedClaim(input, prefixKind))).map((item) => ({
        ...item,
        kind: input.kind,
      })),
    renew: (input) => actual.renew({ ...input, kind: prefixKind + input.kind }),
    finish: (input) =>
      actual.finish({ ...input, kind: prefixKind + input.kind }),
    release: (input) =>
      actual.release({ ...input, kind: prefixKind + input.kind }),
    purge: (input) => actual.purge({ ...input, kind: prefixKind + input.kind }),
  };
  const task = await threads.open({
    ownerUserId: owner.id,
    agentId: bot,
    title: "Draft the reply",
    why: null,
    origin: "asked",
    suggestionId: null,
    sourceApp: null,
    sourceLink: null,
  });
  await queue.offer({
    kind: PROACTIVE_TASK_KIND,
    key: "initial",
    payload: { taskId: task.id, ownerUserId: owner.id },
  });
  await queue.claim({
    kind: PROACTIVE_TASK_KIND,
    owner: "old-worker",
    leaseMs: 60_000,
    serialBy: "taskId",
  });
  const { engine, started } = engineFor(async () => {}, queue);
  const routes = createTaskRoutes(
    taskStore,
    async (context, next) => {
      context.set("actor", { id: owner.id } as AuthenticatedActor);
      await next();
    },
    { retry: engine },
  );
  const post = (reply: string, messageId: string) =>
    routes.request(`/${task.id}/reply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reply, messageId }),
    });
  const responses = await Promise.all([
    post("Keep Friday", "reply-first-0001"),
    post("Also cc Sam", "reply-second-0002"),
  ]);
  expect(responses.map((response) => response.status)).toEqual([202, 202]);
  await engine.idle();
  expect(started).toEqual([]);
  const accepted = await database
    .select({
      text: sql<string>`${workItems.payload}->>'text'`,
      questionIds: sql<string[]>`${workItems.payload}->'questionIds'`,
    })
    .from(workItems)
    .where(
      and(
        eq(workItems.kind, prefixKind + PROACTIVE_TASK_KIND),
        sql`${workItems.payload}->>'followup' = 'true'`,
      ),
    )
    .orderBy(workItems.createdAt, workItems.key);
  expect(accepted).toHaveLength(2);
  expect(accepted.map((row) => row.questionIds)).toEqual([[], []]);
  // The original process/page is gone: nothing in their memory delivers these messages.
  await queue.finish({
    kind: PROACTIVE_TASK_KIND,
    key: "initial",
    owner: "old-worker",
  });
  const resumed = engineFor(async () => {}, queue);
  await resumed.engine.sweep();
  await resumed.engine.sweep();
  expect(resumed.started.map((run) => run.text)).toEqual(
    accepted.map((row) => row.text),
  );
  expect(resumed.started.map((run) => run.runId).sort()).toEqual([
    "reply-first-0001",
    "reply-second-0002",
  ]);
  expect((await post("Keep Friday", "reply-first-0001")).status).toBe(202);
  await engine.idle();
  expect(started).toEqual([]);
});

test("queued task replies preserve their accepted question snapshot through retries", async () => {
  const queue = createWorkQueue(database);
  const claimed: WorkItem[] = [];
  const scoped: WorkQueue = {
    ...queue,
    claim: async (input) => {
      if (input.kind !== PROACTIVE_TASK_KIND) return [];
      const items = await queue.claim(input);
      claimed.push(...items);
      return items;
    },
  };
  const { engine } = engineFor(async () => {}, scoped);
  const task = await engine.startAsked(owner.id, bot, {
    title: "Question lifecycle",
    instruction: "Synthetic question test.",
  });
  await engine.idle();
  expect(claimed.map((item) => item.payload.taskId)).toEqual([task.id]);
  const scope = await threads.scope(owner.id, task.id);
  const oldKey = `old-question-${randomUUID()}`;
  const newKey = `new-question-${randomUUID()}`;
  const acceptedKey = `accepted-question-${randomUUID()}`;
  const retryKey = `retry-question-${randomUUID()}`;
  const question = {
    ownerUserId: owner.id,
    actorId: owner.id,
    botId: bot,
    channelId: task.channelId,
    threadId: scope!.threadId,
    runId: randomUUID(),
    question: "Which day?",
    mode: "completed_question",
  };
  await database
    .insert(workItems)
    .values({ kind: "person.question", key: oldKey, payload: question });
  let unblock!: () => void;
  const held = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  let announceStarted!: () => void;
  const firstStarted = new Promise<void>((resolve) => {
    announceStarted = resolve;
  });
  let secondAttempts = 0;
  const answering = engineFor(async ({ text }) => {
    if (text === "Keep Friday") {
      announceStarted();
      await held;
    } else if (++secondAttempts === 1) {
      await database
        .insert(workItems)
        .values({ kind: "person.question", key: retryKey, payload: question });
      throw new Error("Retry the second reply after the provider disconnects.");
    }
  }, scoped);
  await answering.engine.reply(owner.id, task.id, {
    reply: "Keep Friday",
    messageId: randomUUID(),
  });
  await firstStarted;
  const secondReply = { reply: "Also cc Sam", messageId: randomUUID() };
  try {
    await queue.offer({
      kind: "person.question",
      key: acceptedKey,
      payload: question,
    });
    await answering.engine.reply(owner.id, task.id, secondReply);
    expect((await taskStore.get(owner.id, task.id)).status).toBe("working");
    await queue.offer({
      kind: "person.question",
      key: newKey,
      payload: question,
    });
    const questions = createApprovalQuestions(database, async () => {});
    const acceptedWork = database
      .select({
        kind: workItems.kind,
        key: workItems.key,
        payload: workItems.payload,
        attempts: workItems.attempts,
      })
      .from(workItems)
      .where(sql`${workItems.payload}->>'taskId' = ${task.id}
        or ${workItems.key} = ${acceptedKey}`)
      .orderBy(workItems.kind, workItems.key);
    const beforeAnswer = await acceptedWork;
    expect(
      beforeAnswer.find((row) => row.key.endsWith(secondReply.messageId)),
    ).toMatchObject({ attempts: 0, payload: { questionIds: [acceptedKey] } });
    expect({
      answered: (
        await taskStore.get(owner.id, task.id)
      ).answeredQuestionIds?.sort(),
      inbox: (await questions.list(owner.id))
        .map((row) => row.id)
        .filter((id) => [oldKey, acceptedKey, newKey].includes(id)),
    }).toEqual({ answered: [oldKey, acceptedKey].sort(), inbox: [newKey] });
    await expect(
      questions.respond(owner.id, acceptedKey, "Actually, Monday"),
    ).rejects.toThrow("You already answered this question.");
    expect({
      work: await acceptedWork,
      pending: await taskStore.pendingQuestions(owner.id, task.id),
    }).toEqual({ work: beforeAnswer, pending: [newKey] });
  } finally {
    unblock();
    await answering.engine.idle();
  }
  expect(secondAttempts).toBe(2);
  expect((await taskStore.pendingQuestions(owner.id, task.id)).sort()).toEqual(
    [newKey, retryKey].sort(),
  );
  // Resubmitting the same message must not replace its acceptance-time snapshot.
  await answering.engine.reply(owner.id, task.id, secondReply);
  await answering.engine.idle();
  expect(secondAttempts).toBe(2);
  const [saved] = await database
    .select({ payload: workItems.payload })
    .from(workItems)
    .where(
      and(
        eq(workItems.kind, PROACTIVE_TASK_KIND),
        eq(workItems.key, `task:${task.id}:reply:${secondReply.messageId}`),
      ),
    );
  expect(saved!.payload.questionIds).toEqual([acceptedKey]);
  expect((await taskStore.get(owner.id, task.id)).status).toBe("needs_input");

  const laterKey = `later-question-${randomUUID()}`;
  let successfulExecutions = 0;
  const taskTurn = createTaskTurn({
    actorFor,
    channels: channelStore,
    runTurn: async () => {
      await queue.offer({
        kind: "person.question",
        key: laterKey,
        payload: question,
      });
      return { replyText: "Finished the requested work." };
    },
  });
  const successful = engineFor(async ({ scope, ...input }, signal) => {
    await taskTurn(scope, { ...input, signal });
    successfulExecutions += 1;
  }, scoped);
  const cleanup = spyOn(threads, "answerQuestions").mockRejectedValueOnce(
    new Error("Synthetic question acknowledgment failure"),
  );
  const reply = { reply: "Finish it", messageId: randomUUID() };
  try {
    await successful.engine.reply(owner.id, task.id, reply);
    await successful.engine.idle();
    expect(successfulExecutions).toBe(1);
    const [finished] = await database
      .select()
      .from(workItems)
      .where(eq(workItems.key, `task:${task.id}:reply:${reply.messageId}`));
    expect(finished?.finishedAt).toBeInstanceOf(Date);
    expect(await taskStore.get(owner.id, task.id)).toMatchObject({
      status: "needs_input",
      failure: null,
    });
    expect(await taskStore.pendingQuestions(owner.id, task.id)).toEqual([
      laterKey,
    ]);
  } finally {
    await successful.engine.idle();
    cleanup.mockRestore();
  }
});

test("a legacy task reply without a question snapshot runs without acknowledging unknown questions", async () => {
  const queue = createWorkQueue(database);
  const scoped: WorkQueue = {
    ...queue,
    claim: (input) =>
      input.kind === PROACTIVE_TASK_KIND
        ? queue.claim(input)
        : Promise.resolve([]),
  };
  const { engine, started } = engineFor(async () => {}, scoped);
  const task = await engine.startAsked(owner.id, bot, {
    title: "Legacy reply",
    instruction: "Synthetic legacy question test.",
  });
  await engine.idle();
  const key = `legacy-question-${randomUUID()}`;
  await database.insert(workItems).values({
    kind: "person.question",
    key,
    payload: {
      ownerUserId: owner.id,
      actorId: owner.id,
      channelId: task.channelId,
      mode: "completed_question",
    },
  });
  const messageId = randomUUID();
  await queue.offer({
    kind: PROACTIVE_TASK_KIND,
    key: `task:${task.id}:reply:${messageId}`,
    payload: {
      ownerUserId: owner.id,
      taskId: task.id,
      text: "Also cc Sam",
      reply: "Also cc Sam",
      messageId,
      followup: true,
      runs: 2,
    },
  });
  await engine.sweep();
  expect(started.at(-1)).toMatchObject({
    runId: messageId,
    text: "Also cc Sam",
  });
  expect(await taskStore.pendingQuestions(owner.id, task.id)).toEqual([key]);
});

test.each(["released", "expired"])(
  "a late-committed reply stays failed and retryable after its final attempt is %s",
  async (ending) => {
    const task = await threads.open({
      ownerUserId: owner.id,
      agentId: bot,
      title: "Late reply",
      why: null,
      origin: "asked",
      suggestionId: null,
      sourceApp: null,
      sourceLink: null,
    });
    const queue = createWorkQueue(database);
    // Persist through the engine, but advance only this task's ledger so other tests' work is safe.
    const { engine } = engineFor(async () => {}, {
      ...queue,
      claim: async () => [],
    });
    const kind = PROACTIVE_TASK_KIND;
    const lateKey = `task:${task.id}:reply:${randomUUID()}`;
    const where = and(eq(workItems.kind, kind), eq(workItems.key, lateKey));
    const envelope = {
      text: "",
      reply: "Sent attachments",
      attachmentIds: ["12345678-1234-4123-8123-123456789abc"],
      skillIds: ["review-late-ledger"],
      followup: true,
      questionIds: [],
    };
    const input = {
      ownerUserId: owner.id,
      taskId: task.id,
      ...envelope,
      runs: 2,
    };
    const inserted = Promise.withResolvers<void>();
    const commit = Promise.withResolvers<void>();
    const delayed = database.transaction(async (transaction) => {
      await transaction
        .insert(workItems)
        .values({ kind, key: lateKey, payload: input });
      inserted.resolve();
      await commit.promise;
    });
    const assertNotFailed = async (status: "working" | "ready_for_review") => {
      expect(await taskStore.get(owner.id, task.id)).toMatchObject({
        status,
        failure: null,
        failedAt: null,
      });
      await expect(taskStore.failedTurn(owner.id, task.id)).rejects.toThrow(
        "Only a task that couldn't finish can be tried again.",
      );
    };
    try {
      await inserted.promise;
      await turnFor(task.id, {
        attempts: 1,
        finishedAt: new Date(),
        payload: {
          ownerUserId: owner.id,
          taskId: task.id,
          text: "Newer successful ask",
        },
      });
      await assertNotFailed("ready_for_review");
    } finally {
      commit.resolve();
      await delayed;
    }
    await assertNotFailed("working");
    await database
      .update(workItems)
      .set({
        attempts: 2,
        claimedBy: "late-worker",
        leaseUntil: sql`now() + interval '1 minute'`,
        updatedAt: sql`now()`,
      })
      .where(where);
    await assertNotFailed("working");
    if (ending === "released") {
      expect(
        await queue.release({
          kind,
          key: lateKey,
          owner: "late-worker",
          delayMs: 0,
          reason: "fetch failed",
        }),
      ).toBe(true);
    } else {
      // Renewal timestamps precede the cutoff: the expired lease is when this turn failed.
      await database
        .update(workItems)
        .set({
          leaseUntil: sql`now() - interval '1 millisecond'`,
          updatedAt: sql`now() - interval '1 minute'`,
          lastError: "fetch failed",
        })
        .where(where);
    }
    const [failed] = await database.select().from(workItems).where(where);
    expect(await taskStore.get(owner.id, task.id)).toMatchObject({
      status: "failed",
      failure:
        ending === "released"
          ? "a service didn't answer"
          : "the run was cut off partway through",
      failedAt: (ending === "released"
        ? failed!.updatedAt
        : failed!.leaseUntil!
      ).toISOString(),
    });
    expect(await taskStore.failedTurn(owner.id, task.id)).toEqual({
      ask: envelope,
      turns: 2,
    });
    await engine.again(owner.id, task.id);
    await engine.idle();
    const retryKey = `task:${task.id}:again:2`;
    const retryWhere = and(
      eq(workItems.kind, kind),
      eq(workItems.key, retryKey),
    );
    const [retry] = await database.select().from(workItems).where(retryWhere);
    expect(retry!.payload).toEqual({ ...input, again: true });
    await assertNotFailed("working");
    await queue.claim({
      kind,
      owner: "recovery-worker",
      leaseMs: 60_000,
      maxAttempts: 2,
      serialBy: "taskId",
    });
    expect(
      await queue.finish({ kind, key: retryKey, owner: "recovery-worker" }),
    ).toBe(true);
    // Historical exhausted rows remain on the ledger without resurrecting a handled failure.
    await assertNotFailed("ready_for_review");
  },
);

test.each(["released", "expired"])(
  "a later successful execution clears the %s failure of a newer-created turn",
  async (ending) => {
    const task = await threads.open({
      ownerUserId: owner.id,
      agentId: bot,
      title: "Out-of-order recovery",
      why: null,
      origin: "asked",
      suggestionId: null,
      sourceApp: null,
      sourceLink: null,
    });
    const at = Date.now() - 60_000;
    await turnFor(task.id, {
      createdAt: new Date(at + 1_000),
      attempts: 2,
      lastError: "fetch failed",
      updatedAt: new Date(at + 2_000),
      ...(ending === "expired"
        ? {
            claimedBy: "gone",
            leaseUntil: new Date(at + 3_000),
          }
        : {}),
    });
    await turnFor(
      task.id,
      {
        createdAt: new Date(at),
        attempts: 1,
        finishedAt: new Date(at + 4_000),
        updatedAt: new Date(at + 4_000),
      },
      `late-success:${randomUUID()}`,
    );
    expect(await taskStore.get(owner.id, task.id)).toMatchObject({
      status: "ready_for_review",
      failure: null,
      failedAt: null,
    });
    await expect(taskStore.failedTurn(owner.id, task.id)).rejects.toThrow(
      "Only a task that couldn't finish can be tried again.",
    );
  },
);

test.each(["release", "finish"])("expired task %s", async (ending) => {
  const actual = createWorkQueue(database);
  const kind = PROACTIVE_TASK_KIND;
  const renewed = Promise.withResolvers<boolean>();
  // The file's private queue schema keeps the production kind visible to task status readers.
  const queue: WorkQueue = {
    ...actual,
    renew: async (input) => {
      const kept = await actual.renew(input);
      renewed.resolve(kept);
      return kept;
    },
  };
  const task = await threads.open({
    ownerUserId: owner.id,
    agentId: bot,
    title: "Heartbeat handover",
    why: null,
    origin: "asked",
    suggestionId: null,
    sourceApp: null,
    sourceLink: null,
  });
  const claim = { kind, leaseMs: 30_000, maxAttempts: 2, serialBy: "taskId" };
  const payload = {
    ownerUserId: owner.id,
    taskId: task.id,
    text: "Keep Friday",
    runs: 2,
  };
  await actual.offer({ kind, key: "expired", payload });
  await actual.claim({ ...claim, owner: "prior-attempt" });
  await actual.release({
    kind,
    key: "expired",
    owner: "prior-attempt",
    delayMs: 0,
  });
  const running = Promise.withResolvers<AbortSignal>();
  const stopped = Promise.withResolvers<void>();
  const { engine } = engineFor(async (_run, signal) => {
    running.resolve(signal);
    await stopped.promise;
    signal.throwIfAborted();
  }, queue);
  const interval = spyOn(globalThis, "setInterval");
  const settled = engine.sweep().then(
    () => null,
    (error: unknown) => error,
  );
  try {
    const signal = await running.promise;
    const [expired] = await database
      .select()
      .from(workItems)
      .where(and(eq(workItems.kind, kind), eq(workItems.key, "expired")));
    expect(expired?.attempts).toBe(2);
    expect(expired?.claimedBy).toBeString();
    await actual.renew({
      kind,
      key: "expired",
      owner: expired!.claimedBy!,
      leaseMs: -1,
    });
    await actual.offer({
      kind,
      key: "sibling",
      payload: { ...payload, text: "Use the newer draft" },
    });
    expect(
      await actual.claim({ ...claim, owner: "replacement" }),
    ).toMatchObject([{ key: "sibling", attempts: 1 }]);
    // Drive the real heartbeat after handover, without waiting a minute for its interval.
    const heartbeat = interval.mock.calls[0]?.[0];
    if (typeof heartbeat !== "function")
      throw new Error("No task heartbeat scheduled");
    const aborted = new Promise<void>((resolve) =>
      signal.addEventListener("abort", () => resolve(), { once: true }),
    );
    heartbeat();
    expect(await renewed.promise).toBe(false);
    await aborted;
    expect(signal.aborted).toBe(true);
    if (ending === "finish") {
      const sibling = { kind, key: "sibling", owner: "replacement" };
      await actual.release({ ...sibling, delayMs: 0 });
      await actual.claim({ ...claim, owner: sibling.owner });
      await actual.release({
        ...sibling,
        delayMs: 0,
        reason: "newer draft failed",
      });
      const before = {
        task: await taskStore.get(owner.id, task.id),
        retry: await taskStore.failedTurn(owner.id, task.id),
      };
      expect(before).toMatchObject({
        task: {
          status: "failed",
          failure: "something went wrong during the run",
        },
        retry: { ask: { text: "Use the newer draft" } },
      });
      const rows = await database
        .select()
        .from(workItems)
        .where(eq(workItems.kind, kind))
        .orderBy(workItems.key);
      // A completed model can reach this callback after its post-run work outlives the lease.
      expect(
        await actual.finish({
          kind,
          key: "expired",
          owner: expired!.claimedBy!,
        }),
      ).toBe(false);
      expect(
        await database
          .select()
          .from(workItems)
          .where(eq(workItems.kind, kind))
          .orderBy(workItems.key),
      ).toEqual(rows);
      expect({
        task: await taskStore.get(owner.id, task.id),
        retry: await taskStore.failedTurn(owner.id, task.id),
      }).toEqual(before);
      return;
    }
    // The successor finishes before the aborted worker delivers its delayed ordinary release.
    await actual.finish({ kind, key: "sibling", owner: "replacement" });
    expect((await taskStore.get(owner.id, task.id)).status).toBe(
      "ready_for_review",
    );
    stopped.resolve();
    expect(await settled).toMatchObject({ name: "AbortError" });
    expect(await taskStore.get(owner.id, task.id)).toMatchObject({
      status: "ready_for_review",
      failure: null,
      failedAt: null,
    });
    await expect(taskStore.failedTurn(owner.id, task.id)).rejects.toThrow(
      "Only a task that couldn't finish can be tried again.",
    );
    const rows = await database
      .select({
        key: workItems.key,
        attempts: workItems.attempts,
        claimedBy: workItems.claimedBy,
        finishedAt: workItems.finishedAt,
        live: sql<boolean>`coalesce(${workItems.leaseUntil} > now(), false)`,
      })
      .from(workItems)
      .where(eq(workItems.kind, kind))
      .orderBy(workItems.key);
    expect(rows).toEqual([
      {
        key: "expired",
        attempts: 2,
        claimedBy: expired!.claimedBy,
        finishedAt: null,
        live: false,
      },
      {
        key: "sibling",
        attempts: 1,
        claimedBy: null,
        finishedAt: expect.any(Date),
        live: false,
      },
    ]);
  } finally {
    stopped.resolve();
    await settled;
    interval.mockRestore();
    await database.delete(workItems).where(eq(workItems.kind, kind));
  }
});

for (const failedRuns of [0, 1]) {
  test(`task reply survives four initial lock conflicts after ${failedRuns} provider failures with stable message identity`, async () => {
    const actual = createWorkQueue(database);
    const prefixKind = `busy-reply-${randomUUID()}:`;
    const claimOwners: string[] = [];
    const queue: WorkQueue = {
      offer: (input) =>
        actual.offer({ ...input, kind: prefixKind + input.kind }),
      claim: async (input) => {
        const items = await actual.claim(prefixedClaim(input, prefixKind));
        if (items.length) claimOwners.push(input.owner);
        return items.map((item) => ({ ...item, kind: input.kind }));
      },
      renew: (input) =>
        actual.renew({ ...input, kind: prefixKind + input.kind }),
      finish: (input) =>
        actual.finish({ ...input, kind: prefixKind + input.kind }),
      release: (input) =>
        actual.release({ ...input, kind: prefixKind + input.kind }),
      purge: (input) =>
        actual.purge({ ...input, kind: prefixKind + input.kind }),
    };
    const task = await threads.open({
      ownerUserId: owner.id,
      agentId: bot,
      title: "Draft the reply",
      why: null,
      origin: "asked",
      suggestionId: null,
      sourceApp: null,
      sourceLink: null,
    });
    const messageId = randomUUID();
    let calls = 0;
    const said = new Map<string, string>();
    const taskTurn = createTaskTurn({
      actorFor,
      channels: {
        recordActivity: async (_actor, _channel, activity, source) => {
          said.set(source?.id ?? "", activity.text);
        },
        signalBusy: async () => {},
      },
      runTurn: async () => {
        calls += 1;
        if (calls <= failedRuns) throw new Error("provider unavailable");
        if (calls <= failedRuns + 4)
          throw new ThreadLockBusyError(new Error("Thread lock denied"));
        return { replyText: "Delivered." };
      },
    });
    const { engine, started } = engineFor(async ({ scope, ...input }) => {
      await taskTurn(scope, { ...input, signal: new AbortController().signal });
    }, queue);
    const reply = { reply: "Keep Friday", messageId };
    await engine.reply(owner.id, task.id, reply);
    await engine.idle();
    expect(calls).toBe(failedRuns + 5);
    // A late result from a prior claim on this same worker must not match the replacement lease.
    expect(new Set(claimOwners).size).toBe(calls);
    expect(started[0]?.runId).toBe(messageId);
    const deferredRuns = started.slice(failedRuns);
    expect(new Set(deferredRuns.map((run) => run.runId)).size).toBe(1);
    expect(deferredRuns.every((run) => run.final === (failedRuns === 1))).toBe(
      true,
    );
    if (failedRuns) expect(deferredRuns[0]?.runId).not.toBe(messageId);
    expect([...said.keys()].filter((id) => id.endsWith(":failed"))).toEqual([]);
    expect(
      [...said.values()].filter((text) => text === reply.reply),
    ).toHaveLength(failedRuns + 1);
    expect(
      [...said.values()].filter((text) => text === "Delivered."),
    ).toHaveLength(1);
    const [row] = await database
      .select()
      .from(workItems)
      .where(
        and(
          eq(workItems.kind, prefixKind + PROACTIVE_TASK_KIND),
          eq(workItems.key, `task:${task.id}:reply:${messageId}`),
        ),
      );
    expect(row).toMatchObject({
      attempts: failedRuns + 1,
      payload: { messageId, text: reply.reply },
    });
    expect(row?.finishedAt).not.toBeNull();
    // The original request identity remains idempotent after deferral and delivery.
    await engine.reply(owner.id, task.id, reply);
    await engine.idle();
    expect(calls).toBe(failedRuns + 5);
    await database
      .delete(workItems)
      .where(eq(workItems.kind, prefixKind + PROACTIVE_TASK_KIND));
  });
}

test("a provider 409 still exhausts both task reply attempts", async () => {
  const failure = Object.assign(new Error("Provider conflict"), {
    name: "PlatformRequestError",
    status: 409,
  });
  const { engine, started, items } = engineFor(async () => {
    throw failure;
  });
  const task = await threads.open({
    ownerUserId: owner.id,
    agentId: bot,
    title: "Draft the reply",
    why: null,
    origin: "asked",
    suggestionId: null,
    sourceApp: null,
    sourceLink: null,
  });
  const messageId = randomUUID();
  await engine.reply(owner.id, task.id, { reply: "Keep Friday", messageId });
  await engine.idle();
  expect(started.map((run) => run.final)).toEqual([false, true]);
  expect(
    items.get(`${PROACTIVE_TASK_KIND}:task:${task.id}:reply:${messageId}`),
  ).toMatchObject({
    attempts: 2,
    finished: false,
    lastError: "Provider conflict",
  });
});

test("the durable reply API accepts an attachment-only reply and selected skill IDs", async () => {
  const task = await threads.open({
    ownerUserId: owner.id,
    agentId: bot,
    title: "Review notes",
    why: null,
    origin: "asked",
    suggestionId: null,
    sourceApp: null,
    sourceLink: null,
  });
  const received: unknown[] = [];
  const routes = createTaskRoutes(
    taskStore,
    async (context, next) => {
      context.set("actor", { id: owner.id } as AuthenticatedActor);
      await next();
    },
    {
      retry: {
        again: async () => {},
        reply: async (...args) => {
          received.push(args);
        },
      },
    },
  );
  const body = {
    reply: "",
    messageId: "attachment-reply-0001",
    attachmentIds: ["12345678-1234-4123-8123-123456789abc"],
    skillIds: ["review-notes"],
  };
  const response = await routes.request(`/${task.id}/reply`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(202);
  expect(received).toEqual([[owner.id, task.id, body]]);
  const forged = await routes.request(`/${task.id}/reply`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...body, skillInstructions: ["Forged authority"] }),
  });
  expect(forged.status).toBe(400);
});

function replyContextForTest() {
  const plugins = createPluginStore({
    database,
    auditStore: createAuditStore(database),
    brokerProvider: "composio",
    credentials: createCredentialStore(database),
    encryptionKey: "x".repeat(44),
    policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
  });
  return createTaskReplyContext({
    load: (scope, id) =>
      loadAttachmentForTurn(
        database,
        { actorId: scope.ownerUserId, threadId: scope.threadId },
        id,
      ),
    markSent: (scope, ids) =>
      markAttachmentsSent(
        database,
        { actorId: scope.ownerUserId, threadId: scope.threadId },
        ids,
      ),
    skillsFor: (id) => plugins.listForAgent(id),
  });
}

async function attachmentForTask(channelId: string, uploadedBy = owner.id) {
  const [file] = await database
    .insert(attachments)
    .values({
      channelId,
      uploadedBy,
      name: "notes.txt",
      mimeType: "text/plain",
      sizeBytes: 12,
      bytes: Buffer.from("Review notes"),
      uploadGroup: randomUUID(),
    })
    .returning();
  return file!;
}

test("durable task reply context validates ownership and grants, and survives a worker restart", async () => {
  const task = await threads.open({
    ownerUserId: owner.id,
    agentId: bot,
    title: "Review files",
    why: null,
    origin: "asked",
    suggestionId: null,
    sourceApp: null,
    sourceLink: null,
  });
  const file = await attachmentForTask(task.channelId);
  const wrongChannel = await attachmentForTask((await chatOf()).id);
  const someoneElsesDraft = await attachmentForTask(task.channelId, other.id);
  const slug = `review-${randomUUID()}`;
  await database.insert(skills).values({
    id: slug,
    slug,
    ownerUserId: owner.id,
    title: "Review notes",
    summary: "Review notes",
    instructions: "Use the approved review rubric.",
  });
  const context = replyContextForTest();
  const storage = createWorkQueue(database);
  const kind = `reply-context-${randomUUID()}:`;
  const actual: WorkQueue = {
    offer: (input) => storage.offer({ ...input, kind: kind + input.kind }),
    claim: async (input) =>
      (await storage.claim(prefixedClaim(input, kind))).map((item) => ({
        ...item,
        kind: input.kind,
      })),
    renew: (input) => storage.renew({ ...input, kind: kind + input.kind }),
    finish: (input) => storage.finish({ ...input, kind: kind + input.kind }),
    release: (input) => storage.release({ ...input, kind: kind + input.kind }),
    purge: (input) => storage.purge({ ...input, kind: kind + input.kind }),
  };
  // A paused worker accepts into PostgreSQL without executing: its page/process can then vanish.
  const paused: WorkQueue = { ...actual, claim: async () => [] };
  const accepting = engineFor(async () => {}, paused, context);
  const routes = createTaskRoutes(
    taskStore,
    async (ctx, next) => {
      ctx.set("actor", { id: owner.id } as AuthenticatedActor);
      await next();
    },
    { retry: accepting.engine },
  );
  const post = (body: unknown) =>
    routes.request(`/${task.id}/reply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const body = {
    reply: "",
    messageId: `file-${randomUUID()}`,
    attachmentIds: [file.id],
    skillIds: [slug],
  };
  expect((await post(body)).status).toBe(409); // The skill exists, but is not granted to the task's Bot.
  expect(
    (
      await database
        .select()
        .from(attachments)
        .where(eq(attachments.id, file.id))
    )[0]?.attachedAt,
  ).toBeNull();
  await database
    .insert(pluginGrants)
    .values({ kind: "skill", ref: slug, agentId: bot, grantedBy: owner.id });
  for (const forbidden of [wrongChannel, someoneElsesDraft]) {
    expect(
      (await post({ ...body, attachmentIds: [forbidden.id] })).status,
    ).toBe(409);
    expect(
      (
        await database
          .select()
          .from(attachments)
          .where(eq(attachments.id, forbidden.id))
      )[0]?.attachedAt,
    ).toBeNull();
  }
  expect((await post(body)).status).toBe(202);
  await accepting.engine.idle();
  expect(accepting.started).toEqual([]);
  const [saved] = await database
    .select()
    .from(workItems)
    .where(
      and(
        eq(workItems.kind, kind + PROACTIVE_TASK_KIND),
        eq(workItems.key, `task:${task.id}:reply:${body.messageId}`),
      ),
    );
  expect(saved?.payload).toMatchObject({
    text: "",
    attachmentIds: [file.id],
    skillIds: [slug],
    messageId: body.messageId,
  });
  expect(JSON.stringify(saved?.payload)).not.toContain(
    "Use the approved review rubric",
  );
  expect(
    (
      await database
        .select()
        .from(attachments)
        .where(eq(attachments.id, file.id))
    )[0]?.attachedAt,
  ).not.toBeNull();
  expect(saved?.payload.reply).toBe("Sent attachments");

  const received: Parameters<TurnRunner>[0][] = [];
  const run = createTaskTurn({
    channels: channelStore,
    actorFor,
    replyContext: context,
    runTurn: async (input) => {
      received.push(input);
      return { replyText: "Reviewed the attachment." };
    },
  });
  const restarted = engineFor(
    async ({ scope, ...input }) =>
      run(scope, { ...input, signal: new AbortController().signal }),
    actual,
    context,
  );
  await restarted.engine.sweep();
  await restarted.engine.idle();
  expect(received).toHaveLength(1);
  expect(received[0]?.userMessage).toEqual({
    id: body.messageId,
    role: "user",
    content: [
      {
        type: "text",
        text: frameTaskInput("", {
          id: body.messageId,
          text: "Sent attachments",
        }),
      },
      {
        type: "document",
        source: {
          type: "url",
          value: `/api/attachments/${file.id}`,
          mimeType: "text/plain",
        },
        metadata: { attachmentId: file.id, filename: "notes.txt" },
      },
    ],
  });
  expect(received[0]?.systemMessages).toEqual([
    {
      id: `${body.messageId}:skill:0`,
      role: "system",
      content: "Use the approved review rubric.",
    },
  ]);
  // Execution rechecks the current grant, even for context that was authorized before a restart.
  await database
    .delete(pluginGrants)
    .where(
      and(
        eq(pluginGrants.kind, "skill"),
        eq(pluginGrants.ref, slug),
        eq(pluginGrants.agentId, bot),
      ),
    );
  await expect(
    context.resolve((await threads.scope(owner.id, task.id))!, body),
  ).rejects.toThrow("selected skill is no longer available");
});
