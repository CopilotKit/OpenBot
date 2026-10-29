import type { DurableTaskReply } from "@openbot/shared/task-reply";
import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { client } from "@/lib/client";
import { channelKeys } from "@/lib/channels/queries";
import { type TaskRecord, taskKeys } from "./queries";

/** What the + on Tasks sends: which Bot, and the ask in the person's words. */
export type TaskInput = { botId: string; instruction: string; title?: string };

/** The sentence for every write here, since they all fail the same way to a reader. */
const FALLBACK = "Couldn't save that change to the task. Try again.";

const taskPath = (id: string, action: string) =>
  `/api/tasks/${encodeURIComponent(id)}/${action}`;

/**
 * Server-derived fields are invalidated, never patched. The conversation list goes too: a task's
 * conversation is in it, and starting or rerunning a turn is what lights its working dot.
 */
function invalidateTasks(queryClient: QueryClient) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: taskKeys.all }),
    queryClient.invalidateQueries({ queryKey: channelKeys.list() }),
  ]);
}

/** The + on Tasks: the ask opens a task in a conversation of its own, and its turn starts there. */
export function startTaskMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (input: TaskInput): Promise<TaskRecord> =>
      client("/api/tasks", "task", {
        method: "POST",
        body: input,
        fallback: FALLBACK,
      }),
    onSuccess: () => invalidateTasks(queryClient),
  });
}

/** Mark a task done, or reopen one marked done. Its conversation stays either way. */
export function resolveTaskMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (variables: {
      id: string;
      done: boolean;
    }): Promise<TaskRecord> =>
      client(
        taskPath(variables.id, variables.done ? "resolve" : "reopen"),
        "task",
        { method: "POST", fallback: FALLBACK },
      ),
    onSuccess: () => invalidateTasks(queryClient),
  });
}

/**
 * Try again: a task that couldn't finish runs its turn once more, in its own conversation. A reply
 * typed on the failed task goes with it, beside the ask, under the id its bubble is drawn with.
 */
export function tryTaskAgainMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (variables: {
      id: string;
      reply?: string;
      messageId?: string;
    }): Promise<TaskRecord> =>
      client(taskPath(variables.id, "again"), "task", {
        method: "POST",
        body: {
          ...(variables.reply ? { reply: variables.reply } : {}),
          ...(variables.messageId ? { messageId: variables.messageId } : {}),
        },
        fallback: FALLBACK,
      }),
    onSuccess: () => invalidateTasks(queryClient),
  });
}

/**
 * A reply that steers the task. Taken durably by the server before the composer clears, and run
 * after whatever is running or queued in the task, so the page need not stay open for it.
 */
export function replyToTaskMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: ({
      id,
      ...reply
    }: { id: string } & DurableTaskReply): Promise<TaskRecord> =>
      client(taskPath(id, "reply"), "task", {
        method: "POST",
        body: reply,
        fallback: FALLBACK,
      }),
    onSuccess: () => invalidateTasks(queryClient),
  });
}
