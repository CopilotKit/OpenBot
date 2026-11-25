import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
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
import userEvent from "@testing-library/user-event";
import { PluginPage } from "@/components/manage/plugin-page";
import { BrokerDirectory } from "@/components/plugins/broker-directory";
import { agentKeys } from "@/lib/agents/queries";
import { authKeys } from "@/lib/auth/queries";
import { deploymentKeys } from "@/lib/deployment/queries";
import {
  CONSENT_HANDOFF_PATH,
  readConsentHandoff,
} from "@/lib/plugins/consent-handoff";
import { pluginKeys } from "@/lib/plugins/queries";
import { Route as AdminAppsRoute } from "@/routes/_authed/admin/plugins/index";
import {
  APPS_PATH,
  type AppsFixture,
  answerAppsApi,
  appBody,
  seedAppReads,
  type TodayCatalogueItem,
  type TodayDirectoryApp,
  type TodayServer,
} from "./apps-api";
import {
  APP_ACCESS_REQUESTS_PATH,
  appAccessRequestsResponse,
} from "./bot-grants-api";
import {
  connectionPage,
  connectionsCall,
  MY_CONNECTIONS_PATH,
  startResponse,
} from "./connections-api";
import { settleReactWork } from "./settle-react-work";

/**
 * CONNECT IS ONE PRESS, FOR EVERY KIND OF APP AND FROM EVERY PLACE AN ADMIN ADDS ONE.
 *
 * Reported in dogfooding: connecting an app was two steps, "turn on" and then "connect", and "turn
 * on" is not something a person thinks of as a step. Admin, Apps, Browse apps said Add, the row then
 * read "Added, not connected" with a separate Connect beside it; an app's own page under Admin had an
 * "Enable for this organization" switch before its Connect. Now each place has one Connect, which
 * adds the app for everyone and goes straight on to the admin's own sign-in or key form, the press a
 * Bot's card and Connections already made. The switch stays, once the app is added, for turning it
 * off for everyone.
 *
 * Every response is the shape the real API answers: the directory's entries, the app createApp
 * returns (201), and the `authorizationUrl` connectApp returns.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

function directoryApp(
  slug: string,
  name: string,
  kind: TodayDirectoryApp["connection"]["kind"],
): TodayDirectoryApp {
  return {
    slug,
    name,
    description: `${name} for your Bots.`,
    logo: null,
    categories: [],
    actionCount: 12,
    classifiedCount: null,
    permissionCount: null,
    scopedActionCount: null,
    connection: { kind },
    enabled: false,
  };
}

function directoryServer(slug: string, authScheme: string): TodayServer {
  return {
    id: `composio-${slug}`,
    title: slug,
    vendor: "composio",
    url: `composio://${slug}`,
    summary: "",
    docsUrl: "",
    provenance: "composio",
    hasCredential: false,
    toolsRefreshedAt: null,
    lastError: null,
    addedBy: "me",
    dynamicClient: false,
    authScheme,
    tools: [],
    withdrawn: [],
    accountMode: "personal",
  };
}

const notionEntry: TodayCatalogueItem = {
  key: "notion",
  title: "Notion",
  vendor: "Notion",
  summary: "Pages and databases.",
  docsUrl: "",
  auth: "user-oauth",
  perInstance: false,
};

const notionServer: TodayServer = {
  id: "notion",
  title: "Notion",
  vendor: "Notion",
  url: "https://mcp.notion.com/mcp",
  summary: "Pages and databases.",
  docsUrl: "",
  provenance: "first-party",
  hasCredential: true,
  toolsRefreshedAt: null,
  lastError: null,
  addedBy: "me",
  dynamicClient: true,
  authScheme: null,
  tools: [],
  withdrawn: [],
  accountMode: null,
  sharedVendorConnected: false,
  ownerGrants: "any",
  ownerGrantsChosen: null,
};

let directory: TodayDirectoryApp[] = [];
let servers: TodayServer[] = [];
const writes: string[] = [];

function fixture(): AppsFixture {
  return {
    catalogue: [notionEntry],
    servers,
    directory,
    botsMayCallBack: true,
    redirectUri: null,
    composioConfigured: true,
    provider: "composio",
    authorizesPerAction: false,
  };
}

const originalFetch = global.fetch;
beforeEach(() => {
  writes.length = 0;
  servers = [];
  directory = [];
  global.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const path = String(input).split("?")[0] ?? "";
      if (init?.method === "POST" && path === APPS_PATH) {
        const body = JSON.parse(String(init.body)) as {
          directoryEntryId?: string;
          key?: string;
        };
        // A catalogue entry is added by its key, a directory app by its entry's id.
        if (body.directoryEntryId?.startsWith("directory:")) {
          const slug = body.directoryEntryId.replace(/^directory:/, "");
          writes.push(`add ${slug}`);
          const kind = directory.find((row) => row.slug === slug)?.connection
            .kind;
          const added = directoryServer(
            slug,
            kind === "fields" ? "API_KEY" : "OAUTH2",
          );
          servers = [...servers, added];
          directory = directory.map((row) =>
            row.slug === slug ? { ...row, enabled: true } : row,
          );
          return Response.json(appBody(added), { status: 201 });
        }
        writes.push("add notion");
        servers = [...servers, notionServer];
        return Response.json(appBody(notionServer), { status: 201 });
      }
      const call = connectionsCall(path, init);
      if (call?.operation === "connect") {
        const id = call.appId ?? "";
        writes.push(`connect ${id}`);
        return startResponse({
          authorizationUrl: `https://sign-in.example/${id}`,
        });
      }
      const apps = answerAppsApi(input, init, fixture());
      if (apps) return apps;
      if (path === MY_CONNECTIONS_PATH || call?.operation === "list")
        return connectionPage([]);
      if (path === APP_ACCESS_REQUESTS_PATH)
        return appAccessRequestsResponse([]);
      return new Response(null, { status: 404 });
    },
    { preconnect: originalFetch.preconnect },
  );
});
afterEach(() => {
  global.fetch = originalFetch;
});

/** The tab `window.open` hands back, recording where the page sends it. */
type FakeTab = { url: string | null; closed: boolean };
let tabs: FakeTab[] = [];
let originalOpen: typeof window.open;
beforeEach(() => {
  tabs = [];
  originalOpen = window.open;
  window.open = (() => {
    const tab: FakeTab = { url: null, closed: false };
    tabs.push(tab);
    return {
      get closed() {
        return tab.closed;
      },
      opener: null,
      close: () => {
        tab.closed = true;
      },
      location: {
        replace: (url: string) => {
          tab.url = url;
        },
      },
    } as unknown as Window;
  }) as typeof window.open;
});
afterEach(() => {
  window.open = originalOpen;
});

