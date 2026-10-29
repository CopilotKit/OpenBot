import {
  frameTaskInput,
  readTaskBrief,
  TASK_ENDING,
} from "@openbot/shared/task-brief";
import { HeadlessToolSuspension } from "@openbot/toolkit/headless-tools";
import { ThreadLockBusyError } from "@openbot/toolkit/lease";
import {
  HEADLESS_WAITING_FALLBACK,
  type TurnRunner,
} from "@openbot/toolkit/run-turn";
import type { AgentActor } from "../agents/profile-types";
import { PERSON_INITIATOR } from "../audit";
import type { ChannelStore } from "../channels/routes";
import type { Database } from "../db/client";
import type {
  ProactiveEngineDeps,
  ProactiveScope,
  TaskThreads,
  TaskTurnEnding,
} from "../proactive/engine";
import type { TaskReplyContextReader } from "./reply-context";
import { replyEnding } from "./reply-ending";
import { plainFailure, type TaskStore } from "./store";

/*
 * The two halves of a task the proactive engine leaves to the server's assembly: making its
 * conversation, and running its turn there.
 */

/**
 * Opens a task in a new conversation with the Bot, and finds that conversation again to run it.
 *
 * A NEW CONVERSATION EVERY TIME, never the person's own with the Bot, so the work stays out of the
 * conversation it was asked in. The channel store leaves task conversations out when it looks for
 * that one (`direct`), and the roster marks them (`taskId`), so the app never mistakes one for the
 * person's own.
 */
export function createTaskThreads(deps: {
  database: Pick<Database, "transaction">;
  store: Pick<
    TaskStore,
    "create" | "locate" | "failedTurn" | "pendingQuestions" | "answerQuestions"
  >;
  channels: Pick<ChannelStore, "create" | "signalBusy">;
  actorFor: (ownerUserId: string) => Promise<AgentActor>;
  /** The conversation as a turn needs it, or null once the person cannot reach it or its Bot. */
  scopeFor: (
    ownerUserId: string,
    channelId: string,
    agentId: string,
  ) => Promise<ProactiveScope | null>;
}): TaskThreads {
  async function scope(ownerUserId: string, taskId: string) {
    const task = await deps.store.locate(ownerUserId, taskId);
    return task ? deps.scopeFor(ownerUserId, task.channelId, task.botId) : null;
  }
  return {
    pendingQuestions: (ownerUserId, taskId) =>
      deps.store.pendingQuestions(ownerUserId, taskId),
    answerQuestions: (ownerUserId, ids) =>
      deps.store.answerQuestions(ownerUserId, ids),
    async open(input) {
      const actor = await deps.actorFor(input.ownerUserId);
      /*
       * One transaction for both. `direct` tells a task's conversation by its task row, so a
       * conversation committed before its row could be taken for the person's own with the Bot by a
       * lookup that ran in between.
       */
      return deps.database.transaction(async (transaction) => {
        const channel = await deps.channels.create(
          actor,
          [input.agentId],
          transaction,
        );
        const task = await deps.store.create(
          {
            ownerUserId: input.ownerUserId,
            botId: input.agentId,
            channelId: channel.id,
            title: input.title,
            why: input.why,
            origin: input.origin,
            suggestionId: input.suggestionId,
            sourceApp: input.sourceApp,
            sourceLink: input.sourceLink,
          },
          transaction,
        );
        return { id: task.id, channelId: task.channelId, title: task.title };
      });
    },
    scope,
    failedTurn: (ownerUserId, taskId) =>
      deps.store.failedTurn(ownerUserId, taskId),
    async settled(ownerUserId, taskId) {
      const found = await scope(ownerUserId, taskId);
      if (found) await deps.channels.signalBusy(found.threadId, false);
    },
  };
}

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
 * through the runner every started task uses, and the Bot's reply recorded, which is what tells an
 * open conversation to read the thread again.
 *
 * The conversation reads as busy from the moment it starts, since no browser streams this turn. The
 * engine says it is no longer busy once the turn is off the queue (`TaskThreads.settled`).
 *
 * STOPPING FOR THE PERSON IS NOT FAILING. A turn that reaches Allow once, or asks a question, ends
 * with the request waiting on them; answering it carries the turn on (approvals/resume-sweep.ts). So
 * it is recorded as the Bot's line and the turn is done, rather than thrown as an error the queue
 * would log and hold.
 *
 * FAILING ON ITS LAST RUN IS SAID. A turn that throws is thrown on, for the queue to hold and retry.
 * On its last run (`final`) the Bot's line says it couldn't finish and why, in plain words, so the
 * conversation does not end on the person's ask with nothing after it. A turn refused the
 * conversation's lock on its first ask never ran, and is put back on the queue without a word.
 */
export function createTaskTurn(deps: {
  channels: Pick<ChannelStore, "recordActivity" | "signalBusy">;
  actorFor: (ownerUserId: string) => Promise<AgentActor>;
  runTurn: TurnRunner;
  /** Resolves a reply's files and skills. Absent, a reply with either fails. */
  replyContext?: Pick<TaskReplyContextReader, "resolve">;
}): (
  ...turn: Parameters<ProactiveEngineDeps["startTask"]>
) => Promise<TaskTurnEnding | undefined> {
  return async (scope, input) => {
    const actor = await deps.actorFor(scope.ownerUserId);
    const record = (text: string, agentId: string | null, id: string) =>
      deps.channels.recordActivity(
        actor,
        scope.channelId,
        { text, agentId, at: new Date() },
        { id },
      );
    // The conversation's line is the person's ask, never the frame the model reads around it.
    const brief = readTaskBrief(input.text);
    await record(
      input.acceptedReply?.text ?? brief ?? (input.text || "Sent attachments"),
      null,
      brief === null ? input.runId : `${input.runId}:input`,
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
      /*
       * A reply carries who sent it and what they said in its message, so the reply reads the same
       * however many times it is run. The runner's instruction and any files are the person's input
       * as it was.
       */
      const text = input.acceptedReply
        ? frameTaskInput(input.text, input.acceptedReply)
        : input.text;
      const content = context.attachments.length
        ? [
            ...(text ? [{ type: "text" as const, text }] : []),
            ...context.attachments,
          ]
        : text;
      const result = await deps.runTurn({
        ...scope,
        routineId: input.runId,
        instruction: input.text,
        userMessage: { id: input.runId, role: "user", content },
        systemMessages: [
          // One id for every turn of the task, so its conversation holds this once.
          { id: "task:ending", role: "system" as const, content: TASK_ENDING },
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
       * Recorded as how the reply ends, its next step, rather than how it starts: Tasks shows this
       * line after the task's status (`TaskRecord.next`), and a conversation's preview keeps only
       * its first 200 characters, which for a long reply would be its opening.
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
    } catch (error) {
      if (!(error instanceof HeadlessToolSuspension)) {
        if (input.final && !(error instanceof ThreadLockBusyError))
          await record(
            `I couldn't finish this: ${plainFailure(error instanceof Error ? error.message : String(error))}.`,
            scope.agentId,
            `${input.runId}:failed`,
          ).catch(() => {});
        throw error;
      }
      await record(waitingLine(error), scope.agentId, `${input.runId}:waiting`);
    }
  };
}
