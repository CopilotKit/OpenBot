import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, isNull, or, type SQL, sql } from "drizzle-orm";
import {
  type PersonQuestion,
  pendingPersonQuestion,
  questionResponseMessage,
} from "../approvals/questions";
import type { Database } from "../db/client";
import {
  approvalRequests,
  channels,
  intelligenceChannelMappings,
  tasks,
  workItems,
} from "../db/schema";
import {
  PROACTIVE_TASK_KIND,
  type TaskInput,
  taskInputSchema,
  taskTurnEndingSchema,
} from "../proactive/engine";
import { ProactiveRefusedError } from "../proactive/types";
import { DEFAULT_MAX_ATTEMPTS } from "../work/queue";
import { replyEnding, replyTail } from "./reply-ending";
import {
  type NewTask,
  TASK_RUNS,
  TaskNotFoundError,
  type TaskRecord,
  type TaskStatus,
} from "./types";

/*
 * The person's tasks: work a Bot does in the background, each in a conversation of its own, so the
 * conversation it was asked in stays one thread. The task page is its conversation, where the
 * person can reply to steer it; Tasks lists them.
 *
 * WHAT A TASK IS DOING IS READ, NEVER STORED. The work queue already knows whether the task's turn is
 * queued or running, the approval inbox whether it stopped for Allow once, and the question queue
 * whether its Bot asked the person something. Copying any of that onto the task would be a second
 * ledger that drifts from the first the moment one of them changes without it. The one thing only
 * the person can say, that they are done with it, is the one thing kept: `resolvedAt`. It covers
 * work accepted by then; a later durable turn supersedes it, without a separate reopening write.
 *
 * FAILING IS READ THE SAME WAY. A task's turn runs at most twice (`TASK_RUNS`): once, and once more
 * if the first run threw or was cut off by a restart. A turn that has run out of runs stays on the
 * queue unfinished, with its count and its last error, which is the queue's own terminal state
 * (work/queue.ts). That row is the failure and its reason; nothing else records it.
 */

/** The rule on `TaskStatus`, on its own, so it can be read and tested without a database. */
export function taskStatus(state: {
  resolved: boolean;
  needsInput: boolean;
  working: boolean;
  failed?: boolean;
}): TaskStatus {
  if (state.needsInput) return "needs_input";
  if (state.working) return "working";
  if (state.resolved) return "resolved";
  if (state.failed) return "failed";
  return "ready_for_review";
}

/** How long a task with no turn on the queue yet still reads as just started. */
const STARTING_MS = 60_000;
/** A turn whose last run a crash or restart cut off. */
const CUT_OFF = "the run was cut off partway through";
/** A task whose turn never reached the queue. */
const NEVER_STARTED = "it never started";

/**
 * Why a task's turn couldn't finish, in words that read right after both the row's "Couldn't
 * finish:" and the Bot's own "I couldn't finish this:", so never the Bot in the third person. Never
 * the error itself: that is an operator's, kept on the queue's row, and can be a status code, a
 * JSON body or a stack. Anything not recognised here is said generically.
 */
export function plainFailure(error: string | null | undefined): string {
  if (!error) return CUT_OFF;
  if (error === NEVER_STARTED) return NEVER_STARTED;
  const stopped = /stopped after (\d+)s/.exec(error);
  if (stopped) {
    const minutes = Math.max(1, Math.round(Number(stopped[1]) / 60));
    return `the run took longer than ${minutes} minute${minutes === 1 ? "" : "s"}`;
  }
  const rules: [RegExp, string][] = [
    [/finished without saying anything/i, "the run ended without a reply"],
    [/stopped to ask a question/i, "the run stopped to ask a question"],
    [/no longer available/i, "this conversation is gone"],
    [/nothing to start/i, "there was nothing to start"],
    [/before (it|retries) could/i, "it failed before it could be tried again"],
    [/\bpaused\b/i, "work is paused"],
    [/allowed model/i, "the model isn't allowed here"],
    [
      /lock|busy with another turn/i,
      "the conversation was busy with another reply",
    ],
    [/cancel|abort/i, "the run was stopped"],
    [
      /\b40[13]\b|authentication|api.?key/i,
      "the model provider turned the request away",
    ],
    [
      /fetch failed|ECONN|ETIMEDOUT|ENOTFOUND|socket hang up|unavailable|overloaded|\b50[234]\b/i,
      "a service didn't answer",
    ],
  ];
  return (
    rules.find(([pattern]) => pattern.test(error))?.[1] ??
    "something went wrong during the run"
  );
}

