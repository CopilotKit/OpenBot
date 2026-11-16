import type { Message } from "@ag-ui/core";
import { CopilotKitProvider } from "@copilotkit/react-core/v2";
import { taskReportMessageId } from "@openbot/shared/orchestration";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { ChatTranscript } from "@/components/channels/chat-transcript";
import { GalleryMarkdown } from "@/components/gallery/markdown";
import { TooltipProvider } from "@/components/ui/tooltip";

/**
 * One answer with maths in it, drawn where a Bot's words are drawn, as a page of its own for
 * maths-rendering.test.tsx to bundle and load in a browser.
 *
 *   ?surface=direct   a reply in the conversation
 *   ?surface=thread   the task's last message in its own thread
 *   ?surface=origin   the task's result line in the conversation that asked for it
 *   ?surface=card     the text of a card a Bot draws
 *   ?theme=dark       the dark theme
 *
 * The answer is written as models write one: `\( \)` in a sentence, `\[ \]` on lines of its own and
 * wider than a phone, `$$` in a sentence, prices with single dollars, and code with both in it.
 */
const params = new URLSearchParams(location.search);
if (params.get("theme") === "dark")
  document.documentElement.classList.add("dark");
const surface = params.get("surface") ?? "direct";

const ANSWER = [
  "The monthly payment is **$489.15**, calculated using \\(M = P\\frac{r}{1-(1+r)^{-n}}\\), where \\(P=$25,000\\) and \\(n=60\\).",
  "",
  "\\[",
  "M = P\\cdot\\frac{r\\,(1+r)^{n}}{(1+r)^{n}-1} = 25000\\cdot\\frac{0.0054167\\,(1.0054167)^{60}}{(1.0054167)^{60}-1} \\approx 489.15",
  "\\]",
  "",
  "The monthly rate is $$r = \\frac{0.065}{12}$$ for a 6.5% annual rate.",
  "",
  "The loan is $25,000 and fees run $5 to $10.",
  "",
  "```python",
  'price = "$25,000"',
  'pattern = r"\\(\\d+\\)"',
  "```",
].join("\n");

const QUESTION: Message = {
  id: "u1",
  role: "user",
  content: "What's the monthly payment on a $25,000 loan at 6.5% over 5 years?",
};

const messages: Record<string, Message[]> = {
  direct: [QUESTION, { id: "a1", role: "assistant", content: ANSWER }],
  thread: [
    { id: "u1", role: "user", content: "Calculate the monthly loan payment." },
    { id: "a1", role: "assistant", content: ANSWER },
  ],
  origin: [
    QUESTION,
    {
      id: taskReportMessageId("result", "task-1", "run-1"),
      role: "assistant",
      content: ANSWER,
    },
  ],
};

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
            {surface === "card" ? (
              <div className="m-4 max-w-sm rounded-xl border bg-card p-4 text-card-foreground text-sm">
                <GalleryMarkdown>{ANSWER}</GalleryMarkdown>
              </div>
            ) : (
              <ChatTranscript
                messages={messages[surface] ?? []}
                restoring={false}
              />
            )}
          </div>
        </TooltipProvider>
      </CopilotKitProvider>
    </QueryClientProvider>,
  );
}
