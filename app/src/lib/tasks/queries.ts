import { queryOptions } from "@tanstack/react-query";
import type { Reaction, Task, TaskTurn } from "@/lib/api/generated/model";
import { listReactions } from "@/lib/api/generated/reactions/reactions";
import {
  getTask,
  listTasks,
  listTaskTurns,
} from "@/lib/api/generated/tasks/tasks";
import { organizationId } from "@/lib/api/request";

/*
 * The person's tasks: what Start makes of an item a Bot's check-in found. Each runs in a conversation
 * of its own, as the person's own turn, so every send or change it makes meets the approval gate.
 *
 * `status` is the server's word, worked out on every read from the work queue, the approval inbox and
 * the questions its Bot asked, never stored (server/src/tasks). The app adds one thing the server
 * cannot see: a turn running in the person's own browser, from the conversation's live busy signal.
 */

/**
 * Where a task stands. First match wins, in this order: an approval or a question in its
 * conversation waits on the person; its turn is queued or running; the person marked it done; its
 * turn ran out of runs; its Bot replied.
 */
export type TaskStatus =
  | "needs_input"
  | "working"
  | "resolved"
  | "failed"
  | "ready_for_review";

export type BotTask = {
  id: string;
  agentId: string;
  /** The task's own conversation, where the person reads it and replies. */
  channelId: string;
  /** That conversation's thread, which its approvals and questions name. Null once it is gone. */
  threadId: string | null;
  title: string;
  why: string | null;
  /** A check-in's item the person started, or work a Bot handed out of a conversation. */
  origin: "check_in" | "delegated";
  suggestionId: string | null;
  sourceApp: string | null;
  sourceLink: string | null;
  /** The conversation a delegated task was asked for in, where its result is said. */
  originChannelId: string | null;
  status: TaskStatus;
  /** Why its turn couldn't finish, in plain words, while `failed`. Null otherwise. */
  failure: string | null;
  failedAt: string | null;
  /**
   * When the person stopped its run. Its status is `failed` while this is set, and its card reads
   * Stopped. Null once it carries on.
   */
  stoppedAt?: string | null;
  /**
   * False when trying it again can't change how it ends: it couldn't finish for a reason asking
   * again gets the same answer to (a Bot it asked isn't shared with the person). Absent from a
   * server that does not say, which reads as true.
   */
  canTryAgain?: boolean;
  /** One line on what comes next, from the last thing said in its conversation. */
  next: string | null;
  /** When the work it is doing now began, for how long it has been working. Null unless working. */
  workingSince?: string | null;
  /**
   * When its turn will next be tried, while it waits to try again after a failure that passes (a
   * rate limit, a service that did not answer). Null or absent when it is not waiting.
   */
  tryingAgainAt?: string | null;
  /** When it last did something: a step of its work, or a line said in its conversation. */
  lastActivityAt?: string;
  resolvedAt: string | null;
  /**
   * The agent doing the work, when the Bot handed it to one of the agents it may use. Null for a
   * task the Bot does itself; absent from a server that does not name it. An agent private to
   * somebody else is named "Private agent".
   */
  agent?: { id: string; name: string } | null;
  /** The latest thing the person told it directly in its conversation, unasked. See `TaskSteer`. */
  steer?: { text: string; at: string } | null;
  createdAt: string;
  updatedAt: string;
};

export const taskKeys = {
  all: ["tasks"] as const,
  list: ["tasks", "list"] as const,
  /** Every task read on its own, whichever it is: what a card in a conversation reads. */
  ones: ["tasks", "one"] as const,
  one: (id: string) => ["tasks", "one", id] as const,
  reactions: (threadId: string) => ["tasks", "reactions", threadId] as const,
  turns: (id: string) => ["tasks", "turns", id] as const,
};

/** A Bot's reaction to one of the person's messages, in place of a line of its own. */
export type { Reaction };

/** Something is moving: read again soon. Otherwise only now and then, for a change made elsewhere. */
const LIVE_MS = 3_000;
const QUIET_MS = 30_000;
const moving = (status: TaskStatus) =>
  status === "working" || status === "needs_input";

/**
 * Every open task of the person's, and the ones marked done in the last 7 days, kept live while any
 * of them is under way.
 */
/**
 * A task as the API answers it, in the names the app's screens use: the API calls a task's Bot
 * `botId` and its conversation `conversationId`.
 */
export function botTaskOf({
  botId,
  conversationId,
  originConversationId,
  ...rest
}: Task): BotTask {
  return {
    ...rest,
    agentId: botId,
    channelId: conversationId,
    originChannelId: originConversationId,
  };
}

export const taskListQueryOptions = () =>
  queryOptions({
    queryKey: taskKeys.list,
    queryFn: async (): Promise<BotTask[]> => {
      const tasks: BotTask[] = [];
      const seen = new Set<string>();
      let cursor: string | undefined;
      // Read to the end; a cursor handed back twice ends the list too.
      do {
        const page = await listTasks(
          organizationId(),
          { limit: 100, ...(cursor ? { cursor } : {}) },
          { fallback: "Couldn't load your tasks" },
        );
        tasks.push(...page.tasks.map(botTaskOf));
        if (cursor) seen.add(cursor);
        cursor = page.nextCursor ?? undefined;
      } while (cursor && !seen.has(cursor));
      return tasks;
    },
    refetchInterval: (query) =>
      query.state.data?.some((task) => moving(task.status))
        ? LIVE_MS
        : QUIET_MS,
  });

