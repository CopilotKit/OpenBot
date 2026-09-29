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
import { cleanup, render, waitFor } from "@testing-library/react";
import { type PluginsPage, pluginKeys } from "@/lib/plugins/queries";
import { Route as AdminAppRoute } from "@/routes/_authed/admin/plugins/$key";
import { Route as AdminToolRoute } from "@/routes/_authed/admin/plugins/$key_.tools.$tool";
import { Route as ConnectedAccountRoute } from "@/routes/_authed/settings/connected-accounts/$key";

/**
 * A connector's own pages, when `GET /api/plugins` fails.
 *
 * Each of them decides whether the connector exists from `plugins.data`, and `isPending` goes false
 * on a failed fetch exactly as it does on a successful one, so a request that never came back fell
 * through to "there is no such connector" — about a connector that may be added and granted right
 * now. The per-Bot grant screen beside them already tells the two apart (`plugins.data && !server`,
 * see `bot-app-grants-screen.test.tsx`); these are the three pages that did not.
 *
 * Only the plugins read fails here. The connections and roster reads answer, so each case is about
 * that one read and nothing else on the page.
 *
 * THE HARNESS IS THIS REPOSITORY'S, as in `bot-app-grants-screen.test.tsx` and
 * `brokered-account-row.test.tsx`: `GlobalRegistrator` in `beforeAll`/`afterAll`, `cleanup` in
 * `afterEach`, queries off `render()`'s own return, a `QueryClient` with `retry: false`, and each
 * exported `Route` singleton captured and restored around its `.update()`.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

const APP_KEY = "slack";
const TOOL_NAME = "list_channels";
const originalFetch = global.fetch;

beforeEach(() => {
  global.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0]) => {
      const path = String(input).split("?")[0];
      const json = (body: unknown) =>
        new Response(JSON.stringify(body), {
          headers: { "content-type": "application/json" },
        });
      if (path === "/api/plugins/connections") return json({ connections: [] });
      if (path === "/api/agents") return json({ agents: [] });
      // The one read under test: a 500 with no body, the shape a broken server sends.
      return new Response(null, { status: 500 });
    },
    { preconnect: originalFetch.preconnect },
  );
});

afterEach(() => {
  global.fetch = originalFetch;
});

/** A client the failing query settles on in one attempt, so no test waits on a retry. */
function failingQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

/** A client already holding a plugins page that genuinely lacks this connector. */
function answeredWithout() {
  const client = failingQueryClient();
  const page: PluginsPage = {
    catalogue: [],
    servers: [],
    skills: [],
    botsMayCallBack: true,
    redirectUri: null,
    composioConfigured: false,
  };
  client.setQueryData(pluginKeys.page(), page);
  return client;
}

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

const routes = [AdminAppRoute, AdminToolRoute, ConnectedAccountRoute];
const pristine = routes.map(captureRouteState);
let snapshots: Record<string, unknown>[] = [];

beforeEach(() => {
  snapshots = pristine.map(captureRouteState);
});

afterEach(() => {
  routes.forEach((route, index) => {
    restoreRouteState(route, snapshots[index] ?? {});
  });
});

type Updatable = { update: (options: unknown) => unknown };

