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
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { PluginPage } from "@/components/manage/plugin-page";
import { agentKeys } from "@/lib/agents/queries";
import { authKeys } from "@/lib/auth/queries";
import { deploymentKeys } from "@/lib/deployment/queries";
import { identityKeys } from "@/lib/identity/queries";
import { Route as AppPageRoute } from "@/routes/_authed/_app/connections.$key";
import { Route as ConnectionsRoute } from "@/routes/_authed/_app/connections.index";
import { APPS_SETTING_PATH, appsSettingResponse } from "./admin-settings-api";
import {
  type AppsFixture,
  answerAppsApi,
  type TodayCatalogueItem,
  type TodayServer,
} from "./apps-api";
import {
  APP_ACCESS_REQUESTS_PATH,
  appAccessRequestsResponse,
} from "./bot-grants-api";
import {
  confirmationResponse,
  connectionPage,
  connectionsCall,
  sharedConnectionResponse,
  startResponse,
  type TodayConnection,
} from "./connections-api";
import { settleReactWork } from "./settle-react-work";

/**
 * RECONNECT ON AN APP THAT SIGNS IN IS ONE PRESS, FROM EVERY SCREEN THAT OFFERS IT.
 *
 * Reconnect on a key app opened its key form over the account that stands. Reconnect on an app that
 * signs in still opened its page as it was: an app OpenBot signs in to itself (Notion from the
 * catalogue, an MCP server added by its address that signs each person in) whose grant the vendor
 * withdrew read "Connected" there, with nothing to press, and arriving from the reconnect list
 * started nothing. Connections drew its tile "Connected" too. Every one of these now starts the
 * sign-in from the one press, through the connect route, and the vendor's page is where it goes.
 *
 * The server is faked at its addresses, in the API's shapes: the connections list names a
 * withdrawn grant `revoked`, and the connect route answers a sign-in with `next: consent` and the
 * vendor's address, as it does for a withdrawn grant.
 */

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  await GlobalRegistrator.unregister();
});

/** Notion from OpenBot's catalogue, signed in to by OpenBot itself. */
const notionEntry: TodayCatalogueItem = {
  key: "notion",
  title: "Notion",
  vendor: "Notion",
  summary: "Pages and databases.",
  docsUrl: "",
  auth: "user-oauth",
  perInstance: false,
};
const notion: TodayServer = {
  id: "notion",
  title: "Notion",
  vendor: "Notion",
  url: "https://mcp.notion.com/mcp",
  summary: "",
  docsUrl: "",
  provenance: "first-party",
  hasCredential: true,
  toolsRefreshedAt: null,
  lastError: null,
  addedBy: "admin@example.com",
  dynamicClient: false,
  signIn: false,
  authScheme: null,
  tools: [],
  withdrawn: [],
  accountMode: null,
  sharedVendorConnected: false,
  ownerGrants: "any",
  ownerGrantsChosen: null,
};
/** An MCP server added by its address, whose own server signs each person in. */
const sanity: TodayServer = {
  ...notion,
  id: "sanity",
  title: "Sanity",
  vendor: "Sanity",
  url: "https://mcp.sanity.io",
  provenance: "custom",
  hasCredential: false,
  dynamicClient: true,
  signIn: true,
};
/** Gmail from the directory, run on the organization's one shared account. */
const sharedGmail: TodayServer = {
  ...notion,
  id: "composio-gmail",
  title: "Gmail",
  vendor: "composio",
  url: "composio://gmail",
  provenance: "composio",
  hasCredential: false,
  authScheme: "OAUTH2",
  accountMode: "shared",
};

const FIXTURE: AppsFixture = {
  catalogue: [notionEntry],
  servers: [notion, sanity, sharedGmail],
  botsMayCallBack: true,
  redirectUri: "https://openbot.example/callback",
  composioConfigured: true,
  authorizesPerAction: false,
  provider: "composio",
};

/** The person's connections: a grant the vendor withdrew, for each app OpenBot signs in to. */
let rows: TodayConnection[] = [];
/** Every connect the browser asked for, as `<app>` or `shared <app>`. */
const connects: string[] = [];
/** What the page sent the browser to: the vendor's sign-in. */
const navigations: string[] = [];

