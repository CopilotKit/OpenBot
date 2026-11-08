/**
 * A card a Bot asked the person with in the conversation, and is waiting on.
 *
 * The approval card, the choice card and the form (`@openbot/shared/decision-tools`) are tools the
 * browser answers: the Bot calls one, its run ends, and the browser holds the call until the person
 * answers on the card. The answer goes back as the tool's result in the conversation's next run.
 * Nothing about the wait is OpenBot's own: the call and the answer are in the thread, which the
 * platform keeps. So the Bot was never under Needs you for it, and nobody was told.
 *
 * WATCHED WHERE THE RUNTIME HANDS A RUN TO ITS RUNNER, which every browser run passes through. A run
 * that finishes leaving a decision call unanswered is saved here as a `person.decision` work item,
 * for the person whose conversation it is and the Bot that asked. A later run whose messages carry a
 * result for that call finishes it. The browser gives every call it could not answer a result before
 * the next run goes out (`repairUnansweredToolCalls` in the app), so a person who typed a reply
 * instead of answering the card finishes it too.
 *
 * Read by the attention counts and the Bot's Activity, and by a task's state when the conversation
 * is a task's (`activity/activity.ts`, `tasks/state.ts`). Never claimed: no worker runs this kind.
 */
import type {
  AbstractAgent,
  AgentSubscriber,
  Message,
  RunAgentInput,
} from "@ag-ui/client";
import {
  DECISION_TOOLS,
  type DecisionToolName,
  isDecisionTool,
} from "@openbot/shared/decision-tools";
import { eq, isNull, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { intelligenceChannelMappings } from "../db/schema/core";
import { workItems } from "../db/schema/work";

export const DECISION_KIND = "person.decision";

/** The cards counted as approvals; every other card is a question. */
export const APPROVAL_CARDS: readonly string[] = Object.entries(DECISION_TOOLS)
  .filter(([, kind]) => kind === "approval")
  .map(([name]) => name);

/** What is saved for one waiting card. */
export type DecisionPayload = {
  /** The person whose conversation it is. */
  actorId: string;
  /** The Bot that asked. */
  botId: string;
  threadId: string;
  channelId: string;
  runId: string;
  toolCallId: string;
  toolName: DecisionToolName;
  /** The card's own title, what the person is asked. */
  title: string | null;
};

/** One call a run left waiting on its card. */
export type WaitingDecision = {
  toolCallId: string;
  toolName: DecisionToolName;
  title: string | null;
};

const TITLE_MAX = 200;

/** A thread holds one call per id; the thread is in the key so two threads can never collide. */
const keyOf = (threadId: string, toolCallId: string) =>
  `${threadId}:${toolCallId}`;

const titleOf = (args: string): string | null => {
  try {
    const parsed = JSON.parse(args) as unknown;
    const title =
      parsed && typeof parsed === "object"
        ? (parsed as { title?: unknown }).title
        : undefined;
    if (typeof title !== "string" || !title.trim()) return null;
    const words = Array.from(title.trim());
    return words.length > TITLE_MAX
      ? `${words.slice(0, TITLE_MAX - 1).join("")}…`
      : words.join("");
  } catch {
    return null;
  }
};

/**
 * The decision calls among a run's pending ones: the calls it started and nothing answered, as the
 * AG-UI client names them when the run finishes. Read from the run's messages, which carry each
 * call's name and arguments.
 */
export function waitingDecisions(
  messages: ReadonlyArray<Readonly<Message>>,
  pendingToolCallIds: readonly string[],
): WaitingDecision[] {
  const pending = new Set(pendingToolCallIds);
  const waiting: WaitingDecision[] = [];
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const call of message.toolCalls ?? []) {
      if (!pending.has(call.id) || !isDecisionTool(call.function.name))
        continue;
      pending.delete(call.id);
      waiting.push({
        toolCallId: call.id,
        toolName: call.function.name,
        title: titleOf(call.function.arguments),
      });
    }
  }
  return waiting;
}

/** The decision calls a run's input carries an answer for. */
export function answeredDecisions(messages: readonly Message[]): string[] {
  const asked = new Set<string>();
  for (const message of messages)
    if (message.role === "assistant")
      for (const call of message.toolCalls ?? [])
        if (isDecisionTool(call.function.name)) asked.add(call.id);
  const answered = new Set<string>();
  for (const message of messages)
    if (message.role === "tool" && asked.has(message.toolCallId))
      answered.add(message.toolCallId);
  return [...answered];
}

