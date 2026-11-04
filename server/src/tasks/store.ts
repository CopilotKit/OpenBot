import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { conversations } from "../conversations/directory";
import { writeKey } from "../conversations/http";
import type { AgentTask, ConversationDraft } from "../conversations/types";
import type { Database } from "../db/client";
import { workItems } from "../db/schema";
import { schedules } from "../schedules/directory";
import type { BotTaskOrigin } from "../db/schema/tasks";
import type { BotTaskCounts, TaskPayload } from "../proactive/contracts";
import {
  PROACTIVE_TASK_KIND,
  readTaskStates,
  type TaskRow,
  type TaskState,
  taskStatus,
} from "./state";

/*
 * The person's tasks: work a Bot does for them in a conversation of its own, opened when they start
 * an item a check-in raised. The task's page is its conversation, where the person reads it and
 * replies; the list shows where each one stands.
 *
 * Every read and write is the owner's: another person's task is the same as no task.
 */

export class TaskNotFoundError extends Error {
  constructor() {
    super("Couldn't find that task.");
    this.name = "TaskNotFoundError";
  }
}

/** A request about a task that its state refuses, said to the person. */
export class TaskRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskRefusedError";
  }
}

/** How long a task the person marked done stays on their list. */
export const RESOLVED_FOR_DAYS = 7;
/** The most tasks a list returns, newest first. A page is what a list shows. */
const LIST_LIMIT = 200;

export type NewTask = {
  ownerUserId: string;
  agentId: string;
  title: string;
  why: string | null;
  origin: BotTaskOrigin;
  suggestionId: string | null;
  sourceApp: string | null;
  sourceLink: string | null;
};

/** A task as Intelligence holds it, under the names `bot_tasks` used. */
/**
 * Unlink every task whose check-in item is gone, as the old foreign key did (`on delete set null`).
 *
 * The items are check-in suggestions in Intelligence's agent schedules and the tasks are in its
 * conversations, so no constraint joins them any more. Whatever removed an item (a person removing a Bot's research, a reset, a
 * cascade), the next read of its task finds no item under its reference, unlinks it in Intelligence,
 * and answers with it unlinked. A failed unlink is said and retried on the next read; the answer
 * is unlinked either way.
 */
async function withLiveItems(rows: TaskRow[]): Promise<TaskRow[]> {
  const refs = [
    ...new Set(
      rows.flatMap((row) => (row.suggestionId ? [row.suggestionId] : [])),
    ),
  ];
  if (refs.length === 0) return rows;
  // Asked of Intelligence by id, past this instance's memory: an item removed on another replica is gone.
  const live = new Set<string>();
  for (let start = 0; start < refs.length; start += 200) {
    const { items } = await schedules().client.all("check-in-suggestions", {
      ids: refs.slice(start, start + 200),
    });
    for (const item of items) live.add(item.id);
  }
  const client = conversations().client;
  return Promise.all(
    rows.map(async (row) => {
      if (!row.suggestionId || live.has(row.suggestionId)) return row;
      await client.tasks
        .unlinkOrigin(row.id, writeKey("task.unlink"))
        .catch((error: unknown) =>
          console.warn(
            JSON.stringify({
              type: "task-unlink-failed",
              taskId: row.id,
              note: "Its check-in item is gone; the next read of the task tries again.",
              error: error instanceof Error ? error.message : String(error),
            }),
          ),
        );
      return { ...row, suggestionId: null };
    }),
  );
}

