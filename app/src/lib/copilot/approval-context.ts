import type { RunAgentInput } from "@ag-ui/core";
import type { ReactFrontendTool } from "@copilotkit/react-core/v2";

type HandlerContext = Parameters<NonNullable<ReactFrontendTool["handler"]>>[1];
type Agent = NonNullable<HandlerContext["agent"]>;
const inputs = new WeakMap<Agent, RunAgentInput>();
/** The agents being observed, and how to stop. Once each, however often a screen asks. */
const observing = new WeakMap<Agent, () => void>();
/** The turns each agent has in flight, counted by `whileObserved`. */
const turns = new WeakMap<Agent, number>();
/** The agents whose screen has let them go, stopped as soon as they have no turn in flight. */
const letGo = new WeakSet<Agent>();

function stopObserving(agent: Agent) {
  observing.get(agent)?.();
}

/**
 * Capture the SDK's real run input before a frontend tool is dispatched.
 *
 * Returns the release a screen calls when it is done with the agent, which is not when observing
 * stops. A conversation's agent carries on with a turn after the person has left, and a step a rule
 * asks about is sent to the gate with this input, so the agent is observed until its last turn is
 * over (`whileObserved`) and only then let go. Stopped any sooner, a run that started after the
 * person left went to the gate under the previous run's id; never stopped, every conversation
 * visited kept its agent and its last input for the rest of the session.
 */
export function observeApprovalAgent(agent: Agent): () => void {
  letGo.delete(agent);
  if (!observing.has(agent)) {
    const subscription = agent.subscribe({
      onRunInitialized: ({ input, messages }) => {
        inputs.set(agent, input);
        const answers = withoutWaitingPlaceholders(messages);
        // Returned, the SDK sends the run these and keeps them as the agent's own messages.
        if (answers.length !== messages.length) return { messages: answers };
      },
      onRunStartedEvent: ({ input, event }) => {
        inputs.set(agent, {
          ...input,
          runId: event.runId,
          threadId: event.threadId,
        });
      },
    });
    observing.set(agent, () => {
      subscription.unsubscribe();
      inputs.delete(agent);
      observing.delete(agent);
      letGo.delete(agent);
    });
  }
  return () => {
    letGo.add(agent);
    if ((turns.get(agent) ?? 0) === 0) stopObserving(agent);
  };
}

/** What a computer tool's handler answers the SDK with while the gate holds the step for a person. */
export const WAITING_FOR_PERSON = { waiting: true } as const;

function isWaitingPlaceholder(message: { role: string; content?: unknown }) {
  if (message.role !== "tool" || typeof message.content !== "string")
    return false;
  try {
    const parsed: unknown = JSON.parse(message.content);
    return (
      !!parsed &&
      typeof parsed === "object" &&
      (parsed as { waiting?: unknown }).waiting === true
    );
  } catch {
    return false;
  }
}

/**
 * The conversation without the stand-in answers a held step left behind.
 *
 * The SDK keeps whatever a handler returns as the call's tool message, and a held step's handler
 * returns `WAITING_FOR_PERSON`. The real answer comes later, from the server's continuation, which
 * the thread saves. Left in, the stand-in went out with the person's next message as a message the
 * thread did not hold, was saved, and took the real answer's place: a declined step, opened again,
 * read as one with no answer and was drawn as done. So it never leaves the browser. A step still
 * waiting is sent with no answer, which every run already handles as a call nothing has answered.
 */
export function withoutWaitingPlaceholders<
  M extends { role: string; content?: unknown },
>(messages: ReadonlyArray<M>): M[] {
  return messages.filter((message) => !isWaitingPlaceholder(message));
}

/**
 * Run one turn of an observed agent, and keep it observed until the turn is over, whatever its screen
 * does meanwhile. A turn is the SDK's `runAgent`: the run, the tools it calls and the runs that follow
 * them. An agent its screen has let go stops being observed when its last turn ends.
 */
export async function whileObserved<T>(
  agent: Agent,
  turn: () => Promise<T>,
): Promise<T> {
  turns.set(agent, (turns.get(agent) ?? 0) + 1);
  try {
    return await turn();
  } finally {
    const left = (turns.get(agent) ?? 1) - 1;
    turns.set(agent, left);
    if (left === 0 && letGo.has(agent)) stopObserving(agent);
  }
}

export function frontendApprovalSnapshot(context: HandlerContext) {
  const agent = context.agent;
  const input = agent ? inputs.get(agent) : undefined;
  if (!agent || !input || input.threadId !== agent.threadId)
    throw new Error(
      "This action needs an active conversation before it can be approved.",
    );
  return {
    runId: input.runId,
    threadId: agent.threadId,
    toolCallId: context.toolCall.id,
    toolName: context.toolCall.function.name,
    args: JSON.parse(context.toolCall.function.arguments),
    messages: agent.messages,
    state: agent.state,
    context: input.context,
    forwardedProps: input.forwardedProps,
  };
}
