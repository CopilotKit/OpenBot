import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import type { Message } from "@ag-ui/core";
import { CopilotKitProvider } from "@copilotkit/react-core/v2";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  DELEGATE_TOOL,
  frameBrief,
  taskReportMessageId,
} from "@openbot/shared/orchestration";
import { SEND_FILE_TOOL } from "@openbot/shared/send-file";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, waitFor } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { ChatTranscript } from "@/components/channels/chat-transcript";
import { attachmentAddress } from "@/lib/channels/attachments";
import { ComputerTools } from "@/lib/copilot/computer-tools";
import { settleReactWork } from "./settle-react-work";

/**
 * A file a Bot sends is seen where the person reads, without opening anything.
 *
 * FOUND BY THE END-TO-END PASS. Asked in a conversation to make a CSV and send it, Personal
 * Assistant handed the work to a task, as it does. The file was stored, but no card showed
 * anywhere: in the task's thread the send folded into "Worked for 13s" with the other steps, and the
 * report in the conversation that asked carried only the words, "Created and sent team-budget.csv",
 * with no card at all.
 *
 * Both threads below are the real run's, as its API answered them (test-20261117-71, Desktop): the
 * brief, a line on the way and the write, the send and its answer, and the report. The report is
 * written the way the server writes one with what the work drew: the words, then each drawn call
 * and its answer under the same message. The transcript and the tools are the app's own; the server
 * is faked at the HTTP boundary only.
 */

const ATTACHMENT = "bffdecae-4a19-48ea-b363-d1842fa33791";
const SENT = JSON.stringify({
  ok: true,
  file: {
    attachmentId: ATTACHMENT,
    name: "team-budget.csv",
    mimeType: "text/csv",
    sizeBytes: 84,
    url: `/api/attachments/${ATTACHMENT}`,
  },
  finishedAt: "2026-11-17T20:57:38.110Z",
});
const REPORT = `Created and sent [team-budget.csv](/api/attachments/${ATTACHMENT}) with three made-up budget lines.`;
const TASK_ID = "68a24229-7ffb-4e2d-98f4-f684f7e92f4f";

const task = {
  id: TASK_ID,
  botId: "personal-assistant",
  conversationId: "channel_task",
  threadId: "thread_task",
  title: "Create and send team budget CSV",
  why: null,
  origin: "delegated",
  suggestionId: null,
  sourceApp: null,
  sourceLink: null,
  originConversationId: "channel_main",
  status: "ready_for_review",
  failure: null,
  failedAt: null,
  stoppedAt: null,
  workingSince: null,
  tryingAgainAt: null,
  lastActivityAt: "2026-11-17T20:57:40.000Z",
  next: REPORT,
  resolvedAt: null,
  createdAt: "2026-11-17T20:57:25.000Z",
  updatedAt: "2026-11-17T20:57:40.000Z",
};
const server = setupServer(
  http.get("*/api/v2/organizations/:organizationId/tasks", () =>
    HttpResponse.json({ tasks: [task], nextCursor: null }),
  ),
  http.get("*/api/v2/organizations/:organizationId/tasks/:id/turns", () =>
    HttpResponse.json({
      turns: [
        {
          askId: `task-${TASK_ID}`,
          startedAt: "2026-11-17T20:57:25.000Z",
          endedAt: "2026-11-17T20:57:38.000Z",
          workedSeconds: 13,
          runs: 1,
          model: "gpt-5.1",
        },
      ],
      nextCursor: null,
    }),
  ),
  http.get("*/api/v2/organizations/:organizationId/bots", () =>
    HttpResponse.json({
      bots: [{ id: "personal-assistant", name: "Personal Assistant" }],
      nextCursor: null,
    }),
  ),
  // The card asks whether its file is still there, at the conversation's attachment address.
  http.head(
    "*/api/v2/organizations/:organizationId/attachments/:id",
    () => new HttpResponse(null, { status: 200 }),
  ),
  // Nothing else on this screen bears on the test.
  http.all("*", () => new HttpResponse(null, { status: 404 })),
);

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  server.listen({ onUnhandledRequest: "bypass" });
});
afterEach(() => {
  cleanup();
  server.resetHandlers();
});
afterAll(async () => {
  server.close();
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const call = (id: string, name: string, args: object) => ({
  id,
  type: "function" as const,
  function: { name, arguments: JSON.stringify(args) },
});

/** The task's thread, as the real run stored it. */
const taskThread: Message[] = [
  {
    id: `task-${TASK_ID}`,
    role: "user",
    content: frameBrief(
      "On your computer, write a small CSV file named team-budget.csv with the exact header row item,owner,amount and three made-up budget lines. Send the file to the user in this chat so they can download it. Do not paste the contents.",
    ),
  },
  {
    id: "msg_0fb5961ed9816a4b",
    role: "assistant",
    content:
      "I’ll create the CSV on my computer and send it here for download.",
    toolCalls: [
      call("call_write", "computer_write_file", {
        path: "team-budget.csv",
        content: "item,owner,amount\n",
      }),
    ],
  },
  {
    id: "f65c068b-7800-4ae7-8a98-9e8682e7bf48",
    role: "tool",
    toolCallId: "call_write",
    content: JSON.stringify({
      ok: true,
      path: "team-budget.csv",
      bytes: 84,
      appended: false,
      finishedAt: "2026-11-17T20:57:34.068Z",
    }),
  },
  {
    id: "ce480438-33e6-4cf5-b84f-617e7df4495b",
    role: "assistant",
    content: "",
    toolCalls: [call("call_send", SEND_FILE_TOOL, { path: "team-budget.csv" })],
  },
  {
    id: "3ea0ed53-4f3d-4a47-a244-5c236aa979f1",
    role: "tool",
    toolCallId: "call_send",
    content: SENT,
  },
  { id: "msg_0875b0466cf3e3cc", role: "assistant", content: REPORT },
];

/** The conversation that asked, with the task's report as the server writes it into it. */
const reportId = taskReportMessageId(
  "result",
  TASK_ID,
  "4c6f2c7f3ad1163d24ac1d28641c14ec",
);
const askingConversation: Message[] = [
  {
    id: "d0dc33ec-e4f7-45da-b18f-99057187e4f0",
    role: "user",
    content:
      "On your computer, write a small CSV file named team-budget.csv with a header row (item,owner,amount) and three made-up budget lines, then send that file to me in this chat so I can download it. Don't paste its contents, send the file.",
  },
  {
    id: "msg_0635dab8d46a7247",
    role: "assistant",
    content: "I’ll create the CSV and send it here for download.",
    toolCalls: [
      call("call_delegate", DELEGATE_TOOL, {
        title: "Create and send team budget CSV",
      }),
    ],
  },
  {
    id: "504a6acb-af8e-4fac-9d01-fb7aa59dd01d",
    role: "tool",
    toolCallId: "call_delegate",
    content: JSON.stringify(
      JSON.stringify({
        taskId: TASK_ID,
        channelId: "channel_task",
        title: "Create and send team budget CSV",
      }),
    ),
  },
  {
    id: reportId,
    role: "assistant",
    content: REPORT,
    toolCalls: [
      call("call_drawn_0", SEND_FILE_TOOL, { path: "team-budget.csv" }),
    ],
  },
  {
    id: "call_drawn_0:result",
    role: "tool",
    toolCallId: "call_drawn_0",
    content: SENT,
  },
];

function draw(messages: Message[], threadId: string) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const rootRoute = createRootRoute({
    component: () => (
      <CopilotKitProvider>
        <ComputerTools />
        <ChatTranscript
          messages={messages}
          restoring={false}
          threadId={threadId}
        />
        <Outlet />
      </CopilotKitProvider>
    ),
  });
  const routeTree = rootRoute.addChildren([
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/channel/$channelId",
      component: () => <p>a conversation</p>,
    }),
  ]);
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return Object.assign(
    render(
      <QueryClientProvider client={client}>
        <RouterProvider router={router as never} />
      </QueryClientProvider>,
    ),
    { router },
  );
}

