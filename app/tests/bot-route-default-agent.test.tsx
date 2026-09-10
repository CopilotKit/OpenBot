import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  mock,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render } from "@testing-library/react";
import { type AgentProfile, agentKeys } from "@/lib/agents/queries";

type BotRouteModule = typeof import("@/routes/_authed/_app/bot");

let BotRoute: BotRouteModule["Route"];
let pristineBotRouteState: Record<string, unknown>;
let botRouteSnapshot: Record<string, unknown>;

beforeAll(async () => {
  GlobalRegistrator.register();

  mock.module("@copilotkit/react-core/v2", () => ({
    CopilotChat: ({ agentId }: { agentId: string }) => (
      <div data-agent-id={agentId} data-testid="copilot-chat" />
    ),
  }));
  mock.module("@/lib/copilot/active-bot", () => ({
    useActiveBot: () => undefined,
  }));
  mock.module("@/lib/copilot/bot-thread", () => ({
    useBotThread: (agentId: string) => ({
      history: "ready",
      startNew: () => undefined,
      threadId: `thread-${agentId}`,
    }),
  }));
  mock.module("@/lib/copilot/stopped-turn", () => ({
    useStoppedTurn: () => null,
  }));

  BotRoute = (await import("@/routes/_authed/_app/bot")).Route;
  pristineBotRouteState = captureRouteState(BotRoute);
});

beforeEach(() => {
  botRouteSnapshot = captureRouteState(pristineBotRouteState);
});

afterEach(() => {
  cleanup();
  restoreRouteState(BotRoute, botRouteSnapshot);
});

afterAll(() => GlobalRegistrator.unregister());

function captureRouteState(route: object): Record<string, unknown> {
  return { ...route, options: { ...(route as { options: object }).options } };
}

function restoreRouteState(
  route: object,
  snapshot: Record<string, unknown>,
): void {
  for (const key of Object.keys(route)) {
    if (!(key in snapshot)) {
      delete (route as Record<string, unknown>)[key];
    }
  }
  Object.assign(route, snapshot);
}

function agent(
  overrides: Partial<AgentProfile> & { id: string },
): AgentProfile {
  return {
    avatarSeed: "seed",
    builtIn: true,
    canManage: true,
    endpoint: null,
    hasAuth: false,
    hasCallbackToken: false,
    hidden: false,
    mine: true,
    name: "Agent",
    roleDescription: "Role",
    systemOwned: false,
    title: "Title",
    visibility: "private",
    ...overrides,
  };
}

function queryClientWithAgents(agents: AgentProfile[]) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        staleTime: Number.POSITIVE_INFINITY,
      },
    },
  });
  queryClient.setQueryData(agentKeys.list(false), agents);
  return queryClient;
}

function renderBot(queryClient: QueryClient, initialEntry = "/bot") {
  const rootRoute = createRootRoute({ component: Outlet });
  const authedRoute = createRoute({
    id: "/_authed",
    getParentRoute: () => rootRoute,
    component: Outlet,
  });
  const appRoute = createRoute({
    id: "/_app",
    getParentRoute: () => authedRoute,
    component: Outlet,
  });
  const wired = (
    BotRoute as unknown as { update: (options: unknown) => typeof BotRoute }
  ).update({
    id: "/bot",
    path: "/bot",
    getParentRoute: () => appRoute,
  });
  const tree = rootRoute.addChildren([
    authedRoute.addChildren([appRoute.addChildren([wired])]),
  ]);
  const router = createRouter({
    routeTree: tree,
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

const GENERAL_ASSISTANT = agent({
  id: "general-assistant",
  name: "General Assistant",
  title: "Everyday work",
});

const PICKED_HARNESS = agent({
  builtIn: false,
  endpoint: "http://127.0.0.1:4201",
  id: "picked-harness",
  name: "LangGraph",
  title: "LangGraph",
});

test("/bot defaults to the picked harness when this setup selected one", async () => {
  const view = renderBot(
    queryClientWithAgents([GENERAL_ASSISTANT, PICKED_HARNESS]),
  );

  expect(await view.findByRole("heading", { name: "LangGraph" })).toBeTruthy();
  expect(view.getByTestId("copilot-chat").dataset.agentId).toBe(
    "picked-harness",
  );
});

test("/bot preserves an explicit agent, including the built-in first agent", async () => {
  const view = renderBot(
    queryClientWithAgents([GENERAL_ASSISTANT, PICKED_HARNESS]),
    "/bot?agent=general-assistant",
  );

  expect(
    await view.findByRole("heading", { name: "General Assistant" }),
  ).toBeTruthy();
  expect(view.getByTestId("copilot-chat").dataset.agentId).toBe(
    "general-assistant",
  );
});

test("/bot preserves an explicit unknown agent as a clear missing-bot state", async () => {
  const view = renderBot(
    queryClientWithAgents([GENERAL_ASSISTANT, PICKED_HARNESS]),
    "/bot?agent=missing-agent",
  );

  expect(
    await view.findByText('This deployment has no Bot called "missing-agent".'),
  ).toBeTruthy();
  expect(view.queryByTestId("copilot-chat")).toBeNull();
});

test("/bot still falls back to the first agent when no picked harness exists", async () => {
  const otherAgent = agent({ id: "researcher", name: "Researcher" });
  const view = renderBot(
    queryClientWithAgents([GENERAL_ASSISTANT, otherAgent]),
  );

  expect(
    await view.findByRole("heading", { name: "General Assistant" }),
  ).toBeTruthy();
  expect(view.getByTestId("copilot-chat").dataset.agentId).toBe(
    "general-assistant",
  );
});
