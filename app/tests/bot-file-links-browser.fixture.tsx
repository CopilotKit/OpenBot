import type { Message } from "@ag-ui/core";
import { CopilotKitProvider } from "@copilotkit/react-core/v2";
import { SEND_FILE_TOOL } from "@openbot/shared/send-file";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { createRoot } from "react-dom/client";
import { ChatTranscript } from "@/components/channels/chat-transcript";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ComputerTools } from "@/lib/copilot/computer-tools";
import { setCurrentOrganization } from "@/lib/organizations/current";
import { queryClient } from "@/query-client";
import { ATTACHMENT, FILE_NAME, SIZE_BYTES } from "./bot-file-links.data";

/**
 * A conversation in which a Bot made a slide deck, sent it, and linked it in its words by its place
 * on the Bot's computer, then mentioned a draft it never sent. As it is drawn when opened again. For
 * bot-file-links-browser.test.tsx to bundle and load in a real browser.
 */
const messages: Message[] = [
  {
    id: "u1",
    role: "user",
    content: "Make me a short slide deck about a historical mystery.",
  },
  {
    id: "a1",
    role: "assistant",
    content: "",
    toolCalls: [
      {
        id: "call_send",
        type: "function",
        function: {
          name: SEND_FILE_TOOL,
          arguments: JSON.stringify({ path: FILE_NAME }),
        },
      },
    ],
  },
  {
    id: "r1",
    role: "tool",
    toolCallId: "call_send",
    content: JSON.stringify({
      ok: true,
      file: {
        attachmentId: ATTACHMENT,
        name: FILE_NAME,
        mimeType:
          "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        sizeBytes: SIZE_BYTES,
        url: `/api/attachments/${ATTACHMENT}`,
      },
    }),
  },
  {
    id: "a2",
    role: "assistant",
    content: `I made a six-slide deck on the Voynich manuscript. [Download the presentation](${FILE_NAME}) to open it in PowerPoint or Keynote.\n\nI also kept [the first draft](notes/draft.pptx) on my computer, in case you want the longer version.`,
  },
];

function Conversation() {
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh" }}>
      <ChatTranscript messages={messages} restoring={false} />
    </div>
  );
}

const rootRoute = createRootRoute({ component: Conversation });
const router = createRouter({
  routeTree: rootRoute,
  history: createMemoryHistory({ initialEntries: ["/"] }),
});

// The person's organization, as the signed-in gate sets it before any screen draws.
setCurrentOrganization("default");

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <QueryClientProvider client={queryClient}>
      <CopilotKitProvider runtimeUrl="/api/copilotkit">
        <ComputerTools />
        <TooltipProvider>
          <RouterProvider router={router as never} />
        </TooltipProvider>
      </CopilotKitProvider>
    </QueryClientProvider>,
  );
}
