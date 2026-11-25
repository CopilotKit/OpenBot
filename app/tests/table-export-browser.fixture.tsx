import type { Message } from "@ag-ui/core";
import { CopilotKitProvider } from "@copilotkit/react-core/v2";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { ChatTranscript } from "@/components/channels/chat-transcript";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  BotMarkdown,
  markdownComponents,
  markdownPlugins,
} from "@/lib/markdown";

/**
 * A Bot's table of links, as a page of its own for table-export-browser.test.tsx to bundle and load
 * in a browser.
 *
 *   ?surface=transcript   the reply in a conversation, as a person sees it
 *   ?surface=ours         the reply's markdown with OpenBot's table
 *   ?surface=streamdown   the same markdown with Streamdown's own table, to compare the look with
 *   ?theme=dark           the dark theme
 */
const params = new URLSearchParams(location.search);
if (params.get("theme") === "dark")
  document.documentElement.classList.add("dark");
const surface = params.get("surface") ?? "transcript";

const REPLY = [
  "Here are the links.",
  "",
  "| Item | Link |",
  "|---|---|",
  "| Release | [OpenBot release notes](https://github.com/CopilotKit/OpenBot/releases/tag/v1.2.0-rc.4) |",
  "| Guide | See [the guide](<https://docs.example.com/guide_(beta)>) first |",
  "| Plan | [Q3 plan](https://docs.google.com/document/d/q3-plan) |",
  "| Plain | no link here |",
].join("\n");

const messages: Message[] = [
  { id: "u1", role: "user", content: "A table of links, please." },
  { id: "a1", role: "assistant", content: REPLY },
];

/** Streamdown's own table: every component of ours but the table. */
const { table: _ours, ...withoutTable } = markdownComponents;

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
            className="flex h-svh flex-col bg-background text-foreground"
            data-surface={surface}
          >
            {surface === "transcript" ? (
              <ChatTranscript messages={messages} restoring={false} />
            ) : (
              <div className="mx-auto w-full max-w-xl p-4 text-sm">
                <BotMarkdown
                  components={
                    surface === "ours" ? markdownComponents : withoutTable
                  }
                  plugins={markdownPlugins}
                >
                  {REPLY}
                </BotMarkdown>
              </div>
            )}
          </div>
        </TooltipProvider>
      </CopilotKitProvider>
    </QueryClientProvider>,
  );
}
