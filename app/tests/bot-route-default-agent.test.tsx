import "./bot-route-default-agent.fixture";

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
import {
  cleanup,
  fireEvent,
  render,
  waitFor,
  within,
} from "@testing-library/react";
import { type AgentProfile, agentKeys } from "@/lib/agents/queries";
import { Route as BotRoute } from "@/routes/_authed/_app/bot";

let originalRect: typeof HTMLElement.prototype.getBoundingClientRect;
beforeAll(() => {
  GlobalRegistrator.register();
  originalRect = HTMLElement.prototype.getBoundingClientRect;
});

const originalFetch = global.fetch;

afterEach(() => {
  cleanup();
  global.fetch = originalFetch;
  HTMLElement.prototype.getBoundingClientRect = originalRect;
});

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
    pinned: false,
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

function queryClientWithAgentsAndFetchedAgent(
  agents: AgentProfile[],
  agentId: string,
  response: Response,
) {
  global.fetch = Object.assign(
    async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === `/api/agents/${agentId}`) return response.clone();
      throw new Error(`Unexpected fetch: ${url}`);
    },
    { preconnect: originalFetch.preconnect },
  );
  return queryClientWithAgents(agents);
}

function queryClientWithFailingAgents() {
  global.fetch = Object.assign(
    async () => new Response(null, { status: 500 }),
    { preconnect: originalFetch.preconnect },
  );
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });
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
type TestFileRouteWiring = Parameters<typeof BotRoute.update>[0] & {
  id: string;
  path: string;
  getParentRoute: () => typeof appRoute;
};

/*
 * TanStack's generated route tree wires file routes with update({ id, path, getParentRoute })
 * (app/src/routeTree.gen.ts), and the memory-router docs use an explicit test tree. The
 * createFileRoute update type exposed to tests does not include those generated wiring fields,
 * so this cast is confined to the file-route attachment point; the rendered component, router,
 * query data, and assertions stay typed.
 */
const testBotRoute = BotRoute.update({
  id: "/bot",
  path: "/bot",
  getParentRoute: () => appRoute,
} as TestFileRouteWiring);
const routeTree = rootRoute.addChildren([
  authedRoute.addChildren([appRoute.addChildren([testBotRoute])]),
]);

function renderBot(queryClient: QueryClient, initialEntry = "/bot") {
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

test("/bot with an empty agent query uses the normal default Bot", async () => {
  const view = renderBot(
    queryClientWithAgents([GENERAL_ASSISTANT, PICKED_HARNESS]),
    "/bot?agent=",
  );

  expect(await view.findByRole("heading", { name: "LangGraph" })).toBeTruthy();
  expect(view.getByTestId("copilot-chat").dataset.agentId).toBe(
    "picked-harness",
  );
  expect(view.queryByText('This deployment has no Bot called "".')).toBeNull();
  expect(view.queryByText("This deployment has no Bots yet.")).toBeNull();
});

test("/bot reports a failed initial roster load instead of claiming there are no Bots", async () => {
  const view = renderBot(queryClientWithFailingAgents());

  expect(await view.findByText("Bots couldn't be loaded.")).toBeTruthy();
  expect(view.queryByText("This deployment has no Bots yet.")).toBeNull();
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
    queryClientWithAgentsAndFetchedAgent(
      [GENERAL_ASSISTANT, PICKED_HARNESS],
      "missing-agent",
      new Response(null, { status: 404 }),
    ),
    "/bot?agent=missing-agent",
  );

  expect(
    await view.findByText('This deployment has no Bot called "missing-agent".'),
  ).toBeTruthy();
  expect(view.queryByTestId("copilot-chat")).toBeNull();
});

test("/bot loads a hidden explicit agent from the detail endpoint", async () => {
  const hiddenBot = agent({
    hidden: true,
    id: "hidden-bot",
    name: "Hidden Bot",
    title: "Hidden Bot",
  });
  const view = renderBot(
    queryClientWithAgentsAndFetchedAgent(
      [GENERAL_ASSISTANT],
      "hidden-bot",
      Response.json({ agent: hiddenBot }),
    ),
    "/bot?agent=hidden-bot",
  );

  expect(await view.findByRole("heading", { name: "Hidden Bot" })).toBeTruthy();
  expect(view.getByTestId("copilot-chat").dataset.agentId).toBe("hidden-bot");
  expect(
    view.queryByText('This deployment has no Bot called "hidden-bot".'),
  ).toBeNull();
});

