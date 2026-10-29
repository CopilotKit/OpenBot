import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, like, sql } from "drizzle-orm";
import { createAgentProfileStore } from "../src/agents/profile-store";
import type { AgentActor } from "../src/agents/profile-types";
import {
  createApprovalQuestions,
  type PersonQuestion,
} from "../src/approvals/questions";
import type { AuthenticatedActor } from "../src/auth/guards";
import { createChannelStore } from "../src/channels/routes";
import { createThreadIdentity } from "../src/channels/thread-identity";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  approvalRequests,
  channels,
  intelligenceChannelMappings,
  tasks,
  users,
  workItems,
} from "../src/db/schema";
import { PROACTIVE_TASK_KIND } from "../src/proactive/engine";
import { createTaskReportReader } from "../src/tasks/report";
import { createTaskRoutes } from "../src/tasks/routes";
import { createTaskStore, type TaskStore } from "../src/tasks/store";
import type { TaskRecord } from "../src/tasks/types";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * A task is work a Bot does in a conversation of its own. These run against PostgreSQL: the
 * conversation is a real channel, and what a task is doing is read from the real work queue,
 * approval inbox and question queue. Nothing in OpenBot opens a task yet, so each one here is a row
 * written beside a real conversation, and each turn a row written where the engine will queue it.
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
const taskStore = createTaskStore(database);
const prefix = `tasks-${randomUUID()}`;
const owner: AgentActor = { id: `${prefix}-owner`, role: "user" };
const other: AgentActor = { id: `${prefix}-other`, role: "user" };
let bot = "";

beforeAll(async () => {
  await database.insert(users).values([
    { id: owner.id, email: `${owner.id}@example.test` },
    { id: other.id, email: `${other.id}@example.test` },
  ]);
  bot = (
    await profileStore.create(owner, {
      name: "Researcher",
      title: "Looks things up",
      roleDescription: "Works for one person.",
      visibility: "private",
    })
  ).id;
});

afterAll(async () => {
  try {
    await database.delete(workItems).where(like(workItems.key, `${prefix}%`));
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
    await database.$client.close();
  }
});

/** A task in a conversation of its own, as the engine will open one. */
async function freshTask(title = `Task ${randomUUID()}`) {
  const conversation = await channelStore.create(owner, [bot]);
  const id = randomUUID();
  await database.insert(tasks).values({
    id,
    ownerUserId: owner.id,
    botId: bot,
    channelId: conversation.id,
    title,
    origin: "asked",
  });
  return { id, channelId: conversation.id, threadId: conversation.threadId };
}

/** A turn for this task on the queue, in whatever state the test needs. */
async function turnFor(
  taskId: string,
  state: Partial<typeof workItems.$inferInsert> = {},
  key = `${prefix}:task:${taskId}:${randomUUID()}`,
) {
  await database.insert(workItems).values({
    kind: PROACTIVE_TASK_KIND,
    key,
    payload: { ownerUserId: owner.id, taskId, text: "Prepare the notes." },
    ...state,
  });
  return and(eq(workItems.kind, PROACTIVE_TASK_KIND), eq(workItems.key, key));
}

/** An approval the task's turn stopped on, waiting for Allow once. */
async function approvalIn(threadId: string, ownerUserId = owner.id) {
  const id = `${prefix}-approval-${randomUUID()}`;
  await database.insert(approvalRequests).values({
    id,
    ownerUserId,
    runId: `${prefix}-run-${randomUUID()}`,
    toolCallId: "send",
    actionDigest: "digest",
    action: {
      threadId,
      botId: bot,
      toolRef: "google-workspace/gmail_send_reply",
    } as never,
  });
  return id;
}

const statusOf = async (id: string, store: TaskStore = taskStore) =>
  (await store.get(owner.id, id)).status;

