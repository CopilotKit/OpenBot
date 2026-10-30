import { HeadlessToolSuspension } from "@openbot/toolkit/headless-tools";
import type { TurnRunner } from "@openbot/toolkit/run-turn";
import type { AgentActor } from "../agents/profile-types";
import { PERSON_INITIATOR } from "../audit";
import type { ChannelStore } from "../channels/routes";
import { ASK_LINE, FAILED_LINE, plainFailure, replyTail } from "./state";

/** A task's conversation, as its turn runs in it. */
export type TaskScope = {
  ownerUserId: string;
  channelId: string;
  agentId: string;
  threadId: string;
};

/** One run of a task's turn. `final` is its last: if it fails, the task has failed. */
export type TaskTurnInput = {
  runId: string;
  /** The person's ask, as their message in the conversation. */
  text: string;
  signal: AbortSignal;
  final: boolean;
};

export type TaskTurn = (
  scope: TaskScope,
  input: TaskTurnInput,
) => Promise<void>;

/**
 * A task's turn: the person's ask as their message in the task's conversation, a person-started turn
 * through the runner every started piece of work uses, and the Bot's reply recorded, which is what
 * tells an open conversation to read the thread again.
 *
 * THE PERSON'S OWN TURN. It runs under `PERSON_INITIATOR` through the approval continuation runner,
 * so every send or change the Bot tries meets the approval gate exactly as it would had the person
 * typed the ask themselves.
 *
 * The conversation's working dot is lit while it runs, since no browser streams this turn.
 *
 * STOPPING FOR THE PERSON IS NOT FAILING. A turn that reaches Allow once, or asks a question, ends
 * with the request waiting on them; answering it carries the turn on (approvals/resume-sweep.ts). So
 * it is recorded as the Bot's line and the turn is done, not thrown as an error the queue would log
 * and retry.
 *
 * FAILING ON ITS LAST RUN IS SAID. A turn that throws is thrown on, for the queue to hold and retry.
 * On its last run (`final`) the Bot's line says it couldn't finish and why, in plain words, so the
 * conversation does not end on the person's ask with nothing after it.
 */
export function createTaskTurn(deps: {
  channels: Pick<ChannelStore, "recordActivity" | "signalBusy">;
  actorFor: (ownerUserId: string) => Promise<AgentActor>;
  /** The approval continuation runner, so a write the Bot tries is held for the person. */
  runTurn: TurnRunner;
}): TaskTurn {
  return async (scope, input) => {
    const actor = await deps.actorFor(scope.ownerUserId);
    const record = (text: string, agentId: string | null, id: string) =>
      deps.channels.recordActivity(
        actor,
        scope.channelId,
        { text, agentId, at: new Date() },
        { id },
      );
    await record(input.text, null, `${input.runId}${ASK_LINE}`);
    await deps.channels.signalBusy(scope.threadId, true).catch(() => {});
    try {
      const result = await deps.runTurn({
        ...scope,
        routineId: input.runId,
        instruction: input.text,
        userMessage: { id: input.runId, role: "user", content: input.text },
        initiator: PERSON_INITIATOR,
        signal: input.signal,
      });
      /*
       * Recorded as how the reply ends, its next step, not how it starts: the task list shows this
       * line after the task's status (`TaskPayload.next`), and the conversation keeps only its
       * first 200 characters, which for a long reply would be its opening, not where it leaves
       * things.
       */
      if (result.replyText)
        await record(
          replyTail(result.replyText) ?? result.replyText,
          scope.agentId,
          `${input.runId}:reply`,
        );
    } catch (error) {
      if (!(error instanceof HeadlessToolSuspension)) {
        if (input.final)
          await record(
            `I couldn't finish this: ${plainFailure(error instanceof Error ? error.message : String(error))}.`,
            scope.agentId,
            `${input.runId}${FAILED_LINE}`,
          ).catch(() => {});
        throw error;
      }
      await record(error.message, scope.agentId, `${input.runId}:waiting`);
    } finally {
      await deps.channels.signalBusy(scope.threadId, false).catch(() => {});
    }
  };
}
