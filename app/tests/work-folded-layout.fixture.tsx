import type { Message } from "@ag-ui/core";
import { CopilotKitProvider } from "@copilotkit/react-core/v2";
import { SEND_FILE_TOOL } from "@openbot/shared/send-file";
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
 * A conversation with a Bot's work in it, as a page of its own for work-folded-layout.test.tsx to
 * bundle and load in a real browser: the transcript the app draws, through the renderers it
 * registers, from a conversation as a reload has it.
 *
 * `?state=done`: asked for the day's top articles, the Bot browsed the site, ran a command that
 * printed a screen of output, used Gmail, sent the person a file and answered; asked to invite
 * somebody, it is waiting for the person's approval. `?state=running`: the same command, still
 * running in a turn that is still going.
 */

const COMMAND =
  "curl -s \"https://dev.to/api/articles?top=1&per_page=5\" | python3 -c \"import json,sys; [print(i, a['title'], '|', a['user']['name'], '|', a['url']) for i, a in enumerate(json.load(sys.stdin), 1)]\"";
const PRINTED = [
  "1 The Price You Pay for Passion | Sylwia Laskowska | https://dev.to/thethirdcup/the-price-you-pay-for-passion-3h5l",
  "2 The mental toll of working in tech | Klaudia Grzondziel | https://dev.to/klaudiagrz/the-mental-toll-of-working-in-tech-2m6k",
  "3 Lazy Senior Dev Mode Made My App Smaller. Was It Better? | Earl Grey | https://dev.to/necoz/lazy-senior-dev-mode-made-my-app-smaller-was-it-better-90i",
  "4 Why Your AI Release Notes Hallucinate | John | https://dev.to/necoz/why-your-ai-release-notes-hallucinate-5ch0",
  "5 The Third Cup: You Don't Have to Fly That High | xulingfeng | https://dev.to/thethirdcup/the-third-cup-you-dont-have-to-fly-that-high-3ehd",
  ...Array.from(
    { length: 20 },
    (_, line) =>
      `debug: fetched page ${line + 1} of the feed in ${40 + line} ms`,
  ),
].join("\n");

type Call = { id: string; name: string; args: unknown; result?: unknown };

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
    ...(result === undefined
      ? []
      : [
          {
            id: `t-${index}`,
            role: "tool" as const,
            toolCallId: id,
            content:
              typeof result === "string" ? result : JSON.stringify(result),
          },
        ]),
  ];
}

const ASKED: Message = {
  id: "u1",
  role: "user",
  content:
    "Hello, can you look at Dev.to today, and tell me what the top 5 articles of the day are?",
};

const BROWSED: Call[] = [
  {
    id: "nav-1",
    name: "computer_navigate",
    args: { url: "https://dev.to" },
    result: { ok: true, url: "https://dev.to/", title: "DEV Community" },
  },
  {
    id: "snap-1",
    name: "computer_snapshot",
    args: {},
    result: { ok: true, elements: [{ ref: "e1" }, { ref: "e2" }] },
  },
];

const RAN: Call = {
  id: "run-1",
  name: "computer_run_command",
  args: { command: COMMAND },
  result: { ok: true, exitCode: 0, stdout: PRINTED, stderr: "" },
};

const GMAIL: Call[] = [1, 2].map((n) => ({
  id: `gmail-${n}`,
  name: "mcp__composio-gmail__GMAIL_FETCH_EMAILS",
  args: { query: "from:dev.to", page: n },
  result: '{"messages":[{"subject":"DEV Community Digest"}]}',
}));

const SENT: Call = {
  id: "send-1",
  name: SEND_FILE_TOOL,
  args: { path: "top-articles.csv" },
  result: {
    ok: true,
    file: {
      attachmentId: "7f1c2a9e-0b5d-4c41-9a37-2f8e6d4b1c01",
      name: "top-articles.csv",
      mimeType: "text/csv",
      sizeBytes: 1843,
      url: "/api/attachments/7f1c2a9e-0b5d-4c41-9a37-2f8e6d4b1c01",
    },
  },
};

const INVITE: Call = {
  id: "invite-1",
  name: "mcp__arcade-GoogleCalendar__CreateEvent",
  args: {
    summary: "Read the top 5 together",
    attendee_emails: ["sam@example.com"],
  },
};

const ANSWER =
  "Here are today's top 5 articles on Dev.to:\n\n1. **The Price You Pay for Passion** by Sylwia Laskowska\n2. **The mental toll of working in tech** by Klaudia Grzondziel\n3. **Lazy Senior Dev Mode Made My App Smaller. Was It Better?** by Earl Grey\n4. **Why Your AI Release Notes Hallucinate** by John\n5. **The Third Cup: You Don't Have to Fly That High** by xulingfeng\n\nI've put them in a spreadsheet for you too.";

const state = new URLSearchParams(location.search).get("state") ?? "done";

const done: Message[] = [
  ASKED,
  ...[...BROWSED, RAN, ...GMAIL, SENT].flatMap((step, index) =>
    call(index, step),
  ),
  { id: "answer", role: "assistant", content: ANSWER },
  {
    id: "u2",
    role: "user",
    content: "Invite Sam to read them with me on Friday.",
  },
  ...call(20, INVITE),
];

const running: Message[] = [
  ASKED,
  ...[...BROWSED, { ...RAN, result: undefined }].flatMap((step, index) =>
    call(index, step),
  ),
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
    requests: [
      {
        id: "approval-1",
        status: "pending",
        createdAt: "2026-11-25T10:00:00.000Z",
        action: {
          botId: "general-assistant",
          toolRef: "arcade-GoogleCalendar/CreateEvent",
          effect: "write",
          scope: "arcade-GoogleCalendar",
          threadId: "thread-1",
          toolCallId: INVITE.id,
          args: INVITE.args,
          target: {},
          policy: {
            behaviour: "ask",
            source: "safety",
            reason: "Sending something to other people asks you first.",
            kind: "sending",
          },
        },
      },
    ],
    rules: [],
    teamRules: [],
    questions: [],
  });
  if (approvals) return approvals;
  if (url.pathname.includes("/attachments/"))
    return new Response(null, { status: 200 });
  if (url.origin === location.origin)
    return Response.json({ error: "not served" }, { status: 404 });
  return realFetch(input, init);
}) as typeof fetch;

function Page() {
  return (
    <main className="bg-background text-foreground" data-state={state}>
      <QueryClientProvider client={queryClient}>
        <CopilotKitProvider runtimeUrl="/api/copilotkit">
          <ComputerTools />
          <section aria-label="Conversation" className="flex flex-col">
            <ChatTranscript
              busy={state === "running"}
              messages={state === "running" ? running : done}
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
