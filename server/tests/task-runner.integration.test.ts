import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { ThreadLockBusyError } from "@openbot/toolkit/lease";
import { and, eq, inArray, sql } from "drizzle-orm";
import { Hono } from "hono";
import { createAgentProfileStore } from "../src/agents/profile-store";
import type { AgentActor } from "../src/agents/profile-types";
import { createApprovalQuestions } from "../src/approvals/questions";
import type { AppVariables } from "../src/auth/guards";
import { createChannelStore } from "../src/channels/routes";
import { createThreadIdentity } from "../src/channels/thread-identity";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  botTasks,
  channelMemberships,
  channels,
  users,
  workItems,
} from "../src/db/schema";
import type { TaskPayload } from "../src/proactive/contracts";
import { createContinuationRunner } from "../src/tasks/continuation";
import { createTaskReportReader } from "../src/tasks/report";
import { createTaskRoutes } from "../src/tasks/routes";
import { createTaskRunner, TASK_TURNS_PER_PERSON } from "../src/tasks/runner";
import {
  PERSON_RESPONSE_KIND,
  PROACTIVE_TASK_KIND,
  TASK_TURN_ORDER,
} from "../src/tasks/state";
import { createTaskStore } from "../src/tasks/store";
import type { TaskScope, TaskTurnInput } from "../src/tasks/turn";
import { createWorkQueue } from "../src/work/queue";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * How a task's work is scheduled: asked tasks and their Start id, the person's replies in the
 * task's order, the caps on how many turns run, the time limit, and a turn refused before it ran.
 * The real stores and the real work queue against PostgreSQL; the turn itself is a fake that the
 * test holds open or lets finish, since what is under test is when it runs, not what it says.
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
const queue = createWorkQueue(database);
const taskStore = createTaskStore(database);
const prefix = `task-runner-${randomUUID()}`;
const people: string[] = [];
const bots: string[] = [];

const actorFor = async (id: string): Promise<AgentActor> => ({
  id,
  role: "user",
});

const scopeFor = async (
  ownerUserId: string,
  channelId: string,
  agentId: string,
) => {
  const actor = await actorFor(ownerUserId);
  const [channel, bot] = await Promise.all([
    channelStore.get(actor, channelId),
    profileStore.get(actor, agentId),
  ]);
  return channel?.active && bot && channel.agentIds.includes(agentId)
    ? { ownerUserId, channelId, agentId, threadId: channel.threadId }
    : null;
};

/** One run of a turn, as the fake saw it, and the hand that ends it. */
type Run = {
  scope: TaskScope;
  input: TaskTurnInput;
  finish: (reply?: string) => void;
  fail: (error: Error) => void;
};

/**
 * A runner whose turns wait until the test ends them, unless `behave` answers first. Each runner
 * has a worker id of its own, so another test's runner never claims its turns' siblings.
 */
function runnerFor(
  options: {
    behave?: (
      run: Run,
    ) => Promise<{ messageId: string; asks: boolean } | undefined> | undefined;
    turnMs?: number;
    turnsAtOnce?: number;
  } = {},
) {
  const runs: Run[] = [];
  const runner = createTaskRunner({
    database,
    store: taskStore,
    channels: channelStore,
    actorFor,
    queue,
    owner: `${prefix}-worker-${randomUUID()}`,
    scopeFor,
    questions: taskStore,
    retryMs: 0,
    ...(options.turnMs === undefined ? {} : { turnMs: options.turnMs }),
    ...(options.turnsAtOnce === undefined
      ? {}
      : { turnsAtOnce: options.turnsAtOnce }),
    runTask: (scope, input) =>
      new Promise((resolve, reject) => {
        const run: Run = {
          scope,
          input,
          finish: (reply) =>
            resolve(
              reply === undefined
                ? undefined
                : { messageId: `${input.runId}:reply`, asks: false },
            ),
          fail: reject,
        };
        runs.push(run);
        const answered = options.behave?.(run);
        if (answered) answered.then(resolve, reject);
      }),
  });
  return { runner, runs };
}

/** Waits until `check` holds, or fails the test after a few seconds. */
async function until(check: () => boolean | Promise<boolean>, what: string) {
  for (let tries = 0; tries < 200; tries += 1) {
    if (await check()) return;
    await Bun.sleep(20);
  }
  throw new Error(`Timed out waiting for ${what}.`);
}

