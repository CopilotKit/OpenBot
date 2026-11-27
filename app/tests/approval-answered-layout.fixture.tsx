import type { Message } from "@ag-ui/core";
import { CopilotKitProvider } from "@copilotkit/react-core/v2";
import { QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { ChatTranscript } from "@/components/channels/chat-transcript";
import { ComputerTools } from "@/lib/copilot/computer-tools";
import { setCurrentOrganization } from "@/lib/organizations/current";
import { queryClient } from "@/query-client";

// The organization the fake server answers for, as every test starts in (tests/preload.ts).
setCurrentOrganization("default");

/**
 * A conversation whose Bot asks the person for approval, as a page of its own for
 * approval-answered-layout.test.tsx to bundle and load in a real browser: the transcript the app
 * draws, through the renderers it registers, from the conversation as the server has it now
 * (`/conversation.json`). The approvals are read from the API, which the test answers and remembers
 * across a reload, as the server does.
 */

function Page() {
  const [messages, setMessages] = useState<Message[] | null>(null);
  useEffect(() => {
    void fetch("/conversation.json")
      .then((answer) => answer.json())
      .then((loaded: Message[]) => setMessages(loaded));
  }, []);
  return (
    <main className="bg-background text-foreground">
      <QueryClientProvider client={queryClient}>
        <CopilotKitProvider runtimeUrl="/api/copilotkit">
          <ComputerTools />
          <section aria-label="Conversation" className="flex flex-col">
            {messages ? (
              <ChatTranscript
                busy={false}
                messages={messages}
                restoring={false}
              />
            ) : null}
          </section>
        </CopilotKitProvider>
      </QueryClientProvider>
    </main>
  );
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<Page />);
