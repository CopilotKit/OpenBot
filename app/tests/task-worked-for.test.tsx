import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import type { Message } from "@ag-ui/core";
import { CopilotKitProvider } from "@copilotkit/react-core/v2";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { frameBrief } from "@openbot/shared/orchestration";
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
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { ChatTranscript } from "@/components/channels/chat-transcript";
import type { TranscriptItem } from "@/components/channels/tool-activity";
import { foldTurnWork } from "@/components/tasks/turn-work";
import { settleReactWork } from "./settle-react-work";

/**
 * A task's thread reads the way dots reads one: what it was asked, one "Worked for 52s" row, and
 * what it came back with. The steps it took and what it said on the way fold into that row, which
 * opens to them; how long is the server's, from listTaskTurns. A turn the server has not listed
 * says how many steps it took.
 *
 * The transcript is the real one; the server is faked at the HTTP boundary only, in the API's
 * shapes, through the client generated from api/openapi.yaml.
 */

const task = {
  id: "task-1",
  botId: "general-assistant",
  conversationId: "channel_task",
  threadId: "thread_task",
  title: "Check tonight's doors time",
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
  lastActivityAt: "2026-11-15T21:00:52.000Z",
  next: "Doors open at 7:00 p.m.",
  resolvedAt: null,
  createdAt: "2026-11-15T21:00:00.000Z",
  updatedAt: "2026-11-15T21:00:52.000Z",
};
let turns: unknown[] = [];
const server = setupServer(
  http.get("*/api/v2/organizations/:organizationId/tasks", () =>
    HttpResponse.json({ tasks: [task], nextCursor: null }),
  ),
  http.get("*/api/v2/organizations/:organizationId/tasks/:id/turns", () =>
    HttpResponse.json({ turns, nextCursor: null }),
  ),
  http.get("*/api/v2/organizations/:organizationId/bots", () =>
    HttpResponse.json({
      bots: [{ id: "general-assistant", name: "General Assistant" }],
      nextCursor: null,
    }),
  ),
  // Nothing else on this screen bears on the test: what waits on the person, the approval rules.
  http.all("*", () => new HttpResponse(null, { status: 404 })),
);

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  server.listen({ onUnhandledRequest: "error" });
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

const NARRATION = "Let me read the venue's listing first.";
const ANSWER = "Doors open at 7:00 p.m. tonight, and the show starts at 8.";

/** The task's thread as its history holds it: the brief, a line on the way, a step, the answer. */
const history: Message[] = [
  {
    id: "brief",
    role: "user",
    content: frameBrief("Find out when doors open tonight."),
  },
  { id: "said-on-the-way", role: "assistant", content: NARRATION },
  {
    id: "looked",
    role: "assistant",
    content: "",
    toolCalls: [
      {
        id: "call-fetch",
        type: "function",
        function: {
          name: "mcp__web__fetch",
          arguments: '{"url":"https://venue.example/tonight"}',
        },
      },
    ],
  },
  {
    id: "fetched",
    role: "tool",
    toolCallId: "call-fetch",
    content: "Doors 7:00 p.m., show 8:00 p.m.",
  },
  { id: "answer", role: "assistant", content: ANSWER },
];

