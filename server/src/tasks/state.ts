import { approvalWords } from "@openbot/shared/tool-name";
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
import { DEFAULT_MAX_ATTEMPTS, type SerialOrder } from "../work/queue";

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
 * A PERSON'S REPLY IS A TURN OF THE TASK'S. Sent through `POST /api/tasks/:id/reply`, it is queued
 * as a task's turn before it is answered, so it survives a restart and waits its turn behind one still
 * running (`TASK_TURN_ORDER`). While it waits it is one of the task's `queuedReplies`, and the
 * questions waiting when it was taken are answered by it (`answeredQuestionIds`). A reply typed as an
 * ordinary chat turn in the conversation still counts as the person carrying it on.
 */

/** The work queue kind a task's turn is queued as. */
export const PROACTIVE_TASK_KIND = "proactive.task";
/** The answer to a question card, carried on by the person-response sweep. */
export const PERSON_RESPONSE_KIND = "person.response";
/** A decided approval, carried out and its turn carried on by the approval resume sweep. */
export const APPROVAL_RESUME_KIND = "approval.resume";

/**
 * How many times a task's turn runs: once, and once more when the first run threw or a restart cut
 * it off. The queue's attempt cap for the kind, so a turn out of runs stays on the queue unfinished
 * with its count and its reason, which is what reads as Failed.
 */
export const TASK_RUNS = 2;

/**
 * One task's conversation takes one turn at a time, in the order the person gave them: its own
 * turns, the person's replies, the answers to question cards its Bot asked there, and the turns
 * Allow once carries on. Claimed under this by the task runner (tasks/runner.ts), the
 * person-response sweep (approvals/person-response-sweep.ts) and the approval resume sweep
 * (approvals/resume-sweep.ts). Named for the turns it orders, apart from the app's `TASK_ORDER`,
 * which is the order Tasks lists statuses in.
 *
 * Three kinds share the order. A task's turn names its task in its payload. An answer names only the
 * question it answers, which names the thread it was asked in, so its task is the one whose
 * conversation that thread is, read the way the task's status reads it: the person's own mapping,
 * the person's own task, and the question's channel when it names one. An approval's resume names
 * only the approval, which names the thread its turn stopped in, and its task is found the same way.
 * An answer or an approval anywhere else is in no task, and runs as it always has.
 *
 * A turn stopped for Allow once has finished, so without the resume in the order a reply sent before
 * the person allowed it could run after the resume, or one sent after it before, and the resume
 * carries on from the conversation as it was when the turn stopped.
 *
 * Each kind has the attempt cap its worker claims at: a task's turn runs `TASK_RUNS` times, an
 * answer once, and a resume as many times as the queue's default allows.
 */
export const TASK_TURN_ORDER: SerialOrder = {
  name: PROACTIVE_TASK_KIND,
  kinds: {
    [PROACTIVE_TASK_KIND]: TASK_RUNS,
    [PERSON_RESPONSE_KIND]: 1,
    [APPROVAL_RESUME_KIND]: DEFAULT_MAX_ATTEMPTS,
  },
  groupOf: (row) => sql`case when ${row}.kind = ${PERSON_RESPONSE_KIND} then (
      select task.id from "bot_tasks" as task
      inner join "intelligence_channel_mappings" as mapping
        on mapping.channel_id = task.channel_id
      where task.owner_user_id = ${row}.payload->>'ownerUserId'
        and mapping.user_id = task.owner_user_id
        and ${row}.payload->'question'->>'actorId' = task.owner_user_id
        and mapping.thread_id = ${row}.payload->'question'->>'threadId'
        and (${row}.payload->'question'->>'channelId' is null
          or ${row}.payload->'question'->>'channelId' = task.channel_id)
    ) when ${row}.kind = ${APPROVAL_RESUME_KIND} then (
      select task.id from "approval_requests" as approval
      inner join "intelligence_channel_mappings" as mapping
        on mapping.user_id = approval.owner_user_id
        and mapping.thread_id = approval.action->>'threadId'
      inner join "bot_tasks" as task
        on task.channel_id = mapping.channel_id
        and task.owner_user_id = approval.owner_user_id
      where approval.id = ${row}.payload->>'approvalId'
        and approval.owner_user_id = ${row}.payload->>'ownerUserId'
    ) else ${row}.payload->>'taskId' end`,
};

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

