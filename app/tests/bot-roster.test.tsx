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
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { BotRoster } from "@/components/bots/bot-roster";
import { type AgentProfile, agentKeys } from "@/lib/agents/queries";
import { settleReactWork } from "./settle-react-work";

/**
 * The Bots roster: one list of every Bot a person can reach, replacing the Bots, Agents and Team
 * Bots screens. The harness is this repository's: `GlobalRegistrator` around the file, `cleanup`
 * after each test, a `QueryClient` per test with `retry: false`, and `fetch` stubbed per test.
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

function bot(overrides: Partial<AgentProfile> & { id: string }): AgentProfile {
  return {
    name: overrides.id,
    title: "Title",
    roleDescription: "Role",
    avatarSeed: "seed",
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
    ...overrides,
  };
}

/** Serves the visible roster, the hidden roster, and an empty attention list. */
function serving(
  visible: AgentProfile[],
  hidden: AgentProfile[],
  attention: Record<string, unknown>[] = [],
) {
  global.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/bots/attention"))
      return Response.json({ bots: attention });
    return Response.json({
      agents: url.includes("hidden=true") ? hidden : visible,
    });
  }) as unknown as typeof fetch;
}

let queryClient: QueryClient;
beforeEach(() => {
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
});

function draw() {
  const rootRoute = createRootRoute();
  const routeTree = rootRoute.addChildren([
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/",
      component: BotRoster,
    }),
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/bots/$agentId",
      component: () => null,
    }),
  ]);
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

test("sections read Pinned, Yours, Shared with you, and each Bot appears once", async () => {
  serving(
    [
      bot({ id: "favourite", name: "Favourite", pinned: true }),
      bot({ id: "mine", name: "Mine" }),
      bot({ id: "theirs", name: "Theirs", mine: false, canManage: false }),
    ],
    [],
  );
  const view = draw();
  expect(await view.findByText("Theirs")).toBeTruthy();
  const headings = [...view.container.querySelectorAll("h2")].map(
    (heading) => heading.textContent,
  );
  expect(headings).toEqual(["Pinned", "Yours", "Shared with you"]);
  expect(view.getAllByText("Favourite")).toHaveLength(1);
});

test("a row opens the Bot's own page", async () => {
  serving([bot({ id: "mine", name: "Mine" })], []);
  const view = draw();
  const row = (await view.findByText("Mine")).closest("a");
  expect(row?.getAttribute("href")).toBe("/bots/mine");
});

test("with every Bot of yours pinned, Yours says so instead of claiming none", async () => {
  serving([bot({ id: "favourite", name: "Favourite", pinned: true })], []);
  const view = draw();
  expect(await view.findByText("Your Bots are all pinned above.")).toBeTruthy();
  expect(view.queryByText("You have no Bots of your own yet.")).toBeNull();
});

test("a hidden Bot is under Hidden, folded until asked for, and its row opens its page", async () => {
  serving(
    [bot({ id: "mine", name: "Mine" })],
    [bot({ id: "tucked", name: "Tucked", hidden: true })],
  );
  const view = draw();
  expect(await view.findByText("Hidden")).toBeTruthy();
  expect(view.queryByText("Tucked")).toBeNull();
  fireEvent.click(view.getByRole("button", { name: "Show" }));
  const row = view.getByText("Tucked").closest("a");
  expect(row?.getAttribute("href")).toBe("/bots/tucked");
});

test("with nothing hidden there is no Hidden section", async () => {
  serving([bot({ id: "mine", name: "Mine" })], []);
  const view = draw();
  expect(await view.findByText("Mine")).toBeTruthy();
  await waitFor(() =>
    expect(queryClient.getQueryState(agentKeys.list(true))?.status).toBe(
      "success",
    ),
  );
  expect(view.queryByText("Hidden")).toBeNull();
});

test("a roster that never loaded says so, not that you have no Bots", async () => {
  global.fetch = (async () =>
    new Response(null, { status: 500 })) as unknown as typeof fetch;
  const view = draw();
  expect(await view.findByRole("alert")).toBeTruthy();
  expect(view.queryByText("You have no Bots of your own yet.")).toBeNull();
});

test("a failed refetch keeps the roster it already had, not the error", async () => {
  queryClient.setQueryData(agentKeys.list(false), [
    bot({ id: "mine", name: "Mine" }),
  ]);
  global.fetch = (async () =>
    new Response(null, { status: 500 })) as unknown as typeof fetch;
  const view = draw();
  await waitFor(() =>
    expect(queryClient.getQueryState(agentKeys.list(false))?.status).toBe(
      "error",
    ),
  );
  expect(view.getByText("Mine")).toBeTruthy();
  expect(view.queryByRole("alert")).toBeNull();
});

test("a Bot with something waiting comes first, under Needs you, with its count", async () => {
  serving(
    [
      bot({ id: "mine", name: "Mine" }),
      bot({ id: "waiting", name: "Waiting", mine: false }),
    ],
    [],
    [
      {
        agentId: "waiting",
        name: "Waiting",
        questions: 1,
        approvals: 1,
        handoffs: 0,
        unread: 0,
        paused: false,
        notify: "all",
      },
    ],
  );
  const view = draw();
  expect(await view.findByText("Needs you")).toBeTruthy();
  const headings = [...view.container.querySelectorAll("h2")].map(
    (heading) => heading.textContent,
  );
  expect(headings).toEqual(["Needs you", "Yours", "Shared with you"]);
  // Once, under Needs you, not again under Shared with you.
  expect(view.getAllByText("Waiting")).toHaveLength(1);
  expect(view.getByText("2")).toBeTruthy();
});
