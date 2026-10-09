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
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TeamApprovalSettings } from "@/components/approvals/team-settings";
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
        return Response.json({ ok: true });
      }
      if (url === "/api/approvals") return Response.json(inbox);
      if (url === "/api/approvals/shared-use")
        return Response.json({ requests: [] });
      if (url === "/api/me")
        return Response.json({
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

function draw() {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <TeamApprovalSettings />
    </QueryClientProvider>,
  );
}

test("an administrator sets the team-wide controls", async () => {
  const view = draw();
  await view.findByText("Team settings");
  fireEvent.change(
    view.getByRole("combobox", {
      name: "Commands on members' computers, at most",
    }),
    { target: { value: "never" } },
  );
  await waitFor(() =>
    expect(sent).toContainEqual({
      path: "/api/approvals/team",
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
  await user.type(
    view.getByRole("textbox", { name: "Tool or app" }),
    "mcp/slack/*",
  );
  const save = view.getByRole("button", { name: "Save rule" });
  fireEvent.submit(save.closest("form") as HTMLFormElement);
  await waitFor(() =>
    expect(sent).toContainEqual({
      path: "/api/approvals/team/rules",
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
