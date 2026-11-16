import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import {
  reopenTask,
  resolveTask,
  retryTask,
  stopTask,
} from "@/lib/api/generated/tasks/tasks";
import { idempotencyKey, organizationId } from "@/lib/api/request";
import { botLifecycleKeys } from "@/lib/bot-lifecycle/queries";
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
          await (done ? resolveTask : reopenTask)(
            organizationId(),
            id,
            once(),
            {
              fallback: done
                ? "Couldn't mark this task done. Try again."
                : "Couldn't reopen this task. Try again.",
            },
          )
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
          await retryTask(organizationId(), id, once(), {
            fallback: "Couldn't run this task again. Try again in a moment.",
          })
        ).task,
      ),
    onSuccess: () => invalidateTasks(queryClient),
  });

/**
 * Stop: the task's work stops as Stop in its thread stops it, and the steps it finished stay done.
 * The answer is the task as it stands once the stop landed, so its card and row read Stopped at
 * once, before the lists are read again.
 */
export const stopTaskMutationOptions = (queryClient: QueryClient) =>
  mutationOptions({
    mutationFn: async (id: string): Promise<BotTask> =>
      botTaskOf(
        (
          await stopTask(organizationId(), id, once(), {
            fallback: "Couldn't stop this task. Try again.",
          })
        ).task,
      ),
    onSuccess: (task) => {
      queryClient.setQueryData(taskKeys.one(task.id), task);
      return invalidateTasks(queryClient);
    },
  });