/** Where a tab ends up: the sign-in itself, or the one OpenBot's step goes on to. */
function signInBehind(url: string | null | undefined): string | null {
  if (!url) return null;
  const marker = `${CONSENT_HANDOFF_PATH}#`;
  const at = url.indexOf(marker);
  if (at < 0) return url;
  return (
    readConsentHandoff(decodeURIComponent(url.slice(at + marker.length)))
      ?.url ?? null
  );
}

function clientFor(): QueryClient {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(deploymentKeys.capabilities(), {
    generativeUi: true,
    selfHostBanner: false,
    localEvaluation: false,
    edition: "team",
  });
  client.setQueryData(authKeys.currentUser(), {
    id: "usr_admin",
    email: "admin@example.com",
    name: "Admin",
    role: "admin",
  } as never);
  return client;
}

/** Admin, Apps, Browse apps: the directory as Admin opens it. */
function drawBrowse() {
  const client = clientFor();
  const root = createRootRoute({ component: Outlet });
  const browse = createRoute({
    path: "/admin/plugins/composio",
    getParentRoute: () => root,
    component: () => <BrokerDirectory place="admin" provider="composio" />,
  });
  const keyForm = createRoute({
    path: "/connections/$key",
    getParentRoute: () => root,
    validateSearch: (search: Record<string, unknown>) => search,
    component: () => <p data-testid="key-form">the app's key form</p>,
  });
  const history = createMemoryHistory({
    initialEntries: ["/admin/plugins/composio"],
  });
  const router = createRouter({
    routeTree: root.addChildren([browse, keyForm]),
    history,
  });
  const view = render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
  return { view, history, user: userEvent.setup({ document }) };
}

/** Admin, Apps, then one app: its own page. */
function drawAppPage(drawn: TodayServer[]) {
  servers = drawn;
  const client = clientFor();
  seedAppReads(client, fixture());
  client.setQueryData(pluginKeys.connections(), { connections: [] });
  client.setQueryData(agentKeys.list(false), []);
  client.setQueryData(agentKeys.list(true), []);
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: createRootRoute({
      component: () => <PluginPage pluginKey="notion" />,
    }),
  });
  const view = render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
  return { view, user: userEvent.setup({ document }) };
}

