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
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TeamApprovalSettings } from "@/components/approvals/team-settings";
import { ME_PATH, meResponse } from "./accounts-api";
import { approvalInboxResponse, approvalWriteResponse } from "./approvals-api";
import { settleReactWork } from "./settle-react-work";

/** Admin → Approvals: the team-wide controls and team rules, in one place for administrators. */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const originalFetch = global.fetch;
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

beforeEach(() => {
  sent.length = 0;
  global.fetch = Object.assign(
    async (path: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(path);
      if (init?.method && init.method !== "GET") {
        sent.push({
          path: url,
          method: init.method,
          body: init.body ? JSON.parse(String(init.body)) : undefined,
        });
        return approvalWriteResponse(path, init) ?? Response.json({ ok: true });
      }
      {
        const approvals = approvalInboxResponse(url, inbox);
        if (approvals) return approvals;
      }
      if (url === "/api/v2/organizations/default/shared-use-requests?limit=100")
        return Response.json({ sharedUseRequests: [], nextCursor: null });
      if (url === ME_PATH)
        return meResponse({
          user: { id: "me", email: "me@example.test", role: "admin" },
        });
      return new Response(null, { status: 404 });
    },
    { preconnect: originalFetch.preconnect },
  );
});
afterEach(() => {
  global.fetch = originalFetch;
});

/** On Admin → Approvals, inside a router: the screen links on to describing rules in words. */
function draw() {
  const root = createRootRoute({ component: TeamApprovalSettings });
  const describe = createRoute({
    path: "/admin/approvals/describe",
    getParentRoute: () => root,
    component: () => null,
  });
  const router = createRouter({
    routeTree: root.addChildren([describe]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
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

test("an administrator sets the team-wide controls", async () => {
  const view = draw();
  await view.findByText("Team settings");
  const user = userEvent.setup({ document });
  await user.click(
    view.getByRole("combobox", {
      name: "Commands on members' computers, at most",
    }),
  );
  await user.click(await view.findByRole("option", { name: "Never" }));
  await waitFor(() =>
    expect(sent).toContainEqual({
      path: "/api/v2/organizations/default/approval-settings",
      method: "PATCH",
      body: { hostCommandsCap: "never" },
    }),
  );
  // Team rules only: a member's own rules are theirs, in Settings.
  expect(view.getAllByRole("button", { name: "Remove" }).length).toBe(1);
});

test("an administrator adds a team rule for every Bot", async () => {
  const view = draw();
  await view.findByText("Add a team rule");
  const user = userEvent.setup({ document });
  await user.click(view.getByRole("button", { name: /Add a team rule/ }));
  await user.type(
    await view.findByRole("textbox", { name: "Tool or app" }),
    "mcp/slack/*",
  );
  await user.click(view.getByRole("button", { name: "Save rule" }));
  await waitFor(() =>
    expect(sent).toContainEqual({
      path: "/api/v2/organizations/default/approval-rules",
      method: "POST",
      body: {
        botId: "*",
        toolRef: "mcp/slack/*",
        effect: "*",
        scope: "*",
        behaviour: "ask",
      },
    }),
  );
});
