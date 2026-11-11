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
import { deploymentKeys } from "@/lib/deployment/queries";
import { identityKeys } from "@/lib/identity/queries";
import {
  type CatalogueItem,
  type PluginServer,
  type PluginsPage,
  pluginKeys,
} from "@/lib/plugins/queries";
import { Route as ConnectionRoute } from "@/routes/_authed/_app/connections.$key";
import { Route as ConnectionsRoute } from "@/routes/_authed/_app/connections.index";
import { settleReactWork } from "./settle-react-work";

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

function entry(
  key: string,
  title: string,
  auth: CatalogueItem["auth"],
  oneStep: boolean,
): CatalogueItem {
  return {
    key,
    title,
    vendor: title,
    summary: `${title} for your Bots.`,
    docsUrl: "",
    auth,
    perInstance: false,
    oneStep,
  };
}

/** Notion registers its own OAuth client; Google Drive needs one typed in. */
const CATALOGUE = [
  entry("notion", "Notion", "user-oauth", true),
  entry("google-drive", "Google Drive", "user-oauth", false),
  entry("exa", "Exa Search", "none", true),
  entry(
    "exa-authenticated",
    "Exa Search (API key)",
    "deployment-bearer",
    false,
  ),
  entry("routines", "Routines", "builtin", true),
];

/** A server row as the plugin list returns it. Notion registers its own client; Drive needs one. */
function server(key: string): PluginServer {
  return {
    id: key,
    title: CATALOGUE.find((item) => item.key === key)?.title ?? key,
    vendor: key,
    url: `https://${key}.example/mcp`,
    summary: "",
    docsUrl: "",
    provenance: "first-party",
    hasCredential: false,
    toolsRefreshedAt: null,
    lastError: null,
    addedBy: "me",
    dynamicClient: key === "notion",
    authScheme: null,
    tools: [],
    withdrawn: [],
    accountMode: null,
    sharedVendorConnected: false,
    ownerGrants: "any",
    ownerGrantsChosen: null,
  } as unknown as PluginServer;
}

let servers: PluginServer[] = [];
let connected: string[] = [];
let composio = false;
const writes: string[] = [];
/** Paths that answer 500, for the states a failed read leaves the page in. */
let failing = new Set<string>();
let catalogue = CATALOGUE;

function page(): PluginsPage {
  return {
    catalogue,
    servers,
    skills: [],
    botsMayCallBack: true,
    redirectUri: null,
    composioConfigured: composio,
    authorizesPerAction: false,
  } as unknown as PluginsPage;
}

const originalFetch = global.fetch;
beforeEach(() => {
  servers = [server("notion")];
  connected = [];
  composio = false;
  writes.length = 0;
  failing = new Set();
  catalogue = CATALOGUE;
  global.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const path = String(input).split("?")[0] ?? "";
      if (init?.method && init.method !== "GET") {
        writes.push(`${init.method} ${path}`);
        if (path === "/api/plugins/servers") {
          const { key } = JSON.parse(String(init.body)) as { key: string };
          servers = [...servers, server(key)];
        }
        if (path.endsWith("/connect"))
          return Response.json({ connected: true });
        return Response.json({ ok: true });
      }
      if (failing.has(path))
        return Response.json({ error: "Server error" }, { status: 500 });
      if (path === "/api/plugins") return Response.json(page());
      if (path === "/api/plugins/connections")
        return Response.json({
          connections: connected.map((serverId) => ({
            serverId,
            status: "connected",
          })),
        });
      return new Response(null, { status: 404 });
    },
    { preconnect: originalFetch.preconnect },
  );
});
afterEach(() => {
  global.fetch = originalFetch;
});

/**
 * `edition: null` leaves the edition unread (its request fails), and `fetchApps` reads the apps
 * through the fake API rather than starting with them in the cache.
 */
function draw(
  edition: "team" | "personal" | null,
  at = "/connections",
  { fetchApps = false }: { fetchApps?: boolean } = {},
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  if (edition)
    client.setQueryData(deploymentKeys.capabilities(), {
      generativeUi: true,
      selfHostBanner: false,
      localEvaluation: edition === "personal",
      edition,
    });
  if (!fetchApps) {
    client.setQueryData(pluginKeys.page(), page());
    client.setQueryData(pluginKeys.connections(), { connections: [] });
  }
  client.setQueryData(identityKeys.links(), []);
  client.setQueryData(identityKeys.providers(), {
    slack: false,
    github: false,
  });

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
  const list = (
    ConnectionsRoute as unknown as { update: (o: unknown) => unknown }
  ).update({
    id: "/connections/",
    path: "/connections/",
    getParentRoute: () => app,
  });
  const one = (
    ConnectionRoute as unknown as { update: (o: unknown) => unknown }
  ).update({
    id: "/connections/$key",
    path: "/connections/$key",
    getParentRoute: () => app,
  });
  // Where a personal owner's recovery links go; drawn as nothing, it only has to exist.
  const setup = createRoute({
    path: "/settings/setup",
    getParentRoute: () => authed,
    component: () => null,
  });
  const history = createMemoryHistory({ initialEntries: [at] });
  const router = createRouter({
    routeTree: root.addChildren([
      authed.addChildren([
        app.addChildren([list as never, one as never]),
        setup,
      ]),
    ]),
    history,
  });
  const view = render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
  return { view, history, user: userEvent.setup({ document }) };
}

