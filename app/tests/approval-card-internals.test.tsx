import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { WaitingForYou } from "@/components/approvals/waiting";
import { BotNeedsYou } from "@/components/needs-you/board";
import { settleReactWork } from "./settle-react-work";

/*
 * FOUND IN THE 1.0 RC1 MAC PASS: a pending click's "Needs you" card read "Click / en.wikipedia.org"
 * over a raw block, `{ "ref": "f3e43", "snapshotId": 4 }`. Those are the handles the model cites for
 * an element on a page snapshot, and nobody deciding can read them. The card names the link from the
 * label the server resolved, and shows only what the action would send.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

/** A pending computer action as `GET /api/approvals` returns it (`publicApproval`). */
const request = (
  id: string,
  toolRef: string,
  args: Record<string, unknown>,
  element: { ref: string; role: string; name: string },
) => ({
  id,
  status: "pending",
  createdAt: "2026-11-08T10:00:00Z",
  action: {
    botId: "researcher",
    toolRef,
    effect: "write",
    scope: "en.wikipedia.org",
    threadId: `thread-${id}`,
    toolCallId: `call-${id}`,
    args,
    target: {
      pageUrl: "https://en.wikipedia.org/wiki/Main_Page",
      element: { ...element, type: "" },
      snapshotId: 4,
    },
  },
});

function serving() {
  global.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/approvals")
      return Response.json({
        enabled: true,
        rules: [],
        teamRules: [],
        questions: [],
        requests: [
          request(
            "click",
            "computer_click",
            { ref: "f3e43", snapshotId: 4 },
            {
              ref: "f3e43",
              role: "link",
              name: "Python (programming language)",
            },
          ),
          request(
            "type",
            "computer_type",
            { ref: "f7", snapshotId: 4, text: "monty python" },
            { ref: "f7", role: "searchbox", name: "Search Wikipedia" },
          ),
        ],
      });
    if (url === "/api/proactive/suggestions")
      return Response.json({ suggestions: [] });
    if (url === "/api/tasks") return Response.json({ tasks: [] });
    if (url.startsWith("/api/channels"))
      return Response.json({ channels: [], nextCursor: null });
    return Response.json({
      agents: [{ id: "researcher", name: "Researcher" }],
    });
  }) as unknown as typeof fetch;
}

function draw(node: ReactNode) {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      {node}
    </QueryClientProvider>,
  );
}

/** Nothing the model cites, and no raw JSON, anywhere a person reads. */
function expectNoInternals(text: string) {
  expect(text).not.toContain("snapshotId");
  expect(text).not.toContain("f3e43");
  expect(text).not.toContain('"ref"');
  expect(text).not.toContain("computer_");
  expect(text).not.toContain("{");
}

test("on the Needs you board, a click names the link and shows no raw JSON", async () => {
  serving();
  const view = draw(<BotNeedsYou agentId="researcher" />);
  expect(
    await view.findByText("Click the link “Python (programming language)”"),
  ).toBeTruthy();
  expect(view.getByText("Fill in “Search Wikipedia”")).toBeTruthy();
  // What a typing step would send is still shown whole, by its label.
  expect(view.getByText("Text")).toBeTruthy();
  expect(view.getByText("monty python")).toBeTruthy();
  expect(view.getAllByText("en.wikipedia.org").length).toBeGreaterThan(0);
  expectNoInternals(view.container.textContent ?? "");
});

test("on the Bot's page, a click says what the Bot wants to do and shows no raw JSON", async () => {
  serving();
  const view = draw(<WaitingForYou agentId="researcher" />);
  expect(
    await view.findByText(
      "Researcher wants to click the link “Python (programming language)”",
    ),
  ).toBeTruthy();
  expect(view.getByText("monty python")).toBeTruthy();
  expectNoInternals(view.container.textContent ?? "");
});
