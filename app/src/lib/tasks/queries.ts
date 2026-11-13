import { queryOptions } from "@tanstack/react-query";
import type { Reaction } from "@/lib/api/generated/model";
import { listReactions } from "@/lib/api/generated/reactions/reactions";
import { ORGANIZATION_ID } from "@/lib/api/request";
import { client } from "@/lib/client";

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
  /** One line on what comes next, from the last thing said in its conversation. */
  next: string | null;
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export const taskKeys = {
  all: ["tasks"] as const,
  list: ["tasks", "list"] as const,
  one: (id: string) => ["tasks", "one", id] as const,
  reactions: (threadId: string) => ["tasks", "reactions", threadId] as const,
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
export const taskListQueryOptions = () =>
  queryOptions({
    queryKey: taskKeys.list,
    queryFn: (): Promise<BotTask[]> =>
      client("/api/tasks", "tasks", { fallback: "Couldn't load your tasks" }),
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
    queryFn: (): Promise<BotTask> =>
      client(`/api/tasks/${encodeURIComponent(id)}`, "task", {
        fallback: "Couldn't load this task",
      }),
    refetchInterval: (query) =>
      query.state.data && moving(query.state.data.status) ? LIVE_MS : false,
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
          ORGANIZATION_ID,
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