async function person() {
  const id = `${prefix}-person-${randomUUID()}`;
  await database
    .insert(users)
    .values({ id, email: `${id}@example.test`, name: "Task Runner Person" });
  people.push(id);
  return actorFor(id);
}

async function seed() {
  const owner = await person();
  const bot = await profileStore.create(owner, {
    name: "Assistant",
    title: "Research",
    roleDescription: "Find things out.",
    visibility: "private",
  });
  bots.push(bot.id);
  return { owner, botId: bot.id };
}

function appFor(runner: ReturnType<typeof runnerFor>["runner"]) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.route(
    "/api/tasks",
    createTaskRoutes(taskStore, runner, async (context, next) => {
      const id = context.req.header("x-test-user") ?? "";
      context.set("actor", { id, email: `${id}@example.test`, role: "user" });
      await next();
    }),
  );
  return (user: string, path: string, body?: unknown) =>
    app.request(`/api/tasks${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "x-test-user": user,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
}

async function turnsOf(taskId: string) {
  return database
    .select()
    .from(workItems)
    .where(
      and(
        eq(workItems.kind, PROACTIVE_TASK_KIND),
        sql`${workItems.payload}->>'taskId' = ${taskId}`,
      ),
    )
    .orderBy(workItems.createdAt);
}

afterAll(async () => {
  const theirs = await database
    .select({ id: channelMemberships.channelId })
    .from(channelMemberships)
    .where(inArray(channelMemberships.userId, people));
  await database
    .delete(workItems)
    .where(
      sql`${workItems.payload}->>'ownerUserId' in ${people} or ${workItems.payload}->>'actorId' in ${people}`,
    );
  if (theirs.length)
    await database.delete(channels).where(
      inArray(
        channels.id,
        theirs.map((row) => row.id),
      ),
    );
  await database.delete(users).where(inArray(users.id, people));
  await database
    .delete(agentProfiles)
    .where(inArray(agentProfiles.agentId, bots));
  await database.delete(agents).where(inArray(agents.id, bots));
  await database.$client.close();
});

describe("an asked task", () => {
  test("opens in a conversation of its own and runs the person's words there", async () => {
    const { owner, botId } = await seed();
    const { runner, runs } = runnerFor({
      behave: async () => ({ messageId: "m", asks: false }),
    });
    const request = appFor(runner);
    const response = await request(owner.id, "", {
      agentId: botId,
      instruction: "Find a time for coffee with Sam. He prefers mornings.",
    });
    expect(response.status).toBe(201);
    const { task } = (await response.json()) as { task: TaskPayload };
    expect(task).toMatchObject({
      agentId: botId,
      origin: "asked",
      title: "Find a time for coffee with Sam",
      suggestionId: null,
      queuedReplies: [],
      answeredQuestionIds: [],
    });
    await runner.idle();
    expect(runs).toHaveLength(1);
    expect(runs[0]?.scope.channelId).toBe(task.channelId);
    expect(runs[0]?.input).toMatchObject({
      runId: `task-${task.id}`,
      askId: `task-${task.id}`,
      text: "Find a time for coffee with Sam. He prefers mornings.",
    });
    // Never the person's own conversation with the Bot.
    expect((await channelStore.direct(owner, botId)).id).not.toBe(
      task.channelId,
    );
    expect((await channelStore.get(owner, task.channelId))?.taskId).toBe(
      task.id,
    );
  });

  test("sent twice with one clientId, at once or after, opens one task and one conversation", async () => {
    const { owner, botId } = await seed();
    const { runner, runs } = runnerFor({
      behave: async () => ({ messageId: "m", asks: false }),
    });
    const request = appFor(runner);
    const clientId = randomUUID();
    const ask = {
      title: "Plan the Lisbon trip",
      instruction: "Plan it.",
      clientId,
    };
    // Two at once race on the unique index; the loser rolls back.
    const [first, second] = await Promise.all([
      runner.startAsked(owner.id, botId, ask),
      runner.startAsked(owner.id, botId, ask),
    ]);
    // And sent again later, as the browser retries it.
    const again = await request(owner.id, "", {
      agentId: botId,
      instruction: "Plan it.",
      clientId,
    });
    expect(again.status).toBe(201);
    const ids = [
      first.id,
      second.id,
      ((await again.json()) as { task: TaskPayload }).task.id,
    ];
    expect(new Set(ids).size).toBe(1);
    await runner.idle();
    const rows = await database
      .select()
      .from(botTasks)
      .where(eq(botTasks.ownerUserId, owner.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.clientId).toBe(clientId);
    // The loser rolled back: the person has the one task's conversation and no other.
    const theirs = await database
      .select({ id: channelMemberships.channelId })
      .from(channelMemberships)
      .where(eq(channelMemberships.userId, owner.id));
    expect(theirs).toEqual([{ id: rows[0]?.channelId ?? "" }]);
    expect(runs).toHaveLength(1);
  });

  test("refuses an ask it can't run, and another person's Bot", async () => {
    const { owner } = await seed();
    const other = await seed();
    const { runner } = runnerFor();
    const request = appFor(runner);
    expect((await request(owner.id, "", { agentId: "x" })).status).toBe(400);
    expect(
      (
        await request(owner.id, "", {
          agentId: other.botId,
          instruction: "Read their mail.",
        })
      ).status,
    ).toBe(404);
  });
});

describe("a reply to a task", () => {
  test("waits behind the turn still running, is listed while it waits, and runs after it, under its own id", async () => {
    const { owner, botId } = await seed();
    const { runner, runs } = runnerFor();
    const request = appFor(runner);
    const opened = await runner.startAsked(owner.id, botId, {
      title: "Draft the reply",
      instruction: "Draft the reply to Rosa.",
    });
    await until(() => runs.length === 1, "the first turn");
    const messageId = `reply-${randomUUID()}`;
    const replied = await request(owner.id, `/${opened.id}/reply`, {
      reply: "Make it shorter.",
      messageId,
    });
    expect(replied.status).toBe(202);
    const { task } = (await replied.json()) as { task: TaskPayload };
    expect(task.status).toBe("working");
    expect(task.queuedReplies).toEqual([
      { messageId, text: "Make it shorter." },
    ]);
    // Sent twice, it is taken once.
    await request(owner.id, `/${opened.id}/reply`, {
      reply: "Make it shorter.",
      messageId,
    });
    await runner.sweep();
    await Bun.sleep(50);
    expect(runs).toHaveLength(1);

    runs[0]?.finish("Drafted.");
    await until(() => runs.length === 2, "the reply's turn");
    expect(runs[1]?.input).toMatchObject({
      runId: messageId,
      askId: messageId,
      text: "Make it shorter.",
    });
    expect((await taskStore.get(owner.id, opened.id)).queuedReplies).toEqual(
      [],
    );
    runs[1]?.finish("Shortened.");
    await runner.idle();
    expect(await turnsOf(opened.id)).toHaveLength(2);
  });

  test("answers the questions waiting in the task's conversation from the moment it is taken", async () => {
    const { owner, botId } = await seed();
    const { runner, runs } = runnerFor({
      behave: async () => ({ messageId: "m", asks: false }),
    });
    const opened = await runner.startAsked(owner.id, botId, {
      title: "Book the tour",
      instruction: "Book the Alfama tour.",
    });
    await runner.idle();
    const before = await taskStore.get(owner.id, opened.id);
    const question = `${prefix}-question-${randomUUID()}`;
    await queue.offer({
      kind: "person.question",
      key: question,
      payload: {
        actorId: owner.id,
        botId,
        channelId: opened.channelId,
        threadId: before.threadId,
        runId: `${prefix}-run`,
        question: "Friday or Saturday?",
        mode: "completed_question",
      },
    });
    expect((await taskStore.get(owner.id, opened.id)).status).toBe(
      "needs_input",
    );
    const inbox = createApprovalQuestions(database, async () => {});
    expect((await inbox.list(owner.id)).map((row) => row.id)).toContain(
      question,
    );

    await runner.reply(owner.id, opened.id, {
      reply: "Friday.",
      messageId: `reply-${randomUUID()}`,
    });
    const taken = await taskStore.get(owner.id, opened.id);
    expect(taken.answeredQuestionIds).toEqual([question]);
    expect(taken.status).not.toBe("needs_input");
    // The inbox no longer offers it, so it can't be answered twice.
    expect((await inbox.list(owner.id)).map((row) => row.id)).not.toContain(
      question,
    );
    await runner.idle();
    expect(runs).toHaveLength(2);
    const [row] = await database
      .select({ finishedAt: workItems.finishedAt })
      .from(workItems)
      .where(eq(workItems.key, question));
    expect(row?.finishedAt).not.toBeNull();
  });

  test("waits its turn behind an answer to a question card carried on in the task's conversation", async () => {
    const { owner, botId } = await seed();
    const { runner, runs } = runnerFor({
      behave: async () => ({ messageId: "m", asks: false }),
    });
    const opened = await runner.startAsked(owner.id, botId, {
      title: "Book the tour",
      instruction: "Book the Alfama tour.",
    });
    await runner.idle();
    const { threadId } = await taskStore.get(owner.id, opened.id);
    // The person-response sweep has the answer, under the same order.
    const answer = `${prefix}-answer-${randomUUID()}`;
    await queue.offer({
      kind: PERSON_RESPONSE_KIND,
      key: answer,
      payload: {
        ownerUserId: owner.id,
        question: {
          actorId: owner.id,
          threadId,
          channelId: opened.channelId,
          question: "Friday or Saturday?",
        },
        response: "Friday",
      },
    });
    const sweepOwner = `${prefix}-responses`;
    const [claimed] = await queue.claim({
      kind: PERSON_RESPONSE_KIND,
      owner: sweepOwner,
      leaseMs: 60_000,
      maxAttempts: 1,
      serialBy: TASK_TURN_ORDER,
    });
    expect(claimed?.key).toBe(answer);

    await runner.reply(owner.id, opened.id, {
      reply: "And book lunch after.",
      messageId: `reply-${randomUUID()}`,
    });
    await runner.idle();
    await runner.sweep();
    expect(runs).toHaveLength(1);
    expect((await taskStore.get(owner.id, opened.id)).status).toBe("working");

    await queue.finish({
      kind: PERSON_RESPONSE_KIND,
      key: answer,
      owner: sweepOwner,
    });
    await runner.sweep();
    await runner.idle();
    expect(runs).toHaveLength(2);
    expect(runs[1]?.input.text).toBe("And book lunch after.");
  });
});

describe("a task's turn", () => {
  test("past its time limit is stopped, and the task says it took too long", async () => {
    const { owner, botId } = await seed();
    const signals: AbortSignal[] = [];
    const { runner, runs } = runnerFor({
      turnMs: 30,
      // Never answers, whatever its signal says.
      behave: (run) => {
        signals.push(run.input.signal);
        return undefined;
      },
    });
    const opened = await runner.startAsked(owner.id, botId, {
      title: "Hang",
      instruction: "Read everything.",
    });
    await until(async () => {
      await runner.idle();
      return (await taskStore.get(owner.id, opened.id)).status === "failed";
    }, "the task to fail");
    expect(runs).toHaveLength(2);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect((await taskStore.get(owner.id, opened.id)).failure).toBe(
      "the run took longer than 1 minute",
    );
  });

  test("refused the conversation's lock before it ran goes back on the queue without spending a run", async () => {
    const { owner, botId } = await seed();
    let refusals = 2;
    const { runner, runs } = runnerFor({
      behave: async () => {
        if (refusals > 0) {
          refusals -= 1;
          throw new ThreadLockBusyError(new Error("Thread lock denied"));
        }
        return { messageId: "m", asks: false };
      },
    });
    const opened = await runner.startAsked(owner.id, botId, {
      title: "Busy",
      instruction: "Do the thing.",
    });
    await until(async () => {
      await runner.idle();
      return runs.length === 3;
    }, "the third try");
    await runner.idle();
    const [turn] = await turnsOf(opened.id);
    // Refused twice and run once: one attempt spent, and the same message every time.
    expect(turn?.attempts).toBe(1);
    expect(turn?.finishedAt).not.toBeNull();
    expect(new Set(runs.map((run) => run.input.runId)).size).toBe(1);
    expect((await taskStore.get(owner.id, opened.id)).status).toBe(
      "ready_for_review",
    );
  });
});

describe("how many task turns run at once", () => {
  test(`at most ${TASK_TURNS_PER_PERSON} of one person's, the rest waiting until one finishes`, async () => {
    const { owner, botId } = await seed();
    const { runner, runs } = runnerFor();
    const opened = [];
    for (let index = 0; index < TASK_TURNS_PER_PERSON + 2; index += 1)
      opened.push(
        await runner.startAsked(owner.id, botId, {
          title: `Task ${index}`,
          instruction: `Do task ${index}.`,
        }),
      );
    await until(() => runs.length === TASK_TURNS_PER_PERSON, "the first turns");
    await runner.sweep();
    await Bun.sleep(50);
    expect(runs).toHaveLength(TASK_TURNS_PER_PERSON);
    // Waiting reads as Working, not failed.
    for (const task of opened)
      expect((await taskStore.get(owner.id, task.id)).status).toBe("working");
    runs[0]?.finish("Done.");
    await until(
      () => runs.length === TASK_TURNS_PER_PERSON + 1,
      "the next turn",
    );
    for (const run of runs) run.finish("Done.");
    await until(
      () => runs.length === TASK_TURNS_PER_PERSON + 2,
      "the last turn",
    );
    for (const run of runs) run.finish("Done.");
    await runner.idle();
  });

  test("and no more in one process than it may run, whoever they are for", async () => {
    const first = await seed();
    const second = await seed();
    const { runner, runs } = runnerFor({ turnsAtOnce: 1 });
    await runner.startAsked(first.owner.id, first.botId, {
      title: "One",
      instruction: "Do one.",
    });
    await runner.startAsked(second.owner.id, second.botId, {
      title: "Two",
      instruction: "Do two.",
    });
    await until(() => runs.length === 1, "the first turn");
    await runner.sweep();
    await Bun.sleep(50);
    expect(runs).toHaveLength(1);
    runs[0]?.finish("Done.");
    await until(() => runs.length === 2, "the second turn");
    runs[1]?.finish("Done.");
    await runner.idle();
  });
});

