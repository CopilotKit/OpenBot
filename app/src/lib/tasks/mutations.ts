import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { botLifecycleKeys } from "@/lib/bot-lifecycle/queries";
import {
  reopenTask,
  resolveTask,
  retryTask,
} from "@/lib/api/generated/tasks/tasks";
import { idempotencyKey, ORGANIZATION_ID } from "@/lib/api/request";
import { type BotTask, botTaskOf, taskKeys } from "./queries";

/** A key for one write, so a retry of it is recognised as the same write. */
const once = () => ({ "Idempotency-Key": idempotencyKey() });

/** A task's state moves the sidebar's badge as well as the lists, so both are read again. */
function invalidateTasks(queryClient: QueryClient) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: taskKeys.all }),
    queryClient.invalidateQueries({ queryKey: botLifecycleKeys.attention }),
  ]);
}

/** Mark a task done, or reopen one marked done. Its conversation stays either way. */
export const resolveTaskMutationOptions = (queryClient: QueryClient) =>
  mutationOptions({
    mutationFn: async ({
      id,
      done,
    }: {
      id: string;
      done: boolean;
    }): Promise<BotTask> =>
      botTaskOf(
        (
          await (done ? resolveTask : reopenTask)(ORGANIZATION_ID, id, once(), {
            fallback: done
              ? "Couldn't mark this task done. Try again."
              : "Couldn't reopen this task. Try again.",
          })
        ).task,
      ),
    onSuccess: () => invalidateTasks(queryClient),
  });

/**
 * Try again: a task that couldn't finish runs its turn once more, in its own conversation. The server
 * keys the run on the turn count, so pressing it twice runs it once.
 */
export const tryTaskAgainMutationOptions = (queryClient: QueryClient) =>
  mutationOptions({
    mutationFn: async (id: string): Promise<BotTask> =>
      botTaskOf(
        (
          await retryTask(ORGANIZATION_ID, id, once(), {
            fallback: "Couldn't run this task again. Try again in a moment.",
          })
        ).task,
      ),
    onSuccess: () => invalidateTasks(queryClient),
  });