const CARD = 'figure[aria-label="File from the Bot: team-budget.csv"]';

test("in the task's thread the sent file's card stands outside Worked for, before the answer", async () => {
  const view = draw(taskThread, "thread_task");
  await waitFor(() =>
    expect(
      view.container.querySelector('[data-slot="worked-for"]'),
    ).not.toBeNull(),
  );
  await waitFor(() =>
    expect(view.container.querySelector(CARD)).not.toBeNull(),
  );
  const card = view.container.querySelector(CARD) as HTMLElement;
  // Seen without opening anything: not inside the fold's disclosure.
  expect(card.closest("details")).toBeNull();
  expect(card.closest('[data-slot="worked-for"]')).toBeNull();
  // The work still folds: the write is a step inside it.
  const fold = view.container.querySelector(
    '[data-slot="worked-for"] details',
  ) as HTMLDetailsElement;
  expect(fold.open).toBe(false);
  // The card comes before the answer's words.
  const answer = view.getByText(/with three made-up budget lines/);
  expect(
    card.compareDocumentPosition(answer) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
});

test("in the conversation that asked, the task's report shows the card, now and on reload", async () => {
  // A reload draws from the stored thread, which is this same list: drawn twice, from scratch.
  for (let pass = 0; pass < 2; pass += 1) {
    const view = draw(askingConversation, "thread_main");
    await waitFor(() =>
      expect(view.container.querySelector(CARD)).not.toBeNull(),
    );
    const card = view.container.querySelector(CARD) as HTMLElement;
    expect(card.closest("details")).toBeNull();
    expect(card.textContent).toContain("CSV · 84 bytes");
    expect(view.getByText(/with three made-up budget lines/)).toBeTruthy();
    cleanup();
  }
});

/*
 * AND THE NAME IN THE WORDS IS THE FILE TOO. The Bot links the file's name to its stored address,
 * `/api/attachments/<id>`, which read as a page of the app: a click asked the router for it, found
 * no such page, and landed on home. So no click in the chat ever gave the person the file. It is a
 * download of the file from the conversation's own address, as the card's Download button is.
 */
test("the file's name in the Bot's words downloads the file instead of leaving the conversation", async () => {
  const view = draw(askingConversation, "thread_main");
  const link = await view.findByRole("link", { name: "team-budget.csv" });
  expect(link.getAttribute("href")).toBe(
    attachmentAddress(`/api/attachments/${ATTACHMENT}`),
  );
  expect(link.hasAttribute("download")).toBe(true);
  link.click();
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(view.router.state.location.pathname).toBe("/");
  expect(view.router.state.location.href).not.toContain("/api/");
});