export type DecisionWaits = ReturnType<typeof createDecisionWaits>;

export function createDecisionWaits(database: Database) {
  return {
    /**
     * Save the calls a run finished waiting on, for the person whose conversation the thread is.
     * Idempotent on the call: a call already saved, or already answered, is left as it is.
     */
    async opened(input: {
      threadId: string;
      runId: string;
      botId: string;
      calls: WaitingDecision[];
    }): Promise<void> {
      if (input.calls.length === 0) return;
      const [conversation] = await database
        .select({
          userId: intelligenceChannelMappings.userId,
          channelId: intelligenceChannelMappings.channelId,
        })
        .from(intelligenceChannelMappings)
        .where(eq(intelligenceChannelMappings.threadId, input.threadId))
        .limit(1);
      // A thread no conversation shows has nobody to tell and nowhere to send them.
      if (!conversation) return;
      await database
        .insert(workItems)
        .values(
          input.calls.map((call) => ({
            kind: DECISION_KIND,
            key: keyOf(input.threadId, call.toolCallId),
            payload: {
              actorId: conversation.userId,
              botId: input.botId,
              threadId: input.threadId,
              channelId: conversation.channelId,
              runId: input.runId,
              toolCallId: call.toolCallId,
              toolName: call.toolName,
              title: call.title,
            } satisfies DecisionPayload,
          })),
        )
        .onConflictDoNothing();
    },

    /**
     * Finish the waits these calls answer.
     *
     * Written as finished even when nothing was saved yet: the answer can reach the server before
     * the run that asked has been saved (a card the browser answers on its own, such as a refusal),
     * and the finished row is what keeps that late save from opening a wait nobody can close.
     */
    async answered(threadId: string, toolCallIds: string[]): Promise<void> {
      if (toolCallIds.length === 0) return;
      await database
        .insert(workItems)
        .values(
          toolCallIds.map((toolCallId) => ({
            kind: DECISION_KIND,
            key: keyOf(threadId, toolCallId),
            payload: { threadId, toolCallId },
            finishedAt: new Date(),
          })),
        )
        .onConflictDoUpdate({
          target: [workItems.kind, workItems.key],
          set: { finishedAt: sql`now()`, updatedAt: sql`now()` },
          setWhere: isNull(workItems.finishedAt),
        });
    },
  };
}

type RunRequest = {
  threadId: string;
  agent: AbstractAgent;
  input: RunAgentInput;
};

type WatchedRunner<Request extends RunRequest, Events> = {
  run(request: Request): Events;
  runWithStartupBoundary?: (request: Request) => unknown;
};

const logFailure = (stage: string, threadId: string) => (error: unknown) =>
  console.error(
    JSON.stringify({
      type: "decision-wait-write-failed",
      stage,
      threadId,
      error: String(error),
    }),
  );

/**
 * Watch every run the runtime hands to its runner: finish the waits its input answers, and save
 * the decision calls it finishes waiting on.
 *
 * The runner's own stream carries only a run's start and its error (it sends the rest to the
 * platform), so the run's events are read from its agent, which the runner runs in place. Patched on
 * the runner the runtime built, at both ways in, as product telemetry does in `copilot.ts`.
 */
export function watchDecisionWaits<Request extends RunRequest, Events>(
  runner: WatchedRunner<Request, Events>,
  waits: DecisionWaits,
): void {
  const watch = (request: Request) => {
    const { threadId } = request;
    void waits
      .answered(threadId, answeredDecisions(request.input.messages))
      .catch(logFailure("answered", threadId));
    const watcher: AgentSubscriber = {
      onRunFinishedEvent: (params) => {
        if (params.outcome !== "success") return;
        const calls = waitingDecisions(
          params.messages,
          params.pendingToolCallIds,
        );
        const botId = request.agent.agentId;
        if (calls.length === 0 || !botId) return;
        void waits
          .opened({ threadId, runId: request.input.runId, botId, calls })
          .catch(logFailure("opened", threadId));
      },
    };
    request.agent.subscribe(watcher);
  };
  const run = runner.run.bind(runner);
  runner.run = (request) => {
    watch(request);
    return run(request);
  };
  const startup = runner.runWithStartupBoundary?.bind(runner);
  if (startup)
    runner.runWithStartupBoundary = (request) => {
      watch(request);
      return startup(request);
    };
}
