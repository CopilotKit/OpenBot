import { and, desc, eq, inArray, isNull, or, type SQL, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import {
  approvalRequests,
  botTasks,
  channels,
  intelligenceChannelMappings,
  workItems,
} from "../db/schema";
import type { TaskStatus } from "../proactive/contracts";
import { DEFAULT_MAX_ATTEMPTS } from "../work/queue";

/*
 * WHAT A TASK IS DOING IS READ, NEVER STORED. The work queue already knows whether the task's turn is
 * queued or running, the approval inbox whether it stopped for Allow once, and the question queue
 * whether its Bot asked the person something. Copying any of that onto the task would be a second
 * ledger that drifts from the first the moment one of them changes without it. The one thing only
 * the person can say, that they are done with it, is the one thing kept: `resolved_at`. It covers
 * the turns accepted by then; a later one supersedes it, without a separate reopening write.
 *
 * FAILING IS READ THE SAME WAY. A task's turn runs at most twice (`TASK_RUNS`): once, and once more
 * if the first run threw or was cut off by a restart. A turn that has run out of runs stays on the
 * queue unfinished, with its count and its last error, which is the queue's own terminal state
 * (work/queue.ts). That row is the failure and its reason; nothing else records it.
 *
 * Ported from OpenDuet's task store, less what OpenBot does differently: a person replies in a
 * task's conversation as an ordinary chat turn, not as a queued turn of the task's, so nothing here
 * reads queued replies or answers to question cards.
 */

/** The work queue kind a task's turn is queued as. */
export const PROACTIVE_TASK_KIND = "proactive.task";

/**
 * How many times a task's turn runs: once, and once more when the first run threw or a restart cut
 * it off. The queue's attempt cap for the kind, so a turn out of runs stays on the queue unfinished
 * with its count and its reason, which is what reads as Failed.
 */
export const TASK_RUNS = 2;

/** The rule above, on its own, so it can be read and tested without a database. */
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
 * Why a task's turn couldn't finish, in words that read right after both the list's "Couldn't
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
    [/lock/i, "the conversation was busy with another reply"],
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

/** How long a kept reply tail may be. A next step is one line on the task list. */
const REPLY_TAIL_MAX = 240;
/** A last sentence shorter than this is kept with the one before it. */
const SHORT_SENTENCE = 20;

/** A paragraph that is a list: every line of it is an item. */
const LIST_ITEM = /^\s*(?:[-*+•]|\d+[.)])\s+/;
/** A paragraph that is something the Bot drafted for the person, not what it says to them. */
const DRAFT =
  /^\s*(?:>|```|["“'‘]|\*{0,2}_{0,2}(?:draft|subject|to|dear|hi|hello)\b[^\n]{0,40}?:)/i;
/** What can trail a question and still leave it one: closing quotes, brackets, emoji, spaces. */
const TRAILING = /(?:[\s"”'’)\]}»\p{Extended_Pictographic}]|️|‍)+$/u;

/** Whether a sentence asks something, once what trails its question mark is set aside. */
const asksIn = (sentence: string) =>
  sentence.replace(TRAILING, "").endsWith("?");

const plain = (line: string) =>
  line
    .replace(/^\s*(?:[-*+>•]|#{1,6}|\d+[.)])\s+/, "")
    .replace(/[*_`]+/g, "")
    .trim();

/**
 * How a reply ends: the sentence to show as the task's next step, and whether it asks the person
 * something.
 *
 * A Bot ends a turn on what comes next, in the last paragraph it writes to the person. Lists and
 * drafts that close a reply are what it prepared, not what it says, so they are set aside. Within
 * that last paragraph its last question is the next step, even with a remark after it; without
 * one, its last sentence is. A short closing sentence keeps the one before it, so "Do you want me
 * to?" never stands alone. Null when there is nothing to say.
 */
