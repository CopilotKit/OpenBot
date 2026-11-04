import type { TurnRunner } from "@openbot/toolkit/run-turn";

/**
 * Carries on a turn that waited on the person: Allow once, an answer to a question card, a sign-in.
 * One in a task's own conversation is that task's turn, so it is built as a task's turn is
 * (`taskTurn`), and its Bot is not offered `start_task` there (tasks/tools.ts). Anywhere else it is
 * built as `otherwise` builds it.
 */
export function createContinuationRunner(deps: {
  isTaskThread: (ownerUserId: string, threadId: string) => Promise<boolean>;
  taskTurn: TurnRunner;
  otherwise: TurnRunner;
}): TurnRunner {
  return async (input) =>
    (await deps.isTaskThread(input.ownerUserId, input.threadId))
      ? deps.taskTurn(input)
      : deps.otherwise(input);
}
