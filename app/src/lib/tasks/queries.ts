import { queryOptions } from "@tanstack/react-query";
import { client } from "@/lib/client";

/*
 * The person's tasks: background work one Bot does in a conversation of its own
 * (server/src/tasks/store.ts), so their Chat stays one thread. Chat draws a card for each one a Bot
 * starts, Tasks lists them, and a task's page is its conversation with a report above it.
 *
 * `status` is the server's word, worked out on every read from what the task's conversation is doing:
 * its turn queued or running, an approval or a question waiting on the person, its turn out of runs
 * without finishing, or the person's own Mark done. Nothing here recomputes it.
 */

export type TaskStatus =
  | "needs_input"
  | "working"
  | "resolved"
  | "failed"
  | "ready_for_review";

export type TaskRecord = {
  id: string;
  botId: string;
  /** The task's own conversation. */
  channelId: string;
  /** That conversation's thread, which its approvals and questions name. Null once it is gone. */
  threadId: string | null;
  title: string;
  why: string | null;
  origin: "asked" | "suggestion";
  suggestionId: string | null;
  sourceApp: string | null;
  sourceLink: string | null;
  status: TaskStatus;
  /**
   * Why its turn couldn't finish, in plain words, while it is `failed`, or marked done after failing.
   * Null otherwise.
   */
  failure: string | null;
  /** When it failed, alongside `failure`. */
  failedAt: string | null;
  /**
   * The run's own next step, one line: the last sentence or question of the Bot's newest words, or
   * the person's reply in quotes while it is worked on. Null before anything was said.
   */
  next: string | null;
  /** Replies the server took and has not started yet, oldest first. */
  queuedReplies: { messageId: string; text: string }[];
  /** Questions already answered by an accepted reply, including one whose turn failed. */
  answeredQuestionIds: string[];
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export const taskKeys = {
  all: ["tasks"] as const,
  list: () => ["tasks", "list"] as const,
  detail: (id: string) => ["tasks", "detail", id] as const,
  report: (id: string) => ["tasks", "report", id] as const,
};

/**
 * A task at work: read again soon. Otherwise only now and then, for a change made elsewhere.
 *
 * Waiting on the person is not at work. The sidebar keeps the list mounted on every screen, and a
 * task can wait all day. An answer given here reads the tasks again at once (`lib/approvals.ts`),
 * and one given elsewhere arrives with the next read.
 */
const LIVE_MS = 3_000;
const QUIET_MS = 30_000;
const moving = (status: TaskStatus | undefined) => status === "working";

/** Every task of the person's, newest first, kept live while any of them is at work. */
export const taskListQueryOptions = () =>
  queryOptions({
    queryKey: taskKeys.list(),
    queryFn: (): Promise<TaskRecord[]> =>
      client("/api/tasks", "tasks", {
        fallback: "Couldn't load your tasks.",
      }),
    refetchInterval: (query) =>
      query.state.data?.some((task) => moving(task.status))
        ? LIVE_MS
        : QUIET_MS,
  });

/** One task, kept live while it is at work. */
export const taskQueryOptions = (id: string) =>
  queryOptions({
    queryKey: taskKeys.detail(id),
    queryFn: (): Promise<TaskRecord> =>
      client(`/api/tasks/${encodeURIComponent(id)}`, "task", {
        fallback: "Couldn't open this task.",
      }),
    refetchInterval: (query) =>
      moving(query.state.data?.status) ? LIVE_MS : QUIET_MS,
  });

/**
 * Where a task stands right now. The roster's working dot sees a turn the moment it starts, before
 * the next read of the task does, so a busy conversation reads Working. Waiting on the person still
 * comes first.
 */
export function liveStatus(status: TaskStatus, busy: boolean): TaskStatus {
  return busy && status !== "needs_input" ? "working" : status;
}

/** Each status in a word or two, on a row, a card and the task's own page. */
export const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  needs_input: "Needs you",
  working: "Working",
  failed: "Failed",
  ready_for_review: "Ready for review",
  resolved: "Done",
};

/** Why a task couldn't finish, as its row and its page say it. */
export function couldNotFinish(failure: string | null): string {
  return failure ? `Couldn't finish: ${failure}.` : "Couldn't finish.";
}

/*
 * A task's report, as `GET /api/tasks/:id/report` works it out from the task's conversation
 * (server/src/tasks/report.ts): what the person decided, the Bot's updates and the person's replies,
 * in the order they happened. A time is null where no ledger saw that moment.
 */

/** Something the person decided in the task's conversation, by the approval it answered. */
export type ReportDecision = {
  kind: "decision";
  id: string;
  decision: "allow_once" | "allow_always" | "deny" | "handled";
  by: "you";
  at: string | null;
  /** What was asked about, in the approval inbox's shape, so it is named the way the inbox names it. */
  action: {
    toolRef: string;
    effect: string;
    scope: string;
    args: unknown;
    target?: unknown;
  };
};

export type ReportEntry =
  | ReportDecision
  | { kind: "reply"; id: string; text: string; at: string | null }
  | { kind: "update"; id: string; text: string; at: string | null };

export type TaskReport = { taskId: string; entries: ReportEntry[] };

/**
 * One task's report, read again while the task is at work, as the task itself is. `status` is the
 * task's own, passed in so the report keeps pace with the page it is on.
 */
export const taskReportQueryOptions = (id: string, status?: TaskStatus) =>
  queryOptions({
    queryKey: taskKeys.report(id),
    queryFn: (): Promise<TaskReport> =>
      client(`/api/tasks/${encodeURIComponent(id)}/report`, "report", {
        fallback: "Couldn't load this task's report.",
      }),
    refetchInterval: moving(status) ? LIVE_MS : QUIET_MS,
  });