/**
 * The longest a task's turn may take, start to finish, before it is given up on. The turn runner
 * stops the model's run at five minutes (`TURN_LIMITS.turnTimeoutMs`), but not the steps around it:
 * reading the conversation, taking its lock, giving the lock back. One of those never answering
 * kept the turn's lease renewing for as long as it waited, so the task read Working for a quarter
 * of an hour. Seven minutes leaves room for the runner's own stop and its wind-down.
 */
export const TASK_TURN_MS = 7 * 60_000;

/**
 * A task's turn ran past `TASK_TURN_MS`. Its message names the limit in the words `plainFailure`
 * reads ("stopped after Ns"), so the task says it took too long rather than that it was cut off.
 */
export class TaskTurnTimeoutError extends Error {
  override name = "TaskTurnTimeoutError";
  constructor(limitMs: number) {
    super(`The task's turn was stopped after ${Math.round(limitMs / 1000)}s.`);
  }
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

/** How long a kept reply tail may be. A next step is one line on the task list. */
const REPLY_TAIL_MAX = 240;
/** A last sentence shorter than this is kept with the one before it. */
const SHORT_SENTENCE = 20;

/** A paragraph that is a list: every line of it is an item. */
const LIST_ITEM = /^\s*(?:[-*+•]|\d+[.)])\s+/;
/** A paragraph that is something the Bot drafted for the person, not what it says to them. */
const DRAFT =
  /^\s*(?:>|```|["“'‘]|\*{0,2}_{0,2}(?:draft|subject|to|dear|hi|hello)\b[^\n]{0,40}?:)/i;
/**
 * A line that says where the reply came from: "Source: …", "**Sources:**", "References -". A Bot
 * closes on one because it is asked to cite what it read, and it is a footnote, not where things
 * stand: shown as the next step it read "Source: Requests, request r-oneone." over "I couldn't send".
 */
const FOOTNOTE = /^(?:sources?|references?|citations?)\s*[:：\-–]/i;
/** What can trail a question and still leave it one: closing quotes, brackets, emoji, spaces. */
const TRAILING = /(?:[\s"”'’)\]}»\p{Extended_Pictographic}]|️|‍)+$/u;

/**
 * A closing sentence that only says nothing waits on the person. It reports no work, and it would
 * stand on Tasks as the next step of a finished task, so it is set aside. Matched whole, so a
 * finding such as "Nothing in your inbox needs a reply from you" is kept.
 */
const NOTHING_WAITING = [
  /^(?:there(?:'s|’s| is) )?nothing(?: else)?(?: is| 's|’s)? (?:waiting on|waiting for|needed from|required from|needs|pending (?:on|from)) you(?: right now| now| for now| at the moment)?[.!]?$/i,
  /^no (?:further |other )?(?:action|input) (?:is )?(?:needed|required)(?: from you)?(?: right now| now| for now)?[.!]?$/i,
  /^you don['’]t need to do anything(?: else)?(?: right now| now| for now)?[.!]?$/i,
];
const waitsOnNothing = (sentence: string) =>
  NOTHING_WAITING.some((pattern) => pattern.test(sentence));

/** Whether a sentence asks something, once what trails its question mark is set aside. */
const asksIn = (sentence: string) =>
  sentence.replace(TRAILING, "").endsWith("?");

const plain = (line: string) =>
  line
    .replace(/^\s*(?:[-*+>•]|#{1,6}|\d+[.)])\s+/, "")
    .replace(/[*_`]+/g, "")
    .trim();

