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
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render } from "@testing-library/react";
import type { PluginServer, PluginsPage } from "@/lib/plugins/queries";
import { Route as AdminPluginRoute } from "@/routes/_authed/admin/plugins/$key";

/**
 * The admin app-detail page's brokered row, on each broker (spec D11).
 *
 * The row is drawn by `BrokeredAccountRow`, which is told the provider by its caller.
 * The page already knows the provider, so it must tell the row — in both places it draws one (the
 * personal row and the Shared-mode team row). Arcade is scanned over text AND markup; Composio's
 * affected sentence is pinned as an exact string.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(async () => {
  await new Promise((resolve) => setTimeout(resolve, 50));
  await GlobalRegistrator.unregister();
});

const APP = "gmail";

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
const pristine = captureRouteState(AdminPluginRoute);
let snapshot: Record<string, unknown>;
beforeEach(() => {
  snapshot = captureRouteState(pristine);
});
afterEach(() => {
  restoreRouteState(AdminPluginRoute, snapshot);
});

type Provider = "composio" | "arcade";

function server(provider: Provider, shared: boolean): PluginServer {
  return {
    authScheme: "OAUTH2",
    id: APP,
    title: "Gmail",
    vendor: "Google",
    url: provider === "arcade" ? "arcade://gmail" : "https://example.invalid",
    summary: "Mail.",
    docsUrl: "",
    provenance: provider,
    hasCredential: false,
    toolsRefreshedAt: null,
    lastError: null,
    addedBy: null,
    dynamicClient: false,
    accountMode: shared ? "shared" : null,
    sharedVendorConnected: false,
    ownerGrants: shared ? "admin" : "any",
    ownerGrantsChosen: null,
    tools: [],
    withdrawn: [],
  };
}

function install(setup: {
  provider: Provider;
  shared: boolean;
  configured: boolean;
}) {
  const page: PluginsPage = {
    catalogue: [],
    servers: [server(setup.provider, setup.shared)],
    skills: [],
    botsMayCallBack: true,
    redirectUri: null,
    composioConfigured: setup.configured,
    authorizesPerAction: setup.provider === "arcade",
    provider: setup.provider,
  };
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      headers: { "content-type": "application/json" },
      status,
    });
  global.fetch = (async (input: RequestInfo | URL) => {
    const path = String(input).split("?")[0] ?? "";
    if (path === "/api/plugins") return json(page);
    if (path.startsWith("/api/plugins/connections"))
      return json({ connections: [], redirectUri: null });
    if (path.startsWith("/api/agents")) return json([]);
    return json({ error: "unexpected" }, 404);
  }) as typeof fetch;
}

function renderScreen() {
  const rootRoute = createRootRoute({ component: Outlet });
  const authedRoute = createRoute({
    id: "/_authed",
    getParentRoute: () => rootRoute,
    component: Outlet,
  });
  const adminRoute = createRoute({
    path: "/admin",
    getParentRoute: () => authedRoute,
    component: Outlet,
  });
  const indexRoute = createRoute({
    path: "/plugins/",
    getParentRoute: () => adminRoute,
    component: () => null,
  });
  const wired = (
    AdminPluginRoute as unknown as {
      update: (options: unknown) => typeof AdminPluginRoute;
    }
  ).update({
    id: "/plugins/$key",
    path: "/plugins/$key",
    getParentRoute: () => adminRoute,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      authedRoute.addChildren([adminRoute.addChildren([indexRoute, wired])]),
    ]),
    history: createMemoryHistory({ initialEntries: [`/admin/plugins/${APP}`] }),
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

/** Every string the page puts in front of anyone: its text AND its markup, attributes included. */
function everythingRendered(view: ReturnType<typeof render>): string {
  return `${view.container.textContent ?? ""}\n${view.container.innerHTML}`;
}

/** Waits for the row only, whichever broker it names: the assertions below do the judging. */
const WAIT_FOR_ROW = /^Set [A-Z]+_API_KEY on this deployment\./;

const COMPOSIO_KEY_MISSING =
  "Set COMPOSIO_API_KEY on this deployment. Until then, this account can't be connected or disconnected here. The app stays turned on, and its tool grants still stand.";
const ARCADE_KEY_MISSING =
  "Set ARCADE_API_KEY on this deployment. Until then, this account can't be connected or disconnected here. The app stays turned on, and its tool grants still stand.";

for (const shared of [false, true]) {
  const row = shared ? "team row" : "personal row";

  test(`on an Arcade deployment the admin page's brokered ${row} says nothing of Composio`, async () => {
    install({ provider: "arcade", shared, configured: false });
    const view = renderScreen();
    await view.findByText(WAIT_FOR_ROW);
    const rendered = everythingRendered(view);
    expect(rendered).not.toMatch(/composio/i);
    expect(rendered).not.toContain("COMPOSIO_API_KEY");
    expect(rendered).toContain(ARCADE_KEY_MISSING);
  });

  test(`on a Composio deployment the admin page's brokered ${row} renders its sentence verbatim`, async () => {
    install({ provider: "composio", shared, configured: false });
    const view = renderScreen();
    await view.findByText(WAIT_FOR_ROW);
    expect(view.container.textContent).toContain(COMPOSIO_KEY_MISSING);
  });
}
