import type { Message } from "@ag-ui/core";
import { CopilotKitProvider } from "@copilotkit/react-core/v2";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { ComposerDraft } from "@/components/channels/composer";
import { ConversationView } from "@/components/channels/conversation-view";
import { TooltipProvider } from "@/components/ui/tooltip";
import { setCurrentOrganization } from "@/lib/organizations/current";

/**
 * A conversation whose Bot is mid-turn, as a page of its own for queue-send-now-layout.test.tsx to
 * bundle and load in a browser: the real conversation view, composer and transcript, with this page
 * playing the channel. The turn has done some work (a reply under way). Stop ends the turn when the
 * test says so (`window.__endTurn()`), and a send adds the person's message to the conversation and
 * holds the turn it starts until `window.__endTurn()` again.
 *
 * `?theme=dark` draws it in the dark theme.
 */
type Page = Window & {
  __stops: number;
  __sent: string[];
  __endTurn: () => void;
};
const page = window as unknown as Page;
page.__stops = 0;
page.__sent = [];
setCurrentOrganization("default");

if (new URLSearchParams(location.search).get("theme") === "dark") {
  document.documentElement.classList.add("dark");
}

const SO_FAR: Message[] = [
  {
    id: "asked",
    role: "user",
    content:
      "Weigh harvest crates 1 to 30 with the scale, then tell me the total.",
  },
  {
    id: "partial",
    role: "assistant",
    content:
      "Crate 1 weighs 3.5 kg, crate 2 weighs 5 kg, crate 3 weighs 6.5 kg. Weighing crate 4 next.",
  },
];

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false } },
});

function Conversation() {
  const [messages, setMessages] = useState<Message[]>(SO_FAR);
  const [busy, setBusy] = useState(true);
  const [ending, setEnding] = useState<(() => void) | null>(
    () => () => setBusy(false),
  );
  page.__endTurn = () => ending?.();
  return (
    <ConversationView
      busy={busy}
      channelId="channel-1"
      messages={messages}
      onStop={() => {
        page.__stops += 1;
      }}
      onSubmit={(draft: ComposerDraft) =>
        new Promise<void>((resolve) => {
          page.__sent.push(draft.text);
          setMessages((now) => [
            ...now,
            { id: `sent-${now.length}`, role: "user", content: draft.text },
          ]);
          setBusy(true);
          setEnding(() => () => {
            setBusy(false);
            resolve();
          });
        })
      }
      pending={busy}
      queueWhileBusy
      stoppable={busy}
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