const originalFetch = global.fetch;
beforeEach(() => {
  rows = [
    { serverId: "notion", revoked: true, scope: "read" },
    { serverId: "sanity", revoked: true, scope: "" },
  ];
  connects.length = 0;
  navigations.length = 0;
  global.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), "http://openbot.invalid").pathname;
      if (path === APPS_SETTING_PATH) return appsSettingResponse(false);
      if (path === APP_ACCESS_REQUESTS_PATH)
        return appAccessRequestsResponse([]);
      const call = connectionsCall(input, init);
      if (call?.operation === "list") return connectionPage(rows);
      if (call?.operation === "connect") {
        connects.push(`${call.shared ? "shared " : ""}${call.appId}`);
        return startResponse({
          authorizationUrl: `https://sign-in.example/${call.appId}`,
        });
      }
      if (call?.operation === "confirm") return confirmationResponse(false);
      if (call?.shared && call.operation === "get")
        return sharedConnectionResponse({
          appId: call.appId ?? "",
          connected: false,
        });
      const apps = answerAppsApi(input, init, FIXTURE);
      if (apps) return apps;
      return Response.json({ error: "not served" }, { status: 404 });
    },
    { preconnect: originalFetch.preconnect },
  );
  /*
   * happy-dom does not navigate, and keeps `about:blank` whatever is written to `href`: the one act
   * a sign-in press ends in leaves no trace unless the property is watched.
   */
  Object.defineProperty(window.location, "href", {
    configurable: true,
    get: () => "http://localhost/",
    set: (value: string) => {
      navigations.push(String(value));
    },
  });
});
afterEach(() => {
  global.fetch = originalFetch;
  delete (window.location as unknown as Record<string, unknown>).href;
});

/*
 * `.update()` merges into the exported route objects, which every other file in this bun process
 * shares, so each is captured and put back (as `connection-page-arrival.test.tsx` does).
 */
function captureRouteState(route: object): Record<string, unknown> {
  return { ...route, options: { ...(route as { options: object }).options } };
}
function restoreRouteState(route: object, snapshot: Record<string, unknown>) {
  for (const key of Object.keys(route)) {
    if (!(key in snapshot)) delete (route as Record<string, unknown>)[key];
  }
  Object.assign(route, snapshot);
}
const pristine = [
  [AppPageRoute, captureRouteState(AppPageRoute)],
  [ConnectionsRoute, captureRouteState(ConnectionsRoute)],
] as const;
afterEach(() => {
  for (const [route, snapshot] of pristine)
    restoreRouteState(route, captureRouteState(snapshot));
});

function client(): QueryClient {
  const queries = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  queries.setQueryData(deploymentKeys.capabilities(), {
    generativeUi: true,
    selfHostBanner: false,
    localEvaluation: false,
    edition: "team",
    hostedSignIn: true,
  });
  queries.setQueryData(authKeys.currentUser(), {
    id: "usr_member",
    email: "member@example.com",
    name: "Member",
    role: "member",
  } as never);
  queries.setQueryData(identityKeys.links(), []);
  queries.setQueryData(identityKeys.providers(), {
    slack: false,
    github: false,
  });
  return queries;
}

