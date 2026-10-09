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
import { SharingSections } from "@/components/bot-profile/sharing";
import type { AgentProfile } from "@/lib/agents/queries";
import type { TeamBot, TeamBotsData } from "@/lib/team-bots";
import { settleReactWork } from "./settle-react-work";

/**
 * A Bot's Sharing page: its owner publishes and unpublishes it, an administrator assigns it to
 * groups. Each is offered only to whoever the server lets do it.
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

const BOT: AgentProfile = {
  id: "expenses",
  name: "Expenses",
  title: "Finance",
  roleDescription: "Receipts.",
  avatarSeed: "e",
  visibility: "private",
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

const PUBLISHED: TeamBot = {
  id: "expenses",
  name: "Expenses",
  title: "Finance",
  roleDescription: "Receipts.",
  mine: true,
  audience: "team",
  publishedAt: "2026-10-01T00:00:00Z",
  assigned: false,
  visibleToTeam: true,
  people: [],
  groups: [],
  assignments: [],
};

function serving(data: TeamBotsData, role: "admin" | "user") {
  global.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/team-bots")) return Response.json(data);
    if (url.includes("/shared-use/bot/")) return Response.json({ apps: [] });
    if (url.includes("/shared-use")) return Response.json({ requests: [] });
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
      component: () => <SharingSections agent={agent} />,
    }),
  });
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

test("an unpublished Bot of yours offers to publish it", async () => {
  serving(
    {
      teamBots: [],
      publishable: [{ id: "expenses", name: "Expenses", title: "Finance" }],
    },
    "user",
  );
  const view = draw(BOT);
  expect(
    await view.findByRole("button", { name: "Publish to team" }),
  ).toBeTruthy();
  expect(view.queryByRole("button", { name: "Unpublish" })).toBeNull();
});

test("a published Bot of yours can be updated, unpublished and its link copied", async () => {
  serving({ teamBots: [PUBLISHED], publishable: [] }, "user");
  const view = draw(BOT);
  expect(await view.findByRole("button", { name: "Update" })).toBeTruthy();
  expect(view.getByRole("button", { name: "Unpublish" })).toBeTruthy();
  expect(view.getByRole("button", { name: "Copy link" })).toBeTruthy();
  // Not an administrator: no group assignment.
  expect(view.queryByLabelText("Assign Expenses to a group")).toBeNull();
});

test("an administrator can assign a published Bot to groups but not publish someone else's", async () => {
  serving(
    { teamBots: [{ ...PUBLISHED, mine: false }], publishable: [] },
    "admin",
  );
  const view = draw({ ...BOT, mine: false });
  expect(await view.findByLabelText("Assign Expenses to a group")).toBeTruthy();
  expect(view.queryByRole("button", { name: "Update" })).toBeNull();
  expect(view.queryByRole("button", { name: "Unpublish" })).toBeNull();
});
