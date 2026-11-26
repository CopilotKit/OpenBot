import type { Message } from "@ag-ui/core";
import { CopilotKitProvider } from "@copilotkit/react-core/v2";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { ChatTranscript } from "@/components/channels/chat-transcript";
import { GalleryMarkdown } from "@/components/gallery/markdown";
import { TooltipProvider } from "@/components/ui/tooltip";
import { A2UIMarkdown } from "@/lib/copilot/a2ui-markdown";
import {
  BotMarkdown,
  markdownComponents,
  markdownPlugins,
} from "@/lib/markdown";

/**
 * A Bot's table, as a page of its own for table-export-browser.test.tsx to bundle and load in a
 * browser.
 *
 *   ?surface=transcript   the reply in a conversation, as a person sees it
 *   ?surface=ours         the reply's markdown with OpenBot's table
 *   ?surface=streamdown   the same markdown with Streamdown's own table, to compare the look with,
 *                         its body cells set at the top of their row as OpenBot's are
 *   ?surface=gallery      the markdown in a card's text, as a Bot's card draws it
 *   ?surface=a2ui         the markdown in an interface a Bot generates
 *   ?reply=wrapping       a table with one cell that wraps to many lines, rather than links
 *   ?theme=dark           the dark theme
 */
const params = new URLSearchParams(location.search);
if (params.get("theme") === "dark")
  document.documentElement.classList.add("dark");
const surface = params.get("surface") ?? "transcript";

const LINKS = [
  "Here are the links.",
  "",
  "| Item | Link |",
  "|---|---|",
  "| Release | [OpenBot release notes](https://github.com/CopilotKit/OpenBot/releases/tag/v1.2.0-rc.4) |",
  "| Guide | See [the guide](<https://docs.example.com/guide_(beta)>) first |",
  "| Plan | [Q3 plan](https://docs.google.com/document/d/q3-plan) |",
  "| Plain | no link here |",
].join("\n");

const WRAPPING = [
  "Here is who works where.",
  "",
  "| Company | Employees | People |",
  "|---|---|---|",
  "| Northwind | 200 in your team's | Ada Lovelace (founder), Grace Hopper (engineering), Alan Turing (research), Katherine Johnson (flight), Edsger Dijkstra (platform), Barbara Liskov (systems), Donald Knuth (typesetting), Frances Allen (compilers), John Backus (languages), Margaret Hamilton (software), Ken Thompson (operating systems), Radia Perlman (networking), Leslie Lamport (distributed systems), Tim Berners-Lee (the web) |",
  "| Fabrikam | 12 | Linus Pauling |",
].join("\n");

const REPLY = params.get("reply") === "wrapping" ? WRAPPING : LINKS;

const messages: Message[] = [
  { id: "u1", role: "user", content: "A table, please." },
  { id: "a1", role: "assistant", content: REPLY },
];

/** Streamdown's own table: every component of ours but the table. */
const { table: _ours, ...withoutTable } = markdownComponents;

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false } },
});

function Surface() {
  if (surface === "transcript")
    return <ChatTranscript messages={messages} restoring={false} />;
  return (
    <div className="mx-auto w-full max-w-xl p-4 text-sm">
      {surface === "streamdown" ? (
        // OpenBot's one change from Streamdown's look (`CELLS_AT_TOP` in lib/markdown-table.tsx),
        // made to Streamdown's table too, inline and full screen, so the comparison finds any other.
        <style>{"td { vertical-align: top; }"}</style>
      ) : null}
      {surface === "gallery" ? (
        <GalleryMarkdown>{REPLY}</GalleryMarkdown>
      ) : surface === "a2ui" ? (
        <A2UIMarkdown text={REPLY} />
      ) : (
        <BotMarkdown
          components={surface === "ours" ? markdownComponents : withoutTable}
          plugins={markdownPlugins}
        >
          {REPLY}
        </BotMarkdown>
      )}
    </div>
  );
}

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
            <Surface />
          </div>
        </TooltipProvider>
      </CopilotKitProvider>
    </QueryClientProvider>,
  );
}
