import { readTaskBrief, readTaskFrame } from "@openbot/shared/task-brief";
import { historyOrEmpty } from "@openbot/toolkit/thread-history";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { approvalRequests, channels, workItems } from "../db/schema";
import { PROACTIVE_TASK_KIND, taskExecutionId } from "../proactive/engine";
import { replyConclusion } from "./reply-ending";
import type { TaskRecord } from "./types";

/*
 * A task's report: what was decided in it and what it said, worked out from what its conversation
 * already holds. Nothing here is stored.
 *
 * WHERE EACH PART COMES FROM.
 * - The conversation is read from Intelligence, as the runtime holds it. Its messages carry no
 *   times, so a time comes from whichever ledger saw that moment, or there is none.
 * - Decisions are the approval inbox's: Allowed once, Always allowed or Refused, by the person, at
 *   `decidedAt`. Each sits where the conversation carried it on (the `approval:<id>` message the
 *   resume writes), or after the call it was asked about.
 * - The ask is the person's, as the task's first message carries it under its frame
 *   (`readTaskBrief`), or as its first turn was queued with when the conversation can't be read.
 * - The why is a suggestion's own reason, kept on the task when it was started. An asked task has
 *   none here: the person's words are its ask, and a why the Bot wrote for one could be its own
 *   reasoning about making a task.
 * - Updates are each finished turn's conclusion: the last paragraph the Bot wrote to the person
 *   (`replyConclusion`), since a reply often opens on a preamble. A turn ends when the Bot's work item finishes (the task's first turn, a turn carried on after an
 *   approval), when it pauses to ask for approval, or, for the latest turn, at the conversation's
 *   last message.
 * - The person's replies are their own messages after the ask that opened the task.
 */

/** A message as Intelligence keeps it. Only the fields the report reads. */
export type ReportMessage = {
  id: string;
  role: string;
  content?: unknown;
  toolCalls?: { id: string; name: string; args: string }[];
  toolCallId?: string;
};

/** An approval asked in the task's conversation, as the inbox holds it. */
export type ReportApproval = {
  id: string;
  toolCallId: string;
  status: string;
  decision: string | null;
  createdAt: Date;
  decidedAt: Date | null;
  completedAt: Date | null;
  action: {
    toolRef: string;
    effect: string;
    scope: string;
    args: unknown;
    target?: unknown;
  };
};

export type ReportDecision = {
  kind: "decision";
  id: string;
  decision: "allow_once" | "allow_always" | "deny" | "handled";
  /** Always the person: a task's approvals are asked of the person it belongs to. */
  by: "you";
  at: string | null;
  /** What was asked about, in the inbox's shape, so the app names it the way the inbox does. */
  action: ReportApproval["action"];
};
export type ReportReply = {
  kind: "reply";
  id: string;
  text: string;
  at: string | null;
};
export type ReportUpdate = {
  kind: "update";
  id: string;
  text: string;
  at: string | null;
};
export type ReportEntry = ReportDecision | ReportReply | ReportUpdate;

export type TaskReport = {
  taskId: string;
  /** What the person asked for, in their words. */
  ask: string;
  /** The suggestion's own reason it matters. Only on a task started from a suggestion that gave one. */
  why?: string;
  /**
   * True when the conversation couldn't be read in time: the ask is the one the task was queued
   * with, and the entries hold only the decisions.
   */
  partial: boolean;
  /** In the order they happened in the conversation. */
  entries: ReportEntry[];
};

/** What the report is built from, read beforehand so the building can be tested without a database. */
export type ReportInput = {
  task: Pick<TaskRecord, "id" | "status" | "title" | "origin" | "why">;
  messages: readonly ReportMessage[];
  /** The conversation couldn't be read in time, so `messages` is empty. */
  partial?: boolean;
  /** The instruction the task's first turn was queued with, for when its conversation holds no ask. */
  instruction?: string | null;
  approvals: readonly ReportApproval[];
  /** When the task's first turn finished, from its work item. */
  firstTurnEndedAt: Date | null;
  /** When the turn carried on after each approval finished, from the resume's work item. */
  resumedEndedAt: ReadonlyMap<string, Date>;
  /** The conversation's last message, from its channel. */
  lastMessageAt: Date | null;
  /** Transcript openers whose particular execution finished, even while later work waits. */
  completedTurnIds?: ReadonlySet<string>;
  /** Accepted question answers, keyed by their original response message ID, without model context. */
  questionResponses?: ReadonlyMap<string, string>;
};

