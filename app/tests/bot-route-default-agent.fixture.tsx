import { mock } from "bun:test";
import { useState } from "react";

mock.module("@copilotkit/react-core/v2", () => ({
  CopilotChat: ({
    agentId,
    threadId,
  }: {
    agentId: string;
    threadId?: string;
  }) => (
    <div
      data-agent-id={agentId}
      data-thread-id={threadId}
      data-testid="copilot-chat"
    >
      <textarea aria-label="Chat draft" />
    </div>
  ),
}));

/*
 * `@/lib/copilot/active-bot` IS NOT MOCKED, though the route calls `useActiveBot`. Drawn without an
 * `ActiveBotProvider`, as these tests draw it, the real hook finds no holder and does nothing — which
 * is all the mock that used to be here did. And a module mock is not this file's to keep: bun cannot
 * take one back off, so a replacement exporting only `useActiveBot` stood in for the whole module in
 * every file walked into the same process, and `useDeclaredBotId` — the app-access card's fallback
 * for a refusal that names no Bot — stopped existing there.
 */

mock.module("@/lib/copilot/bot-thread", () => ({
  useBotThread: (agentId: string) => {
    const [revision, setRevision] = useState(0);
    return {
      history: "ready",
      startNew: () => setRevision((value) => value + 1),
      threadId: `thread-${agentId}-${revision}`,
    };
  },
}));

mock.module("@/lib/copilot/stopped-turn", () => ({
  useStoppedTurn: () => null,
}));