/**
 * What the Bot says to the person in a reply, as the sentences of each paragraph it writes to them.
 * Lists and drafts that close a reply are what it prepared, not what it says, and a line citing its
 * source is a footnote to it, so they are set aside, and so is a sentence that only says nothing
 * waits on the person. With nothing else to read, the reply's last paragraph is kept, less any such
 * sentence. `spoken` is false then.
 */
function spokenParagraphs(reply: string | null | undefined): {
  paragraphs: string[][];
  spoken: boolean;
} {
  const paragraphs = (reply ?? "")
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => /[\p{L}\p{N}]/u.test(paragraph));
  const spoken = paragraphs
    .filter((paragraph) => {
      const lines = paragraph.split("\n").filter((line) => line.trim());
      return !(
        lines.every((line) => LIST_ITEM.test(line)) ||
        DRAFT.test(paragraph) ||
        // "Sources:" and the list under it.
        (lines[0] !== undefined && footnote(lines[0]))
      );
    })
    .map((paragraph) =>
      sentencesOf(paragraph).filter((sentence) => !waitsOnNothing(sentence)),
    )
    .filter((sentences) => sentences.length > 0);
  if (spoken.length) return { paragraphs: spoken, spoken: true };
  const last = sentencesOf(paragraphs.at(-1)).filter(
    (sentence) => !waitsOnNothing(sentence),
  );
  return { paragraphs: last.length ? [last] : [], spoken: false };
}

const footnote = (line: string) => FOOTNOTE.test(plain(line));

