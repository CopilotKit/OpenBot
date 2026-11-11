import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  type AnyRoute,
  createMemoryHistory,
  createRootRouteWithContext,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, waitFor } from "@testing-library/react";
import type { ComponentType } from "react";
import { deploymentKeys } from "@/lib/deployment/queries";
import { Route as BotAccessRoute } from "@/routes/_authed/_app/bots.$agentId.access";
import { Route as BotMemoryRoute } from "@/routes/_authed/_app/bots.$agentId.memory";
import { Route as BotsRoute } from "@/routes/_authed/_app/bots.index";
import { Route as CapabilitiesMemoryRoute } from "@/routes/_authed/_app/capabilities.memory";
import { Route as MemoryRoute } from "@/routes/_authed/_app/memory";
import { Route as SettingsMemoryRoute } from "@/routes/_authed/settings/memory";
import { settleReactWork } from "./settle-react-work";

/*
 * The personal edition offers no memory: OpenBot Desktop's local Intelligence is not licensed for
 * it. So no screen, row or link there leads to memory, and an address that used to open one opens
 * the nearest page that is there. The team edition keeps every one of them.
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

type Edition = "team" | "personal";

function clientFor(edition: Edition) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(deploymentKeys.capabilities(), {
    generativeUi: true,
    selfHostBanner: false,
    localEvaluation: edition === "personal",
    edition,
  });
  return client;
}

/** Everything else answers as a server with nothing in it would. */
function servingNothing() {
  global.fetch = Object.assign(
    async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/api/proactive/settings")
        return Response.json({ settings: [], allowed: true });
      if (path === "/api/agents/expenses")
        return Response.json({
          agent: { id: "expenses", name: "Expenses", mine: true },
        });
      return Response.json({ error: "Not part of this test" }, { status: 404 });
    },
    { preconnect: originalFetch.preconnect },
  );
}

describe("an address that opened memory", () => {
  /**
   * The memory routes' own guards, in a router at the paths they have in the app. Each page is a
   * stand-in that names itself, so where the router lands is what the test reads.
   */
  async function land(edition: Edition, at: string) {
    const client = clientFor(edition);
    const root = createRootRouteWithContext<{ queryClient: QueryClient }>()({
      component: Outlet,
    });
    const page = (
      path: string,
      name: string,
      real?: { options: { beforeLoad?: unknown } },
    ): AnyRoute =>
      createRoute({
        getParentRoute: () => root,
        path,
        // The real route's guard, unchanged.
        beforeLoad: real?.options.beforeLoad as never,
        component: () => <p>{name}</p>,
      }) as unknown as AnyRoute;
    const router = createRouter({
      context: { queryClient: client },
      history: createMemoryHistory({ initialEntries: [at] }),
      routeTree: root.addChildren([
        page("/bots", "Bots"),
        page("/bots/$agentId/access", "What it can do"),
        page("/bots/$agentId/routines", "Routines"),
        page("/bots/$agentId/memory", "Bot memory", BotMemoryRoute),
        page("/capabilities/memory", "Old memory", CapabilitiesMemoryRoute),
        page("/settings/memory", "Older memory", SettingsMemoryRoute),
        page("/memory", "Memory", MemoryRoute),
      ]),
    });
    const view = render(
      <QueryClientProvider client={client}>
        <RouterProvider router={router as never} />
      </QueryClientProvider>,
    );
    await router.load();
    return { view, path: () => router.state.location.pathname };
  }

  test("goes to the Bots page in the personal edition", async () => {
    for (const at of ["/capabilities/memory", "/memory", "/settings/memory"]) {
      const { view, path } = await land("personal", at);
      await waitFor(() => expect(path()).toBe("/bots"));
      expect(await view.findByText("Bots")).toBeTruthy();
      cleanup();
    }
  });

  test("goes to the Bot's Routines, where its check-ins are, in the personal edition", async () => {
    const { view, path } = await land("personal", "/bots/expenses/memory");
    await waitFor(() => expect(path()).toBe("/bots/expenses/routines"));
    expect(await view.findByText("Routines")).toBeTruthy();
  });

  test("still opens memory in the team edition, on its own page", async () => {
    for (const at of ["/capabilities/memory", "/memory", "/settings/memory"]) {
      const { view, path } = await land("team", at);
      await waitFor(() => expect(path()).toBe("/memory"));
      expect(await view.findByText("Memory")).toBeTruthy();
      cleanup();
    }
    const { view, path } = await land("team", "/bots/expenses/memory");
    expect(await view.findByText("Bot memory")).toBeTruthy();
    expect(path()).toBe("/bots/expenses/memory");
  });
});

/** A real page component, in a router whose every address is a page. */
function drawPage(edition: Edition, Page: ComponentType, at: string) {
  const client = clientFor(edition);
  const root = createRootRouteWithContext<{ queryClient: QueryClient }>()({
    component: Outlet,
  });
  const router = createRouter({
    context: { queryClient: client },
    history: createMemoryHistory({ initialEntries: [at] }),
    routeTree: root.addChildren([
      createRoute({
        getParentRoute: () => root,
        path: "$",
        component: () => <Page />,
      }),
    ]),
  });
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

describe("the Bots page", () => {
  test("has Skills and no Memory under What your Bots learn in the personal edition", async () => {
    servingNothing();
    // The page reads its search and navigates through its own route, mounted here at `$`.
    const search = spyOn(BotsRoute, "useSearch").mockImplementation(
      (() => ({})) as never,
    );
    try {
      const view = drawPage(
        "personal",
        BotsRoute.options.component as ComponentType,
        "/bots",
      );
      expect(await view.findByText("What your Bots learn")).toBeTruthy();
      expect(view.getByText("Skills").closest("a")?.getAttribute("href")).toBe(
        "/skills",
      );
      expect(view.queryByText("Memory")).toBeNull();
      expect(view.container.querySelector('a[href="/memory"]')).toBeNull();
    } finally {
      search.mockRestore();
    }
  });
});

describe("a Bot's What it can do page", () => {
  test("is split by kind, and an old link opens the Bot's Apps", () => {
    let thrown: unknown;
    try {
      (
        BotAccessRoute.options.beforeLoad as unknown as (input: unknown) => void
      )({ params: { agentId: "expenses" } });
    } catch (error) {
      thrown = error;
    }
    expect(
      (thrown as { options?: { to?: string; params?: unknown } }).options,
    ).toMatchObject({
      to: "/bots/$agentId/apps",
      params: { agentId: "expenses" },
    });
  });
});
