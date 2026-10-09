import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import type { ReactNode } from "react";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApprovalInbox } from "@/components/approvals/inbox";
import { ApprovalSettings } from "@/components/approvals/settings";
import { InlineApproval } from "@/components/approvals/inline-approval";
import {
  BrowserActivity,
  groupBrowserSteps,
} from "@/components/channels/browser-activity";
import { toVisibleChatItems } from "@/components/channels/chat-messages";

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

const originalFetch = global.fetch;
let role: "user" | "admin" = "user";
const sent: { path: string; method: string; body: unknown }[] = [];

const inbox = {
  enabled: false,
  requests: [
    {
      id: "request-1",
      status: "pending",
      createdAt: new Date().toISOString(),
      action: {
        botId: "Shopper",
        toolRef: "computer_click",
        effect: "write",
        scope: "shop.example",
        threadId: "thread",
        args: { element: "Pay now" },
        target: {},
        toolCallId: "pay-call",
        policy: {
          behaviour: "hand_off",
          source: "safety",
          reason:
            "Paying, purchasing or moving money is always done by the person.",
        },
      },
    },
  ],
  rules: [
    {
      id: "mine",
      botId: "*",
      toolRef: "mcp/gmail/*",
      effect: "*",
      scope: "*",
      behaviour: "allow",
    },
  ],
  teamRules: [
    {
      id: "locked",
      botId: "*",
      toolRef: "mcp/drive/share",
      effect: "*",
      scope: "*",
      behaviour: "ask",
    },
  ],
  preferences: { enabled: false, autoReview: false, hostCommands: "allow" },
  team: {
    enforceAutoReview: true,
    customRulesEnabled: true,
    hostCommandsCap: "ask",
  },
  hostCommands: "ask",
  questions: [],
};

/** Per-test changes to the inbox the server returns. */
let inboxOverride: Record<string, unknown> = {};

beforeEach(() => {
  sent.length = 0;
  inboxOverride = {};
  role = "user";
  global.fetch = Object.assign(
    async (path: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(path);
      if (init?.method && init.method !== "GET") {
        sent.push({
          path: url,
          method: init.method,
          body: init.body ? JSON.parse(String(init.body)) : undefined,
        });
        return Response.json({ ok: true });
      }
      if (url === "/api/approvals")
        return Response.json({ ...inbox, ...inboxOverride });
      if (url === "/api/me")
        return Response.json({
          user: { id: "me", email: "me@example.test", role },
        });
      return new Response(null, { status: 404 });
    },
    { preconnect: originalFetch.preconnect },
  );
});
afterEach(() => {
  global.fetch = originalFetch;
});

/** A screen in a router of one route, for the links it holds. */
function draw(screen: ReactNode = <ApprovalInbox />) {
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: createRootRoute({ component: () => screen }),
  });
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

test("a hand-off is marked done by the person, never allowed on their behalf", async () => {
  const view = draw();
  await view.findByText(/Handed to you: Paying/);
  expect(view.queryByRole("button", { name: "Allow once" })).toBeNull();
  fireEvent.click(view.getByRole("button", { name: "I did it myself" }));
  await waitFor(() =>
    expect(sent).toContainEqual({
      path: "/api/approvals/request-1/decision",
      method: "POST",
      body: { decision: "handled" },
    }),
  );
});

test("team rules are locked for members, enforced auto-review is shown as required, and the host cap is named", async () => {
  const view = draw(<ApprovalSettings />);
  await view.findByText("Ask before taking action (team rule)");
  const mine = view.getByRole("combobox", {
    name: "Behaviour for mcp/gmail/*",
  }) as HTMLSelectElement;
  expect(mine.value).toBe("allow");
  expect(view.getByText("Locked")).toBeTruthy();
  const review = view.getByRole("switch", { name: "Auto-review" });
  expect(review.getAttribute("aria-checked")).toBe("true");
  expect(view.getByText(/Required by your team/)).toBeTruthy();
  expect(
    view.getByText(/Your team limits this to "Ask every time"/),
  ).toBeTruthy();
  expect(view.queryByText("Team settings")).toBeNull();
});

test("a member changes a saved rule in place", async () => {
  const view = draw(<ApprovalSettings />);
  const mine = await view.findByRole("combobox", {
    name: "Behaviour for mcp/gmail/*",
  });
  fireEvent.change(mine, { target: { value: "hand_off" } });
  await waitFor(() =>
    expect(sent).toContainEqual({
      path: "/api/approvals/rules/mine",
      method: "PATCH",
      body: { behaviour: "hand_off" },
    }),
  );
  expect(
    view.queryByRole("combobox", { name: "Behaviour for mcp/drive/share" }),
  ).toBeNull();
});

test("a member adds a rule with one of the four behaviours", async () => {
  const view = draw(<ApprovalSettings />);
  await view.findByText("Add a rule");
  // Rules here apply to every Bot, so there is no Bot to name.
  expect(view.queryByRole("textbox", { name: "Bot" })).toBeNull();
  const user = userEvent.setup({ document });
  await user.type(
    view.getByRole("textbox", { name: "Tool or app" }),
    "mcp/slack/*",
  );
  fireEvent.change(
    view.getAllByRole("combobox", { name: "Behaviour" })[0] as HTMLElement,
    {
      target: { value: "pre_approved" },
    },
  );
  const save = view.getByRole("button", { name: "Save rule" });
  fireEvent.submit(save.closest("form") as HTMLFormElement);
  await waitFor(() =>
    expect(sent).toContainEqual({
      path: "/api/approvals/rules",
      method: "POST",
      body: {
        botId: "*",
        toolRef: "mcp/slack/*",
        effect: "*",
        scope: "*",
        behaviour: "pre_approved",
      },
    }),
  );
});

