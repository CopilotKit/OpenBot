import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { InlineApproval } from "@/components/approvals/inline-approval";
import { WaitingForYou } from "@/components/approvals/waiting";
import { settleReactWork } from "./settle-react-work";

/*
 * What an approval says it is waiting on. An app's tool is asked about as `<app>/<tool>` on the app,
 * and the card in the conversation once read "Waiting for your approval: requests/get request on
 * requests", the app's key twice and the tool's raw name, where a computer action reads "click on
 * example.com". Both places a person decides one in the browser: the card in the conversation, and
 * the row on the Bot's page.
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

/** A pending request as `GET /api/approvals` returns it. */
const request = (
  id: string,
  toolRef: string,
  scope: string,
  args: Record<string, unknown>,
) => ({
  id,
  status: "pending",
  createdAt: "2026-10-30T22:00:00Z",
  action: {
    actorId: "me",
    botId: "assistant",
    toolRef,
    effect: "write",
    scope,
    threadId: `thread-${id}`,
    runId: `run-${id}`,
    toolCallId: `call-${id}`,
    actionDigest: `digest-${id}`,
    args,
    target: null,
    policy: {
      behaviour: "ask",
      source: "task",
      reason: "Tasks started from a check-in ask before every change.",
    },
  },
});

function serving() {
  global.fetch = (async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path === "/api/approvals")
      return Response.json({
        enabled: false,
        rules: [],
        teamRules: [],
        questions: [],
        requests: [
          // An MCP server the admin added, and an app through a broker.
          request("mcp", "requests/get_request", "requests", {
            id: "r-expense",
          }),
          request(
            "brokered",
            "composio-gmail/GMAIL_SEND_EMAIL",
            "composio-gmail",
            { to: "sam@example.test" },
          ),
          request("computer", "computer_click", "example.com", {
            ref: "e12",
          }),
        ],
      });
    if (path.startsWith("/api/agents"))
      return Response.json({
        agents: [{ id: "assistant", name: "General Assistant" }],
      });
    return Response.json({ error: "not served" }, { status: 404 });
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

test("in the conversation, an app's approval names the action in words and the app by its name", async () => {
  serving();
  const view = draw(
    <>
      <InlineApproval toolCallId="call-mcp" fallback={null} />
      <InlineApproval toolCallId="call-brokered" fallback={null} />
      <InlineApproval toolCallId="call-computer" fallback={null} />
    </>,
  );
  const cards = await view.findAllByRole("region", {
    name: "Waiting for your approval",
  });
  expect(cards.map((card) => card.querySelector("p")?.textContent)).toEqual([
    "Waiting for your approval: get request on Requests",
    "Waiting for your approval: send email on Gmail",
    "Waiting for your approval: click on example.com",
  ]);
});

test("on the Bot's page, the row says what the Bot wants to do, over the app's name", async () => {
  serving();
  const view = draw(<WaitingForYou agentId="assistant" />);
  const row = (await view.findByText("General Assistant wants to get request"))
    .parentElement as HTMLElement;
  expect(row.textContent).toContain("Requests");
  expect(row.textContent).not.toContain("requests/");
  expect(
    view.getByText("General Assistant wants to send email").parentElement
      ?.textContent,
  ).toContain("Gmail");
  expect(view.getByText("General Assistant wants to click")).toBeTruthy();
  expect(view.container.textContent).not.toContain("composio");
});