function sentencesOf(paragraph: string | undefined): string[] {
  return (paragraph ?? "")
    .split("\n")
    .filter((line) => !footnote(line))
    .map(plain)
    .flatMap((line) => line.split(/(?<=[.!?][\s"”'’)\]]*)\s+(?=\S)/))
    .map((sentence) => sentence.trim())
    .filter((sentence) => /[\p{L}\p{N}]/u.test(sentence));
}

/**
 * How a reply ends: the sentence to show as the task's next step, and whether it asks the person
 * something.
 *
 * A Bot ends a turn on what comes next, in the last paragraph it writes to the person
 * (`spokenParagraphs`). Within that last paragraph its last question is the next step, even with a
 * remark after it; without one, its last sentence is. A short closing sentence keeps the one before
 * it, so "Do you want me to?" never stands alone. Null when there is nothing to say.
 */
export function replyEnding(reply: string | null | undefined): {
  tail: string | null;
  asks: boolean;
} {
  const { paragraphs, spoken } = spokenParagraphs(reply);
  const sentences = paragraphs.at(-1) ?? [];
  const question = sentences.findLastIndex(asksIn);
  const at = question >= 0 ? question : sentences.length - 1;
  const chosen = sentences[at];
  if (!chosen) return { tail: null, asks: false };
  // A paragraph of its own still leans on the paragraph before it.
  const before = sentences[at - 1] ?? paragraphs.at(-2)?.at(-1);
  const sentence =
    chosen.length < SHORT_SENTENCE && before ? `${before} ${chosen}` : chosen;
  return {
    tail:
      sentence.length > REPLY_TAIL_MAX
        ? `${Array.from(sentence)
            .slice(0, REPLY_TAIL_MAX - 1)
            .join("")}…`
        : sentence,
    asks: spoken && question >= 0,
  };
}

/**
 * The reply's conclusion: the whole last paragraph the Bot wrote to the person, on one line. A
 * reply often opens on a preamble ("Here's a thoughtful plan") and ends on what was done or found,
 * so this, not its first sentence, is what a task's report says the turn did. Null when there is
 * nothing to say.
 */
export function replyConclusion(
  reply: string | null | undefined,
): string | null {
  return spokenParagraphs(reply).paragraphs.at(-1)?.join(" ") || null;
}

/** The sentence `replyEnding` would show, alone. */
export function replyTail(reply: string | null | undefined): string | null {
  return replyEnding(reply).tail;
}

/**
 * A task the person marked done has no next step of the Bot's: what it said last is about the work,
 * and a closing question there would read as still waiting on them. Tasks shows when from
 * `resolvedAt`.
 */
export const MARKED_DONE = "Marked done by you";

/** How long a question the Bot asked may run as a task's next step. */
const QUOTE_MAX = 120;

/**
 * A task's next step, from the last line said in its conversation: the Bot's own words, where they
 * leave things (`replyTail`). Never the person's: shown back to them as the next step, their own
 * message read as the task's outcome while it was Ready for review, and said nothing about what the
 * Bot did with it. A task whose last line is theirs shows its status alone until the Bot answers.
 */
export function nextStepOf(
  said: string | null | undefined,
  byBot: boolean,
): string | null {
  const text = said?.trim();
  if (!text || !byBot) return null;
  return replyTail(text);
}

/**
 * What a task waiting on the person waits for, as its next step: the action its Bot asked to take,
 * in the words its approval card uses in the conversation, or the question it asked. Never the last
 * line said there, which while it waits is as often the person's own message as anything the Bot
 * wrote, and says nothing about what they are being asked for.
 */
export function waitingLine(
  waiting:
    | { kind: "approval"; toolRef: string; scope: string; handOff: boolean }
    | { kind: "question"; question: string },
): string {
  if (waiting.kind === "question") {
    const words = Array.from(waiting.question.trim());
    return `Waiting for your answer: ${words.length > QUOTE_MAX ? `${words.slice(0, QUOTE_MAX - 1).join("")}…` : words.join("")}`;
  }
  const { action, place } = approvalWords(waiting);
  return `${waiting.handOff ? "This needs you" : "Waiting for your approval"}: ${action} on ${place}`;
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
  /** The person's replies still waiting their turn, oldest first. */
  queuedReplies: { messageId: string; text: string }[];
  /** Questions a reply the person sent answers, from the moment it was taken. */
  answeredQuestionIds: Set<string>;
};

/**
 * How a task's turn ended, kept on its work item as `ending` when it finishes: the id its reply was
 * recorded under in the task's conversation, and whether that reply, read whole, asked the person
 * something. The conversation keeps only a short line of the reply, where a long closing question
 * loses its question mark.
 */
export type TaskTurnEnding = { messageId: string; asks: boolean };

function endingOf(value: unknown): TaskTurnEnding | null {
  const ending = value as Partial<TaskTurnEnding> | null | undefined;
  return typeof ending?.messageId === "string" &&
    ending.messageId &&
    typeof ending.asks === "boolean"
    ? { messageId: ending.messageId, asks: ending.asks }
    : null;
}

/** A JSON field of a work item's payload, as text. */
const payload = (field: string) => sql<string>`${workItems.payload}->>${field}`;
/*
 * The same expressions as `work_items_owner_task_idx`, so the reads use it however their statement
 * is planned. Through `payload` the field is a parameter, which a plan made once for every value
 * cannot match to the index. See work.ts.
 */
const workOwner = sql<string>`(${workItems.payload}->>'ownerUserId')`;
const turnTask = sql<string>`(${workItems.payload}->>'taskId')`;
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
        queuedReplies: [],
        answeredQuestionIds: new Set<string>(),
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
        // Said after the person's "done", or never marked done.
        afterResolution: sql<boolean>`coalesce(${channels.lastMessageAt} > ${botTasks.resolvedAt}, true)`,
      })
      .from(channels)
      .innerJoin(botTasks, eq(botTasks.channelId, channels.id))
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
  /** What each task waits on the person for, the newest if more than one: its next step. */
  const waitingFor = new Map<TaskState, { at: Date; line: string }>();
  const waitsFor = (
    channelId: string | null | undefined,
    at: Date,
    line: string,
  ) => {
    const entry = entryOfChannel(channelId);
    if (!entry) return;
    entry.needsInput = true;
    const known = waitingFor.get(entry);
    if (!known || at > known.at) waitingFor.set(entry, { at, line });
  };

  const taskIds = rows.map((row) => row.id);
  const [approvals, questions, turns, carriedOn] = await Promise.all([
    // Waiting on the person: an action its turn paused on for Allow once.
    database
      .select({
        threadId: approvalThread,
        toolRef: sql<string>`${approvalRequests.action}->>'toolRef'`,
        scope: sql<string>`${approvalRequests.action}->>'scope'`,
        handOff: sql<boolean>`coalesce(${approvalRequests.action}->'policy'->>'behaviour' = 'hand_off', false)`,
        createdAt: approvalRequests.createdAt,
      })
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
        key: workItems.key,
        channelId: payload("channelId"),
        threadId: payload("threadId"),
        question: payload("question"),
        createdAt: workItems.createdAt,
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
        reply: payload("reply"),
        followup: payload("followup"),
        questionIds: sql<string[] | null>`${workItems.payload}->'questionIds'`,
        messageId: payload("messageId"),
      })
      .from(workItems)
      .innerJoin(botTasks, eq(botTasks.id, turnTask))
      .where(
        and(
          eq(workItems.kind, PROACTIVE_TASK_KIND),
          // Every task turn names the person it runs as: the index's first two columns.
          eq(workOwner, owner),
          inArray(turnTask, taskIds),
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
            eq(workOwner, owner),
            inThreads(answeredThread),
            sql`(${workItems.attempts} < ${DEFAULT_MAX_ATTEMPTS} or ${workItems.leaseUntil} > now())`,
          ),
        ),
    ]).then(([resuming, answering]) => [...resuming, ...answering]),
  ]);
  for (const row of approvals)
    waitsFor(
      channelOfThread.get(row.threadId),
      row.createdAt,
      waitingLine({
        kind: "approval",
        toolRef: row.toolRef ?? "",
        scope: row.scope ?? "",
        handOff: row.handOff,
      }),
    );

  // Whether a turn's reply asked, read whole as it finished, by the id it was recorded under.
  const replyAsks = new Map<string, boolean>();
  for (const turn of turns) {
    const ending = endingOf(turn.input?.ending);
    if (ending) replyAsks.set(ending.messageId, ending.asks);
    const entry = state.get(turn.taskId);
    if (!entry) continue;
    /*
     * A reply answers the questions waiting when it was taken, from that moment, even if its turn
     * later fails: the person said what they had to say.
     */
    if (turn.followup === "true")
      for (const id of turn.questionIds ?? [])
        entry.answeredQuestionIds.add(id);
    // Taken and not yet running, with its turn still to come: waiting behind another.
    if (
      turn.reply &&
      turn.messageId &&
      !turn.finished &&
      !turn.live &&
      turn.attempts < TASK_RUNS
    )
      entry.queuedReplies.unshift({
        messageId: turn.messageId,
        text: turn.reply,
      });
  }
  for (const question of questions) {
    const channelId =
      question.channelId ?? channelOfThread.get(question.threadId ?? "");
    if (entryOfChannel(channelId)?.answeredQuestionIds.has(question.key))
      continue;
    waitsFor(
      channelId,
      question.createdAt,
      waitingLine({ kind: "question", question: question.question ?? "" }),
    );
  }

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
    // The Bot's own last words; the person's, the ask a turn starts on included, are never shown.
    if (said) entry.next = nextStepOf(said.lastMessage, said.byBot);
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
  for (const row of rows) {
    const entry = state.get(row.id);
    const said = saidIn.get(row.channelId);
    if (!entry || !said?.byBot) continue;
    /*
     * The Bot ended on a question: the task waits on the person's answer. The line its conversation
     * keeps is cut short, so a long closing question loses its question mark there; a task's turn
     * says whether its reply asked (`TaskTurnEnding`). Anything else said there, and a reply from a
     * turn that never said, is read from the line.
     */
    const asks =
      replyAsks.get(said.sourceId ?? "") ?? replyEnding(said.lastMessage).asks;
    if (
      asks &&
      !entry.working &&
      !entry.failure &&
      !entry.resolvedAt &&
      // Work after the "done" must not bring back a closing question the person put away.
      said.afterResolution
    )
      entry.needsInput = true;
  }
  for (const [entry, waiting] of waitingFor) entry.next = waiting.line;
  return state;
}
