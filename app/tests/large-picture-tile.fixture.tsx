import type { Message } from "@ag-ui/core";
import { CopilotKitProvider } from "@copilotkit/react-core/v2";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { ChatTranscript } from "@/components/channels/chat-transcript";
import { TooltipProvider } from "@/components/ui/tooltip";
import { setCurrentOrganization } from "@/lib/organizations/current";

/**
 * A sent message carrying a picture over 8MB and one under it, as a page of its own for
 * large-picture-tile.test.tsx to bundle and load in Chromium. `?theme=dark` draws it dark.
 */
if (new URLSearchParams(location.search).get("theme") === "dark") {
  document.documentElement.classList.add("dark");
}
setCurrentOrganization("default");

const picture = (id: string, filename: string, sizeBytes: number) => ({
  type: "image" as const,
  source: {
    type: "url" as const,
    value: `/api/attachments/${id}`,
    mimeType: "image/png",
  },
  metadata: { attachmentId: id, filename, sizeBytes },
});

const MESSAGES: Message[] = [
  {
    id: "u1",
    role: "user",
    content: [
      { type: "text", text: "Here is the drone survey and the site photo." },
      picture("big", "drone-survey.png", 99_553_808),
      picture("small", "site-photo.png", 2_400_000),
    ],
  } as Message,
  { id: "a1", role: "assistant", content: "I have both pictures." },
];

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false } },
});

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <QueryClientProvider client={queryClient}>
      <CopilotKitProvider runtimeUrl="/api/copilotkit">
        <TooltipProvider>
          <div className="flex h-svh flex-col bg-background text-foreground">
            <ChatTranscript messages={MESSAGES} restoring={false} />
          </div>
        </TooltipProvider>
      </CopilotKitProvider>
    </QueryClientProvider>,
  );
}