/** Admin, Apps: the list, with the catalogue under Explore apps. */
function drawAppsList() {
  const client = clientFor();
  const root = createRootRoute({ component: Outlet });
  const authed = createRoute({
    id: "/_authed",
    getParentRoute: () => root,
    component: Outlet,
  });
  const admin = createRoute({
    path: "/admin",
    getParentRoute: () => authed,
    component: Outlet,
  });
  const apps = (
    AdminAppsRoute as unknown as { update: (o: unknown) => unknown }
  ).update({
    id: "/plugins/",
    path: "/plugins/",
    getParentRoute: () => admin,
  });
  const router = createRouter({
    routeTree: root.addChildren([
      authed.addChildren([admin.addChildren([apps as never])]),
    ]),
    history: createMemoryHistory({ initialEntries: ["/admin/plugins"] }),
  });
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

describe("Admin, Apps, Browse apps", () => {
  test("one press of an app you sign in to adds it and opens the admin's own sign-in", async () => {
    directory = [directoryApp("slack", "Slack", "consent")];
    const { view, user } = drawBrowse();

    const row = await view.findByTestId("directory-slack");
    // No Add, and no second Connect to find after it: the one press is Connect.
    expect(within(row).queryByRole("button", { name: "Add" })).toBeNull();
    await user.click(
      within(row).getByRole("button", { name: "Connect Slack" }),
    );

    await waitFor(() => {
      expect(writes).toEqual(["add slack", "connect composio-slack"]);
      expect(tabs).toHaveLength(1);
      expect(signInBehind(tabs[0]?.url)).toBe(
        "https://sign-in.example/composio-slack",
      );
    });
    // Added for everyone, and this admin's own account is the sign-in that is open now.
    await waitFor(() => {
      expect(
        within(row).getByTestId("directory-not-connected").textContent,
      ).toBe("Added, not connected");
      expect(row.textContent).toContain("Waiting for Slack…");
    });
  });

  test("one press of an app that takes a key adds it and opens its key form", async () => {
    directory = [directoryApp("posthog", "PostHog", "fields")];
    const { view, user, history } = drawBrowse();

    const row = await view.findByTestId("directory-posthog");
    expect(within(row).queryByRole("button", { name: "Add" })).toBeNull();
    await user.click(
      within(row).getByRole("button", { name: "Connect PostHog" }),
    );

    await waitFor(() => {
      expect(history.location.pathname).toBe("/connections/composio-posthog");
    });
    expect(history.location.search).toContain("connect=true");
    expect(await view.findByTestId("key-form")).toBeTruthy();
    expect(writes).toEqual(["add posthog"]);
    expect(tabs).toHaveLength(0);
  });
});

describe("Admin, Apps, an app's own page", () => {
  test("has no enable step: Connect adds the app and starts the admin's sign-in", async () => {
    const { view, user } = drawAppPage([]);

    const connect = await view.findByRole("button", { name: "Connect Notion" });
    expect(view.queryByText("Enable for this organization")).toBeNull();
    expect(view.queryByRole("switch")).toBeNull();
    expect(view.container.textContent).not.toMatch(/\bTurn (it )?on\b/);

    await user.click(connect);
    await waitFor(() =>
      expect(writes).toEqual(["add notion", "connect notion"]),
    );
  });

  test("once it is added, the switch turns it off for everyone", async () => {
    const { view } = drawAppPage([notionServer]);
    const off = await view.findByRole("switch", {
      name: "Notion on for everyone in the organization",
    });
    expect(off.getAttribute("aria-checked")).toBe("true");
    expect(view.getByText("On for everyone")).toBeTruthy();
    expect(view.queryByRole("button", { name: "Connect Notion" })).toBeNull();
  });
});

describe("Admin, Apps, Explore apps", () => {
  test("lists each app nobody has added as one to connect, never one to add", async () => {
    const view = drawAppsList();
    const row = await view.findByTestId("plugin-notion");
    expect(row.textContent).toContain("Not connected");
    expect(row.textContent).not.toContain("Not added");
    expect(
      view.getByText("Reviewed, first-party servers. Open one to connect it."),
    ).toBeTruthy();
    // The row opens the app's page, whose Connect is the one press above.
    expect(row.getAttribute("href")).toBe("/admin/plugins/notion");
  });
});
