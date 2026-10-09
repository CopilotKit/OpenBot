import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render } from "@testing-library/react";
import { BotSettingsRows } from "@/components/bot-profile/settings-rows";
import type { AgentProfile } from "@/lib/agents/queries";
import { settleReactWork } from "./settle-react-work";

/** The "Settings for this Bot" card: each row says its current answer and opens its page. */

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

const BOT: AgentProfile = {
  id: "expenses",
  name: "Expenses",
  title: "Finance",
  roleDescription: "Receipts.",
  avatarSeed: "e",
  visibility: "public",
  endpoint: null,
  builtIn: true,
  hasAuth: false,
  hasCallbackToken: false,
  hidden: false,
  pinned: false,
  systemOwned: false,
  canManage: true,
  mine: true,
};

function serving(
  role: "admin" | "user",
  teamBots: { id: string; audience: "team" | "people" }[] = [],
) {
  global.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/routines")) {
      return Response.json({
        routines: [{ id: "r1", agentId: "expenses" }],
        sweep: null,
      });
    }
    if (url.includes("/api/plugins/for/")) {
      return Response.json({ tools: [], skills: [] });
    }
    if (url.includes("/api/team-bots")) {
      return Response.json({ teamBots, publishable: [] });
    }
    if (url === "/api/responsibilities") {
      return Response.json({
        responsibilities: [
          { id: "g1", agentId: "expenses", status: "active" },
          { id: "g2", agentId: "expenses", status: "paused" },
          { id: "g3", agentId: "knowledge", status: "active" },
        ],
      });
    }
    if (url === "/api/delivery") {
      return Response.json({
        bindings: [
          { id: "b1", transport: "slack", agentId: "expenses", enabled: true },
          { id: "b2", transport: "sms", agentId: "knowledge", enabled: true },
        ],
        devices: [],
        deliveries: [],
        available: { slack: true, teams: false, sms: true, push: false },
      });
    }
    if (url === "/api/memory/sources") {
      return Response.json({
        sources: [{ id: "s1", agentId: "expenses", enabled: true }],
      });
    }
    if (url === "/api/proactive/settings") {
      return Response.json({ settings: [] });
    }
    if (url === "/api/approvals") {
      return Response.json({
        enabled: true,
        requests: [],
        questions: [],
        rules: [
          { id: "r1", botId: "expenses" },
          { id: "r2", botId: "*" },
        ],
        teamRules: [],
      });
    }
    return Response.json({
      user: { id: "me", role, email: "me@example.test", name: "Me" },
    });
  }) as unknown as typeof fetch;
}

function draw(agent: AgentProfile) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: createRootRoute({
      component: () => <BotSettingsRows agent={agent} />,
    }),
  });
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

test("the owner sees Sharing, and each row opens its own page", async () => {
  serving("user");
  const view = draw(BOT);
  const sharing = (await view.findByText("Sharing")).closest("a");
  expect(sharing?.getAttribute("href")).toBe("/bots/expenses/sharing");
  expect(view.getByText("Setup").closest("a")?.getAttribute("href")).toBe(
    "/bots/expenses/setup",
  );
  // Public and unpublished: everyone can already use it.
  expect(await view.findByText("Everyone (public)")).toBeTruthy();
});

test("someone who neither owns the Bot nor administers the deployment does not see Sharing", async () => {
  serving("user");
  const view = draw({ ...BOT, mine: false, canManage: false });
  expect(await view.findByText("Setup")).toBeTruthy();
  expect(view.queryByText("Sharing")).toBeNull();
});

test("an administrator sees Sharing on somebody else's Bot", async () => {
  serving("admin");
  const view = draw({ ...BOT, mine: false });
  expect(await view.findByText("Sharing")).toBeTruthy();
});

test("someone a Bot was published to sees Sharing, where its link is", async () => {
  serving("user", [{ id: "expenses", audience: "team" }]);
  const view = draw({ ...BOT, mine: false, canManage: false });
  expect(await view.findByText("Sharing")).toBeTruthy();
  expect(await view.findByText("Whole team")).toBeTruthy();
});

test("the rows for responsibilities, reach, memory and rules say what this Bot has and open their pages", async () => {
  serving("user");
  const view = draw(BOT);
  const row = async (title: string, summary: string, path: string) => {
    expect(await view.findByText(summary)).toBeTruthy();
    expect(view.getByText(title).closest("a")?.getAttribute("href")).toBe(
      `/bots/expenses/${path}`,
    );
  };
  await row("Responsibilities", "1 active", "responsibilities");
  await row("Reaching you", "Slack", "reach");
  await row("Memory", "1 source", "memory");
  await row("Approval rules", "1 rule", "approvals");
});
