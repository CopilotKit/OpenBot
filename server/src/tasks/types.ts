/** How a task began: asked for, or started from one of the Bot's suggestions. */
export type TaskOrigin = "asked" | "suggestion";

/**
 * How many times a task's turn runs: once, and once more when the first run threw or a restart cut
 * it off. The queue's attempt cap for the turn's kind, so a turn out of runs stays on the queue
 * unfinished with its count and its reason, which is what reads as `failed` (tasks/store.ts).
 */
export const TASK_RUNS = 2;

/**
 * Where a task stands, worked out on every read, first match wins:
 * - `needs_input`: an approval or a question in its conversation waits on the person;
 * - `working`: its turn is queued, running, or due its one retry, or an answered approval or question
 *   is being carried on;
 * - `resolved`: the person marked it done;
 * - `failed`: its turn ran out of runs without finishing, and nothing has happened in its
 *   conversation since;
 * - `ready_for_review`: its turn finished and wrote a reply.
 */
export type TaskStatus =
  | "needs_input"
  | "working"
  | "resolved"
  | "failed"
  | "ready_for_review";

/** A task as the person reads it. */
export type TaskRecord = {
  id: string;
  botId: string;
  /** The task's own conversation. */
  channelId: string;
  /**
   * That conversation's thread, which an approval or a question raised in it names. Null when the
   * conversation is gone.
   */
  threadId: string | null;
  title: string;
  why: string | null;
  origin: TaskOrigin;
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
   * The run's own next step, one line, for Tasks: the last sentence or question of the Bot's newest
   * words in its conversation, or the person's own words in quotes while their reply is being
   * worked on. Null before anything has been said there.
   */
  next: string | null;
  /** The person's replies still waiting their turn, oldest first. */
  queuedReplies: { messageId: string; text: string }[];
  /** Questions the person already answered in accepted replies, even if their turns failed. */
  answeredQuestionIds: string[];
  /** Null once durable work accepted after the person's last completion supersedes it. */
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export class TaskNotFoundError extends Error {
  constructor() {
    super("Couldn't find that task.");
    this.name = "TaskNotFoundError";
  }
}
