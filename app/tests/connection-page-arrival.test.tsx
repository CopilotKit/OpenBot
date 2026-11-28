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
import { cleanup, render, waitFor, within } from "@testing-library/react";
import { Route as ConnectedAccountRoute } from "@/routes/_authed/_app/connections.$key";
import { type AppsFixture, answerAppsApi, type TodayServer } from "./apps-api";
import {
  confirmationResponse,
  connectionPage,
  MY_CONNECTIONS_PATH,
  myConnectionPath,
  startResponse,
} from "./connections-api";

/**
 * ARRIVING AT ANOTHER APP'S PAGE WITH `?connect=true` OPENS THAT APP'S KEY FORM.
 *
 * On a sign-in app's page, "Connect with a key instead" adds the key version and moves to that app's
 * page with `?connect=true`. The router keeps the page's component across the change of `$key`, so
 * an arrival read only on first mount still held the first app's, with no connect, and the key
 * form never opened. The page reads the arrival again whenever the app changes.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(async () => {
  await new Promise((resolve) => setTimeout(resolve, 50));
  await GlobalRegistrator.unregister();
});

/** An app from the directory that signs in. */
const SIGN_IN_APP = "gmail";
/** An app from the directory that connects with a key. */
const KEY_APP = "perplexityai";

function directoryApp(id: string, title: string, authScheme: string) {
  return {
    authScheme,
    id,
    title,
    url: `composio://${id}`,
    summary: "",
    docsUrl: "",
    provenance: "composio",
    hasCredential: false,
    toolsRefreshedAt: null,
    lastError: null,
    addedBy: null,
    dynamicClient: false,
    accountMode: null,
    sharedVendorConnected: false,
    ownerGrants: "any",
    ownerGrantsChosen: null,
    tools: [],
    withdrawn: [],
  } satisfies TodayServer;
}

const DEPLOYMENT: AppsFixture = {
  catalogue: [],
  servers: [
    directoryApp(SIGN_IN_APP, "Gmail", "OAUTH2"),
    directoryApp(KEY_APP, "Perplexity", "API_KEY"),
  ],
  botsMayCallBack: true,
  redirectUri: null,
  composioConfigured: true,
  provider: "composio",
  authorizesPerAction: false,
};

/** Every POST to a person's connect route, by its path. */
function installDeployment(): { connects: string[] } {
  const connects: string[] = [];
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input).split("?")[0] ?? "";
    const method = (init?.method ?? "GET").toUpperCase();
    if (path === MY_CONNECTIONS_PATH) return connectionPage([]);
    if (path.endsWith("/connect") && method === "POST") {
      connects.push(path);
      return startResponse({
        fields: [
          {
            name: "generic_api_key",
            label: "API Key",
            help: "Your Perplexity API key.",
            required: true,
            secret: true,
          },
        ],
      });
    }
    if (path.endsWith("/confirm") && method === "POST")
      return confirmationResponse(false);
    const apps = answerAppsApi(input, init, DEPLOYMENT);
    if (apps) return apps;
    return new Response(null, { status: 404 });
  }) as typeof fetch;
  return { connects };
}

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

/*
 * Capture and restore of the exported `Route` singleton, as `brokered-account-row.test.tsx` does:
 * `.update()` merges into the live object, which every other file in this bun process shares.
 */
function captureRouteState(route: object): Record<string, unknown> {
  return { ...route, options: { ...(route as { options: object }).options } };
}

function restoreRouteState(
  route: object,
  snapshot: Record<string, unknown>,
): void {
  for (const key of Object.keys(route)) {
    if (!(key in snapshot)) delete (route as Record<string, unknown>)[key];
  }
  Object.assign(route, snapshot);
}

const pristineRouteState = captureRouteState(ConnectedAccountRoute);
let routeSnapshot: Record<string, unknown>;
beforeEach(() => {
  routeSnapshot = captureRouteState(pristineRouteState);
});
afterEach(() => {
  restoreRouteState(ConnectedAccountRoute, routeSnapshot);
});

type TestRouter = { navigate: (options: unknown) => Promise<void> };

/** The connection page at its real id, under decoy parents, starting on `at`. */
function renderScreen(at: string) {
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
  const wired = (
    ConnectedAccountRoute as unknown as {
      update: (options: unknown) => typeof ConnectedAccountRoute;
    }
  ).update({
    id: "/$key",
    path: "/$key",
    getParentRoute: () => connectionsRoute,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      authedRoute.addChildren([
        appRoute.addChildren([
          connectionsRoute.addChildren([indexRoute, wired]),
        ]),
      ]),
    ]),
    history: createMemoryHistory({ initialEntries: [at] }),
  });
  const view = render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
  return { view, router: router as unknown as TestRouter };
}

test("arriving at another app's page with connect opens that app's key form", async () => {
  const server = installDeployment();
  const { view, router } = renderScreen(`/connections/${SIGN_IN_APP}`);

  // On the sign-in app's page, with nothing started.
  expect(await view.findByRole("button", { name: "Connect" })).toBeTruthy();
  expect(view.queryByRole("dialog")).toBeNull();

  await router.navigate({
    to: "/connections/$key",
    params: { key: KEY_APP },
    search: { connect: true },
  });

  // The key app's form opens on arrival, asked of the key app.
  const dialog = await view.findByRole("dialog");
  expect(within(dialog).getByText("Connect your account")).toBeTruthy();
  expect(await within(dialog).findByLabelText("API Key")).toBeTruthy();
  await waitFor(() =>
    expect(server.connects).toEqual([myConnectionPath(KEY_APP, "connect")]),
  );
});