describe("a turn carried on after waiting on the person", () => {
  test("in a task's conversation is built as the task's turn, and anywhere else as before", async () => {
    const { owner, botId } = await seed();
    const { runner } = runnerFor({
      behave: async () => ({ messageId: "m", asks: false }),
    });
    const opened = await runner.startAsked(owner.id, botId, {
      title: "T",
      instruction: "Do it.",
    });
    await runner.idle();
    const { threadId } = await taskStore.get(owner.id, opened.id);
    const own = await channelStore.direct(owner, botId);
    const built: string[] = [];
    const carryOn = createContinuationRunner({
      isTaskThread: taskStore.isTaskThread,
      taskTurn: async () => {
        built.push("task");
        return { replyText: "" };
      },
      otherwise: async () => {
        built.push("other");
        return { replyText: "" };
      },
    });
    const turn = (thread: string, ownerUserId = owner.id) =>
      carryOn({
        ownerUserId,
        routineId: "approval",
        agentId: botId,
        threadId: thread,
        instruction: "",
        initiator: { kind: "person" },
      });
    await turn(threadId ?? "");
    await turn(own.threadId);
    // Another person's look at the thread is not the task's.
    await turn(threadId ?? "", (await person()).id);
    expect(built).toEqual(["task", "other", "other"]);
  });
});