test("/bot hidden lookup does not collide with the shared agent detail cache", async () => {
  const hiddenBot = agent({
    hidden: true,
    id: "hidden-bot",
    name: "Hidden Bot",
    title: "Hidden Bot",
  });
  const queryClient = queryClientWithAgentsAndFetchedAgent(
    [GENERAL_ASSISTANT],
    "hidden-bot",
    Response.json({ agent: hiddenBot }),
  );
  queryClient.setQueryData(agentKeys.detail("hidden-bot"), hiddenBot);
  const view = renderBot(queryClient, "/bot?agent=hidden-bot");

  expect(await view.findByRole("heading", { name: "Hidden Bot" })).toBeTruthy();
  expect(view.getByTestId("copilot-chat").dataset.agentId).toBe("hidden-bot");
  expect(
    view.queryByText('This deployment has no Bot called "hidden-bot".'),
  ).toBeNull();
});

test("/bot reports an explicit agent detail load failure", async () => {
  const view = renderBot(
    queryClientWithAgentsAndFetchedAgent(
      [GENERAL_ASSISTANT],
      "error-bot",
      Response.json({ error: "detail exploded" }, { status: 500 }),
    ),
    "/bot?agent=error-bot",
  );

  expect((await view.findByRole("alert")).textContent).toBe(
    "Bot couldn't be loaded.",
  );
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

test("/bot opens a live Computer sidebar with ownership controls and preserves the chat", async () => {
  HTMLElement.prototype.getBoundingClientRect = () =>
    new DOMRect(0, 0, 1200, 800);
  global.fetch = Object.assign(
    async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/control"))
        return Response.json({
          holder: "bot",
          since: "2026-09-26",
          requested: false,
          transitioning: false,
          resumeSnapshotRequired: false,
        });
      return Response.json({ error: "No frame yet" }, { status: 404 });
    },
    { preconnect: originalFetch.preconnect },
  );
  const view = renderBot(
    queryClientWithAgents([GENERAL_ASSISTANT, PICKED_HARNESS]),
    "/bot?agent=general-assistant",
  );
  const toggle = await view.findByRole("button", { name: "Open Computer" });
  await waitFor(() =>
    expect(
      view
        .getByRole("button", { name: "Take control" })
        .hasAttribute("disabled"),
    ).toBe(false),
  );
  const chat = view.getByTestId("copilot-chat");
  fireEvent.change(view.getByRole("textbox", { name: "Chat draft" }), {
    target: { value: "Keep this conversation" },
  });
  fireEvent.click(toggle);
  const sidebarElement = await view.findByRole("region", {
    name: "Computer sidebar",
  });
  const sidebar = within(sidebarElement);
  expect(
    sidebar
      .getByRole("button", { name: "Take control" })
      .hasAttribute("disabled"),
  ).toBe(false);
  expect(
    sidebar.getByRole("button", {
      name: "Open the assistant's screen full size",
    }),
  ).toBeTruthy();
  expect(sidebar.getByRole("heading", { name: "Activity" })).toBeTruthy();
  fireEvent.click(view.getByRole("button", { name: "Close Computer" }));
  // Poll a boolean: Bun serializes the entire Happy DOM tree when a pending
  // element is compared with null, starving the navigation this wait observes.
  await waitFor(() => expect(sidebarElement.isConnected).toBe(false));
  expect(view.getByTestId("copilot-chat")).toBe(chat);
  expect(chat.dataset.agentId).toBe("general-assistant");
  expect(view.getByDisplayValue("Keep this conversation")).toBeTruthy();
  expect(view.getByRole("button", { name: "Open Computer" })).toBeTruthy();
  fireEvent.click(view.getByRole("button", { name: "New chat" }));
  await waitFor(() =>
    expect(view.getByTestId("copilot-chat").dataset.threadId).not.toBe(
      chat.dataset.threadId,
    ),
  );
  expect(view.getByTestId("copilot-chat").dataset.agentId).toBe(
    "general-assistant",
  );
});

test("/bot?watch=true restores the live Computer panel on reload", async () => {
  HTMLElement.prototype.getBoundingClientRect = () =>
    new DOMRect(0, 0, 1200, 800);
  global.fetch = Object.assign(
    async () =>
      Response.json({
        holder: "bot",
        since: "2026-09-26",
        requested: false,
        transitioning: false,
        resumeSnapshotRequired: false,
      }),
    { preconnect: originalFetch.preconnect },
  );
  const view = renderBot(
    queryClientWithAgents([GENERAL_ASSISTANT]),
    "/bot?agent=general-assistant&watch=true",
  );
  const sidebar = within(
    await view.findByRole("region", { name: "Computer sidebar" }),
  );
  await waitFor(() =>
    expect(
      sidebar
        .getByRole("button", { name: "Take control" })
        .hasAttribute("disabled"),
    ).toBe(false),
  );
  expect(view.getByTestId("copilot-chat").dataset.agentId).toBe(
    "general-assistant",
  );
});
