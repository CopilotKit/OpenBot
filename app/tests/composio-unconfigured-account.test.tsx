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
import { serversListedFor } from "@/lib/plugins/listed";
import {
  type PluginConnections,
  type PluginServer,
  type PluginsPage,
  pluginKeys,
} from "@/lib/plugins/queries";
import { Route as ConnectedAccountRoute } from "@/routes/_authed/_app/connections.$key";
import { settleReactWork } from "./settle-react-work";

/**
 * A Composio app on a deployment with no Composio key, as the person who would connect it sees it.
 *
 * An app an administrator enabled while a key was set keeps its row after the key goes. The
 * Connected accounts list offered it, and its page drew "Set COMPOSIO_API_KEY on this deployment" —
 * an instruction for whoever runs the deployment, shown to somebody who cannot act on it. The list
 * now leaves it off, and the page says plainly that it is not available yet.
 *
 * The harness is `plugin-read-failure.test.tsx`'s: the exported `Route` singleton is captured and
 * restored around its `.update()`.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
// React may still have a passive effect queued when the last test ends; unregistering under it
// throws "window is not defined" between tests, which fails the run though every test passed.
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const originalFetch = global.fetch;

beforeEach(() => {
  // Every read this page makes is seeded below; anything else is a request the test did not expect.
  global.fetch = Object.assign(
    async () => new Response(null, { status: 404 }),
    { preconnect: originalFetch.preconnect },
  );
});

afterEach(() => {
  global.fetch = originalFetch;
});

function server(overrides: Partial<PluginServer> & { id: string }) {
  return {
    title: "App",
    summary: "",
    vendor: "Composio",
    url: `composio://${overrides.id}`,
    provenance: "composio",
    authScheme: "OAUTH2",
    tools: [],
    ...overrides,
  } as PluginServer;
}

const gmail = server({ id: "composio-gmail", title: "Gmail" });
const drive = server({
  id: "google-drive",
  title: "Google Drive",
  provenance: "catalogue",
  vendor: "Google",
} as Partial<PluginServer> & { id: string });

test("lists no Composio app when the deployment has no Composio key", () => {
  expect(
    serversListedFor({
      servers: [gmail, drive],
      composioConfigured: false,
    }).map((row) => row.id),
  ).toEqual(["google-drive"]);
});

test("lists Composio apps as before once the key is set", () => {
  expect(
    serversListedFor({
      servers: [gmail, drive],
      composioConfigured: true,
    }).map((row) => row.id),
  ).toEqual(["composio-gmail", "google-drive"]);
});

type Updatable = { update: (options: unknown) => unknown };

const pristine = {
  ...ConnectedAccountRoute,
  options: { ...ConnectedAccountRoute.options },
} as Record<string, unknown>;

afterEach(() => {
  for (const key of Object.keys(ConnectedAccountRoute)) {
    if (!(key in pristine)) {
      delete (ConnectedAccountRoute as unknown as Record<string, unknown>)[key];
    }
  }
  Object.assign(ConnectedAccountRoute, pristine);
});

function renderAccount(composioConfigured: boolean) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const page: PluginsPage = {
    catalogue: [],
    servers: [gmail],
    skills: [],
    botsMayCallBack: true,
    redirectUri: null,
    composioConfigured,
    // Composio's answer: its auth config fixes one state for a whole toolkit.
    authorizesPerAction: false,
  };
  const connections: PluginConnections = { connections: [], redirectUri: null };
  client.setQueryData(pluginKeys.page(), page);
  client.setQueryData(pluginKeys.connections(), connections);

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
  const connectionsRoute = createRoute({
    path: "/connections",
    getParentRoute: () => appRoute,
    component: Outlet,
  });
  const indexRoute = createRoute({
    path: "/",
    getParentRoute: () => connectionsRoute,
    component: () => null,
  });
  const account = (ConnectedAccountRoute as unknown as Updatable).update({
    id: "/$key",
    path: "/$key",
    getParentRoute: () => connectionsRoute,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      authedRoute.addChildren([
        appRoute.addChildren([
          connectionsRoute.addChildren([indexRoute, account as never]),
        ]),
      ]),
    ]),
    history: createMemoryHistory({
      initialEntries: ["/connections/composio-gmail"],
    }),
  });
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

test("the app's page says it is not available yet, and names no setting", async () => {
  const view = renderAccount(false);
  const empty = await view.findByText(/An admin has to turn on Gmail/);
  expect(empty.parentElement?.textContent).toContain("Not set up yet");
  expect(view.queryByText(/COMPOSIO_API_KEY/)).toBeNull();
  expect(view.queryByRole("button", { name: "Connect" })).toBeNull();
});

test("with the key set, the app's page offers the account as before", async () => {
  const view = renderAccount(true);
  expect(await view.findByText("Your account")).toBeTruthy();
  expect(view.queryByText(/isn't set up yet/)).toBeNull();
});
