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
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { Route as ConnectedAccountRoute } from "@/routes/_authed/_app/connections.$key";
import { ME_PATH } from "./accounts-api";
import { type AppsFixture, answerAppsApi, type TodayServer } from "./apps-api";
import {
  accountsPage,
  confirmationResponse,
  connectionPage,
  connectionResponse,
  connectionsCall,
  connectionsProblem,
  disconnectionResponse,
  disconnectPreviewResponse,
} from "./connections-api";

/**
 * ONCE A CONNECTION IS DISCONNECTED, ITS PAGE STOPS READING IT.
 *
 * Disconnecting an app refreshes the person's connections, and the app's page stays up, reading the
 * account, until that list comes back without it. The account's own reads (the connection, its
 * accounts, what a disconnect would also end) asked once more in that moment, for a connection that
 * no longer exists, and were answered 404. So from the moment a disconnect of this app is on its
 * way they are not read, and what they had read is dropped rather than read again.
 *
 * The list is held here until the end, which is the moment a slow list gives those reads in
 * production: every request after the disconnect is recorded, and none may be for the connection.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(async () => {
  // Let React's scheduler drain before the DOM globals it reads go away.
  await new Promise((resolve) => setTimeout(resolve, 50));
  await GlobalRegistrator.unregister();
});

const APP = "composio-gmail";

function gmail(): TodayServer {
  return {
    authScheme: "OAUTH2",
    id: APP,
    title: "Gmail",
    vendor: "Google",
    url: "https://example.invalid/composio",
    summary: "Mail.",
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
  };
}

/** The API, connected until the disconnect lands; after it, the list is held until `release`. */
function install() {
  const state = { connected: true, disconnected: false };
  const afterDisconnect: string[] = [];
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const page: AppsFixture = {
    catalogue: [],
    servers: [gmail()],
    botsMayCallBack: true,
    redirectUri: null,
    composioConfigured: true,
    authorizesPerAction: false,
  };
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      headers: { "content-type": "application/json" },
      status,
    });
  const row = {
    serverId: APP,
    connectedAt: "2026-11-15T01:39:19.849Z",
    verified: true,
    verifiedAt: "2026-11-15T01:39:19.848Z",
    checkable: true,
    canAddAccount: true,
  };
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input).split("?")[0] ?? "";
    if (path === ME_PATH)
      return json({ user: { id: "u", role: "user", email: "u@x.io" } });
    const apps = answerAppsApi(input, init, page);
    if (apps) return apps;
    const call = connectionsCall(input, init);
    if (call) {
      if (state.disconnected && call.appId === APP)
        afterDisconnect.push(`${call.method} ${call.operation}`);
      if (call.operation === "list") {
        if (state.disconnected) await held;
        return connectionPage(state.connected ? [row] : []);
      }
      if (call.operation === "disconnect") {
        state.connected = false;
        state.disconnected = true;
        return disconnectionResponse();
      }
      if (!state.connected)
        return connectionsProblem(404, "There is no such connection.");
      if (call.operation === "get") return connectionResponse(row);
      if (call.operation === "accounts")
        return accountsPage([
          {
            id: "acc_1",
            identity: "me@example.com",
            label: "me@example.com",
            isDefault: true,
            connectedAt: row.connectedAt,
          },
        ]);
      if (call.operation === "disconnect-preview")
        return disconnectPreviewResponse({ siblings: [], unanswered: 0 });
      if (call.operation === "confirm") return confirmationResponse(true);
    }
    return json({ error: "unexpected" }, 404);
  }) as typeof fetch;
  return {
    afterDisconnect,
    disconnected: () => state.disconnected,
    release: () => release(),
  };
}

function renderPage() {
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
  const listRoute = createRoute({
    path: "/connections/",
    getParentRoute: () => appRoute,
    component: () => null,
  });
  const accountRoute = (
    ConnectedAccountRoute as unknown as {
      update: (options: unknown) => typeof ConnectedAccountRoute;
    }
  ).update({
    id: "/connections/$key",
    path: "/connections/$key",
    getParentRoute: () => appRoute,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      authedRoute.addChildren([
        appRoute.addChildren([listRoute, accountRoute]),
      ]),
    ]),
    history: createMemoryHistory({ initialEntries: [`/connections/${APP}`] }),
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

test("disconnecting an app reads nothing more about its connection while the list comes back", async () => {
  const api = install();
  const view = renderPage();

  const disconnect = await view.findByRole("button", { name: "Disconnect" });
  fireEvent.click(disconnect);
  await waitFor(() => expect(api.disconnected()).toBe(true));
  // Long enough for a refetch the disconnect started to have been asked.
  await new Promise((resolve) => setTimeout(resolve, 300));

  // Nothing about this app's connection is asked once it is gone: the list is how the page learns.
  expect(api.afterDisconnect).toEqual([]);

  api.release();
  await waitFor(() =>
    expect(view.container.textContent).toContain("Not connected"),
  );
});