/** `/admin/plugins/$key` and `/admin/plugins/$key/tools/$tool`, at the ids their `useParams` read. */
function renderAdmin(client: QueryClient, at: string) {
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
  const pluginsRoute = createRoute({
    path: "/plugins/",
    getParentRoute: () => adminRoute,
    component: () => null,
  });
  const app = (AdminAppRoute as unknown as Updatable).update({
    id: "/plugins/$key",
    path: "/plugins/$key",
    getParentRoute: () => adminRoute,
  });
  const tool = (AdminToolRoute as unknown as Updatable).update({
    id: "/plugins/$key_/tools/$tool",
    path: "/plugins/$key/tools/$tool",
    getParentRoute: () => adminRoute,
  });
  const tree = rootRoute.addChildren([
    authedRoute.addChildren([
      adminRoute.addChildren([pluginsRoute, app as never, tool as never]),
    ]),
  ]);
  const router = createRouter({
    routeTree: tree,
    history: createMemoryHistory({ initialEntries: [at] }),
  });
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

/** `/settings/connected-accounts/$key`, at the id its `useParams` reads. */
function renderAccount(client: QueryClient) {
  const rootRoute = createRootRoute({ component: Outlet });
  const authedRoute = createRoute({
    id: "/_authed",
    getParentRoute: () => rootRoute,
    component: Outlet,
  });
  const settingsRoute = createRoute({
    path: "/settings",
    getParentRoute: () => authedRoute,
    component: Outlet,
  });
  const indexRoute = createRoute({
    path: "/connected-accounts/",
    getParentRoute: () => settingsRoute,
    component: () => null,
  });
  const account = (ConnectedAccountRoute as unknown as Updatable).update({
    id: "/connected-accounts/$key",
    path: "/connected-accounts/$key",
    getParentRoute: () => settingsRoute,
  });
  const tree = rootRoute.addChildren([
    authedRoute.addChildren([
      settingsRoute.addChildren([indexRoute, account as never]),
    ]),
  ]);
  const router = createRouter({
    routeTree: tree,
    history: createMemoryHistory({
      initialEntries: [`/settings/connected-accounts/${APP_KEY}`],
    }),
  });
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

async function waitForFailedRead(client: QueryClient) {
  await waitFor(() => {
    expect(client.getQueryState(pluginKeys.page())?.status).toBe("error");
  });
}

test("a connector's admin page says the plugin list failed, not that there is no such plugin", async () => {
  const client = failingQueryClient();
  const view = renderAdmin(client, `/admin/plugins/${APP_KEY}`);
  await waitForFailedRead(client);

  expect(await view.findByText("Plugins could not be loaded.")).toBeTruthy();
  expect(view.queryByText("Not a plugin")).toBeNull();
  expect(view.queryByText("Nothing to configure.")).toBeNull();
});

test("a list that genuinely lacks the connector still says it is not a plugin", async () => {
  const client = answeredWithout();
  const view = renderAdmin(client, `/admin/plugins/${APP_KEY}`);
  await waitForFailedRead(client);

  expect(await view.findByText("Not a plugin")).toBeTruthy();
  expect(view.queryByText("Plugins could not be loaded.")).toBeNull();
});

test("a tool's admin page says the plugin list failed, not that the connector is off", async () => {
  const client = failingQueryClient();
  const view = renderAdmin(
    client,
    `/admin/plugins/${APP_KEY}/tools/${TOOL_NAME}`,
  );
  await waitForFailedRead(client);

  expect(await view.findByText("Plugins could not be loaded.")).toBeTruthy();
  expect(
    view.queryByText("This deployment has not enabled that connector."),
  ).toBeNull();
  expect(
    view.queryByText("This connector does not advertise a tool by that name."),
  ).toBeNull();
});

test("a list that genuinely lacks the connector still says it is not enabled, on the tool page", async () => {
  const client = answeredWithout();
  const view = renderAdmin(
    client,
    `/admin/plugins/${APP_KEY}/tools/${TOOL_NAME}`,
  );
  await waitForFailedRead(client);

  expect(
    await view.findByText("This deployment has not enabled that connector."),
  ).toBeTruthy();
  expect(view.queryByText("Plugins could not be loaded.")).toBeNull();
});

test("a connected account's page says the plugin list failed, not that it is not a service to connect", async () => {
  const client = failingQueryClient();
  const view = renderAccount(client);
  await waitForFailedRead(client);

  expect(await view.findByRole("alert")).toBeTruthy();
  expect(
    view.queryByText("This is not a service you connect for yourself."),
  ).toBeNull();
});
