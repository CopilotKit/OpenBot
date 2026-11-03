import { TASK_ENDING, TASK_FRAME } from "@openbot/shared/task-brief";
import type { TaskReplyContext } from "@openbot/shared/task-reply";
import { HeadlessToolSuspension } from "@openbot/toolkit/headless-tools";
import {
  isThreadAlreadyRunning,
  ThreadLockBusyError,
} from "@openbot/toolkit/lease";
import {
  HEADLESS_WAITING_FALLBACK,
  type TurnRunner,
} from "@openbot/toolkit/run-turn";
import type { AgentActor } from "../agents/profile-types";
import { PERSON_INITIATOR } from "../audit";
import type { ChannelStore } from "../channels/routes";
import type { TaskReplyContextReader } from "./reply-context";
import {
  ASK_LINE,
  FAILED_LINE,
  plainFailure,
  replyEnding,
  type TaskTurnEnding,
  TaskTurnTimeoutError,
} from "./state";

/** What the model is told `TASK_FRAME` is, in its context. */
export const TASK_FRAME_DESCRIPTION = "This conversation is a task";
/** What the model is told `TASK_ENDING` is, in its context. Never "Selected skill". */
export const TASK_ENDING_DESCRIPTION = "How to end your reply in this task";

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
  /**
   * The id the ask is drawn under: its message in the conversation, and its line. The same for a
   * retry of the turn as for its first run, so a retry carries on the ask already there instead of
   * putting it in the conversation, and in front of the model, a second time.
   */
  askId: string;
  /** The person's ask, or their reply, as their message in the conversation. */
  text: string;
  signal: AbortSignal;
  final: boolean;
} & TaskReplyContext;

/** Answers how its reply ended, when it wrote one: kept on the turn's work item. */
export type TaskTurn = (
  scope: TaskScope,
  input: TaskTurnInput,
) => Promise<TaskTurnEnding | undefined>;

/**
 * What a task's conversation says while its turn waits on the person. The line becomes the task's
 * next step on Tasks, so a turn stopped with no words of its own is named for what it waits on,
 * never by the toolkit's "The turn is waiting for human input."
 */
function waitingLine(suspension: HeadlessToolSuspension): string {
  if (suspension.message !== HEADLESS_WAITING_FALLBACK)
    return suspension.message;
  return suspension.waiting.kind === "approval"
    ? "Waiting for you to allow a step."
    : "Waiting for your answer.";
}

/**
 * A task's turn: the person's ask as their message in the task's conversation, a person-started turn
 * through the runner every started piece of work uses, and the Bot's reply recorded, which is what
 * tells an open conversation to read the thread again.
 *
 * THE PERSON'S OWN TURN. It runs under `PERSON_INITIATOR` through the approval continuation runner,
 * so every send or change the Bot tries meets the approval gate, as it would had the person typed
 * the ask themselves, with one difference: in a task's conversation the gate asks before EVERY
 * step, whatever the person's "Ask before making changes" or their rules would allow, because the
 * work began with something a Bot noticed rather than something they wrote out. The one thing it
 * does unasked is read an app the person connected with their own account, with a tool a reviewed
 * read list names (`reviewedRead` in plugins/catalogue.ts). The gate knows a task's conversation by
 * its thread (`asksEveryChange` in approvals/store.ts), so the turn an approval carries on, and the
 * person replying there, ask the same way.
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
 * conversation does not end on the person's ask with nothing after it. A turn refused the
 * conversation's lock on its first ask, or refused by the runner while a run before it winds down,
 * never ran, and is put back on the queue without a word. A turn the runner stopped for taking too
 * long says so (`TaskTurnTimeoutError`), not that it was cancelled.
 *
 * TOLD IT IS A TASK. The frame (`TASK_FRAME`) and how to end its reply (`TASK_ENDING`) go to the model
 * as instructions of their own, named for what they are, never in the person's message, so the
 * conversation shows the ask in their words. A reply's files and skills are read and checked again
 * as it runs, so a grant taken away while it waited is not used.
 */
export function createTaskTurn(deps: {
  channels: Pick<ChannelStore, "recordActivity" | "signalBusy">;
  actorFor: (ownerUserId: string) => Promise<AgentActor>;
  /**
   * The runner a task's own turns use: the approval continuation runner's, with the Bot built for a
   * task's turn, so a write the Bot tries is held for the person and `start_task` is not offered.
   */
  runTurn: TurnRunner;
  /** Resolves a reply's files and skills. Absent, a reply with either fails. */
  replyContext?: Pick<TaskReplyContextReader, "resolve">;
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
    await record(
      input.text || "Sent attachments",
      null,
      `${input.askId}${ASK_LINE}`,
    );
    await deps.channels.signalBusy(scope.threadId, true).catch(() => {});
    try {
      const context =
        input.attachmentIds?.length || input.skillIds?.length
          ? await (deps.replyContext?.resolve(scope, input) ??
              Promise.reject(
                new Error("Files and skills are unavailable for this task."),
              ))
          : { attachments: [], skillInstructions: [] };
      const content = context.attachments.length
        ? [
            ...(input.text
              ? [{ type: "text" as const, text: input.text }]
              : []),
            ...context.attachments,
          ]
        : input.text;
      const result = await deps.runTurn({
        ...scope,
        routineId: input.runId,
        telemetry: {
          trigger: "human",
          surface: "web",
          rootTaskId: input.askId,
        },
        instruction: input.text,
        userMessage: { id: input.askId, role: "user", content },
        systemMessages: [
          // One id each for every turn of the task, so its conversation holds them once.
          {
            id: "task:frame",
            role: "system" as const,
            content: TASK_FRAME.join("\n"),
            description: TASK_FRAME_DESCRIPTION,
          },
          {
            id: "task:ending",
            role: "system" as const,
            content: TASK_ENDING,
            description: TASK_ENDING_DESCRIPTION,
          },
          ...context.skillInstructions.map((instructions, index) => ({
            id: `${input.runId}:skill:${index}`,
            role: "system" as const,
            content: instructions,
          })),
        ],
        initiator: PERSON_INITIATOR,
        signal: input.signal,
      });
      /*
       * Recorded as how the reply ends, its next step, not how it starts: the task list shows this
       * line after the task's status (`TaskPayload.next`), and the conversation keeps only its
       * first 200 characters, which for a long reply would be its opening, not where it leaves
       * things.
       *
       * Whether it asks is read here, from the whole reply, and answered for the turn's work item:
       * the line recorded is cut short, and a long closing question loses its question mark there.
       */
      if (result.replyText) {
        const ending = replyEnding(result.replyText);
        const messageId = `${input.runId}:reply`;
        await record(ending.tail ?? result.replyText, scope.agentId, messageId);
        return { messageId, asks: ending.asks };
      }
      return undefined;
    } catch (error) {
      if (!(error instanceof HeadlessToolSuspension)) {
        const busy =
          error instanceof ThreadLockBusyError || isThreadAlreadyRunning(error);
        // Stopped by the runner's time limit, the turn says only that it was cancelled.
        const reason =
          input.signal.reason instanceof TaskTurnTimeoutError
            ? input.signal.reason
            : error;
        if (input.final && !busy)
          await record(
            `I couldn't finish this: ${plainFailure(reason instanceof Error ? reason.message : String(reason))}.`,
            scope.agentId,
            `${input.runId}${FAILED_LINE}`,
          ).catch(() => {});
        throw error;
      }
      await record(waitingLine(error), scope.agentId, `${input.runId}:waiting`);
      return undefined;
    } finally {
      await deps.channels.signalBusy(scope.threadId, false).catch(() => {});
    }
  };
}