export function replyEnding(reply: string | null | undefined): {
  tail: string | null;
  asks: boolean;
} {
  const paragraphs = (reply ?? "")
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => /[\p{L}\p{N}]/u.test(paragraph));
  const spoken = paragraphs.filter((paragraph) => {
    const lines = paragraph.split("\n").filter((line) => line.trim());
    return !(
      lines.every((line) => LIST_ITEM.test(line)) || DRAFT.test(paragraph)
    );
  });
  const kept = spoken.length ? spoken : paragraphs.slice(-1);
  const sentencesOf = (paragraph: string | undefined) =>
    (paragraph ?? "")
      .split("\n")
      .map(plain)
      .flatMap((line) => line.split(/(?<=[.!?][\s"”'’)\]]*)\s+(?=\S)/))
      .map((sentence) => sentence.trim())
      .filter((sentence) => /[\p{L}\p{N}]/u.test(sentence));
  const sentences = sentencesOf(kept.at(-1));
  const question = sentences.findLastIndex(asksIn);
  const at = question >= 0 ? question : sentences.length - 1;
  const chosen = sentences[at];
  if (!chosen) return { tail: null, asks: false };
  // A paragraph of its own still leans on the paragraph before it.
  const before = sentences[at - 1] ?? sentencesOf(kept.at(-2)).at(-1);
  const sentence =
    chosen.length < SHORT_SENTENCE && before ? `${before} ${chosen}` : chosen;
  return {
    tail:
      sentence.length > REPLY_TAIL_MAX
        ? `${Array.from(sentence)
            .slice(0, REPLY_TAIL_MAX - 1)
            .join("")}…`
        : sentence,
    asks: spoken.length > 0 && question >= 0,
  };
}

/** The sentence `replyEnding` would show, alone. */
export function replyTail(reply: string | null | undefined): string | null {
  return replyEnding(reply).tail;
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

/** The suffix of the line a task's turn records when it fails on its last run. */
export const FAILED_LINE = ":failed";
/** The suffix of the person's ask, recorded as their line when a task's turn starts. */
export const ASK_LINE = ":input";

export type TaskRow = typeof botTasks.$inferSelect;

/** What a task's conversation is doing, and its thread, as one read of the ledgers found them. */
export type TaskState = {
  /** The person's "done", unless a turn accepted after it superseded it. */
  resolvedAt: Date | null;
  /** What the effective turn was asked, so Try again asks the same. */
  turnInput: Record<string, unknown> | null;
  /** How many turns the task has had, for Try again's key. */
  turns: number;
  needsInput: boolean;
  working: boolean;
  threadId: string | null;
  /** The plain reason, when its turn ran out of runs, and when. */
  failure: string | null;
  failedAt: Date | null;
  /** One line on what comes next, from the last thing said in its conversation. */
  next: string | null;
};

/** A JSON field of a work item's payload, as text. */
const payload = (field: string) => sql<string>`${workItems.payload}->>${field}`;
/** The conversation an approval was raised in, as text. */
const approvalThread = sql<string>`${approvalRequests.action}->>'threadId'`;
/** The conversation the question a person.response answers was asked in, as text. */
const answeredThread = sql<string>`${workItems.payload}->'question'->>'threadId'`;

/**
 * What each task is doing, from the ledgers that say so. A handful of queries for the whole list,
 * whatever its length, each narrowed to the person first.
 */
export async function readTaskStates(
  database: Database,
  owner: string,
  rows: readonly TaskRow[],
  now: Date,
): Promise<Map<string, TaskState>> {
  const state = new Map<string, TaskState>(
    rows.map((row) => [
      row.id,
      {
        resolvedAt: row.resolvedAt,
        turnInput: null,
        turns: 0,
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
  const entryOfChannel = (channelId: string | null | undefined) =>
    state.get(taskOfChannel.get(channelId ?? "") ?? "");

  const [lastSaid, threads] = await Promise.all([
    // The last line said in each task's conversation, for its next step and for what came after.
    database
      .select({
        id: channels.id,
        lastMessage: channels.lastMessage,
        lastMessageAt: channels.lastMessageAt,
        byBot: sql<boolean>`${channels.lastMessageAgentId} is not null`,
        sourceId: channels.lastMessageSourceId,
      })
      .from(channels)
      .where(inArray(channels.id, channelIds)),
    database
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
      ),
  ]);
  const channelOfThread = new Map(
    threads.map((row) => [row.threadId, row.channelId]),
  );
  for (const row of threads) {
    const entry = entryOfChannel(row.channelId);
    if (entry) entry.threadId = row.threadId;
  }
  const threadIds = [...channelOfThread.keys()];
  const inThreads = (expression: SQL) =>
    threadIds.length > 0 ? inArray(expression, threadIds) : sql`false`;
  const mark = (
    channelId: string | null | undefined,
    field: "needsInput" | "working",
  ) => {
    const entry = entryOfChannel(channelId);
    if (entry) entry[field] = true;
  };

  const taskIds = rows.map((row) => row.id);
  const [approvals, questions, turns, carriedOn] = await Promise.all([
    // Waiting on the person: an action its turn paused on for Allow once.
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
    // Or a question its Bot asked them, in its conversation or its thread.
    database
      .select({
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
    /*
     * Its turns. The effective outcome follows when each turn finished or failed, not when it was
     * queued: an older turn may run, and fail, after a newer one finished.
     */
    database
      .select({
        key: workItems.key,
        taskId: payload("taskId"),
        input: workItems.payload,
        acceptedAt: sql`extract(epoch from ${workItems.createdAt})`.mapWith(
          Number,
        ),
        // Compared in SQL, so a turn accepted in the same millisecond still follows the "done".
        afterResolution: sql<boolean>`coalesce(${workItems.createdAt} > ${botTasks.resolvedAt}, false)`,
        // A crash fails at lease expiry, not its last heartbeat. Finished rows use their actual
        // completion; released rows use the release. Kept in PostgreSQL's sub-millisecond order.
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
      })
      .from(workItems)
      .innerJoin(botTasks, eq(botTasks.id, payload("taskId")))
      .where(
        and(
          eq(workItems.kind, PROACTIVE_TASK_KIND),
          inArray(payload("taskId"), taskIds),
        ),
      )
      .orderBy(desc(workItems.createdAt), desc(workItems.key)),
    /*
     * The person answered, and the conversation is being carried on: an approved action being
     * carried out and its result given back to the Bot, or an answer to a question being given to
     * it. While either is in flight, nothing waits on the person and the Bot is working.
     */
    Promise.all([
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
        .select({ threadId: answeredThread })
        .from(workItems)
        .where(
          and(
            eq(workItems.kind, "person.response"),
            isNull(workItems.finishedAt),
            sql`${payload("ownerUserId")} = ${owner}`,
            inThreads(answeredThread),
            sql`(${workItems.attempts} < ${DEFAULT_MAX_ATTEMPTS} or ${workItems.leaseUntil} > now())`,
          ),
        ),
    ]).then(([resuming, answering]) => [...resuming, ...answering]),
  ]);
  for (const row of approvals)
    mark(channelOfThread.get(row.threadId), "needsInput");
  for (const question of questions)
    mark(
      question.channelId ?? channelOfThread.get(question.threadId ?? ""),
      "needsInput",
    );

  const latestOutcome = new Map<string, (typeof turns)[number]>();
  const unfinished = new Map<string, (typeof turns)[number]>();
  for (const turn of turns) {
    const entry = state.get(turn.taskId);
    if (!entry) continue;
    entry.turns += 1;
    // A turn accepted after the person's "done" supersedes it.
    if (turn.afterResolution) entry.resolvedAt = null;
    const latest = latestOutcome.get(turn.taskId);
    // Ties keep creation order, but insertion order never hides a later terminal turn.
    if (!latest || turn.outcomeAt > latest.outcomeAt)
      latestOutcome.set(turn.taskId, turn);
    if (
      !turn.finished &&
      (turn.live || turn.attempts < TASK_RUNS) &&
      !unfinished.has(turn.taskId)
    )
      unfinished.set(turn.taskId, turn);
  }

  const saidIn = new Map(lastSaid.map((said) => [said.id, said]));
  for (const row of rows) {
    const entry = state.get(row.id);
    if (!entry) continue;
    const said = saidIn.get(row.channelId);
    // The ask a turn starts on is the task itself, not a step: "Just started" says that better.
    const ask = !said?.byBot && (said?.sourceId?.endsWith(ASK_LINE) ?? false);
    if (said && !ask) entry.next = nextStepOf(said.lastMessage, said.byBot);
    /*
     * The person spoke in its conversation after marking it done: a turn they started in the
     * browser, which reports its lines with no source of its own. Lines from the task's own turns
     * and from approvals carry their run's id, so a reply to work accepted before the "done" never
     * reopens it.
     */
    if (
      entry.resolvedAt &&
      said?.lastMessageAt &&
      said.sourceId === null &&
      said.lastMessageAt > entry.resolvedAt
    )
      entry.resolvedAt = null;

    // Any queued or live turn takes priority, including one whose older insert committed late.
    const turn = unfinished.get(row.id) ?? latestOutcome.get(row.id);
    entry.turnInput = turn?.input ?? null;
    if (!turn) {
      /*
       * Opened, and its turn not queued yet: the moment between the two writes that start a task.
       * Past that, it never will be, so it failed to start rather than reading Working for ever.
       */
      if (now.getTime() - row.createdAt.getTime() < STARTING_MS)
        entry.working = true;
      else {
        entry.failure = plainFailure(NEVER_STARTED);
        entry.failedAt = new Date(row.createdAt.getTime() + STARTING_MS);
      }
      continue;
    }
    if (turn.finished) continue;
    // Working while queued, running, or below the attempt cap after a throw or restart.
    if (turn.live || turn.attempts < TASK_RUNS) {
      entry.working = true;
      continue;
    }
    /*
     * Still claimed means its last run was cut off, not let go after a throw, whatever error an
     * earlier run left on the row; it failed when that lease ran out.
     */
    const cutOff = turn.claimed && turn.leaseUntil !== null;
    const failedAt =
      cutOff && turn.leaseUntil ? turn.leaseUntil : turn.updatedAt;
    /*
     * Failed until something is said in its conversation after: the person replying there, and the
     * Bot answering, is the task carrying on. The Bot's own "I couldn't finish this" is the failure
     * itself, not something said after it.
     */
    const saidSince =
      said?.lastMessageAt != null &&
      said.lastMessageAt > failedAt &&
      !(said.sourceId?.endsWith(FAILED_LINE) ?? false);
    if (saidSince) continue;
    entry.failure = plainFailure(cutOff ? null : turn.lastError);
    entry.failedAt = failedAt;
  }
  for (const row of carriedOn)
    mark(channelOfThread.get(row.threadId), "working");
  return state;
}