const tile = (view: ReturnType<typeof draw>["view"], key: string) =>
  view.getByTestId(`account-${key}`);

describe("Connections in the personal edition", () => {
  test("lists every app you could add under Add an app, the ones that need setup included, with no count", async () => {
    const { view } = draw("personal");
    await view.findByTestId("account-notion");
    expect(
      view.getByRole("textbox", { name: "Search connections" }),
    ).toBeTruthy();
    // Nothing is in use yet, so there is no Your apps.
    expect(view.queryByRole("heading", { name: "Your apps" })).toBeNull();
    const add = view.getByRole("heading", { name: "Add an app" }).parentElement
      ?.parentElement as HTMLElement;
    for (const key of ["notion", "exa", "google-drive", "exa-authenticated"])
      expect(within(add).getByTestId(`account-${key}`)).toBeTruthy();
    expect(within(tile(view, "notion")).getByText("Connect")).toBeTruthy();
    expect(within(tile(view, "exa")).getByText("Add")).toBeTruthy();
    expect(
      within(tile(view, "exa-authenticated")).getByText("Set up"),
    ).toBeTruthy();
    expect(view.queryByRole("button", { name: /need setup/ })).toBeNull();
    expect(view.queryByText(/in use/)).toBeNull();
  });

  test("apps in use are under Your apps, apart from the ones you could add", async () => {
    connected = ["notion"];
    const { view } = draw("personal");
    const yours = (await view.findByRole("heading", { name: "Your apps" }))
      .parentElement?.parentElement as HTMLElement;
    await waitFor(() =>
      expect(within(yours).getByTestId("account-notion")).toBeTruthy(),
    );
    expect(within(yours).queryByTestId("account-exa")).toBeNull();
    const add = view.getByRole("heading", { name: "Add an app" }).parentElement
      ?.parentElement as HTMLElement;
    expect(within(add).queryByTestId("account-notion")).toBeNull();
    expect(within(add).getByTestId("account-exa")).toBeTruthy();
  });

  test("Routines is not listed: it is on for every Bot and has its own page", async () => {
    servers = [server("notion"), server("routines")];
    const { view } = draw("personal");
    await view.findByTestId("account-notion");
    expect(view.queryByTestId("account-routines")).toBeNull();
  });

  test("links to the Vault, where saved logins and keys live", async () => {
    const { view } = draw("personal");
    await view.findByTestId("account-notion");
    expect(
      view.getByRole("link", { name: /^Vault/ }).getAttribute("href"),
    ).toBe("/settings/vault");
    expect(view.queryByRole("link", { name: /Saved logins/ })).toBeNull();
    expect(view.queryByRole("link", { name: /^Keys/ })).toBeNull();
  });

  test("searching finds an app that needs setup", async () => {
    const { view, user } = draw("personal");
    await user.type(
      await view.findByRole("textbox", { name: "Search connections" }),
      "drive",
    );
    expect(await view.findByTestId("account-google-drive")).toBeTruthy();
  });

  test("Connect on an app with a client goes straight to your account", async () => {
    const { view, user } = draw("personal");
    await user.click(await view.findByTestId("account-notion"));
    await waitFor(() =>
      expect(writes).toEqual(["POST /api/plugins/servers/notion/connect"]),
    );
  });

  test("Connect on an app nobody added adds it first; one that needs a client set up then opens its page", async () => {
    const { view, user, history } = draw("personal");
    await user.click(await view.findByTestId("account-google-drive"));
    await waitFor(() =>
      expect(history.location.pathname).toBe("/connections/google-drive"),
    );
    expect(writes).toEqual(["POST /api/plugins/servers"]);
  });

  test("Add on an app with no account turns it on and is done", async () => {
    const { view, user } = draw("personal");
    await user.click(await view.findByTestId("account-exa"));
    await waitFor(() => expect(writes).toEqual(["POST /api/plugins/servers"]));
    await waitFor(() =>
      expect(within(tile(view, "exa")).getByText("On")).toBeTruthy(),
    );
  });

  test("Set up opens the app's page, where its key is typed", async () => {
    const { view, user, history } = draw("personal");
    await user.click(await view.findByTestId("account-exa-authenticated"));
    await waitFor(() =>
      expect(history.location.pathname).toBe("/connections/exa-authenticated"),
    );
    expect(writes).toEqual([]);
  });

  test("a connected app opens its page, to choose which Bots use it", async () => {
    connected = ["notion"];
    const { view, user, history } = draw("personal");
    await waitFor(() =>
      expect(within(tile(view, "notion")).getByText("Connected")).toBeTruthy(),
    );
    await user.click(await view.findByTestId("account-notion"));
    await waitFor(() =>
      expect(history.location.pathname).toBe("/connections/notion"),
    );
  });
});

