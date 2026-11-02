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
 * The admin app page's "Bot owners can give it to their Bots" line says what letting owners decide
 * means for the app's account: on a shared account, an owner's grant lets their Bot use the team
 * account.
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

function server(shared: boolean, ownerGrants: "any" | "admin"): PluginServer {
  return {
    authScheme: "OAUTH2",
    id: APP,
    title: "Gmail",
    vendor: "Google",
    url: "https://example.invalid",
    summary: "Mail.",
    docsUrl: "",
    provenance: "composio",
    hasCredential: false,
    toolsRefreshedAt: null,
    lastError: null,
    addedBy: null,
    dynamicClient: false,
    accountMode: shared ? "shared" : null,
    sharedVendorConnected: false,
    ownerGrants,
    ownerGrantsChosen: null,
    tools: [],
    withdrawn: [],
  };
}

function install(setup: { shared: boolean; ownerGrants: "any" | "admin" }) {
  const page: PluginsPage = {
    catalogue: [],
    servers: [server(setup.shared, setup.ownerGrants)],
    skills: [],
    botsMayCallBack: true,
    redirectUri: null,
    composioConfigured: true,
    authorizesPerAction: false,
    provider: "composio",
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

const cases = [
  {
    shared: true,
    ownerGrants: "any",
    line: "Bot owners who give it to their Bots let those Bots use the team account.",
  },
  {
    shared: false,
    ownerGrants: "any",
    line: "People can let Bots they own use it, on the account of whoever is asking.",
  },
  {
    shared: true,
    ownerGrants: "admin",
    line: "Only an admin can give it to a Bot.",
  },
] as const;

for (const { shared, ownerGrants, line } of cases) {
  test(`a ${shared ? "shared" : "personal"} app whose rule is ${ownerGrants} says: ${line}`, async () => {
    install({ shared, ownerGrants });
    const view = renderScreen();
    expect(await view.findByText(line)).toBeTruthy();
  });
}