test("rules for one Bot stay on the Approvals page, and rules for every Bot move to Settings", async () => {
  inboxOverride = {
    rules: [
      ...inbox.rules,
      {
        id: "one-bot",
        botId: "Shopper",
        toolRef: "computer_click",
        effect: "*",
        scope: "*",
        behaviour: "ask",
      },
    ],
  };
  const page = draw();
  expect(
    await page.findByRole("combobox", { name: "Behaviour for computer_click" }),
  ).toBeTruthy();
  expect(page.queryByRole("switch", { name: "Auto-review" })).toBeNull();
  expect(
    page.queryByRole("combobox", { name: "Behaviour for mcp/gmail/*" }),
  ).toBeNull();
  cleanup();

  const settings = draw(<ApprovalSettings />);
  expect(
    await settings.findByRole("combobox", {
      name: "Behaviour for mcp/gmail/*",
    }),
  ).toBeTruthy();
  expect(
    settings.queryByRole("combobox", { name: "Behaviour for computer_click" }),
  ).toBeNull();
});

test("with personal rules switched off by the team, they are shown as not applying and none can be added", async () => {
  inboxOverride = {
    team: { ...inbox.team, customRulesEnabled: false },
  };
  const view = draw(<ApprovalSettings />);
  expect(await view.findByText(/kept but do not apply/)).toBeTruthy();
  expect(view.queryByText("Add a rule")).toBeNull();
});

test("a rule added for one Bot must name that Bot", async () => {
  const view = draw();
  await view.findByText("Add a rule for one Bot");
  const user = userEvent.setup({ document });
  await user.type(
    view.getByRole("textbox", { name: "Tool or app" }),
    "mcp/slack/*",
  );
  const save = view.getByRole("button", { name: "Save rule" });
  // Without a Bot it would become a rule for every Bot and vanish from this page.
  expect(save.hasAttribute("disabled")).toBe(true);
  await user.type(view.getByRole("textbox", { name: "Bot" }), "Shopper");
  fireEvent.submit(save.closest("form") as HTMLFormElement);
  await waitFor(() =>
    expect(sent).toContainEqual({
      path: "/api/approvals/rules",
      method: "POST",
      body: {
        botId: "Shopper",
        toolRef: "mcp/slack/*",
        effect: "*",
        scope: "*",
        behaviour: "ask",
      },
    }),
  );
});

test("an administrator on the Approvals page is told where team settings went", async () => {
  role = "admin";
  const view = draw();
  const link = await view.findByRole("link", { name: "Admin → Approvals" });
  expect(link.getAttribute("href")).toBe("/admin/approvals");
});

test("a member on the Approvals page is not pointed at Admin", async () => {
  const view = draw();
  await view.findByText("Rules for one Bot");
  expect(view.queryByRole("link", { name: "Admin → Approvals" })).toBeNull();
});

test("rules for every Bot point to where rules for a single Bot are", async () => {
  const view = draw(<ApprovalSettings />);
  const link = await view.findByRole("link", { name: "Approvals" });
  expect(link.getAttribute("href")).toBe("/approvals");
});

test("a pending change is drawn in the conversation where the action was, and decided there", async () => {
  const view = render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <InlineApproval toolCallId="pay-call" fallback={<p>Clicked on page</p>} />
      <InlineApproval
        toolCallId="other-call"
        fallback={<p>Filled in field</p>}
      />
    </QueryClientProvider>,
  );
  await view.findByRole("region", { name: "Waiting for your approval" });
  expect(view.getByText(/This needs you: click on shop.example/)).toBeTruthy();
  // Another call's line is left to its own renderer.
  expect(view.getByText("Filled in field")).toBeTruthy();
  expect(view.queryByText("Clicked on page")).toBeNull();
  fireEvent.click(view.getByRole("button", { name: "I did it myself" }));
  await waitFor(() =>
    expect(sent).toContainEqual({
      path: "/api/approvals/request-1/decision",
      method: "POST",
      body: { decision: "handled" },
    }),
  );
});

test("in the real transcript shape a waiting click is folded into browser activity, so its card is drawn beside the group", async () => {
  // What the channel transcript builds from the conversation: a navigate that finished and the
  // click the chat stopped on, unanswered, grouped into one browser-activity line.
  const items = groupBrowserSteps(
    toVisibleChatItems([
      { id: "u1", role: "user", content: "Order a pizza on httpbin" },
      {
        id: "a1",
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "nav-call",
            type: "function",
            function: {
              name: "computer_navigate",
              arguments: '{"url":"https://httpbin.org/forms/post"}',
            },
          },
          {
            id: "pay-call",
            type: "function",
            function: {
              name: "computer_click",
              arguments: '{"ref":"e7","snapshotId":3}',
            },
          },
        ],
      },
      {
        id: "t1",
        role: "tool",
        toolCallId: "nav-call",
        content: '{"ok":true,"url":"https://httpbin.org/forms/post"}',
      },
    ] as never),
  );
  const group = items.find((item) => item.kind === "browser");
  if (group?.kind !== "browser") throw new Error("no browser group");
  const view = render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      {/* BrowserActivity mounts the waiting cards beside its folded line itself. */}
      <BrowserActivity group={group} active={false} />
    </QueryClientProvider>,
  );
  await view.findByRole("region", { name: "Waiting for your approval" });
  // Only the waiting call gets a card; the finished navigate does not.
  expect(
    view.getAllByRole("region", { name: "Waiting for your approval" }),
  ).toHaveLength(1);
  expect(view.getByRole("button", { name: "I did it myself" })).toBeTruthy();
});
