import type { Message } from "@ag-ui/core";
import { CopilotKitProvider } from "@copilotkit/react-core/v2";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { ChatTranscript } from "@/components/channels/chat-transcript";
import { TooltipProvider } from "@/components/ui/tooltip";

/**
 * A conversation of several turns, the transcript filling the window, as a page of its own for
 * transcript-rail-clearance.test.tsx to bundle and load in Chromium. Enough turns for the rail to
 * draw; the Bot's replies are prose, a list and a code block, so their text and their boxes start
 * at the column's left edge.
 */
const REPLIES = [
  "Here is what changed in the quarterly numbers since last week, and where the gap came from.",
  "Three things stand out:\n\n- Signups rose in the second half\n- Churn held flat\n- Expansion revenue doubled",
  "The query I ran:\n\n```sql\nselect region, sum(amount) from orders group by region;\n```",
  "Shall I draft the summary for the team channel, or send it to you first?",
];
const messages: Message[] = REPLIES.flatMap((reply, index) => [
  {
    id: `u${index}`,
    role: "user" as const,
    content: `Question number ${index + 1} about the numbers`,
  },
  { id: `a${index}`, role: "assistant" as const, content: reply },
]);

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false } },
});

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <QueryClientProvider client={queryClient}>
      <CopilotKitProvider runtimeUrl="/api/copilotkit">
        <TooltipProvider>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              height: "100vh",
            }}
          >
            <ChatTranscript messages={messages} restoring={false} />
          </div>
        </TooltipProvider>
      </CopilotKitProvider>
    </QueryClientProvider>,
  );
}
