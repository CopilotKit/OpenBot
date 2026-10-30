import { queryOptions } from "@tanstack/react-query";
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
  origin: "check_in";
  suggestionId: string | null;
  sourceApp: string | null;
  sourceLink: string | null;
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
};

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