const DECISIONS = new Set(["allow_once", "allow_always", "deny", "handled"]);

/** How long a reply gets before it is cut at a word. */
const LINE_LENGTH = 160;
/** How long an update gets: a conclusion runs to a sentence or two. */
const UPDATE_LENGTH = 280;

/** A message's text: a string, or the text parts of structured content. */
export function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      part &&
      typeof part === "object" &&
      (part as { type?: unknown }).type === "text" &&
      typeof (part as { text?: unknown }).text === "string"
        ? (part as { text: string }).text
        : "",
    )
    .filter(Boolean)
    .join("\n");
}

/** Markdown's marks taken off a line, so a sentence reads as words. */
function plain(line: string): string {
  return line
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__|`)/g, "")
    .replace(/(^|\s)[*_](\S[^*_]*\S|\S)[*_](?=\s|$|[.,;:!?])/g, "$1$2")
    .replace(/\s+/g, " ")
    .trim();
}

/** Cut at a word with an ellipsis past `length`. */
function capped(text: string, length = LINE_LENGTH): string {
  if (text.length <= length) return text;
  const cut = text.slice(0, length);
  const space = cut.lastIndexOf(" ");
  return `${(space > length / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:.-]+$/, "")}…`;
}

/**
 * What a turn did, from the Bot's last words in it: their conclusion (`replyConclusion`), without
 * markdown, on one line, cut at a word past `UPDATE_LENGTH`.
 */
export function updateText(text: string): string {
  return capped(plain(replyConclusion(text) ?? ""), UPDATE_LENGTH);
}

/** The person's words, on one line. */
function said(text: string): string {
  return capped(text.split("\n").map(plain).filter(Boolean).join(" "));
}

const asString = (value: unknown): string =>
  typeof value === "string" ? value : "";

type Turn = {
  id: string;
  /** What opened it: the task's ask or replay, the person's reply, or an approval carried on from. */
  opener:
    | { kind: "brief" }
    | { kind: "reply"; id: string; text: string }
    | { kind: "resume"; approvalId: string };
  messages: ReportMessage[];
};

const RESUME_PREFIX = "approval:";

/** The conversation as turns: each opened by the ask, a reply, or an approval carried on from. */
function turnsOf(
  messages: readonly ReportMessage[],
  questionResponses: ReportInput["questionResponses"],
): Turn[] {
  const turns: Turn[] = [];
  const acceptedInputs = new Set<string>();
  for (const message of messages) {
    if (message.role === "user") {
      const text = textOf(message.content);
      const frame = readTaskFrame(text);
      // New execution IDs still open outcome turns, but only accepted input adds a human reply.
      const replay =
        frame?.inputId !== undefined && acceptedInputs.has(frame.inputId);
      if (frame?.inputId) acceptedInputs.add(frame.inputId);
      // Question-card answers predate task frames. Their stable message ID is also the accepted
      // input ID carried by Try again, so replay adds an outcome without another human answer.
      else if (message.id.startsWith("person-response:"))
        acceptedInputs.add(message.id);
      turns.push({
        id: message.id,
        opener:
          frame?.kind === "brief" || replay
            ? { kind: "brief" }
            : {
                kind: "reply",
                id: message.id,
                // The ledger preserves the literal answer even if the question or answer quotes
                // framing syntax. Never split the generated question wrapper to recover it.
                text: questionResponses?.get(message.id) ?? frame?.text ?? text,
              },
        messages: [],
      });
      continue;
    }
    if (message.role === "tool" && message.id.startsWith(RESUME_PREFIX)) {
      turns.push({
        id: message.id,
        opener: {
          kind: "resume",
          approvalId: message.id.slice(RESUME_PREFIX.length),
        },
        messages: [message],
      });
      continue;
    }
    if (message.role !== "assistant" && message.role !== "tool") continue;
    const current = turns.at(-1);
    if (current) current.messages.push(message);
    // Anything before the first user message (a seeded greeting) opens a turn of its own.
    else
      turns.push({
        id: message.id,
        opener: { kind: "brief" },
        messages: [message],
      });
  }
  return turns;
}

const iso = (at: Date | null | undefined) => (at ? at.toISOString() : null);

/** The report, from what was read. Pure, so every rule above is tested without a database. */
export function buildTaskReport(input: ReportInput): TaskReport {
  const approvalsByCall = new Map(
    input.approvals.map((approval) => [approval.toolCallId, approval]),
  );
  const approvalsById = new Map(
    input.approvals.map((approval) => [approval.id, approval]),
  );
  const decided = (approval: ReportApproval | undefined) =>
    approval?.decision && DECISIONS.has(approval.decision) ? approval : null;
  const decisionEntry = (approval: ReportApproval): ReportDecision => ({
    kind: "decision",
    id: approval.id,
    decision: approval.decision as ReportDecision["decision"],
    by: "you",
    at: iso(approval.decidedAt),
    action: {
      toolRef: approval.action.toolRef,
      effect: approval.action.effect,
      scope: approval.action.scope,
      args: approval.action.args,
      ...(approval.action.target === undefined
        ? {}
        : { target: approval.action.target }),
    },
  });

  const turns = turnsOf(input.messages, input.questionResponses);
  const entries: ReportEntry[] = [];
  const placed = new Set<string>();
  turns.forEach((turn, index) => {
    const last = index === turns.length - 1;
    if (turn.opener.kind === "reply") {
      const text = said(turn.opener.text);
      if (text)
        entries.push({
          kind: "reply",
          id: turn.opener.id,
          text,
          at: null,
        });
    }
    if (turn.opener.kind === "resume") {
      const approval = decided(approvalsById.get(turn.opener.approvalId));
      if (approval && !placed.has(approval.id)) {
        placed.add(approval.id);
        entries.push(decisionEntry(approval));
      }
    }

    // The approvals this turn stopped to ask for: it ended when it asked.
    const asked = turn.messages
      .flatMap((message) => message.toolCalls ?? [])
      .map((call) => approvalsByCall.get(call.id))
      .filter((approval): approval is ReportApproval => approval !== undefined);
    const reply = turn.messages.findLast(
      (message) =>
        message.role === "assistant" && textOf(message.content).trim() !== "",
    );
    // Working includes future queued work. Keep a known completed execution's update, while
    // still excluding the latest turn when its own completion has not reached the ledger.
    const finished =
      !(last && input.task.status === "working") ||
      input.completedTurnIds?.has(turn.id);
    if (reply && finished) {
      const text = updateText(textOf(reply.content));
      const endedAt =
        asked[0]?.createdAt ??
        (turn.opener.kind === "brief" && index === 0
          ? input.firstTurnEndedAt
          : turn.opener.kind === "resume"
            ? (input.resumedEndedAt.get(turn.opener.approvalId) ??
              approvalsById.get(turn.opener.approvalId)?.completedAt ??
              null)
            : null) ??
        (last ? input.lastMessageAt : null);
      if (text)
        entries.push({ kind: "update", id: reply.id, text, at: iso(endedAt) });
    }

    // A decision the conversation has not carried on from yet sits after the call it was about.
    for (const approval of asked) {
      const answered = decided(approval);
      if (answered && !placed.has(answered.id)) {
        placed.add(answered.id);
        entries.push(decisionEntry(answered));
      }
    }
  });
  // Decided in this conversation but on a call its history no longer holds: last, in time order.
  for (const approval of [...input.approvals].sort(
    (a, b) => (a.decidedAt?.getTime() ?? 0) - (b.decidedAt?.getTime() ?? 0),
  )) {
    const answered = decided(approval);
    if (answered && !placed.has(answered.id)) {
      placed.add(answered.id);
      entries.push(decisionEntry(answered));
    }
  }
  return {
    taskId: input.task.id,
    ask: askOf(input),
    ...(input.task.origin === "suggestion" && input.task.why
      ? { why: input.task.why }
      : {}),
    partial: input.partial ?? false,
    entries,
  };
}

/**
 * The person's ask: the first message framed as the task's brief, read back without its frame. A
 * reply or a correction is not the ask. Without one, the instruction its first turn was queued with,
 * and last of all its title.
 */
function askOf(input: ReportInput): string {
  for (const message of input.messages) {
    if (message.role !== "user") continue;
    const text = textOf(message.content);
    if (readTaskFrame(text)?.kind !== "brief") continue;
    const ask = readTaskBrief(text)?.trim();
    if (ask) return ask;
  }
  return input.instruction?.trim() || input.task.title;
}

/** Reads a thread's messages for its owner. Index.ts gives it Intelligence's client. */
export type ReportHistory = (input: {
  threadId: string;
  ownerUserId: string;
}) => Promise<readonly ReportMessage[]>;

export type TaskReportReader = (
  ownerUserId: string,
  task: TaskRecord,
) => Promise<TaskReport>;

/** The history reader over an Intelligence client: a thread it has never heard of has no messages. */
export function intelligenceHistory(client: {
  getThreadMessages(params: {
    threadId: string;
    userId: string;
  }): Promise<{ messages: ReportMessage[] }>;
}): ReportHistory {
  return async ({ threadId, ownerUserId }) =>
    (
      await historyOrEmpty(
        () => client.getThreadMessages({ threadId, userId: ownerUserId }),
        { messages: [] },
      )
    ).messages;
}

/** How long the report waits for the conversation before it answers without it. */
export const HISTORY_TIMEOUT_MS = 8_000;

/** The conversation, or null when it isn't read within `ms`. A read that fails still throws. */
async function historyWithin(
  read: Promise<readonly ReportMessage[]>,
  ms: number,
): Promise<readonly ReportMessage[] | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  try {
    return await Promise.race([read, late]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * `GET /api/tasks/:id/report`'s reader: the ledgers, then `buildTaskReport`.
 *
 * NEVER HANGS ON THE CONVERSATION. Intelligence holds it, and a read that never answers would hold
 * the task page's report with it. Past `historyTimeoutMs` the report is built without it, marked
 * `partial`, from the ledgers alone.
 */
export function createTaskReportReader(deps: {
  database: Database;
  history: ReportHistory;
  /** See `HISTORY_TIMEOUT_MS`. Tests pass less. */
  historyTimeoutMs?: number;
}): TaskReportReader {
  return async (ownerUserId, task) => {
    if (!task.threadId)
      return buildTaskReport({
        task,
        messages: [],
        approvals: [],
        firstTurnEndedAt: null,
        resumedEndedAt: new Map(),
        lastMessageAt: null,
      });
    const threadId = task.threadId;
    const [history, rows, turns, channel, answers] = await Promise.all([
      historyWithin(
        deps.history({ threadId, ownerUserId }),
        deps.historyTimeoutMs ?? HISTORY_TIMEOUT_MS,
      ),
      deps.database
        .select({
          id: approvalRequests.id,
          toolCallId: approvalRequests.toolCallId,
          status: approvalRequests.status,
          decision: approvalRequests.decision,
          createdAt: approvalRequests.createdAt,
          decidedAt: approvalRequests.decidedAt,
          completedAt: approvalRequests.completedAt,
          action: approvalRequests.action,
        })
        .from(approvalRequests)
        .where(
          and(
            eq(approvalRequests.ownerUserId, ownerUserId),
            sql`${approvalRequests.action}->>'threadId' = ${threadId}`,
          ),
        ),
      deps.database
        .select({
          key: workItems.key,
          attempts: workItems.attempts,
          payload: workItems.payload,
          finishedAt: workItems.finishedAt,
        })
        .from(workItems)
        .where(
          and(
            eq(workItems.kind, PROACTIVE_TASK_KIND),
            sql`${workItems.payload}->>'taskId' = ${task.id}`,
            sql`${workItems.payload}->>'ownerUserId' = ${ownerUserId}`,
          ),
        )
        .orderBy(workItems.createdAt),
      deps.database
        .select({ lastMessageAt: channels.lastMessageAt })
        .from(channels)
        .where(eq(channels.id, task.channelId))
        .limit(1),
      deps.database
        .select({
          key: workItems.key,
          payload: workItems.payload,
          finishedAt: workItems.finishedAt,
        })
        .from(workItems)
        .where(
          and(
            eq(workItems.kind, "person.response"),
            sql`${workItems.payload}->>'ownerUserId' = ${ownerUserId}`,
            sql`${workItems.payload}->'question'->>'actorId' = ${ownerUserId}`,
            sql`${workItems.payload}->'question'->>'threadId' = ${threadId}`,
            sql`(${workItems.payload}->'question'->>'channelId' is null
              or ${workItems.payload}->'question'->>'channelId' = ${task.channelId})`,
          ),
        ),
    ]);
    const approvals: ReportApproval[] = rows.map((row) => ({
      id: row.id,
      toolCallId: row.toolCallId,
      status: row.status,
      decision: row.decision,
      createdAt: row.createdAt,
      decidedAt: row.decidedAt,
      completedAt: row.completedAt,
      action: {
        toolRef: row.action.toolRef,
        effect: row.action.effect,
        scope: row.action.scope,
        args: row.action.args,
        ...(row.action.target === undefined
          ? {}
          : { target: row.action.target }),
      },
    }));
    const resumed =
      approvals.length === 0
        ? []
        : await deps.database
            .select({ key: workItems.key, finishedAt: workItems.finishedAt })
            .from(workItems)
            .where(
              and(
                eq(workItems.kind, "approval.resume"),
                inArray(
                  workItems.key,
                  approvals.map((approval) => approval.id),
                ),
              ),
            );
    if (history === null)
      console.error(
        JSON.stringify({
          type: "task-report-history-timeout",
          timestamp: new Date().toISOString(),
        }),
      );
    // The ask its first own turn was queued with: a reply or a Try again carries other words.
    const first = turns.find(
      (row) => row.payload.followup !== true && row.payload.again !== true,
    );
    return buildTaskReport({
      task,
      messages: history ?? [],
      partial: history === null,
      instruction: asString(first?.payload.text) || null,
      approvals,
      firstTurnEndedAt: turns[0]?.finishedAt ?? null,
      resumedEndedAt: new Map(
        resumed.flatMap((row) =>
          row.finishedAt ? [[row.key, row.finishedAt] as const] : [],
        ),
      ),
      lastMessageAt: channel[0]?.lastMessageAt ?? null,
      completedTurnIds: new Set([
        ...turns.flatMap((row) =>
          row.finishedAt && row.attempts > 0
            ? [
                taskExecutionId({
                  taskId: task.id,
                  workKey: row.key,
                  attempt: row.attempts,
                  messageId: asString(row.payload.messageId) || undefined,
                  again: row.payload.again === true,
                }),
              ]
            : [],
        ),
        ...resumed.flatMap((row) =>
          row.finishedAt ? [`${RESUME_PREFIX}${row.key}`] : [],
        ),
        ...answers.flatMap((row) =>
          row.finishedAt ? [`person-response:${row.key}`] : [],
        ),
      ]),
      questionResponses: new Map(
        answers.flatMap((row) =>
          typeof row.payload.response === "string"
            ? [[`person-response:${row.key}`, row.payload.response] as const]
            : [],
        ),
      ),
    });
  };
}