/**
 * One task, as its card in the conversation that asked for it reads it: kept live while it works or
 * waits on the person, and left alone once it is done or couldn't finish.
 */
export const taskQueryOptions = (id: string) =>
  queryOptions({
    queryKey: taskKeys.one(id),
    queryFn: async (): Promise<BotTask> =>
      botTaskOf(
        (
          await getTask(organizationId(), id, {
            fallback: "Couldn't load this task",
          })
        ).task,
      ),
    refetchInterval: (query) =>
      query.state.data && moving(query.state.data.status) ? LIVE_MS : false,
  });

/** One finished turn of a task: what it answered, how long it worked, and which model answered. */
export type { TaskTurn };

/**
 * How long a task worked on each thing it was asked, oldest first. A turn is listed once it ends,
 * so while one is under way, or has just ended and is not listed yet, it is read again soon
 * (`live`); otherwise only when something asks.
 */
export const taskTurnsQueryOptions = (id: string, live = false) =>
  queryOptions({
    queryKey: taskKeys.turns(id),
    queryFn: async (): Promise<TaskTurn[]> => {
      const turns: TaskTurn[] = [];
      const seen = new Set<string>();
      let cursor: string | undefined;
      // Read to the end; a cursor handed back twice ends the list too.
      do {
        const page = await listTaskTurns(
          organizationId(),
          id,
          { limit: 100, ...(cursor ? { cursor } : {}) },
          { fallback: "Couldn't load how long this task worked." },
        );
        turns.push(...page.turns);
        if (cursor) seen.add(cursor);
        cursor = page.nextCursor ?? undefined;
      } while (cursor && !seen.has(cursor));
      return turns;
    },
    refetchInterval: live ? LIVE_MS : false,
  });

/**
 * The reactions a Bot left in one of the person's conversations, by its thread. Read again when a
 * turn there ends, which is when a new one can appear.
 */
export const reactionsQueryOptions = (threadId: string) =>
  queryOptions({
    queryKey: taskKeys.reactions(threadId),
    queryFn: async (): Promise<Reaction[]> => {
      const reactions: Reaction[] = [];
      const seen = new Set<string>();
      let cursor: string | undefined;
      // Read to the end; a cursor handed back twice ends the list too.
      do {
        const page = await listReactions(
          organizationId(),
          { threadId, limit: 100, ...(cursor ? { cursor } : {}) },
          { fallback: "Couldn't load reactions." },
        );
        reactions.push(...page.reactions);
        if (cursor) seen.add(cursor);
        cursor = page.nextCursor ?? undefined;
      } while (cursor && !seen.has(cursor));
      return reactions;
    },
    staleTime: 10_000,
  });

/**
 * Where a task stands right now. A reply the person typed in the task's conversation runs in their
 * browser, which the server cannot see; the conversation's working dot can, so it counts as Working
 * too. Waiting on the person still comes first.
 */
export function liveStatus(status: TaskStatus, busy: boolean): TaskStatus {
  return busy && status !== "needs_input" ? "working" : status;
}

/** Each status in a word or two, as a row says it. */
export const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  ready_for_review: "Ready for review",
  needs_input: "Needs input",
  failed: "Failed",
  working: "Working",
  resolved: "Resolved",
};

/** What a failed task says after its status: "Couldn't finish: <reason>." */
export function couldNotFinish(failure: string | null): string {
  return failure ? `Couldn't finish: ${failure}.` : "Couldn't finish.";
}

/**
 * A task that couldn't finish, in a word or two: what its card in the conversation says, and its
 * row on the Needs you board, so the two never name one state twice.
 */
export const TASK_FAILED_LABEL = "Couldn't finish";

/**
 * Why a task couldn't finish, as a line of its own after a status that already says so: a
 * sentence. The server words its reason to follow "Couldn't finish:" ("Pipeline Bot isn't shared
 * with you"), so on its own it starts in capitals and ends with a full stop.
 */
export function failureSentence(failure: string): string {
  const said = failure.trim();
  if (!said) return said;
  const sentence = `${said[0]?.toUpperCase()}${said.slice(1)}`;
  return /[.!?]$/.test(sentence) ? sentence : `${sentence}.`;
}

/**
 * Whether Try again is offered: only on a task that couldn't finish, and not on one the server says
 * asking again can't change, which would only be refused the same way again.
 */
export function canTryAgain(task: {
  status: TaskStatus;
  canTryAgain?: boolean;
}): boolean {
  return task.status === "failed" && task.canTryAgain !== false;
}

/**
 * Whether the person stopped this task. Its status is `failed` either way, and only a stop sets
 * `stoppedAt`. A stop is the person's own choice, so nothing that lists the task calls it a failure.
 */
export function stoppedByYou(
  task: { status?: TaskStatus; stoppedAt?: string | null } | undefined,
): boolean {
  return task?.status === "failed" && Boolean(task.stoppedAt);
}

/**
 * A finished task's status in a word, on its card and on its row under Done on a Bot's Activity
 * page. One name for one state: a row under Done never reads "Ready for review".
 */
export const TASK_DONE_LABEL = "Done";

/** A stopped task's status in a word, on its card and on every row that lists it. */
export const TASK_STOPPED_LABEL = "Stopped";

/** What a stopped task says after its status. Stopping never undoes what was already done. */
export const TASK_STOPPED =
  "You stopped this. Anything it had already done stays done.";
