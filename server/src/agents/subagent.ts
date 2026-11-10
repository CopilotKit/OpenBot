/**
 * The tool every Bot uses to give a piece of its own work to a subagent.
 *
 * A SUBAGENT IS THE SAME BOT, RUN AGAIN. A fresh headless turn of the Bot that called it, as the same
 * person and the same initiator, one level deeper, in a thread of its own: so it holds exactly the
 * Bot's granted tools, its computer, its approval rules and its standing instructions, and nothing
 * the Bot was not given. What it does not have is the conversation. It starts from the task alone and
 * hands back only its answer, which is the point: the Bot's own context stays clean for planning and
 * deciding, and twenty pages of reading stay in the subagent's thread.
 *
 * EXECUTED HERE, FOR EVERY KIND OF BOT. A built-in Bot holds it among its tools; a remote AG-UI agent
 * is offered it with its grants and calls it like any of them, and the headless middleware runs it on
 * this server. So an agent somebody brings needs no change to have subagents, and a subagent of a
 * remote Bot is that remote Bot again, at its own endpoint.
 *
 * A SUBAGENT NEVER WAITS ON THE PERSON. Nobody watches its thread, so a question put there would be
 * answered by nobody. An action that needs a yes stops it; the request it opened is withdrawn so the
 * person is not asked twice, and the Bot is told exactly what it wanted to do, to do itself in the
 * conversation where the person is asked as usual.
 *
 * No nesting: a subagent is built with no coordination at all, so it is offered neither this nor
 * `message_bot` nor `ask_person`, and its thread is no conversation a coordination callback accepts.
 */

import type { AbstractAgent, Message } from "@ag-ui/client";
import {
  SUBAGENT_TOOL,
  SUBAGENTS_PER_ANSWER,
  type SubagentResult,
  subagentThreadId,
} from "@openbot/shared/subagent";
import type { GrantedTool, ToolExecution } from "@openbot/toolkit/granted-tool";
import { HeadlessToolSuspension } from "@openbot/toolkit/headless-tools";
import { createTurnRunner } from "@openbot/toolkit/run-turn";
import { z } from "zod";
import { currentApprovalContext } from "../approvals/types";
import type { AuditInitiator } from "../audit";
import type { ProductSurface } from "../telemetry/product";
import { REFUSAL_MARKER } from "../plugins/tools";

const parameters = z.object({
  task: z
    .string()
    .describe(
      "The piece of work, complete in itself. The subagent sees none of this conversation, so include every name, date, id and constraint it needs",
    ),
  answer: z
    .string()
    .describe(
      "What to hand back: a list, a figure, a short summary with its sources, a yes or no with the reason",
    ),
});

/**
 * What a withdrawn request says in the person's approvals. The Bot asks again in the conversation,
 * so this is where they say yes, not here.
 */
export const SUBAGENT_HANDED_BACK =
  "Handed back to your conversation with this Bot, where you're asked instead.";

/** The run asking, as this deployment knows it. */
export type SubagentParent = {
  runId?: string;
  /** The asking run's root task, as its analytics context states it; the subagent works for it. */
  rootTaskId?: string;
  /** Where the asking run's person is: the subagent's work reaches them there. */
  surface?: ProductSurface;
  actorId: string;
  botId: string;
  threadId: string;
  initiator: AuditInitiator;
  depth?: number;
};

type TurnOptions = Parameters<typeof createTurnRunner>[0];

/**
 * The subagent's only message: the task, framed for a run nobody is watching.
 *
 * Written for the model. It is a user message rather than a prompt, so the Bot's own prompt, role
 * and standing instructions are exactly what they are in the conversation.
 */
function framed(task: string, answer: string): string {
  return [
    "You are a subagent: you were given one part of a larger piece of work, to do on your own. Nobody is watching this run and you cannot ask the person anything. Do the work with your tools, then reply with the answer asked for and nothing else.",
    "If an action needs the person's approval, it is handed back to the main conversation; do not look for another way to do it.",
    `Task: ${task}`,
    `Answer wanted: ${answer}`,
  ].join("\n\n");
}

/** Every tool call the subagent made, which is what its card counts as a step. */
function stepsIn(messages: readonly Message[]): number {
  return messages.reduce(
    (sum, message) =>
      sum +
      (message.role === "assistant" ? (message.toolCalls?.length ?? 0) : 0),
    0,
  );
}

/** What it had said before it stopped, which is its own account of why. */
function saidIn(messages: readonly Message[]): string | undefined {
  const said = messages
    .flatMap((message) =>
      message.role === "assistant" &&
      typeof message.content === "string" &&
      message.content.trim()
        ? [message.content.trim()]
        : [],
    )
    .join("\n\n");
  return said || undefined;
}