function draw() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const rootRoute = createRootRoute({
    component: () => (
      <CopilotKitProvider>
        <ChatTranscript
          messages={history}
          restoring={false}
          threadId="thread_task"
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
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

/** The one row a turn's work folds into. */
const workedFor = (container: HTMLElement) =>
  container.querySelector<HTMLElement>('[data-slot="worked-for"]');

test("a finished turn folds its steps and what it said on the way into one Worked for row, timed by the server, with its answer under it", async () => {
  turns = [
    {
      askId: "brief",
      startedAt: "2026-11-15T21:00:00.000Z",
      endedAt: "2026-11-15T21:00:52.000Z",
      workedSeconds: 52,
      runs: 1,
      model: "gpt-5.1",
    },
  ];
  const view = draw();

  await waitFor(() =>
    expect(workedFor(view.container)?.textContent).toContain("Worked for 52s"),
  );
  const row = workedFor(view.container);
  if (!row) throw new Error("No Worked for row.");
  // One row for the work: the line said on the way and the step are inside it, closed.
  expect(
    view.container.querySelectorAll('[data-slot="worked-for"]').length,
  ).toBe(1);
  const fold = row.querySelector("details");
  expect(fold?.open).toBe(false);
  expect(fold?.textContent).toContain(NARRATION);
  // The answer stands on its own, after the row.
  const answer = view.getByText(ANSWER);
  expect(row.contains(answer)).toBe(false);
  expect(
    row.compareDocumentPosition(answer) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();

  // It opens to the steps.
  await userEvent.click(view.getByText("Worked for 52s"));
  expect(fold?.open).toBe(true);
});

test("a turn the server has not listed says how many steps it took", async () => {
  turns = [];
  const view = draw();
  await waitFor(() =>
    expect(workedFor(view.container)?.textContent).toContain(
      "Worked through 1 step",
    ),
  );
  expect(view.getByText(ANSWER)).toBeTruthy();
});

test("a step the app draws as its own card folds too, and what is drawn for the person stays out", () => {
  const step = (
    id: string,
    name: string,
    args: Record<string, unknown>,
    result?: string,
  ) => ({
    kind: "tool" as const,
    id,
    toolCall: {
      id,
      type: "function" as const,
      function: { name, arguments: JSON.stringify(args) },
    },
    ...(result === undefined ? {} : { result }),
  });
  const items: TranscriptItem[] = [
    { kind: "text", id: "brief", role: "user", text: "Read the page." },
    // A command it ran, drawn as Claude Code's command card: a step of the work.
    step(
      "bash",
      "Bash",
      { command: "curl -s https://example.com" },
      "<html>…</html>",
    ),
    // A request for the person's help: drawn for them, never folded away.
    step("help", "computer_request_help", { reason: "A captcha" }, "Done."),
    // A step still waiting (an approval on its way): stays out until it has an answer.
    step("waiting", "computer_click", { ref: "e1" }),
    { kind: "text", id: "answer", role: "assistant", text: "Done." },
  ];
  const folds = foldTurnWork(items, false);
  expect([...folds.inside]).toEqual(["bash"]);
  expect(folds.at.get("bash")?.askId).toBe("brief");
});

test("a run of steps holding one still waiting on the person stays out of the fold, so its approval card is there to answer", () => {
  const step = (id: string, name: string, result?: string) => ({
    kind: "tool" as const,
    id,
    toolCall: {
      id,
      type: "function" as const,
      function: { name, arguments: "{}" },
    },
    ...(result === undefined ? {} : { result }),
  });
  // A browser checkout as the approvals journeys draw it: two steps done, the third (Place order)
  // held for the person's approval, its card drawn under the run's line.
  const run = (id: string, last?: string): TranscriptItem => ({
    kind: "tools",
    id: `group:${id}`,
    steps: [
      step(`${id}-open`, "computer_navigate", "Opened the shop."),
      step(`${id}-add`, "computer_click", "Added to the cart."),
      step(`${id}-pay`, "computer_click", last),
    ],
  });
  const items: TranscriptItem[] = [
    {
      kind: "text",
      id: "brief",
      role: "user",
      text: "Order the tomato seeds.",
    },
    { kind: "text", id: "on-it", role: "assistant", text: "Opening the shop." },
    run("checkout"),
  ];
  // The turn is over (the task waits on the person): the run and its card stay where they are, and
  // what the Bot said last reads as the turn's words, so nothing is left to fold.
  expect([...foldTurnWork(items, false).inside]).toEqual([]);
  // A turn the person typed into the thread can still read as running while its step waits on
  // their approval: the inbox says it waits, so the run and its card stay out all the same.
  expect([
    ...foldTurnWork(items, true, new Set(["checkout-pay"])).inside,
  ]).toEqual(["on-it"]);
  // While the turn still runs, the step is only working, and folds with the rest.
  expect([...foldTurnWork(items, true).inside]).toEqual([
    "on-it",
    "group:checkout",
  ]);
  // Once answered, the run is work like any other.
  const answered: TranscriptItem[] = [
    ...items.slice(0, 2),
    run("checkout", "Placed the order."),
    { kind: "text", id: "answer", role: "assistant", text: "Ordered." },
  ];
  expect([...foldTurnWork(answered, false).inside]).toEqual([
    "on-it",
    "group:checkout",
  ]);
});