describe("a task's report", () => {
  test("answers from the ledgers, marked partial, when the conversation can't be read in time", async () => {
    const { owner, botId } = await seed();
    const { runner } = runnerFor({
      behave: async () => ({ messageId: "m", asks: false }),
    });
    const opened = await runner.startAsked(owner.id, botId, {
      title: "Plan the trip",
      instruction: "Plan a three-day trip to Lisbon.",
    });
    await runner.idle();
    const report = createTaskReportReader({
      database,
      history: () => new Promise(() => {}),
      historyTimeoutMs: 20,
    });
    expect(
      await report(owner.id, await taskStore.get(owner.id, opened.id)),
    ).toEqual({
      taskId: opened.id,
      ask: "Plan a three-day trip to Lisbon.",
      partial: true,
      entries: [],
    });
  });

  test("reads the ask its first turn put in the conversation, in the person's words", async () => {
    const { owner, botId } = await seed();
    const { runner } = runnerFor({
      behave: async () => ({ messageId: "m", asks: false }),
    });
    const opened = await runner.startAsked(owner.id, botId, {
      title: "Plan the trip",
      instruction: "Plan a three-day trip to Lisbon.",
    });
    await runner.idle();
    const report = createTaskReportReader({
      database,
      history: async () => [
        {
          id: `task-${opened.id}`,
          role: "user",
          content: "Plan a three-day trip to Lisbon.",
        },
        {
          id: "a1",
          role: "assistant",
          content: "Here's a plan.\n\nI put the three-day plan in your notes.",
        },
      ],
    });
    const read = await report(
      owner.id,
      await taskStore.get(owner.id, opened.id),
    );
    expect(read.ask).toBe("Plan a three-day trip to Lisbon.");
    expect(read.entries.map((entry) => entry.kind)).toEqual(["update"]);
  });
});

