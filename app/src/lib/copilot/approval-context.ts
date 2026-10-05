import type { RunAgentInput } from "@ag-ui/core";
import type { ReactFrontendTool } from "@copilotkit/react-core/v2";

type HandlerContext = Parameters<NonNullable<ReactFrontendTool["handler"]>>[1];
type Agent = NonNullable<HandlerContext["agent"]>;
const inputs = new WeakMap<Agent, RunAgentInput>();

/** Capture the SDK's real run input before a frontend tool is dispatched. */
export function observeApprovalAgent(agent: Agent) {
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
  return () => {
    subscription.unsubscribe();
    inputs.delete(agent);
  };
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
