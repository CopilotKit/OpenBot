import type { Message } from "@ag-ui/core";
import { CopilotKitProvider } from "@copilotkit/react-core/v2";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { ChatTranscript } from "@/components/channels/chat-transcript";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { RefusedTurn } from "@/lib/channels/queries";
import { withRefusedTurns } from "@/lib/channels/refused-turns";

/**
 * A conversation whose last turn the server refused, as a page of its own for
 * conversation-refusal-layout.test.tsx to bundle and load in a browser: the real transcript, in a
 * window-high column. `?turns=<n>` says how many turns come before it is refused: two, short, fit
 * the window; twelve run well past it.
 */
export const REFUSED =
  "This Bot uses GPT-4.1, which your team's models don't include. Ask an admin to change your team's models.";

const search = new URLSearchParams(location.search);
const turns = Number(search.get("turns") ?? "2");
/**
 * `?refusedInARow=<n>`: the last n turns were each refused, one after another, and each is drawn
 * under its own message (`refusals`), as a conversation does after the second refusal arrives.
 */
const refusedInARow = Number(search.get("refusedInARow") ?? "0");
const refusedMessages: Message[] = Array.from(
  { length: refusedInARow },
  (_, index) => ({
    id: `r${index}`,
    role: "user" as const,
    content:
      index === 0 ? "Say goodbye in one word." : "And once more, one word.",
  }),
);
const refusals = new Map(
  refusedMessages.map((message) => [message.id, REFUSED] as const),
);
const answered: Message[] = Array.from({ length: turns }, (_, index) => [
  {
    id: `u${index}`,
    role: "user" as const,
    content: `Name primary colour number ${index + 1}, one word only.`,
  },
  // Every turn answered but the last, which the server refused (unless refusals follow them).
  ...(index < turns - 1 || refusedInARow > 0 || search.has("reloaded")
    ? [
        {
          id: `a${index}`,
          role: "assistant" as const,
          content: ["Red", "Blue", "Yellow"][index % 3] as string,
        },
      ]
    : []),
]).flat();
/**
 * `?reloaded=person|routine`: the conversation opened again after its turns were refused. The
 * thread holds only the answered turn; the refused ones come back from the server's record
 * (`listRefusedTurns`), put in place as the conversation does (`withRefusedTurns`): two of the
 * person's messages refused one after the other, or a routine's turn refused.
 */
const reloaded = search.get("reloaded");
const stored: RefusedTurn[] =
  reloaded === "person"
    ? [
        storedTurn("t2", "m1", {
          id: "m2",
          text: "And once more, one word.",
        }),
        storedTurn("t1", "a0", {
          id: "m1",
          text: "Say goodbye in one word.",
        }),
      ]
    : reloaded === "routine"
      ? [
          {
            ...storedTurn("t1", null, {
              id: null,
              text: "Say hello in one word.",
            }),
            initiator: "routine",
          },
        ]
      : [];
function storedTurn(
  id: string,
  afterMessageId: string | null,
  message: { id: string | null; text: string },
): RefusedTurn {
  return {
    id,
    botId: "atlas",
    threadId: "thread",
    afterMessageId,
    message,
    initiator: "person",
    code: "MODEL_NOT_ALLOWED",
    detail: REFUSED,
    model: "openai/gpt-4.1",
    createdAt: `2026-11-24T01:0${id === "t1" ? 1 : 2}:00.000Z`,
  };
}
const shown = reloaded
  ? withRefusedTurns(answered, stored)
  : { messages: [...answered, ...refusedMessages], refusals };
const messages: Message[] = shown.messages;

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
            className="bg-background text-foreground"
            style={{
              display: "flex",
              flexDirection: "column",
              height: "100vh",
            }}
          >
            <ChatTranscript
              messages={messages}
              refusals={shown.refusals}
              restoring={false}
              {...(refusedInARow > 0 || reloaded
                ? {}
                : { stopped: { message: REFUSED } })}
            />
          </div>
        </TooltipProvider>
      </CopilotKitProvider>
    </QueryClientProvider>,
  );
}