describe("reading one person's tasks", () => {
  /** Every statement a read sends, as the driver is handed it, so each can be planned as it ran. */
  async function statementsOf(read: () => Promise<unknown>) {
    const client = database.$client;
    const unsafe = client.unsafe.bind(client);
    const sent: { query: string; params: unknown[] }[] = [];
    const spy = spyOn(client, "unsafe").mockImplementation(
      (query: string, params?: unknown[]) => {
        sent.push({ query, params: params ?? [] });
        return unsafe(query, params as never);
      },
    );
    try {
      await read();
    } finally {
      spy.mockRestore();
    }
    return sent;
  }
  /**
   * How Postgres would run each over a queue holding many people's task turns. Written, analysed
   * and planned in one transaction that is rolled back, so no other test sees the rows.
   */
  async function plansOf(statements: { query: string; params: unknown[] }[]) {
    const plans: string[] = [];
    const rollback = new Error("rollback");
    await database.$client
      .begin(async (client) => {
        await client.unsafe(`
          insert into work_items (kind, key, payload, finished_at)
          select kind, kind || ':many:' || n, jsonb_build_object(
            'ownerUserId', 'many-' || (n % 200),
            'taskId', 'many-task-' || (n % 2000),
            'followup', 'true',
            'questionIds', jsonb_build_array('many-question-' || n)
          ), now()
          from generate_series(1, 4000) as n,
            unnest(array['${PROACTIVE_TASK_KIND}', 'person.response']) as kind
        `);
        await client.unsafe("analyze work_items");
        for (const statement of statements) {
          const rows: { "QUERY PLAN": string }[] = await client.unsafe(
            `explain ${statement.query}`,
            statement.params as never,
          );
          plans.push(rows.map((row) => row["QUERY PLAN"]).join("\n"));
        }
        throw rollback;
      })
      .catch((error: unknown) => {
        if (error !== rollback) throw error;
      });
    return plans;
  }

  test("finds their task turns through the index, never by scanning everyone's", async () => {
    const { owner, botId } = await seed();
    const { runner } = runnerFor({
      behave: async () => ({ messageId: "m", asks: false }),
    });
    const opened = await runner.startAsked(owner.id, botId, {
      title: "T",
      instruction: "Do it.",
    });
    await runner.idle();
    const record = await taskStore.get(owner.id, opened.id);
    const report = createTaskReportReader({
      database,
      history: async () => [],
    });
    const questions = createApprovalQuestions(database, async () => {});
    const sent = [
      ...(await statementsOf(() => taskStore.list(owner.id))),
      ...(await statementsOf(() => report(owner.id, record))),
      ...(await statementsOf(() => questions.list(owner.id))),
    ];
    // The list's task turns, the report's, and the inbox's check for answers already taken.
    const plans = await plansOf(
      sent.filter(
        ({ query, params }) =>
          query.includes(`'${PROACTIVE_TASK_KIND}'`) ||
          params.includes(PROACTIVE_TASK_KIND),
      ),
    );
    expect(plans.length).toBeGreaterThanOrEqual(3);
    // Looked up by the person, not filtered from every row of the kind.
    const byPerson =
      /work_items_owner_task_idx.*\n\s*Index Cond: .*'ownerUserId'::text\) = /;
    expect(plans.filter((plan) => !byPerson.test(plan))).toEqual([]);
  });
});
