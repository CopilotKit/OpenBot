import type { Message } from "@ag-ui/core";
import {
  CopilotChatConfigurationProvider,
  CopilotChatMessageView,
  CopilotKitProvider,
} from "@copilotkit/react-core/v2";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { ChatTranscript } from "@/components/channels/chat-transcript";
import { TelemetryAssistantMessage } from "@/components/channels/telemetry-assistant-message";
import { TooltipProvider } from "@/components/ui/tooltip";

/**
 * A finished reply with its toolbar, as a page of its own for conversation-reply-toolbar-layout.test.tsx
 * to bundle and load in a browser. `?view=conversation` is the real conversation transcript;
 * `?view=bot` is the Bot chat page's message view with the same reply, to hold the two side by side.
 */

const search = new URLSearchParams(location.search);
const view = search.get("view") ?? "conversation";

const messages: Message[] = [
  { id: "ask", role: "user", content: "What should I pack for Lisbon?" },
  {
    id: "reply",
    role: "assistant",
    content:
      "Lisbon in late November is mild and often wet. Pack:\n\n- A light waterproof jacket\n- Comfortable shoes with grip, for the hills and the cobbles\n- Layers for 12 to 18 degrees\n\nThe trams fill up by mid-morning, so start early.",
  },
];

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false } },
});

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <QueryClientProvider client={queryClient}>
      <CopilotKitProvider runtimeUrl="/api/copilotkit" enableInspector={false}>
        <TooltipProvider>
          <div
            className="bg-background text-foreground"
            style={{
              display: "flex",
              flexDirection: "column",
              height: "100vh",
            }}
          >
            {view === "bot" ? (
              <CopilotChatConfigurationProvider threadId="thread">
                <div className="mx-auto w-full max-w-3xl px-4 py-6">
                  <CopilotChatMessageView
                    assistantMessage={TelemetryAssistantMessage}
                    messages={messages}
                  />
                </div>
              </CopilotChatConfigurationProvider>
            ) : (
              <ChatTranscript
                messages={messages}
                restoring={false}
                threadId="thread"
              />
            )}
          </div>
        </TooltipProvider>
      </CopilotKitProvider>
    </QueryClientProvider>,
  );
}