test("with a broker set up, the last tile browses its directory of more apps", async () => {
  composio = true;
  const { view } = draw("personal");
  const browse = await view.findByTestId("account-browse");
  expect(within(browse).getByText("Browse apps")).toBeTruthy();
  expect(browse.textContent).not.toMatch(/composio/i);
  expect(browse.getAttribute("href")).toBe("/connections/browse/composio");
});

describe("an app under Connections in the personal edition", () => {
  test("Routines is every Bot's, with no switch, and leads to the Routines page", async () => {
    servers = [server("notion"), server("routines")];
    const { view } = draw("personal", "/connections/routines");
    expect(
      await view.findByText(
        "Routines are work your Bots do on a schedule. Every Bot can set one up for you.",
      ),
    ).toBeTruthy();
    expect(
      (await view.findByRole("link", { name: /Your routines/ })).getAttribute(
        "href",
      ),
    ).toBe("/routines");
    expect(view.queryByRole("switch")).toBeNull();
    expect(view.queryByText("Turned on")).toBeNull();
  });

  test("is one page: turning it on, your account, and which Bots use it", async () => {
    const { view } = draw("personal", "/connections/notion");
    expect(await view.findByText("Turned on")).toBeTruthy();
    expect(view.getByText("Your account")).toBeTruthy();
  });
});

test("the team edition's Connections still lists only what an admin turned on, as your accounts", async () => {
  const { view } = draw("team");
  expect(await view.findByTestId("account-notion")).toBeTruthy();
  expect(view.queryByText("Sign-ins and keys")).toBeNull();
  expect(view.queryByTestId("account-google-drive")).toBeNull();
  expect(view.queryByTestId("account-exa")).toBeNull();
});

test("the team edition's app under Connections is still only your account", async () => {
  const { view } = draw("team", "/connections/notion");
  await view.findAllByText("Notion");
  expect(view.queryByText("Turned on")).toBeNull();
});

/** The notice a failed apps read leaves, found by its words: the page may hold other alerts. */
async function appsAlert(view: ReturnType<typeof draw>["view"]) {
  const words = await view.findByText(/^Couldn't load your connections\./);
  return words.closest('[role="alert"]') as HTMLElement;
}

describe("when Connections can't list apps", () => {
  test("a failed read in the personal edition offers Retry and Setup, and never names an admin", async () => {
    failing = new Set(["/api/plugins"]);
    const { view, user } = draw("personal", "/connections", {
      fetchApps: true,
    });
    const alert = await appsAlert(view);
    expect(alert.textContent).toContain("Couldn't load your connections.");
    expect(alert.textContent).not.toMatch(/admin/i);
    expect(
      within(alert)
        .getByRole("button", { name: "Open Setup" })
        .getAttribute("href"),
    ).toBe("/settings/setup");

    failing = new Set();
    await user.click(within(alert).getByRole("button", { name: "Retry" }));
    expect(await view.findByTestId("account-notion")).toBeTruthy();
    expect(view.queryByText(/Couldn't load your connections/)).toBeNull();
  });

  test("a failed read in the team edition keeps the admin guidance, with Retry and no Setup link", async () => {
    failing = new Set(["/api/plugins/connections"]);
    const { view } = draw("team", "/connections", { fetchApps: true });
    const alert = await appsAlert(view);
    expect(alert.textContent).toBe(
      "Couldn't load your connections. Try again, or ask an admin if it keeps happening.Retry",
    );
    expect(
      within(alert).queryByRole("button", { name: "Open Setup" }),
    ).toBeNull();
    // Nothing is listed as not connected while the connections are unknown.
    expect(view.queryByTestId("account-notion")).toBeNull();
  });

  test("with the edition unread, a failed read says neither admin nor Setup", async () => {
    failing = new Set(["/api/plugins", "/api/capabilities"]);
    const { view } = draw(null, "/connections", { fetchApps: true });
    const alert = await appsAlert(view);
    expect(alert.textContent).toContain(
      "Couldn't load your connections. Try again.",
    );
    expect(alert.textContent).not.toMatch(/admin|Setup/);
  });

  test("no apps in the personal edition points the owner at Setup, not an admin", async () => {
    catalogue = [];
    servers = [];
    const { view } = draw("personal");
    expect(await view.findByText("No apps yet")).toBeTruthy();
    expect(
      view.getByText("Apps show up here once OpenBot is set up to reach them."),
    ).toBeTruthy();
    expect(
      view.getByRole("button", { name: "Open Setup" }).getAttribute("href"),
    ).toBe("/settings/setup");
    expect(view.queryByText(/admin/i)).toBeNull();
  });

  test("no apps in the team edition still says an admin turns them on", async () => {
    catalogue = [];
    servers = [];
    const { view } = draw("team");
    expect(
      await view.findByText("Apps show up here once an admin turns them on."),
    ).toBeTruthy();
    expect(view.queryByRole("button", { name: "Open Setup" })).toBeNull();
  });
});
