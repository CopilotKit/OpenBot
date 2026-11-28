import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import type { Message } from "@ag-ui/core";
import { CopilotKitProvider } from "@copilotkit/react-core/v2";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, within } from "@testing-library/react";
import { ChatTranscript } from "@/components/channels/chat-transcript";
import { queryClient } from "@/query-client";
import { approvalInboxResponse } from "./approvals-api";
import {
  CALLS,
  type Call,
  waitingRequests,
} from "./settings-tool-cards-admin.calls";
import { settleReactWork } from "./settle-react-work";

/**
 * An admin's change to the organization, drawn in the conversation by its own card: waiting on the
 * person with the tool's own before and after and who it reaches, then as what came of it, from the
 * result the server wrote. The transcript draws the same thing live and from history after a
 * reload, so this is both. The same calls are drawn in a real browser, beside the Admin screens, by
 * settings-tool-cards-admin-layout.test.tsx.
 */

const originalFetch = globalThis.fetch;

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  globalThis.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0]) => {
      const url = new URL(
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url,
        "http://localhost",
      );
      const approvals = approvalInboxResponse(url.pathname, {
        requests: waitingRequests(),
      });
      if (approvals) return approvals;
      return Response.json({ error: "not served" }, { status: 404 });
    },
    { preconnect: originalFetch.preconnect },
  );
});

afterEach(() => {
  cleanup();
  queryClient.clear();
});

afterAll(async () => {
  await settleReactWork();
  globalThis.fetch = originalFetch;
  GlobalRegistrator.unregister();
});

function messagesOf(calls: readonly Call[]): Message[] {
  return calls.flatMap((call): Message[] => [
    { id: `${call.id}-ask`, role: "user", content: call.ask },
    {
      id: `${call.id}-call`,
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id: call.id,
          type: "function",
          function: {
            name: `mcp__openbot-settings__${call.tool}`,
            arguments: JSON.stringify(call.args),
          },
        },
      ],
    },
    ...(call.result === undefined
      ? []
      : [
          {
            id: `${call.id}-result`,
            role: "tool" as const,
            toolCallId: call.id,
            content: call.result,
          },
        ]),
  ]);
}

/** The conversation, at an address of the app's router as every conversation is: its cards link. */
function draw(scene: Call["scene"]) {
  const root = createRootRoute({
    component: () => (
      <ChatTranscript
        busy={false}
        messages={messagesOf(CALLS.filter((call) => call.scene === scene))}
        restoring={false}
      />
    ),
  });
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: root,
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <CopilotKitProvider>
        <RouterProvider router={router as never} />
      </CopilotKitProvider>
    </QueryClientProvider>,
  );
}

const cardsOf = (container: HTMLElement) => [
  ...container.querySelectorAll<HTMLElement>("[data-slot=admin-change-card]"),
];

test("making somebody an admin asks with the role before and after and who it reaches, then says it changed", async () => {
  const view = draw("people");
  const waiting = within(
    await view.findByRole("region", { name: "Waiting for your approval" }),
  );
  expect(
    waiting.getByText("Make Sam Ortiz an admin of Northwind Freight"),
  ).toBeTruthy();
  expect(waiting.getByText("Sam Ortiz's role")).toBeTruthy();
  expect(waiting.getByText("Member")).toBeTruthy();
  expect(waiting.getByText("Admin")).toBeTruthy();
  expect(
    waiting.getByText("Sam Ortiz can manage everything in Admin"),
  ).toBeTruthy();
  expect(waiting.getByText("Gains access")).toBeTruthy();
  // Asked every time: only once, or no.
  expect(
    waiting.queryByRole("radio", { name: "Always allow here" }),
  ).toBeNull();

  await view.findByText(
    "Copy the link and send it to lena.koch@northwind.example.",
  );
  const cards = cardsOf(view.container);
  // The change made, the invitation, and the refusal: one card each.
  expect(cards.map((card) => card.dataset.state)).toEqual([
    "done",
    "done",
    "refused",
  ]);
  const [made, invited, refused] = cards.map((card) => within(card));
  expect(made?.getByText("Changed")).toBeTruthy();
  expect(made?.getByText("Open Organization settings")).toBeTruthy();
  expect(
    invited?.getByRole("button", {
      name: "Copy link for lena.koch@northwind.example",
    }),
  ).toBeTruthy();
  expect(
    refused?.getByText(
      "They own this organization. Owners can't be removed or have their role changed here. An owner can change ownership in Organization settings.",
    ),
  ).toBeTruthy();
  expect(refused?.getByText("Not changed")).toBeTruthy();
});

test("a change to the settings and switches names each one as its screen does, and who loses access", async () => {
  const view = draw("settings");
  const waiting = within(
    await view.findByRole("region", { name: "Waiting for your approval" }),
  );
  expect(waiting.getByText("Action Recording")).toBeTruthy();
  expect(waiting.getByText("Check-ins · Members")).toBeTruthy();
  expect(waiting.getAllByText("Loses access").length).toBe(4);
  expect(waiting.getByText("And 9 more people.")).toBeTruthy();
  const [done] = cardsOf(view.container);
  if (!done) throw new Error("no card for the change that ran");
  expect(within(done).getByText("Open Permissions")).toBeTruthy();
  expect(
    within(done).getByText("Northwind Freight · Organization settings"),
  ).toBeTruthy();
});

test("a team moved says where it sits now and that its people get what the new parent is given", async () => {
  const view = draw("teams");
  await view.findByRole("region", { name: "Waiting for your approval" });
  const [moved, added] = cardsOf(view.container).map((card) => within(card));
  expect(moved?.getByText("Move Sales EMEA under Sales")).toBeTruthy();
  expect(moved?.getByText("Top level")).toBeTruthy();
  expect(
    moved?.getByText(
      "Everyone in Sales EMEA (3 people). They get what Sales is given",
    ),
  ).toBeTruthy();
  expect(added?.getByText("Maintainer")).toBeTruthy();
});
