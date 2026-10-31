import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { botLifecycleKeys } from "@/lib/bot-lifecycle/queries";
import { client } from "@/lib/client";
import { type BotTask, taskKeys } from "./queries";

/** A task's state moves the sidebar's badge as well as the lists, so both are read again. */
function invalidateTasks(queryClient: QueryClient) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: taskKeys.all }),
    queryClient.invalidateQueries({ queryKey: botLifecycleKeys.attention }),
  ]);
}

const taskPath = (id: string) => `/api/tasks/${encodeURIComponent(id)}`;

/** Mark a task done, or reopen one marked done. Its conversation stays either way. */
export const resolveTaskMutationOptions = (queryClient: QueryClient) =>
  mutationOptions({
    mutationFn: ({ id, done }: { id: string; done: boolean }) =>
      client<BotTask>(
        `${taskPath(id)}/${done ? "resolve" : "reopen"}`,
        "task",
        {
          method: "POST",
          fallback: done
            ? "Couldn't mark this task done. Try again."
            : "Couldn't reopen this task. Try again.",
        },
      ),
    onSuccess: () => invalidateTasks(queryClient),
  });

/**
 * Try again: a task that couldn't finish runs its turn once more, in its own conversation. The server
 * keys the run on the turn count, so pressing it twice runs it once.
 */
export const tryTaskAgainMutationOptions = (queryClient: QueryClient) =>
  mutationOptions({
    mutationFn: (id: string) =>
      client<BotTask>(`${taskPath(id)}/again`, "task", {
        method: "POST",
        fallback: "Couldn't run this task again. Try again in a moment.",
      }),
    onSuccess: () => invalidateTasks(queryClient),
  });
