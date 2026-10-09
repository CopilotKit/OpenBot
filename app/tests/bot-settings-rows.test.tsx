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

function serving(role: "admin" | "user") {
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
      return Response.json({ teamBots: [], publishable: [] });
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
  expect(await view.findByText("Not shared")).toBeTruthy();
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
