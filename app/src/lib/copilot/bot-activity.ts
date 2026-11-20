import { UseAgentUpdate, useAgent } from "@copilotkit/react-core/v2";
import { useConversationActivity } from "@/lib/computers/activity";

/**
 * What a Bot did on its computer in its own chat, for the Activity pane beside its screen.
 *
 * Read from the shared agent the packaged chat binds, the same one `useStoppedTurn` reads, rather
 * than from what the chat draws: that chat draws only the messages in view, and the pane lists every
 * call in the conversation.
 */
export function useBotActivity(agentId: string): void {
  const { agent } = useAgent({
    agentId,
    updates: [
      UseAgentUpdate.OnMessagesChanged,
      UseAgentUpdate.OnRunStatusChanged,
    ],
  });
  useConversationActivity(agentId, agent.messages);
}