export function createSubagents(options: {
  /** The headless turn a subagent runs, as every background turn is built. No components. */
  turn: Omit<TurnOptions, "buildAgentFor" | "components">;
  /** The same Bot as the person's run gets, built for a subagent: no coordination, no nesting. */
  buildAgentFor: TurnOptions["buildAgentFor"];
  /** Close every approval request the subagent's run opened, without carrying that run on. */
  withdrawApprovals: (ownerUserId: string, runId: string) => Promise<unknown>;
  /**
   * Whether the conversation is a check-in task's, where every step is asked about in it. Those are
   * kept in the conversation: a subagent's own thread is not one the gate knows to ask in that way.
   */
  asksEveryStep?: (ownerUserId: string, threadId: string) => Promise<boolean>;
  perAnswer?: number;
}) {
  const perAnswer = options.perAnswer ?? SUBAGENTS_PER_ANSWER;
  return {
    /** The tool for one run. Its count of subagents is that run's, which is one answer. */
    toolForRun(parent: SubagentParent): GrantedTool {
      let started = 0;
      return {
        name: SUBAGENT_TOOL,
        ref: `bot/${SUBAGENT_TOOL}`,
        /*
         * The rule the prompt's subagents section gives, cost first. This used to say "whenever work
         * takes more than two or three calls", the threshold the prompt had already dropped after a
         * Bot split one web search three ways, so the two disagreed on every run. Anthropic found a
         * subagent tool whose description states its cost first is called about a third less often,
         * with the same results.
         */
        description:
          "Give one self-contained part of your work to a subagent: a fresh copy of you, with your tools, acting for the same person, that sees none of this conversation and returns only its answer. " +
          "Each one is slower than doing the work yourself and is more for the person to follow, so use it only when a request falls into several independent parts that each need a lot of reading of their own, such as one account, document or company each. " +
          "A single question, one search, or a lookup that takes a handful of tool calls, do yourself. " +
          "Give it everything it needs to know and say what answer you want back. Call it several times in one step to run independent parts at the same time. " +
          "If the subagent reaches an action that needs the person's approval, it stops and hands that action back to you.",
        parameters,
        initiator: parent.initiator,
        concurrent: true,
        execute: async (args: unknown, execution?: ToolExecution) => {
          const parsed = parameters.safeParse(args);
          if (!parsed.success)
            return `${REFUSAL_MARKER} No subagent was started: say what the task is and what answer you want back.`;
          // Counted before anything is awaited, so calls arriving together cannot all pass the cap.
          if (started >= perAnswer)
            return `${REFUSAL_MARKER} No subagent was started: one answer can start up to ${perAnswer} subagents, and this one has. Do this part yourself.`;
          started += 1;
          if (await options.asksEveryStep?.(parent.actorId, parent.threadId))
            return `${REFUSAL_MARKER} No subagent was started: in a task from a check-in, every step is checked with the person in this conversation. Do this part yourself.`;

          const toolCallId =
            execution?.toolCallId ??
            currentApprovalContext()?.toolCallId ??
            crypto.randomUUID();
          const threadId = await subagentThreadId(parent.threadId, toolCallId);
          const runId = crypto.randomUUID();
          let agent: AbstractAgent | undefined;
          const runTurn = createTurnRunner({
            ...options.turn,
            buildAgentFor: async (input) => {
              agent = await options.buildAgentFor(input);
              return agent;
            },
          });
          const messages = () => agent?.messages ?? [];
          const answer = (result: SubagentResult) => JSON.stringify(result);
          try {
            const { replyText } = await runTurn({
              ownerUserId: parent.actorId,
              telemetry: {
                trigger: "subagent",
                surface: parent.surface,
                parentRunId: parent.runId,
                inheritedRootTaskId: parent.rootTaskId,
              },
              routineId: SUBAGENT_TOOL,
              agentId: parent.botId,
              threadId,
              runId,
              instruction: parsed.data.task,
              userMessage: {
                id: crypto.randomUUID(),
                role: "user",
                content: framed(parsed.data.task, parsed.data.answer),
              },
              initiator: parent.initiator,
              depth: (parent.depth ?? 0) + 1,
              ...(execution?.signal ? { signal: execution.signal } : {}),
            });
            return answer({
              answer: replyText,
              threadId,
              steps: stepsIn(messages()),
            });
          } catch (error) {
            if (execution?.signal?.aborted) throw error;
            if (!(error instanceof HeadlessToolSuspension))
              return answer({
                error: `The subagent did not finish: ${error instanceof Error ? error.message : String(error)}`,
                threadId,
                steps: stepsIn(messages()),
              });
            await options.withdrawApprovals(parent.actorId, runId);
            const waited = error.waiting.continuation as
              | { toolName?: unknown; args?: unknown }
              | undefined;
            const said = saidIn(messages());
            return answer({
              handedBack: {
                tool:
                  typeof waited?.toolName === "string"
                    ? waited.toolName
                    : "unknown",
                args: waited?.args ?? {},
                reason: error.message,
                ...(said ? { said } : {}),
              },
              next: "The subagent stopped before this action and nothing was done; the person has not been asked. If it still needs doing, call that tool yourself in this conversation with those arguments, so the person is asked here.",
              threadId,
              steps: stepsIn(messages()),
            });
          }
        },
      };
    },
  };
}
