import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { pendingPersonQuestion } from "../approvals/questions";
import type { Database } from "../db/client";
import {
  botTasks,
  channels,
  intelligenceChannelMappings,
  workItems,
} from "../db/schema";
import type { BotTaskOrigin } from "../db/schema/tasks";
import type { BotTaskCounts, TaskPayload } from "../proactive/contracts";
import {
  MARKED_DONE,
  PROACTIVE_TASK_KIND,
  readTaskStates,
  type TaskRow,
  type TaskState,
  taskStatus,
} from "./state";

/*
 * The person's tasks: work a Bot does for them in a conversation of its own, opened when they start
 * an item a check-in raised, or when they ask for it in so many words (`start_task`, or the + on
 * Tasks). The task's page is its conversation, where the person reads it and replies; the list shows
 * where each one stands.
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
  channelId: string;
  title: string;
  why: string | null;
  origin: BotTaskOrigin;
  suggestionId: string | null;
  sourceApp: string | null;
  sourceLink: string | null;
  /**
   * The id the browser made for a Start on Tasks. A second task with the same one from the same
   * person is never opened: the first is answered instead (`byClientId`).
   */
  clientId?: string | null;
};

/** The transaction a task row is written on, beside its conversation. */
type TaskTransaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

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

/** The files and skills a reply's turn carried, as ids. */
function contextIn(input: Record<string, unknown> | null) {
  const ids = (value: unknown) =>
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((id) => typeof id === "string")
      ? (value as string[])
      : undefined;
  const attachmentIds = ids(input?.attachmentIds);
  const skillIds = ids(input?.skillIds);
  return {
    ...(attachmentIds ? { attachmentIds } : {}),
    ...(skillIds ? { skillIds } : {}),
  };
}

/*
 * Listed: every task not marked done, those marked done in the last week, and any marked done
 * longer ago that something reopened since (a turn queued, or the person speaking there). Exported
 * for the attention counts, which must count exactly the tasks this list shows.
 */
export const listedTask = sql`(
    ${botTasks.resolvedAt} is null
    or ${botTasks.resolvedAt} > now() - make_interval(days => ${RESOLVED_FOR_DAYS})
    or exists (
      select 1 from ${workItems}
      where ${workItems.kind} = ${PROACTIVE_TASK_KIND}
        and ${workItems.payload}->>'taskId' = ${botTasks.id}
        and ${workItems.createdAt} > ${botTasks.resolvedAt}
    )
    or exists (
      select 1 from ${channels}
      where ${channels.id} = ${botTasks.channelId}
        and ${channels.lastMessageSourceId} is null
        and ${channels.lastMessageAt} > ${botTasks.resolvedAt}
    )
  )`;

export type TaskStore = ReturnType<typeof createTaskStore>;

