import type { RunAgentInput } from "@ag-ui/core";
import type { ReactFrontendTool } from "@copilotkit/react-core/v2";

type HandlerContext = Parameters<NonNullable<ReactFrontendTool["handler"]>>[1];
type Agent = NonNullable<HandlerContext["agent"]>;
const inputs = new WeakMap<Agent, RunAgentInput>();
/** The agents being observed, and how to stop. Once each, however often a screen asks. */
const observing = new WeakMap<Agent, () => void>();

/**
 * Capture the SDK's real run input before a frontend tool is dispatched.
 *
 * For as long as the agent runs, not as long as a screen shows it: a conversation calls this and
 * never stops it, because its agent carries on with a turn after the person has left, and a step a
 * rule asks about is sent to the gate with this input. Kept per agent, so it goes with the agent.
 */
export function observeApprovalAgent(agent: Agent) {
  const already = observing.get(agent);
  if (already) return already;
  const subscription = agent.subscribe({
    onRunInitialized: ({ input }) => {
      inputs.set(agent, input);
    },
    onRunStartedEvent: ({ input, event }) => {
      inputs.set(agent, {
        ...input,
        runId: event.runId,
        threadId: event.threadId,
      });
    },
  });
  const stop = () => {
    subscription.unsubscribe();
    inputs.delete(agent);
    observing.delete(agent);
  };
  observing.set(agent, stop);
  return stop;
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
