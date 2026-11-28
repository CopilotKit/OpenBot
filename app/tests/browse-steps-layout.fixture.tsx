import type { Message } from "@ag-ui/core";
import { CopilotKitProvider } from "@copilotkit/react-core/v2";
import { QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { ChatTranscript } from "@/components/channels/chat-transcript";
import { ComputerTools } from "@/lib/copilot/computer-tools";
import { setCurrentOrganization } from "@/lib/organizations/current";
import { queryClient } from "@/query-client";
import { approvalInboxResponse } from "./approvals-api";

// The organization the fake server answers for, as every test starts in (tests/preload.ts).
setCurrentOrganization("default");

/**
 * A conversation where a Bot signed in to a site, as a page of its own for
 * browse-steps-layout.test.tsx to bundle and load in a real browser: the transcript the app draws,
 * from the conversation as a reload has it, with the computer's own answers. Each field and button
 * it acted on carries the element the server resolved from the snapshot; one field has a label far
 * longer than the column.
 */

const PAGE = "https://the-internet.herokuapp.com/login";
const EMAIL = "sam@example.com";
const PASSWORD = "hunter2-SuperSecret!";
const LONG_LABEL =
  "Tell us, in as much detail as you would like, the name your organization uses on its invoices and purchase orders";

type Call = { id: string; name: string; args: unknown; result: unknown };

function call(index: number, { id, name, args, result }: Call): Message[] {
  return [
    {
      id: `a-${index}`,
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id,
          type: "function",
          function: { name, arguments: JSON.stringify(args) },
        },
      ],
    },
    {
      id: `t-${index}`,
      role: "tool" as const,
      toolCallId: id,
      content: JSON.stringify(result),
    },
  ];
}

const typed = (ref: string, name: string) => ({
  ok: true,
  action: "type",
  ref,
  url: PAGE,
  element: { role: "textbox", name },
});

const SIGNED_IN: Call[] = [
  {
    id: "open",
    name: "computer_navigate",
    args: { url: PAGE },
    result: { ok: true, url: PAGE, title: "The Internet" },
  },
  {
    id: "look",
    name: "computer_snapshot",
    args: {},
    result: {
      snapshotId: 4,
      url: PAGE,
      title: "The Internet",
      truncated: false,
      elements: [
        { ref: "e3", role: "textbox", name: "Email address", type: "email" },
        { ref: "e4", role: "textbox", name: "Password", type: "password" },
        { ref: "e6", role: "textbox", name: LONG_LABEL, type: "text" },
        { ref: "e5", role: "button", name: "Sign in" },
      ],
    },
  },
  {
    id: "email",
    name: "computer_type",
    args: { ref: "e3", snapshotId: 4, text: EMAIL },
    result: typed("e3", "Email address"),
  },
  {
    id: "password",
    name: "computer_type",
    args: { ref: "e4", snapshotId: 4, text: PASSWORD },
    result: typed("e4", "Password"),
  },
  {
    id: "company",
    name: "computer_type",
    args: { ref: "e6", snapshotId: 4, text: "Acme Widgets Ltd" },
    result: typed("e6", LONG_LABEL),
  },
  {
    id: "submit",
    name: "computer_click",
    args: { ref: "e5", snapshotId: 4 },
    result: {
      ok: true,
      action: "click",
      ref: "e5",
      url: PAGE,
      element: { role: "button", name: "Sign in" },
    },
  },
];

const messages: Message[] = [
  { id: "u1", role: "user", content: "Sign me in to the test site." },
  ...SIGNED_IN.flatMap((step, index) => call(index, step)),
  { id: "answer", role: "assistant", content: "You're signed in." },
];

/** The server, as far as this conversation asks it anything. */
const realFetch = window.fetch.bind(window);
window.fetch = (async (
  input: Parameters<typeof fetch>[0],
  init?: RequestInit,
) => {
  const url = new URL(
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url,
    location.origin,
  );
  const approvals = approvalInboxResponse(url.pathname, {
    enabled: false,
    requests: [],
    rules: [],
    teamRules: [],
    questions: [],
  });
  if (approvals) return approvals;
  if (url.origin === location.origin)
    return Response.json({ error: "not served" }, { status: 404 });
  return realFetch(input, init);
}) as typeof fetch;

function Page() {
  return (
    <main className="bg-background text-foreground">
      <QueryClientProvider client={queryClient}>
        <CopilotKitProvider runtimeUrl="/api/copilotkit">
          <ComputerTools />
          <section aria-label="Conversation" className="flex flex-col">
            <ChatTranscript
              busy={false}
              messages={messages}
              restoring={false}
            />
          </section>
        </CopilotKitProvider>
      </QueryClientProvider>
    </main>
  );
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<Page />);