export function createTaskStore(
  database: Database,
  options: { now?: () => Date } = {},
) {
  const now = options.now ?? (() => new Date());
  const owned = (owner: string, id: string) =>
    and(eq(botTasks.ownerUserId, owner), eq(botTasks.id, id));

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
      next: status === "resolved" ? MARKED_DONE : (state?.next ?? null),
      queuedReplies: state?.queuedReplies ?? [],
      answeredQuestionIds: [...(state?.answeredQuestionIds ?? [])],
      resolvedAt: resolvedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  async function withState(owner: string, rows: TaskRow[]) {
    const state = await readTaskStates(database, owner, rows, now());
    return rows.map((row) => recordOf(row, state.get(row.id)));
  }

  async function oneWithState(owner: string, id: string) {
    const [row] = await database
      .select()
      .from(botTasks)
      .where(owned(owner, id))
      .limit(1);
    if (!row) throw new TaskNotFoundError();
    const state = (await readTaskStates(database, owner, [row], now())).get(id);
    if (!state) throw new TaskNotFoundError();
    return { row, record: recordOf(row, state), state };
  }

  async function one(owner: string, id: string): Promise<TaskPayload> {
    return (await oneWithState(owner, id)).record;
  }

  /*
   * Marked done on the database's clock, the clock the work queue stamps a turn's acceptance with,
   * and never before the last line said in its conversation: a line reported a moment before the
   * person pressed done, by a server whose clock runs ahead, must not read as said after it.
   */
  async function setResolved(owner: string, id: string, resolved: boolean) {
    const [row] = await database
      .update(botTasks)
      .set({
        resolvedAt: resolved
          ? sql`greatest(now(), (select ${channels.lastMessageAt} from ${channels} where ${channels.id} = ${botTasks.channelId}))`
          : null,
        updatedAt: sql`now()`,
      })
      .where(owned(owner, id))
      .returning({ id: botTasks.id });
    if (!row) throw new TaskNotFoundError();
    return one(owner, id);
  }

  /** The owner's tasks, newest first: open ones, and those marked done for a week after. */
  async function list(owner: string): Promise<TaskPayload[]> {
    const rows = await database
      .select()
      .from(botTasks)
      .where(and(eq(botTasks.ownerUserId, owner), listedTask))
      .orderBy(desc(botTasks.createdAt), desc(botTasks.id))
      .limit(LIST_LIMIT);
    return withState(owner, rows);
  }

  return {
    /**
     * Write a task row, on the transaction that makes its conversation. An item already started, or
     * a Start already sent with this `clientId`, keeps the task it opened: `null` here, and the
     * caller rolls its conversation back.
     */
    async create(
      input: NewTask,
      transaction: TaskTransaction,
    ): Promise<{ id: string; channelId: string; title: string } | null> {
      const at = now();
      const [row] = await transaction
        .insert(botTasks)
        .values({ id: randomUUID(), ...input, createdAt: at, updatedAt: at })
        // Either unique index: the item's, or the person's Start id.
        .onConflictDoNothing()
        .returning({
          id: botTasks.id,
          channelId: botTasks.channelId,
          title: botTasks.title,
        });
      return row ?? null;
    },
    /** The task a Start with this browser-made id opened. */
    async byClientId(
      owner: string,
      clientId: string,
    ): Promise<{ id: string; channelId: string; title: string } | null> {
      const [row] = await database
        .select({
          id: botTasks.id,
          channelId: botTasks.channelId,
          title: botTasks.title,
        })
        .from(botTasks)
        .where(
          and(eq(botTasks.ownerUserId, owner), eq(botTasks.clientId, clientId)),
        )
        .limit(1);
      return row ?? null;
    },
    /**
     * The person's questions waiting in a task's conversation, less any a reply already answered:
     * the ones a reply taken now answers.
     */
    async pendingQuestions(owner: string, id: string): Promise<string[]> {
      const task = await one(owner, id);
      const rows = await database
        .select({ key: workItems.key })
        .from(workItems)
        .where(
          and(
            pendingPersonQuestion(owner),
            sql`${workItems.payload}->>'mode' = 'completed_question'`,
            or(
              sql`${workItems.payload}->>'channelId' = ${task.channelId}`,
              task.threadId
                ? sql`${workItems.payload}->>'threadId' = ${task.threadId}`
                : sql`false`,
            ),
          ),
        );
      return rows.map((row) => row.key);
    },
    /** Marks the person's questions answered, by a reply that is now running. */
    async answerQuestions(owner: string, ids: readonly string[]) {
      if (ids.length === 0) return;
      await database
        .update(workItems)
        .set({ finishedAt: sql`now()`, updatedAt: sql`now()` })
        .where(
          and(
            eq(workItems.kind, "person.question"),
            inArray(workItems.key, [...ids]),
            sql`${workItems.payload}->>'actorId' = ${owner}`,
            isNull(workItems.finishedAt),
          ),
        );
    },
    /** Whether this thread of the person's is a task's own conversation. */
    async isTaskThread(owner: string, threadId: string): Promise<boolean> {
      const [row] = await database
        .select({ id: botTasks.id })
        .from(botTasks)
        .innerJoin(
          intelligenceChannelMappings,
          and(
            eq(intelligenceChannelMappings.channelId, botTasks.channelId),
            eq(intelligenceChannelMappings.userId, owner),
          ),
        )
        .where(
          and(
            eq(botTasks.ownerUserId, owner),
            eq(intelligenceChannelMappings.threadId, threadId),
          ),
        )
        .limit(1);
      return row !== undefined;
    },
    /** The task an item opened, if it opened one. */
    async byItem(
      owner: string,
      itemId: string,
    ): Promise<{ id: string; channelId: string } | null> {
      const [row] = await database
        .select({ id: botTasks.id, channelId: botTasks.channelId })
        .from(botTasks)
        .where(
          and(
            eq(botTasks.ownerUserId, owner),
            eq(botTasks.suggestionId, itemId),
          ),
        )
        .limit(1);
      return row ?? null;
    },
    list,
    get: one,
    /** Where a task lives, without working out what it is doing: for running its turn. */
    async locate(owner: string, id: string): Promise<TaskRow | null> {
      const [row] = await database
        .select()
        .from(botTasks)
        .where(owned(owner, id))
        .limit(1);
      return row ?? null;
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
    ): Promise<{
      ask: string;
      turns: number;
      /** The files and skills the failed turn carried, a reply's, to carry them again. */
      context: { attachmentIds?: string[]; skillIds?: string[] };
    }> {
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
        context: contextIn(state.turnInput),
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