/** Connections and an app's page under Connections, the real routes, starting at `at`. */
function drawConnections(at: string) {
  const root = createRootRoute({ component: Outlet });
  const authed = createRoute({
    id: "/_authed",
    getParentRoute: () => root,
    component: Outlet,
  });
  const app = createRoute({
    id: "/_app",
    getParentRoute: () => authed,
    component: Outlet,
  });
  const connections = createRoute({
    path: "/connections",
    getParentRoute: () => app,
    component: Outlet,
  });
  const list = (
    ConnectionsRoute as unknown as { update: (o: unknown) => unknown }
  ).update({ id: "/", path: "/", getParentRoute: () => connections });
  const page = (
    AppPageRoute as unknown as { update: (o: unknown) => unknown }
  ).update({ id: "/$key", path: "/$key", getParentRoute: () => connections });
  const router = createRouter({
    routeTree: root.addChildren([
      authed.addChildren([
        app.addChildren([
          connections.addChildren([list as never, page as never]),
        ]),
      ]),
    ]),
    history: createMemoryHistory({ initialEntries: [at] }),
  });
  return render(
    <QueryClientProvider client={client()}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

/** An app's page under Admin, as an admin of the organization reads it. */
function drawAdminPage(key: string, startConnect = false) {
  const queries = client();
  queries.setQueryData(authKeys.currentUser(), {
    id: "usr_admin",
    email: "admin@example.com",
    name: "Admin",
    role: "admin",
  } as never);
  const bots = [{ id: "bot-1", name: "Expenses", hidden: false }];
  queries.setQueryData(agentKeys.list(false), bots);
  queries.setQueryData(agentKeys.list(true), bots);
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: createRootRoute({
      component: () => (
        <PluginPage pluginKey={key} startConnect={startConnect} />
      ),
    }),
  });
  return render(
    <QueryClientProvider client={queries}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

test.each([
  ["notion", "Notion", "OpenBot's own sign-in"],
  ["sanity", "Sanity", "an MCP server that signs people in"],
])(
  "the app's own page: Reconnect on %s, a sign-in the vendor withdrew, starts the sign-in in one press",
  async (key, title) => {
    const view = drawConnections(`/connections/${key}`);
    expect(
      await view.findByText(`Your ${title} connection needs reconnecting.`),
    ).toBeTruthy();
    // Nothing reads it as connected, or offers only a Disconnect that isn't built.
    expect(view.queryByRole("button", { name: /^Connected/ })).toBeNull();
    fireEvent.click(view.getByRole("button", { name: "Reconnect" }));
    await waitFor(() =>
      expect(navigations).toEqual([`https://sign-in.example/${key}`]),
    );
    expect(connects).toEqual([key]);
  },
);

test.each([
  ["notion", "OpenBot's own sign-in"],
  ["sanity", "an MCP server that signs people in"],
])(
  "arriving to reconnect %s (the reconnect list's Reconnect) starts its withdrawn sign-in with no second press",
  async (key) => {
    drawConnections(`/connections/${key}?connect=true`);
    await waitFor(() =>
      expect(navigations).toEqual([`https://sign-in.example/${key}`]),
    );
    expect(connects).toEqual([key]);
  },
);

test("Connections: a withdrawn sign-in's tile says Reconnect, and one press reaches the sign-in", async () => {
  const view = drawConnections("/connections");
  const tile = await view.findByTestId("account-notion");
  expect(tile.textContent).toContain("Reconnect");
  expect(tile.textContent).not.toContain("Connected");
  fireEvent.click(tile);
  await waitFor(() =>
    expect(navigations).toEqual(["https://sign-in.example/notion"]),
  );
  expect(connects).toEqual(["notion"]);
});

test("Connections: an app connected and working still reads Connected, and opens its page with nothing started", async () => {
  rows = [{ serverId: "notion", scope: "read" }];
  const view = drawConnections("/connections");
  const tile = await view.findByTestId("account-notion");
  expect(tile.textContent).toContain("Connected");
  expect(tile.textContent).not.toContain("Reconnect");
  fireEvent.click(tile);
  expect(
    await view.findByText(
      "Bots you allow use this as you, and see only what you can see.",
    ),
  ).toBeTruthy();
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(connects).toEqual([]);
  expect(navigations).toEqual([]);
});

test("Admin: an app's page offers Reconnect over the admin's withdrawn sign-in, and one press starts it", async () => {
  const view = drawAdminPage("notion");
  expect(
    await view.findByText("Your Notion connection needs reconnecting."),
  ).toBeTruthy();
  fireEvent.click(view.getByRole("button", { name: "Reconnect" }));
  await waitFor(() =>
    expect(navigations).toEqual(["https://sign-in.example/notion"]),
  );
  expect(connects).toEqual(["notion"]);
});

test("Admin: arriving to connect a shared account (a card's Connect or Reconnect the shared account) starts its sign-in", async () => {
  drawAdminPage("composio-gmail", true);
  await waitFor(() => expect(connects).toEqual(["shared composio-gmail"]));
});
