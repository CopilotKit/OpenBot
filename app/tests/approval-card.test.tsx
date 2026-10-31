import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { ApprovalCard } from "@/components/approvals/approval-card";
import type { ApprovalRequest } from "@/lib/approvals";
import { settleReactWork } from "./settle-react-work";

/**
 * The approval card on its own: what a person reads before they say yes, and where they go to take
 * a yes back.
 */

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
afterEach(() => cleanup());
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const click = (
  overrides: Partial<ApprovalRequest> = {},
  action: Partial<ApprovalRequest["action"]> = {},
): ApprovalRequest => ({
  id: "approval-1",
  status: "pending",
  createdAt: "2026-10-30T10:00:00Z",
  action: {
    botId: "shopper",
    toolRef: "computer_click",
    effect: "write",
    scope: "shop.example",
    threadId: "thread-1",
    toolCallId: "call-1",
    args: { ref: "e7", snapshotId: 3 },
    target: {
      pageUrl: "https://shop.example/checkout",
      element: { ref: "e7", role: "button", name: "Place order" },
      snapshotId: 3,
    },
    policy: { behaviour: "ask", source: "default", reason: "Changes ask." },
    ...action,
  },
  ...overrides,
});

test("a browser step's card says which element, on which page, and Details carries the target", () => {
  const card = render(<ApprovalCard onDecide={() => {}} request={click()} />);
  expect(card.getByText("Button")).toBeTruthy();
  expect(card.getByText("Place order")).toBeTruthy();
  expect(card.getByText("shop.example/checkout")).toBeTruthy();
  const details = card.container.querySelector("details pre")?.textContent;
  expect(JSON.parse(details ?? "{}")).toEqual({
    args: { ref: "e7", snapshotId: 3 },
    target: {
      pageUrl: "https://shop.example/checkout",
      element: { ref: "e7", role: "button", name: "Place order" },
      snapshotId: 3,
    },
  });
});

test("a request with nothing as its target keeps Details to its arguments", () => {
  const card = render(
    <ApprovalCard
      onDecide={() => {}}
      request={click({}, { target: {}, args: { url: "https://a.example" } })}
    />,
  );
  const details = card.container.querySelector("details pre")?.textContent;
  expect(JSON.parse(details ?? "{}")).toEqual({ url: "https://a.example" });
});

/** The card inside the app's router, where its link to the Bot's rules can go somewhere. */
function routed(card: ReactNode) {
  const root = createRootRoute();
  const page = createRoute({
    getParentRoute: () => root,
    path: "/",
    component: () => card,
  });
  const rules = createRoute({
    getParentRoute: () => root,
    path: "/bots/$agentId/approvals",
    component: () => null,
  });
  const router = createRouter({
    routeTree: root.addChildren([page, rules]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return render(<RouterProvider router={router as never} />);
}

test("a rule that reaches the whole browser reads as a caution; one site stays quiet", async () => {
  const broad = render(
    <ApprovalCard
      onDecide={() => {}}
      request={click({}, { scope: "browser", target: {} })}
    />,
  );
  const wide = broad.getByText(
    /won't ask you again before doing this in its browser/,
  );
  expect(wide.className).toContain("text-status-needs");
  expect(wide.querySelector("svg")).toBeTruthy();
  cleanup();
  const narrow = render(<ApprovalCard onDecide={() => {}} request={click()} />);
  const site = narrow.getByText(
    /won't ask you again before doing this on shop.example/,
  );
  expect(site.className).toContain("text-muted-foreground");
  expect(site.className).not.toContain("text-status-needs");
});

test("Always allow here links to the Bot's Approval rules, waiting and once it is saved", async () => {
  const waiting = routed(
    <ApprovalCard onDecide={() => {}} request={click()} />,
  );
  const link = await waitFor(() =>
    waiting.getByRole("link", { name: "Approval rules" }),
  );
  expect(link.getAttribute("href")).toBe("/bots/shopper/approvals");
  cleanup();
  const saved = routed(
    <ApprovalCard
      request={click({
        status: "approved",
        decision: "allow_always",
        decidedAt: "2026-10-30T10:01:00Z",
      })}
    />,
  );
  await waitFor(() => saved.getByRole("link", { name: "Approval rules" }));
  cleanup();
  // Allowed once saves no rule, so there is nothing to remove.
  const once = routed(
    <ApprovalCard
      request={click({
        status: "approved",
        decision: "allow_once",
        decidedAt: "2026-10-30T10:01:00Z",
      })}
    />,
  );
  await waitFor(() => once.getByText("Allowed once by you"));
  expect(once.queryByRole("link", { name: "Approval rules" })).toBeNull();
});

test("the card names whose rule asked, when the request says", () => {
  const card = render(
    <ApprovalCard
      onDecide={() => {}}
      request={click(
        {},
        {
          policy: {
            behaviour: "ask",
            source: "personal_rule",
            reason: "A rule asks before this kind of action.",
          },
        },
      )}
    />,
  );
  expect(
    card.getByText(
      "One of your approval rules asks before this kind of action.",
    ),
  ).toBeTruthy();
});
