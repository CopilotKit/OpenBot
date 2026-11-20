import type { Message } from "@ag-ui/core";
import { CopilotKitProvider } from "@copilotkit/react-core/v2";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ChatTranscript } from "@/components/channels/chat-transcript";
import { TooltipProvider } from "@/components/ui/tooltip";

/**
 * A conversation already longer than the window, as a page of its own for transcript-room.test.tsx
 * to bundle and load in Chromium. It opens with its history, as a channel does once history is in.
 * The test then plays the part of the channel while a turn runs: `window.__say(turn, busy)` puts the
 * turn's messages after the history, the person's message first and then the Bot's reply as it
 * arrives, with `busy` true until the turn is over.
 *
 * `?theme=dark` draws it in the dark theme.
 */
type Page = Window & {
  __say: (turn: Message[], busy: boolean) => void;
};
const page = window as unknown as Page;

if (new URLSearchParams(location.search).get("theme") === "dark") {
  document.documentElement.classList.add("dark");
}

const ANSWER =
  "Here is what changed in the quarterly numbers since last week. Signups rose in the second half, churn held flat, and expansion revenue doubled on the back of two large renewals. The gap to plan is now mostly in the enterprise segment, where three deals slipped into next quarter.";
const HISTORY: Message[] = [1, 2, 3, 4].flatMap((turn) => [
  {
    id: `u${turn}`,
    role: "user" as const,
    content: `Question number ${turn} about the numbers`,
  },
  { id: `a${turn}`, role: "assistant" as const, content: ANSWER },
]);

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false } },
});

function Conversation() {
  const [said, setSaid] = useState<{ turn: Message[]; busy: boolean }>({
    turn: [],
    busy: false,
  });
  page.__say = (turn, busy) => setSaid({ turn, busy });
  return (
    <ChatTranscript
      busy={said.busy}
      messages={[...HISTORY, ...said.turn]}
      restoring={false}
    />
  );
}

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <QueryClientProvider client={queryClient}>
      <CopilotKitProvider runtimeUrl="/api/copilotkit">
        <TooltipProvider>
          <div className="flex h-svh flex-col bg-background text-foreground">
            <Conversation />
          </div>
        </TooltipProvider>
      </CopilotKitProvider>
    </QueryClientProvider>,
  );
}