/** How long the person's own words may run as a task's next step. */
const QUOTE_MAX = 120;

/**
 * A task's next step, from the last line said in its conversation: the Bot's words end on what comes
 * next (`replyTail`); the person's are what the Bot is now working on, quoted.
 */
export function nextStepOf(
  said: string | null | undefined,
  byBot: boolean,
): string | null {
  const text = said?.trim();
  if (!text) return null;
  if (byBot) return replyTail(text);
  const words = Array.from(text);
  return `“${words.length > QUOTE_MAX ? `${words.slice(0, QUOTE_MAX - 1).join("")}…` : text}”`;
}

type Row = typeof tasks.$inferSelect;
/** What a task's conversation is doing, and its thread, as one read of the ledgers found them. */
type TaskState = {
  /** The person's completion, unless genuinely new durable work superseded it. */
  resolvedAt: Date | null;
  /** What the turn its status is read from was asked: what Try again asks again. */
  turnInput: Record<string, unknown> | null;
  /** How many turns of its own it has had, which keys Try again so two at once run once. */
  turns: number;
  queuedReplies: { messageId: string; text: string }[];
  answeredQuestionIds: Set<string>;
  needsInput: boolean;
  working: boolean;
  threadId: string | null;
  /** The plain reason, when its turn ran out of runs, and when. */
  failure: string | null;
  failedAt: Date | null;
  /** See `TaskRecord.next`. */
  next: string | null;
};

/** A JSON field of a work item's payload, as text. */
const payload = (field: string) => sql<string>`${workItems.payload}->>${field}`;
/** The conversation an approval was raised in, as text. */
const approvalThread = sql<string>`${approvalRequests.action}->>'threadId'`;

export type TaskStore = ReturnType<typeof createTaskStore>;
type TaskTransaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

