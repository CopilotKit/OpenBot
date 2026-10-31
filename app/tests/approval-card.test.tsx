import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render } from "@testing-library/react";
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