describe("status", () => {
  /**
   * A question the task's Bot asked, and the person's reply that answered it, accepted onto the
   * queue the way a reply on the task page is: naming the questions waiting when it was taken.
   */
  async function acceptedAnswer() {
    const task = await freshTask();
    // Well before the reply: a host clock a few milliseconds ahead of the database's would
    // otherwise put this turn's end after the reply's failure.
    await turnFor(task.id, { finishedAt: new Date(Date.now() - 60_000) });
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
    const messageId = randomUUID();
    const where = await turnFor(
      task.id,
      {
        payload: {
          ownerUserId: owner.id,
          taskId: task.id,
          text: "Use A",
          reply: "Use A",
          messageId,
          inputId: messageId,
          followup: true,
          questionIds: [questionId],
          runs: 2,
        },
      },
      `${prefix}:task:${task.id}:reply:${messageId}`,
    );
    return { task, questionId, question, where };
  }

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
    const approvalId = await approvalIn(task.threadId);
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

    // Marked done: resolved. Reopened, it reads as it did.
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
    await approvalIn(task.threadId, other.id);
    expect(await statusOf(task.id)).toBe("ready_for_review");
  });

  test("a question card's answer stays working, and fails once, on its own single attempt", async () => {
    const task = await freshTask();
    const unrelated = await freshTask();
    await turnFor(task.id, { finishedAt: new Date() });
    await turnFor(unrelated.id, { finishedAt: new Date() });
    const key = `${prefix}-question-response-${randomUUID()}`;
    const question: PersonQuestion = {
      actorId: owner.id,
      botId: bot,
      channelId: task.channelId,
      threadId: task.threadId,
      runId: `task-${task.id}`,
      question: "Which day works?",
      mode: "completed_question",
    };
    await database
      .insert(workItems)
      .values({ kind: "person.question", key, payload: question });
    expect(await statusOf(task.id)).toBe("needs_input");
    await createApprovalQuestions(database, async () => {}).respond(
      owner.id,
      key,
      "Friday",
    );
    const answer = and(
      eq(workItems.kind, "person.response"),
      eq(workItems.key, key),
    );
    expect(await statusOf(task.id)).toBe("working");
    expect(await statusOf(unrelated.id)).toBe("ready_for_review");
    expect((await taskStore.get(owner.id, task.id)).queuedReplies).toEqual([
      { messageId: `person-response:${key}`, text: "Friday" },
    ]);
    // Its one attempt, running.
    await database
      .update(workItems)
      .set({
        attempts: 1,
        claimedBy: "answerer",
        leaseUntil: sql`now() + interval '1 minute'`,
      })
      .where(answer);
    expect(await statusOf(task.id)).toBe("working");
    // Let go after a throw: out of attempts, so failed, in plain words.
    await database
      .update(workItems)
      .set({ claimedBy: null, leaseUntil: null, lastError: "fetch failed" })
      .where(answer);
    expect(await taskStore.get(owner.id, task.id)).toMatchObject({
      status: "failed",
      failure: "a service didn't answer",
      answeredQuestionIds: [key],
    });
    await database.delete(workItems).where(answer);
  });

  test("a new question keeps priority over an accepted answer while working and after exhaustion", async () => {
    const { task, question, where } = await acceptedAnswer();
    expect(await statusOf(task.id)).toBe("working");
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
    await database
      .update(workItems)
      .set({ finishedAt: sql`now()` })
      .where(
        and(eq(workItems.kind, "person.question"), eq(workItems.key, newId)),
      );
    expect(await statusOf(task.id)).toBe("failed");
  });

  test("pending approval keeps priority over an accepted answer while working and after exhaustion", async () => {
    const { task, where } = await acceptedAnswer();
    const approvalId = await approvalIn(task.threadId);
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

  test("an exhausted accepted answer still counts its questions answered", async () => {
    const { task, questionId, where } = await acceptedAnswer();
    expect(await taskStore.get(owner.id, task.id)).toMatchObject({
      status: "working",
      answeredQuestionIds: [questionId],
    });
    await database
      .update(workItems)
      .set({ attempts: 2, lastError: "fetch failed" })
      .where(where);
    // The failed run did not finish the question; the accepted answer is what the read knows.
    expect(await taskStore.get(owner.id, task.id)).toMatchObject({
      status: "failed",
      failure: "a service didn't answer",
      answeredQuestionIds: [questionId],
    });
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
    const task = await freshTask(`Next ${randomUUID()}`);
    const nextOf = async () => (await taskStore.get(owner.id, task.id)).next;
    expect(await nextOf()).toBeNull();
    const at = Date.now();
    // The ask the turn starts on is the task, not a step.
    await channelStore.recordActivity(
      owner,
      task.channelId,
      { text: "Draft a reply to Danny.", agentId: null, at: new Date(at) },
      { id: `task-${task.id}:input` },
    );
    expect(await nextOf()).toBeNull();
    await channelStore.recordActivity(owner, task.channelId, {
      text: "I drafted the reply. **Send the reply to Danny?** It tells him Friday works.",
      agentId: bot,
      at: new Date(at + 1_000),
    });
    expect(await nextOf()).toBe("Send the reply to Danny?");
    await channelStore.recordActivity(owner, task.channelId, {
      text: "Make it shorter",
      agentId: null,
      at: new Date(at + 2_000),
    });
    expect(await nextOf()).toBe("“Make it shorter”");
    // Read the same way on the list.
    expect(
      (await taskStore.list(owner.id)).find((row) => row.id === task.id)?.next,
    ).toBe("“Make it shorter”");
  });

  test("a finished reply asks for input, and a queued reply clears that question while working", async () => {
    const task = await freshTask();
    await turnFor(task.id, { finishedAt: new Date() });
    await channelStore.recordActivity(owner, task.channelId, {
      text: "Here is the draft.\n\nWhich one should I use? 🙂",
      agentId: bot,
      at: new Date(),
    });
    expect(await statusOf(task.id)).toBe("needs_input");
    expect((await taskStore.get(owner.id, task.id)).next).toContain(
      "Which one",
    );
    await turnFor(task.id, {
      payload: {
        taskId: task.id,
        ownerUserId: owner.id,
        reply: "Use A",
        messageId: "reply-a",
      },
    });
    expect(await taskStore.get(owner.id, task.id)).toMatchObject({
      status: "working",
      queuedReplies: [{ messageId: "reply-a", text: "Use A" }],
    });
  });

  test("marked done, a final question stays dismissed until new work follows it", async () => {
    const task = await freshTask();
    await turnFor(task.id, { attempts: 1, finishedAt: new Date() });
    // Said well before it was marked done, and the new question well after, whatever the gap
    // between this process's clock and the database's.
    await channelStore.recordActivity(owner, task.channelId, {
      text: "Should I send the old draft?",
      agentId: bot,
      at: new Date(Date.now() - 60_000),
    });
    expect(await statusOf(task.id)).toBe("needs_input");
    const resolved = await taskStore.resolve(owner.id, task.id);
    expect(resolved.status).toBe("resolved");
    expect(await taskStore.get(owner.id, task.id)).toMatchObject({
      status: "resolved",
      resolvedAt: resolved.resolvedAt,
    });

    // A turn accepted after it was marked done supersedes that, without a write of its own...
    const reply = await turnFor(task.id);
    expect(await taskStore.get(owner.id, task.id)).toMatchObject({
      status: "working",
      resolvedAt: null,
    });
    // ...and cannot bring back the question the person already put away.
    await database
      .update(workItems)
      .set({ attempts: 1, finishedAt: sql`now()` })
      .where(reply);
    expect(await taskStore.get(owner.id, task.id)).toMatchObject({
      status: "ready_for_review",
      resolvedAt: null,
    });
    // A question the new turn ends on is the person's to answer again.
    const text = "Should I send the revised draft?";
    await channelStore.recordActivity(owner, task.channelId, {
      text,
      agentId: bot,
      at: new Date(Date.now() + 60_000),
    });
    const expected = { status: "needs_input", resolvedAt: null, next: text };
    expect(await taskStore.get(owner.id, task.id)).toMatchObject(expected);
    expect(
      (await taskStore.list(owner.id)).find((row) => row.id === task.id),
    ).toMatchObject(expected);
  });
});