export function taskRowOf(task: AgentTask): TaskRow {
  return {
    id: task.id,
    ownerUserId: task.userId,
    agentId: task.agentId,
    channelId: task.conversationId,
    suggestionId: task.originRef,
    title: task.title,
    why: task.why,
    sourceApp: task.sourceApp,
    sourceLink: task.sourceLink,
    origin: task.origin as BotTaskOrigin,
    resolvedAt: task.resolvedAt,
    resolvedAtExact: task.resolvedAtExact,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}

/** The first paragraph of an item's detail: why it matters, without the step after it. */
export function whyOf(detail: string): string | null {
  return detail.split(/\n\s*\n/)[0]?.trim() || null;
}

/** What a started item says to the Bot, as the person's ask: the title, the detail, the source. */
export function itemAsk(item: {
  title: string;
  detail: string;
  sourceLink: string | null;
}): string {
  return `${item.title}\n\n${item.detail}${item.sourceLink ? `\n\nSource: ${item.sourceLink}` : ""}`;
}

/** A turn's payload names its ask as `text`; anything else on it is not this module's. */
const askIn = (input: Record<string, unknown> | null) =>
  typeof input?.text === "string" && input.text.trim() ? input.text : null;

/*
 * Listed: every task not marked done, those marked done in the last week, and any marked done
 * longer ago that something reopened since (a turn queued, or the person speaking there).
 *
 * The tasks live in Intelligence, which answers the first three (`listedSince`: open, done since,
 * or spoken in since done). A turn queued since is in this deployment's own work queue, so those are
 * found here: the person's task turns, and the tasks they belong to that were done before them,
 * compared on this database's clock to the microsecond. Exported for the attention counts, which
 * must count exactly the tasks this list shows.
 */
export async function listedTasks(
  database: Database,
  owner: string,
  now: Date,
  limit = LIST_LIMIT,
): Promise<TaskRow[]> {
  const client = conversations().client;
  const since = new Date(now.getTime() - RESOLVED_FOR_DAYS * 86_400_000);
  const listed = (
    await client.tasks.upTo({ userId: owner, listedSince: since }, limit)
  ).map(taskRowOf);
  const seen = new Set(listed.map((task) => task.id));

  // Turns this person's tasks have had, for the ones Intelligence did not list.
  const queued = await database
    .selectDistinct({ taskId: sql<string>`${workItems.payload}->>'taskId'` })
    .from(workItems)
    .where(
      and(
        eq(workItems.kind, PROACTIVE_TASK_KIND),
        sql`${workItems.payload}->>'ownerUserId' = ${owner}`,
        sql`${workItems.payload}->>'taskId' is not null`,
      ),
    );
  const unlisted = queued
    .map((row) => row.taskId)
    .filter((id) => !seen.has(id))
    .slice(0, 500);
  if (unlisted.length > 0) {
    const done = (await client.tasks.many(unlisted))
      .filter((task) => task.userId === owner && task.resolvedAtExact)
      .map(taskRowOf);
    if (done.length > 0) {
      const resolvedAt = sql.join(
        done.map(
          (task) =>
            sql`when ${task.id} then ${task.resolvedAtExact}::timestamptz`,
        ),
        sql` `,
      );
      const reopened = await database
        .selectDistinct({
          taskId: sql<string>`${workItems.payload}->>'taskId'`,
        })
        .from(workItems)
        .where(
          and(
            eq(workItems.kind, PROACTIVE_TASK_KIND),
            inArray(
              sql`${workItems.payload}->>'taskId'`,
              done.map((task) => task.id),
            ),
            sql`${workItems.createdAt} > (case ${workItems.payload}->>'taskId' ${resolvedAt} end)`,
          ),
        );
      const again = new Set(reopened.map((row) => row.taskId));
      listed.push(...done.filter((task) => again.has(task.id)));
    }
  }
  return (await withLiveItems(listed))
    .sort(
      (left, right) =>
        right.createdAt.getTime() - left.createdAt.getTime() ||
        (left.id < right.id ? 1 : left.id > right.id ? -1 : 0),
    )
    .slice(0, limit);
}

export type TaskStore = ReturnType<typeof createTaskStore>;

export function createTaskStore(
  database: Database,
  options: { now?: () => Date } = {},
) {
  const now = options.now ?? (() => new Date());
  const client = () => conversations().client;

  function recordOf(row: TaskRow, state: TaskState | undefined): TaskPayload {
    const resolvedAt = state ? state.resolvedAt : row.resolvedAt;
    const status = taskStatus({
      resolved: resolvedAt !== null,
      needsInput: state?.needsInput ?? false,
      working: state?.working ?? false,
      failed: (state?.failure ?? null) !== null,
    });
    const failedOrDone = status === "failed" || status === "resolved";
    return {
      id: row.id,
      agentId: row.agentId,
      channelId: row.channelId,
      threadId: state?.threadId ?? null,
      title: row.title,
      why: row.why,
      origin: row.origin,
      suggestionId: row.suggestionId,
      sourceApp: row.sourceApp,
      sourceLink: row.sourceLink,
      status,
      // Kept while it is marked done, too: Reopen brings the failure back.
      failure: failedOrDone ? (state?.failure ?? null) : null,
      failedAt: failedOrDone ? (state?.failedAt?.toISOString() ?? null) : null,
      next: state?.next ?? null,
      resolvedAt: resolvedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  async function withState(owner: string, rows: TaskRow[]) {
    const state = await readTaskStates(database, owner, rows, now());
    return rows.map((row) => recordOf(row, state.get(row.id)));
  }

  /** The owner's task, or null: another person's task is the same as no task. */
  async function owned(owner: string, id: string): Promise<TaskRow | null> {
    const task = await client().tasks.get(id);
    if (!task || task.userId !== owner) return null;
    const [row] = await withLiveItems([taskRowOf(task)]);
    return row ?? null;
  }

  async function oneWithState(owner: string, id: string) {
    const row = await owned(owner, id);
    if (!row) throw new TaskNotFoundError();
    const state = (await readTaskStates(database, owner, [row], now())).get(id);
    if (!state) throw new TaskNotFoundError();
    return { row, record: recordOf(row, state), state };
  }

  async function one(owner: string, id: string): Promise<TaskPayload> {
    return (await oneWithState(owner, id)).record;
  }

  /*
   * Marked done on this deployment's database clock, the clock the work queue stamps a turn's
   * acceptance with, and never before the last line said in its conversation: a line reported a
   * moment before the person pressed done, by a server whose clock runs ahead, must not read as
   * said after it. Worked out here, to the microsecond, and stored in Intelligence as it is.
   */
  async function setResolved(owner: string, id: string, resolved: boolean) {
    const row = await owned(owner, id);
    if (!row) throw new TaskNotFoundError();
    let resolvedAt: string | null = null;
    if (resolved) {
      const conversation = await conversations().refresh(row.channelId);
      const lastSaid = conversation?.lastMessageAtExact ?? null;
      const [stamp] = await database.execute<{ at: string }>(
        sql`select to_char(greatest(now(), ${lastSaid}::timestamptz) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as at`,
      );
      if (!stamp) throw new Error("The database did not say what time it is.");
      resolvedAt = stamp.at;
    }
    if (
      !(await client().tasks.resolve(id, resolvedAt, writeKey("task.resolve")))
    )
      throw new TaskNotFoundError();
    return one(owner, id);
  }

  /** The owner's tasks, newest first: open ones, and those marked done for a week after. */
  async function list(owner: string): Promise<TaskPayload[]> {
    return withState(owner, await listedTasks(database, owner, now()));
  }

  return {
    /**
     * Write a task with its own new conversation, in one write in Intelligence, so the conversation
     * is never there without the task that says what it is for. An item already started keeps the
     * task it opened: that one comes back, and nothing new is made.
     */
    async create(
      input: NewTask,
      conversation: ConversationDraft,
    ): Promise<{ id: string; channelId: string }> {
      const at = now();
      const { task } = await client().tasks.create(
        {
          id: randomUUID(),
          userId: input.ownerUserId,
          agentId: input.agentId,
          conversation,
          originRef: input.suggestionId,
          origin: input.origin,
          title: input.title,
          why: input.why,
          sourceApp: input.sourceApp,
          sourceLink: input.sourceLink,
          createdAt: at,
          updatedAt: at,
        },
        writeKey("task.create"),
      );
      return { id: task.id, channelId: task.conversationId };
    },
    /** The task an item opened, if it opened one. */
    async byItem(
      owner: string,
      itemId: string,
    ): Promise<{ id: string; channelId: string } | null> {
      const { tasks } = await client().tasks.page(
        { userId: owner, originRef: itemId },
        null,
        1,
      );
      const task = tasks[0];
      if (!task) return null;
      // An item that is gone opened no task any more: its task is unlinked.
      const [row] = await withLiveItems([taskRowOf(task)]);
      return row?.suggestionId === itemId
        ? { id: task.id, channelId: task.conversationId }
        : null;
    },
    list,
    get: one,
    /** Where a task lives, without working out what it is doing: for running its turn. */
    async locate(owner: string, id: string): Promise<TaskRow | null> {
      return owned(owner, id);
    },
    /**
     * What a failed task's turn was asked, to run it again, and how many turns it has had: the ask
     * its failed turn carried, or, for one never queued, its title, why and source. Refused unless it
     * failed, so Try again never starts a second run beside a live one.
     *
     * A task marked done after it failed is taken too. Its "done" is superseded only once the retry
     * is queued; reading the ask leaves it alone.
     */
    async failedTurn(
      owner: string,
      id: string,
    ): Promise<{ ask: string; turns: number }> {
      const { row, record, state } = await oneWithState(owner, id);
      const failed =
        record.status === "failed" ||
        (record.status === "resolved" && record.failure !== null);
      if (!failed)
        throw new TaskRefusedError(
          "Only a task that couldn't finish can be tried again.",
        );
      return {
        ask:
          askIn(state.turnInput) ??
          itemAsk({
            title: row.title,
            detail: row.why ?? "",
            sourceLink: row.sourceLink,
          }),
        turns: state.turns,
      };
    },
    /** The person is done with it. Its conversation stays, and Reopen brings it back. */
    resolve: (owner: string, id: string) => setResolved(owner, id, true),
    reopen: (owner: string, id: string) => setResolved(owner, id, false),
    /**
     * Per Bot, the person's tasks that need input, are ready for review, or failed, for the "Needs
     * you" counts. Read from the same list the person sees, so the counts never name a task the list
     * leaves out.
     */
    async counts(owner: string): Promise<BotTaskCounts[]> {
      const byBot = new Map<string, BotTaskCounts>();
      for (const task of await list(owner)) {
        const field =
          task.status === "needs_input"
            ? "needsInput"
            : task.status === "ready_for_review"
              ? "ready"
              : task.status === "failed"
                ? "failed"
                : null;
        if (!field) continue;
        const counts = byBot.get(task.agentId) ?? {
          agentId: task.agentId,
          needsInput: 0,
          ready: 0,
          failed: 0,
        };
        counts[field] += 1;
        byBot.set(task.agentId, counts);
      }
      return [...byBot.values()];
    },
  };
}