/** Every read and write is the owner's: another person's task is the same as no task. */
export function createTaskStore(
  database: Database,
  options: { now?: () => Date } = {},
) {
  const now = options.now ?? (() => new Date());
  const owned = (owner: string, id: string) =>
    and(eq(tasks.ownerUserId, owner), eq(tasks.id, id));

  /**
   * What each task is doing, from the ledgers that say so. A handful of queries for the whole list,
   * whatever its length, each narrowed to the person first.
   */
  async function stateOf(
    owner: string,
    rows: readonly Row[],
  ): Promise<Map<string, TaskState>> {
    const state = new Map<string, TaskState>(
      rows.map((row) => [
        row.id,
        {
          resolvedAt: row.resolvedAt,
          turnInput: null,
          turns: 0,
          queuedReplies: [],
          answeredQuestionIds: new Set<string>(),
          needsInput: false,
          working: false,
          threadId: null,
          failure: null,
          failedAt: null,
          next: null,
        },
      ]),
    );
    if (rows.length === 0) return state;
    const channelIds = rows.map((row) => row.channelId);
    const taskOfChannel = new Map(rows.map((row) => [row.channelId, row.id]));
    // The last line said in each task's conversation, for its next step.
    const lastSaid = await database
      .select({
        id: channels.id,
        lastMessage: channels.lastMessage,
        byBot: sql<boolean>`${channels.lastMessageAgentId} is not null`,
        sourceId: channels.lastMessageSourceId,
        afterResolution: sql<boolean>`coalesce(${channels.lastMessageAt} > ${tasks.resolvedAt}, true)`,
      })
      .from(channels)
      .innerJoin(tasks, eq(tasks.channelId, channels.id))
      .where(inArray(channels.id, channelIds));
    for (const said of lastSaid) {
      const entry = state.get(taskOfChannel.get(said.id) ?? "");
      // The ask a turn starts on is the task itself, not a step: "Just started" says that better.
      const ask = !said.byBot && (said.sourceId?.endsWith(":input") ?? false);
      if (entry && !ask) entry.next = nextStepOf(said.lastMessage, said.byBot);
    }
    const threads = await database
      .select({
        channelId: intelligenceChannelMappings.channelId,
        threadId: intelligenceChannelMappings.threadId,
      })
      .from(intelligenceChannelMappings)
      .where(
        and(
          eq(intelligenceChannelMappings.userId, owner),
          inArray(intelligenceChannelMappings.channelId, channelIds),
        ),
      );
    const channelOfThread = new Map(
      threads.map((row) => [row.threadId, row.channelId]),
    );
    const threadIds = [...channelOfThread.keys()];
    for (const row of threads) {
      const taskId = taskOfChannel.get(row.channelId);
      const entry = taskId ? state.get(taskId) : undefined;
      if (entry) entry.threadId = row.threadId;
    }
    const mark = (
      channelId: string | null | undefined,
      field: "needsInput" | "working",
    ) => {
      const taskId = channelId ? taskOfChannel.get(channelId) : undefined;
      const entry = taskId ? state.get(taskId) : undefined;
      if (entry) entry[field] = true;
    };
    const inThreads = (expression: SQL) =>
      threadIds.length > 0 ? inArray(expression, threadIds) : sql`false`;

    // Waiting on the person: an action its turn paused on for Allow once, or a question it asked.
    const [approvals, questions] = await Promise.all([
      database
        .select({ threadId: approvalThread })
        .from(approvalRequests)
        .where(
          and(
            eq(approvalRequests.ownerUserId, owner),
            eq(approvalRequests.status, "pending"),
            inThreads(approvalThread),
          ),
        ),
      database
        .select({
          key: workItems.key,
          channelId: payload("channelId"),
          threadId: payload("threadId"),
        })
        .from(workItems)
        .where(
          and(
            eq(workItems.kind, "person.question"),
            isNull(workItems.finishedAt),
            sql`${payload("actorId")} = ${owner}`,
            or(
              inArray(payload("channelId"), channelIds),
              inThreads(payload("threadId")),
            ),
          ),
        ),
    ]);
    for (const row of approvals)
      mark(channelOfThread.get(row.threadId), "needsInput");

    /*
     * Its turns, in creation order for the queued reply list. The effective outcome follows when
     * each turn finished or failed: an older insert may commit and run after a newer turn finished.
     * The proactive engine owns task turns; an older one may name its suggestion. Question-card
     * answers are continuations in the same conversation, owned by the person-response worker.
     */
    const suggestionIds = rows.flatMap((row) =>
      row.suggestionId ? [row.suggestionId] : [],
    );
    // The same ledger timestamps order task executions and question-card continuations.
    const turnState = {
      key: workItems.key,
      acceptedAt: sql`extract(epoch from ${workItems.createdAt})`.mapWith(
        Number,
      ),
      // Compare in SQL so a same-millisecond acceptance still follows the exact completion.
      afterResolution: sql<boolean>`coalesce(${workItems.createdAt} > ${tasks.resolvedAt}, false)`,
      // A crash fails at lease expiry, not its last heartbeat. Finished rows use their actual
      // completion; released rows use the release timestamp. Keep PostgreSQL's sub-ms order.
      outcomeAt: sql`extract(epoch from coalesce(
        ${workItems.finishedAt},
        case when ${workItems.claimedBy} is not null then ${workItems.leaseUntil} end,
        ${workItems.updatedAt}
      ))`.mapWith(Number),
      attempts: workItems.attempts,
      live: sql<boolean>`coalesce(${workItems.leaseUntil} > now(), false)`,
      finished: sql<boolean>`${workItems.finishedAt} is not null`,
      lastError: workItems.lastError,
      claimed: sql<boolean>`${workItems.claimedBy} is not null`,
      updatedAt: workItems.updatedAt,
      leaseUntil: workItems.leaseUntil,
    };
    const responseQuestion = sql<PersonQuestion>`${workItems.payload}->'question'`;
    const responseThread = sql<string>`${responseQuestion}->>'threadId'`;
    const responseChannel = sql<string>`${responseQuestion}->>'channelId'`;
    const [turns, resuming, responses] = await Promise.all([
      database
        .select({
          ...turnState,
          input: workItems.payload,
          reply: payload("reply"),
          followup: payload("followup"),
          questionIds: sql<
            string[] | null
          >`${workItems.payload}->'questionIds'`,
          messageId: payload("messageId"),
          taskId: payload("taskId"),
          suggestionId: payload("suggestionId"),
        })
        .from(workItems)
        .leftJoin(tasks, eq(tasks.id, payload("taskId")))
        .where(
          and(
            eq(workItems.kind, PROACTIVE_TASK_KIND),
            or(
              inArray(
                payload("taskId"),
                rows.map((row) => row.id),
              ),
              suggestionIds.length > 0
                ? and(
                    sql`${payload("taskId")} is null`,
                    inArray(payload("suggestionId"), suggestionIds),
                  )
                : undefined,
            ),
          ),
        )
        .orderBy(desc(workItems.createdAt), desc(workItems.key)),
      database
        .select({ threadId: approvalThread })
        .from(workItems)
        .innerJoin(
          approvalRequests,
          eq(approvalRequests.id, payload("approvalId")),
        )
        .where(
          and(
            eq(workItems.kind, "approval.resume"),
            isNull(workItems.finishedAt),
            eq(approvalRequests.ownerUserId, owner),
            inThreads(approvalThread),
            sql`(${workItems.attempts} < ${DEFAULT_MAX_ATTEMPTS} or ${workItems.leaseUntil} > now())`,
          ),
        ),
      database
        .select({
          ...turnState,
          taskId: tasks.id,
          question: responseQuestion,
          response: payload("response"),
        })
        .from(workItems)
        .innerJoin(
          intelligenceChannelMappings,
          and(
            eq(intelligenceChannelMappings.userId, owner),
            eq(intelligenceChannelMappings.threadId, responseThread),
          ),
        )
        .innerJoin(
          tasks,
          and(
            eq(tasks.ownerUserId, owner),
            eq(tasks.channelId, intelligenceChannelMappings.channelId),
          ),
        )
        .where(
          and(
            eq(workItems.kind, "person.response"),
            sql`${payload("ownerUserId")} = ${owner}`,
            sql`${responseQuestion}->>'actorId' = ${owner}`,
            inArray(
              tasks.id,
              rows.map((row) => row.id),
            ),
            or(isNull(responseChannel), eq(responseChannel, tasks.channelId)),
          ),
        ),
    ]);
    const taskOfSuggestion = new Map(
      rows.flatMap((row) =>
        row.suggestionId ? [[row.suggestionId, row.id] as const] : [],
      ),
    );
    // Whether a turn's reply asked, read whole as it finished, by the id it was recorded under.
    const replyAsks = new Map<string, boolean>();
    for (const turn of turns) {
      const ending = taskTurnEndingSchema.safeParse(turn.input.ending);
      if (ending.success)
        replyAsks.set(ending.data.messageId, ending.data.asks);
    }
    const taskTurns = [
      ...turns.map((turn) => ({ ...turn, own: true, maxAttempts: TASK_RUNS })),
      ...responses.map(({ question, response, ...turn }) => {
        const message = questionResponseMessage(
          question,
          response,
          `person-response:${turn.key}`,
        );
        return {
          ...turn,
          own: false,
          // The person-response worker accepts one attempt, unlike a task's own turns.
          maxAttempts: 1,
          suggestionId: null,
          followup: "true",
          reply: response,
          messageId: message.id,
          questionIds: [turn.key],
          // Tried again, the answer is carried on as a reply of the person's, in its own words.
          input: {
            text: message.content,
            followup: true,
            questionIds: [turn.key],
            inputId: message.id,
            reply: response,
          } as Record<string, unknown>,
        };
      }),
    ].sort((a, b) => b.acceptedAt - a.acceptedAt || b.key.localeCompare(a.key));
    const latestOutcome = new Map<string, (typeof taskTurns)[number]>();
    const unfinished = new Map<string, (typeof taskTurns)[number]>();
    for (const turn of taskTurns) {
      const taskId =
        turn.taskId ?? taskOfSuggestion.get(turn.suggestionId ?? "");
      // Acceptance answers only the captured questions. Keep that fact across exhausted turns
      // and later turns that did not carry the original reply's snapshot.
      if (taskId && turn.followup === "true")
        for (const id of turn.questionIds ?? [])
          state.get(taskId)?.answeredQuestionIds.add(id);
      if (taskId) {
        const entry = state.get(taskId);
        if (entry && turn.taskId) {
          if (turn.own) entry.turns += 1;
          if (turn.afterResolution) entry.resolvedAt = null;
        }
        const latest = latestOutcome.get(taskId);
        // Ties retain creation/key order, but insertion order never hides a later terminal turn.
        if (!latest || turn.outcomeAt > latest.outcomeAt)
          latestOutcome.set(taskId, turn);
      }
      if (
        taskId &&
        !turn.finished &&
        (turn.live || turn.attempts < turn.maxAttempts) &&
        !unfinished.has(taskId)
      )
        unfinished.set(taskId, turn);
      if (
        taskId &&
        turn.reply &&
        turn.messageId &&
        !turn.finished &&
        !turn.live &&
        turn.attempts < turn.maxAttempts
      )
        state.get(taskId)?.queuedReplies.unshift({
          messageId: turn.messageId,
          text: turn.reply,
        });
    }
    for (const question of questions) {
      const channelId =
        question.channelId ?? channelOfThread.get(question.threadId ?? "");
      const taskId = channelId ? taskOfChannel.get(channelId) : undefined;
      if (!taskId || !state.get(taskId)?.answeredQuestionIds.has(question.key))
        mark(channelId, "needsInput");
    }
    const at = now().getTime();
    for (const row of rows) {
      const entry = state.get(row.id);
      if (!entry) continue;
      // Any queued/live turn takes priority, including one whose older insert committed late.
      const turn = unfinished.get(row.id) ?? latestOutcome.get(row.id);
      entry.turnInput = turn?.input ?? null;
      if (!turn) {
        /*
         * Opened, and its turn not queued yet: the moment between the two writes that start a task.
         * Past that, it never will be, so it failed to start rather than reading Working for ever.
         */
        if (at - row.createdAt.getTime() < STARTING_MS) entry.working = true;
        else {
          entry.failure = plainFailure(NEVER_STARTED);
          entry.failedAt = new Date(row.createdAt.getTime() + STARTING_MS);
        }
        continue;
      }
      if (turn.finished) continue;
      /*
       * Working while queued, running, or below its worker's attempt cap after a throw or restart.
       * Question-card answers have one attempt; a task's own turns have two.
       */
      if (turn.live || turn.attempts < turn.maxAttempts) {
        entry.working = true;
        continue;
      }
      /*
       * It stays failed until a turn of its own finishes. Anything else said in its conversation
       * since is not that turn: the task page sends a reply on a failed task as Try again.
       *
       * Still claimed means its last run was cut off, not let go after a throw, whatever error an
       * earlier run left on the row; it failed when that lease ran out.
       */
      const cutOff = turn.claimed && turn.leaseUntil !== null;
      entry.failure = plainFailure(cutOff ? null : turn.lastError);
      entry.failedAt =
        cutOff && turn.leaseUntil ? turn.leaseUntil : turn.updatedAt;
    }
    for (const row of resuming)
      mark(channelOfThread.get(row.threadId), "working");
    for (const said of lastSaid) {
      const entry = state.get(taskOfChannel.get(said.id) ?? "");
      /*
       * The line its conversation keeps is cut short, so a long closing question loses its question
       * mark there. A task's turn says whether its reply asked (`TaskTurnEnding`). Anything else
       * said there, and a reply from before turns said so, is read from the line.
       */
      const asks =
        replyAsks.get(said.sourceId ?? "") ??
        replyEnding(said.lastMessage).asks;
      if (
        entry &&
        said.byBot &&
        asks &&
        !entry.working &&
        !entry.failure &&
        !entry.resolvedAt &&
        // New work must not resurrect a final question the person already dismissed.
        said.afterResolution
      )
        entry.needsInput = true;
    }
    return state;
  }

  function recordOf(row: Row, state: TaskState | undefined): TaskRecord {
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
      botId: row.botId,
      channelId: row.channelId,
      threadId: state?.threadId ?? null,
      title: row.title,
      why: row.why,
      origin: row.origin,
      suggestionId: row.suggestionId,
      sourceApp: row.sourceApp,
      sourceLink: row.sourceLink,
      status,
      // Kept while it is marked done, too: Reopen brings the failure back, and so may a reply.
      failure: failedOrDone ? (state?.failure ?? null) : null,
      failedAt: failedOrDone ? (state?.failedAt?.toISOString() ?? null) : null,
      next: state?.next ?? null,
      queuedReplies: state?.queuedReplies ?? [],
      answeredQuestionIds: [...(state?.answeredQuestionIds ?? [])],
      resolvedAt: resolvedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  async function oneWithState(owner: string, id: string) {
    const [row] = await database
      .select()
      .from(tasks)
      .where(owned(owner, id))
      .limit(1);
    if (!row) throw new TaskNotFoundError();
    const state = (await stateOf(owner, [row])).get(id);
    if (!state) throw new TaskNotFoundError();
    return { record: recordOf(row, state), state };
  }

  async function one(owner: string, id: string): Promise<TaskRecord> {
    return (await oneWithState(owner, id)).record;
  }

  async function setResolved(owner: string, id: string, resolved: boolean) {
    // The same clock and precision as durable acceptance, across every server replica.
    const at = sql`now()`;
    const [row] = await database
      .update(tasks)
      .set({ resolvedAt: resolved ? at : null, updatedAt: at })
      .where(owned(owner, id))
      .returning({ id: tasks.id });
    if (!row) throw new TaskNotFoundError();
    return one(owner, id);
  }

  return {
    /**
     * Records a task opened in a conversation made for it. On the transaction that made the
     * conversation, so neither is ever there without the other.
     */
    async create(
      input: NewTask,
      executor: Database | TaskTransaction = database,
    ): Promise<TaskRecord> {
      const at = now();
      const [row] = await executor
        .insert(tasks)
        .values({ id: randomUUID(), ...input, createdAt: at, updatedAt: at })
        .returning();
      if (!row) throw new Error("The task was not saved.");
      return recordOf(row, undefined);
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
    /** Marks the person's questions answered, by a reply that has now run. */
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
    /** Whether this conversation of the person's is a task's own. */
    async isTaskConversation(owner: string, channelId: string) {
      const [row] = await database
        .select({ id: tasks.id })
        .from(tasks)
        .where(
          and(eq(tasks.ownerUserId, owner), eq(tasks.channelId, channelId)),
        )
        .limit(1);
      return row !== undefined;
    },
    /** Where a task lives, without working out what it is doing: for running its turn. */
    async locate(
      owner: string,
      id: string,
    ): Promise<{ channelId: string; botId: string } | null> {
      const [row] = await database
        .select({ channelId: tasks.channelId, botId: tasks.botId })
        .from(tasks)
        .where(owned(owner, id))
        .limit(1);
      return row ?? null;
    },
    /**
     * What a failed task's turn was asked to do, to run it again, and how many turns it has had:
     * the ask its failed turn carried, or, for one never queued, its suggestion or its title.
     * Refused unless it failed, so Try again never starts a second run beside a live one.
     *
     * A task marked done after it failed is taken too. Reading what to ask leaves it done; only the
     * rerun, once it is on the queue, makes it not done.
     */
    async failedTurn(
      owner: string,
      id: string,
    ): Promise<{ ask: TaskInput; turns: number }> {
      const { record: task, state } = await oneWithState(owner, id);
      const failed =
        task.status === "failed" ||
        (task.status === "resolved" && task.failure !== null);
      if (!failed)
        throw new ProactiveRefusedError(
          "Only a task that couldn't finish can be tried again.",
        );
      const input = taskInputSchema.parse(state.turnInput ?? {});
      const suggestionId = input.suggestionId ?? task.suggestionId;
      // An empty text is a reply of files alone, and is kept. Only a missing ask falls back.
      const ask =
        input.text !== undefined
          ? input
          : {
              ...input,
              ...(suggestionId ? { suggestionId } : { text: task.title }),
            };
      return { ask, turns: state.turns };
    },
    /** The owner's tasks, newest first. No cap on how many there are; a page is what a list shows. */
    async list(owner: string, limit = 200): Promise<TaskRecord[]> {
      const rows = await database
        .select()
        .from(tasks)
        .where(eq(tasks.ownerUserId, owner))
        .orderBy(desc(tasks.createdAt), desc(tasks.id))
        .limit(limit);
      const state = await stateOf(owner, rows);
      return rows.map((row) => recordOf(row, state.get(row.id)));
    },
    get: one,
    /** The person is done with it. Its conversation stays, and Reopen brings it back. */
    resolve: (owner: string, id: string) => setResolved(owner, id, true),
    reopen: (owner: string, id: string) => setResolved(owner, id, false),
  };
}