describe("a task whose turn fails", () => {
  test("reads Working while its one retry is due, then Failed with the reason in plain words, never Ready for review", async () => {
    const task = await freshTask();
    // The first run threw: let go with its reason, and due once more.
    const where = await turnFor(task.id, {
      attempts: 1,
      lastError: "fetch failed",
    });
    expect(await statusOf(task.id)).toBe("working");
    // A restart cut the first run off: the lease ran out, so the retry is due.
    await database
      .update(workItems)
      .set({
        lastError: null,
        claimedBy: "gone",
        leaseUntil: sql`now() - interval '1 second'`,
      })
      .where(where);
    expect(await statusOf(task.id)).toBe("working");
    // The retry running.
    await database
      .update(workItems)
      .set({
        attempts: 2,
        claimedBy: "worker",
        leaseUntil: sql`now() + interval '3 minutes'`,
      })
      .where(where);
    expect(await statusOf(task.id)).toBe("working");
    // The retry threw too: out of runs, so it failed, and says why without the error itself.
    await database
      .update(workItems)
      .set({
        claimedBy: null,
        leaseUntil: null,
        lastError: "The routine's turn was stopped after 300s.",
      })
      .where(where);
    const failed = await taskStore.get(owner.id, task.id);
    expect(failed.status).toBe("failed");
    expect(failed.failure).toBe("the run took longer than 5 minutes");
    expect(failed.failedAt).not.toBeNull();

    // Marked done, it is done, and its failure stays on the record; reopened, it is failed again.
    expect(await taskStore.resolve(owner.id, task.id)).toMatchObject({
      status: "resolved",
      failure: "the run took longer than 5 minutes",
    });
    expect((await taskStore.reopen(owner.id, task.id)).status).toBe("failed");

    // A newer turn of its own counts: working, then ready once it finished.
    const again = await turnFor(task.id);
    expect(await statusOf(task.id)).toBe("working");
    await database
      .update(workItems)
      .set({ attempts: 1, finishedAt: new Date() })
      .where(again);
    const done = await taskStore.get(owner.id, task.id);
    expect(done.status).toBe("ready_for_review");
    expect(done.failure).toBeNull();
    expect(done.failedAt).toBeNull();
  });

  test("whose last run a restart cut off fails, saying so, at the moment its lease ran out", async () => {
    const task = await freshTask();
    const expired = new Date(Date.now() - 60_000);
    // The first run threw and left its error; the second was cut off, and that is what is said.
    await turnFor(task.id, {
      attempts: 2,
      claimedBy: "gone",
      leaseUntil: expired,
      lastError: "fetch failed",
      updatedAt: new Date(Date.now() - 4 * 60_000),
    });
    expect(await taskStore.get(owner.id, task.id)).toMatchObject({
      status: "failed",
      failure: "the run was cut off partway through",
      failedAt: expired.toISOString(),
    });
  });

  test("whose turn never reached the queue fails to start, once it should have", async () => {
    const task = await freshTask();
    expect(await statusOf(task.id)).toBe("working");
    const later = createTaskStore(database, {
      now: () => new Date(Date.now() + 2 * 60_000),
    });
    expect(await later.get(owner.id, task.id)).toMatchObject({
      status: "failed",
      failure: "it never started",
    });
  });

  test("whose turns have since left the queue reads from its conversation, never as not started", async () => {
    const task = await freshTask();
    const at = Date.now();
    await channelStore.recordActivity(
      owner,
      task.channelId,
      { text: "Prepare the notes.", agentId: null, at: new Date(at) },
      { id: `task-${task.id}:input` },
    );
    await channelStore.recordActivity(owner, task.channelId, {
      text: "The notes are ready.",
      agentId: bot,
      at: new Date(at + 1_000),
    });
    const later = createTaskStore(database, {
      now: () => new Date(Date.now() + 2 * 60_000),
    });
    expect(await later.get(owner.id, task.id)).toMatchObject({
      status: "ready_for_review",
      failure: null,
    });
  });

  test("stays Failed whatever is said in its conversation, until a turn of its own finishes", async () => {
    const task = await freshTask();
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
    expect(await statusOf(task.id)).toBe("failed");
    // Its own turn finishing is.
    const again = await turnFor(task.id);
    await database
      .update(workItems)
      .set({ attempts: 1, finishedAt: new Date() })
      .where(again);
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
    const first = await freshTask("Older");
    await Bun.sleep(5);
    const second = await freshTask("Newer");
    const listed = (await (await call(owner.id, "/")).json()) as {
      tasks: TaskRecord[];
    };
    const ids = listed.tasks.map((task) => task.id);
    expect(ids.indexOf(second.id)).toBeGreaterThanOrEqual(0);
    expect(ids.indexOf(second.id)).toBeLessThan(ids.indexOf(first.id));
    expect(listed.tasks.every((task) => typeof task.status === "string")).toBe(
      true,
    );
    // Each names its conversation's thread, which its approvals and questions carry.
    expect(listed.tasks.find((task) => task.id === second.id)?.threadId).toBe(
      second.threadId,
    );
    const one = (await (await call(owner.id, `/${second.id}`)).json()) as {
      task: TaskRecord;
    };
    expect(one.task).toEqual(
      listed.tasks.find((task) => task.id === second.id) as TaskRecord,
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
    const mine = await freshTask("Mine");
    for (const [path, method] of [
      [`/${mine.id}`, "GET"],
      [`/${mine.id}/resolve`, "POST"],
      [`/${mine.id}/reopen`, "POST"],
    ] as const) {
      const response = await call(other.id, path, method);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({
        error: "Couldn't find that task.",
      });
    }
    const theirs = (await (await call(other.id, "/")).json()) as {
      tasks: TaskRecord[];
    };
    expect(theirs.tasks).toEqual([]);
    expect((await taskStore.get(owner.id, mine.id)).resolvedAt).toBeNull();
  });

  test("a failure reading them says so in plain words, and logs no detail", async () => {
    const failing = createTaskRoutes(
      {
        ...taskStore,
        list: async () => {
          throw new Error("connection to 10.0.0.4 refused");
        },
      },
      async (context, next) => {
        context.set("actor", { id: owner.id } as AuthenticatedActor);
        await next();
      },
    );
    const logged = spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await failing.request("/");
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        error: "Couldn't load your tasks. Try again.",
      });
      expect(JSON.stringify(logged.mock.calls)).not.toContain("10.0.0.4");
    } finally {
      logged.mockRestore();
    }
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
        return unsafe(query, params);
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
   * How Postgres would run each over a queue holding many people's task turns and answers. Written,
   * analysed and planned in one transaction that is rolled back, so no other test sees the rows.
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
            statement.params,
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

  test("finds their task turns and answers through the index, never by scanning everyone's", async () => {
    const task = await freshTask();
    await turnFor(task.id, { finishedAt: new Date() });
    const record = await taskStore.get(owner.id, task.id);
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
    // The list's turns and answers, the report's, and the inbox's check for answers already taken.
    const plans = await plansOf(
      sent.filter(({ query, params }) =>
        [PROACTIVE_TASK_KIND, "person.response"].some(
          (kind) => query.includes(`'${kind}'`) || params.includes(kind),
        ),
      ),
    );
    expect(plans).toHaveLength(5);
    // Looked up by the person, not filtered from every row of the kind.
    const byPerson =
      /work_items_owner_task_idx.*\n\s*Index Cond: .*'ownerUserId'::text\) = /;
    expect(plans.filter((plan) => !byPerson.test(plan))).toEqual([]);
  });
});
