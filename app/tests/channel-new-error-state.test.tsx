import "./channel-new-error-state.fixture";

import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
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
import { Route as ChannelNewRoute } from "@/routes/_authed/_app/channel/new";

beforeAll(() => GlobalRegistrator.register());

afterEach(() => cleanup());

afterAll(() => GlobalRegistrator.unregister());

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

function queryClientWithFailingAgents() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  queryClient.setQueryData(agentKeys.list(false), undefined);
  queryClient.setQueryDefaults(agentKeys.list(false), {
    queryFn: async () => {
      throw new Error("roster exploded");
    },
    retry: false,
  });
  return queryClient;
}

function queryClientWithHiddenDetail(
  agents: AgentProfile[],
  agentId: string,
  queryFn: () => Promise<AgentProfile>,
) {
  const queryClient = queryClientWithAgents(agents);
  queryClient.setQueryDefaults(agentKeys.detail(agentId), {
    queryFn,
    retry: false,
  });
  return queryClient;
}

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
type TestFileRouteWiring = Parameters<typeof ChannelNewRoute.update>[0] & {
  id: string;
  path: string;
  getParentRoute: () => typeof appRoute;
};
const testChannelNewRoute = ChannelNewRoute.update({
  id: "/channel/new",
  path: "/channel/new",
  getParentRoute: () => appRoute,
} as TestFileRouteWiring);
const routeTree = rootRoute.addChildren([
  authedRoute.addChildren([appRoute.addChildren([testChannelNewRoute])]),
]);

function renderChannelNew(
  queryClient: QueryClient,
  initialEntry = "/channel/new",
) {
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

const GENERAL_ASSISTANT = agent({
  id: "general-assistant",
  name: "General Assistant",
  title: "Everyday work",
});

test("/channel/new reports a failed initial roster load", async () => {
  const view = renderChannelNew(queryClientWithFailingAgents());

  expect((await view.findByRole("alert")).textContent).toBe(
    "Coworkers couldn't be loaded.",
  );
  expect(view.queryByText("No agents found.")).toBeNull();
  expect(view.getByTestId("conversation-view").dataset.disabled).toBe("true");
});

test("/channel/new reports a failed URL-selected hidden detail load", async () => {
  const view = renderChannelNew(
    queryClientWithHiddenDetail([GENERAL_ASSISTANT], "hidden-bot", async () => {
      throw new Error("detail exploded");
    }),
    "/channel/new?agent=hidden-bot",
  );

  expect((await view.findByRole("alert")).textContent).toBe(
    "Coworker couldn't be loaded.",
  );
  expect(view.queryByText("No agents found.")).toBeNull();
  expect(view.getByTestId("conversation-view").dataset.disabled).toBe("true");
});

test("/channel/new keeps a successful empty roster as an empty picker", async () => {
  const view = renderChannelNew(queryClientWithAgents([]));

  expect(view.queryByRole("alert")).toBeNull();
  expect((await view.findByTestId("conversation-view")).dataset.disabled).toBe(
    "true",
  );
});

test("/channel/new keeps a successful visible recipient enabled", async () => {
  const view = renderChannelNew(
    queryClientWithAgents([GENERAL_ASSISTANT]),
    "/channel/new?agent=general-assistant",
  );

  expect(view.queryByRole("alert")).toBeNull();
  expect((await view.findByTestId("conversation-view")).dataset.disabled).toBe(
    "false",
  );
});

test("/channel/new ignores stale detail errors when the URL agent is listed", async () => {
  const queryClient = queryClientWithAgents([GENERAL_ASSISTANT]);
  await queryClient.prefetchQuery({
    queryKey: agentKeys.detail("general-assistant"),
    queryFn: async () => {
      throw new Error("stale detail exploded");
    },
    retry: false,
  });
  const view = renderChannelNew(
    queryClient,
    "/channel/new?agent=general-assistant",
  );

  expect(view.queryByRole("alert")).toBeNull();
  expect((await view.findByTestId("conversation-view")).dataset.disabled).toBe(
    "false",
  );
});

test("/channel/new keeps a successful hidden URL recipient enabled", async () => {
  const hiddenBot = agent({
    hidden: true,
    id: "hidden-bot",
    name: "Hidden Bot",
    title: "Hidden Bot",
  });
  const queryClient = queryClientWithAgents([GENERAL_ASSISTANT]);
  queryClient.setQueryData(agentKeys.detail("hidden-bot"), hiddenBot);
  const view = renderChannelNew(queryClient, "/channel/new?agent=hidden-bot");

  expect(view.queryByRole("alert")).toBeNull();
  expect((await view.findByTestId("conversation-view")).dataset.disabled).toBe(
    "false",
  );
});

test("/channel/new keeps a usable hidden detail when a background refetch fails", async () => {
  const hiddenBot = agent({
    hidden: true,
    id: "hidden-bot",
    name: "Hidden Bot",
    title: "Hidden Bot",
  });
  const queryClient = queryClientWithHiddenDetail(
    [GENERAL_ASSISTANT],
    "hidden-bot",
    async () => {
      throw new Error("background detail exploded");
    },
  );
  queryClient.setQueryData(agentKeys.detail("hidden-bot"), hiddenBot);
  const view = renderChannelNew(queryClient, "/channel/new?agent=hidden-bot");

  expect(view.queryByRole("alert")).toBeNull();
  expect((await view.findByTestId("conversation-view")).dataset.disabled).toBe(
    "false",
  );
});
