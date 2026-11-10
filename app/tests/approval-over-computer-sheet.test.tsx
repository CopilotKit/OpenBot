import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
  within,
} from "@testing-library/react";
import {
  ConversationApprovals,
  InlineApproval,
} from "@/components/approvals/inline-approval";
import { DetailPanel } from "@/components/layout/detail-panel";
import { settleReactWork } from "./settle-react-work";

/*
 * A Bot's screen opens itself while the Bot works. On a narrow window it opens as a sheet over the
 * whole conversation, and when the Bot then stopped to ask (clicking Delete always asks), the
 * "Waiting on you" card sat in the conversation under the sheet, blurred, until the person thought
 * to close the Computer. A waiting approval is never hidden: the sheet draws it too.
 */

class Observer implements ResizeObserver {
  static targets = new Map<Element, Observer>();
  constructor(private readonly callback: ResizeObserverCallback) {}
  observe(target: Element) {
    Observer.targets.set(target, this);
  }
  unobserve(target: Element) {
    Observer.targets.delete(target);
  }
  disconnect() {
    for (const [target, observer] of Observer.targets) {
      if (observer === this) Observer.targets.delete(target);
    }
  }
  resize(target: Element, width: number) {
    this.callback(
      [
        {
          target,
          contentRect: new DOMRect(0, 0, width, 640),
          borderBoxSize: [],
          contentBoxSize: [],
          devicePixelContentBoxSize: [],
        },
      ],
      this,
    );
  }
}

let originalObserver: typeof ResizeObserver;
const originalFetch = global.fetch;
beforeAll(() => {
  GlobalRegistrator.register();
  originalObserver = globalThis.ResizeObserver;
  globalThis.ResizeObserver = Observer;
});
afterEach(() => {
  cleanup();
  Observer.targets.clear();
  global.fetch = originalFetch;
});
afterAll(async () => {
  await settleReactWork();
  globalThis.ResizeObserver = originalObserver;
  GlobalRegistrator.unregister();
});

/** A pending request as `GET /api/approvals` returns it. */
const request = (id: string, toolCallId: string, threadId: string) => ({
  id,
  status: "pending",
  createdAt: "2026-11-06T10:00:00Z",
  action: {
    botId: "claude-sdk",
    toolRef: "computer_click",
    effect: "write",
    scope: "browser",
    threadId,
    toolCallId,
    args: { ref: "e12" },
    target: { url: "https://the-internet.herokuapp.com/add_remove_elements/" },
    policy: {
      behaviour: "ask",
      source: "safety",
      reason: "Deleting something asks you first.",
    },
  },
});

const decisions: { url: string; body: unknown }[] = [];
function serving() {
  decisions.length = 0;
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === "POST") {
      decisions.push({
        url,
        body: typeof init.body === "string" ? JSON.parse(init.body) : null,
      });
      return Response.json({ ok: true });
    }
    if (url === "/api/approvals")
      return Response.json({
        enabled: true,
        rules: [],
        teamRules: [],
        questions: [],
        requests: [
          request("delete-request", "delete-call", "thread-here"),
          request("elsewhere-request", "elsewhere-call", "thread-elsewhere"),
        ],
      });
    return Response.json({ error: "not served" }, { status: 404 });
  }) as unknown as typeof fetch;
}

/** The conversation, its Delete click waiting in the transcript, with the Computer open beside it. */
function draw() {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <DetailPanel
        detail={<p>Browser preview</p>}
        onClose={() => {}}
        open
        title="Computer"
        waiting={<ConversationApprovals threadId="thread-here" />}
      >
        <section aria-label="Conversation">
          <InlineApproval fallback={null} toolCallId="delete-call" />
        </section>
      </DetailPanel>
    </QueryClientProvider>,
  );
}

async function resize(container: HTMLElement, width: number) {
  const target = container.firstElementChild;
  if (!target) throw new Error("Panel root missing");
  await act(async () => {
    Observer.targets.get(target)?.resize(target, width);
  });
}

test("on a narrow window the Computer sheet shows the approval it covers, and answers it there", async () => {
  serving();
  const view = draw();
  await resize(view.container, 560);
  const sheet = await view.findByRole("dialog", { name: "Computer" });
  const card = await within(sheet).findByRole("region", {
    name: "Waiting for your approval",
  });
  expect(
    within(card).getByText("Deleting something asks you first."),
  ).toBeTruthy();
  expect(
    within(card)
      .getAllByRole("radio")
      .map((radio) => radio.getAttribute("aria-label")),
  ).toEqual([
    "Allow once",
    "Allow for this conversation",
    "Always allow here",
    "Deny",
  ]);
  // Only this conversation's: an approval waiting in another one is not drawn here.
  expect(
    within(sheet).getAllByRole("region", { name: "Waiting for your approval" }),
  ).toHaveLength(1);
  expect(within(sheet).getByText("Browser preview")).toBeTruthy();

  fireEvent.click(within(card).getByRole("radio", { name: "Allow once" }));
  fireEvent.click(within(card).getByRole("button", { name: "Allow once" }));
  await waitFor(() =>
    expect(decisions).toContainEqual({
      url: "/api/approvals/delete-request/decision",
      body: { decision: "allow_once" },
    }),
  );
});

test("beside a wide conversation the card is already in view, and the pane does not repeat it", async () => {
  serving();
  const view = draw();
  await resize(view.container, 1200);
  await view.findByRole("region", { name: "Waiting for your approval" });
  expect(view.queryByRole("dialog")).toBeNull();
  expect(view.getByText("Browser preview")).toBeTruthy();
  expect(
    view.getAllByRole("region", { name: "Waiting for your approval" }),
  ).toHaveLength(1);
  expect(
    within(view.getByRole("region", { name: "Conversation" })).getByRole(
      "region",
      { name: "Waiting for your approval" },
    ),
  ).toBeTruthy();
});
