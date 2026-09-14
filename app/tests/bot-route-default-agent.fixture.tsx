import { mock } from "bun:test";

mock.module("@copilotkit/react-core/v2", () => ({
  CopilotChat: ({ agentId }: { agentId: string; threadId?: string }) => (
    <div data-agent-id={agentId} data-testid="copilot-chat" />
  ),
}));

mock.module("@/lib/copilot/active-bot", () => ({
  useActiveBot: () => undefined,
}));

mock.module("@/lib/copilot/bot-thread", () => ({
  useBotThread: (agentId: string) => ({
    history: "ready",
    startNew: () => undefined,
    threadId: `thread-${agentId}`,
  }),
}));

mock.module("@/lib/copilot/stopped-turn", () => ({
  useStoppedTurn: () => null,
}));
