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

function page(): PluginsPage {
  return {
    catalogue: CATALOGUE,
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

function draw(edition: "team" | "personal", at = "/connections") {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(deploymentKeys.capabilities(), {
    generativeUi: true,
    selfHostBanner: false,
    localEvaluation: edition === "personal",
    edition,
  });
  client.setQueryData(pluginKeys.page(), page());
  client.setQueryData(pluginKeys.connections(), { connections: [] });
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
  const history = createMemoryHistory({ initialEntries: [at] });
  const router = createRouter({
    routeTree: root.addChildren([
      authed.addChildren([app.addChildren([list as never, one as never])]),
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
  test("is one searchable list of every app that connects in one press, with no apps-versus-accounts split", async () => {
    const { view } = draw("personal");
    await view.findByTestId("account-notion");
    for (const key of ["notion", "exa"]) expect(tile(view, key)).toBeTruthy();
    expect(
      view.getByRole("textbox", { name: "Search connections" }),
    ).toBeTruthy();
    expect(view.queryByText("Your apps")).toBeNull();
    expect(view.queryByText("Add an app")).toBeNull();
    expect(within(tile(view, "notion")).getByText("Connect")).toBeTruthy();
    expect(within(tile(view, "exa")).getByText("Add")).toBeTruthy();
  });

  test("links to saved logins and keys, which live under Settings", async () => {
    const { view } = draw("personal");
    await view.findByTestId("account-notion");
    expect(
      view.getByRole("link", { name: /Saved logins/ }).getAttribute("href"),
    ).toBe("/settings/passwords");
    expect(view.getByRole("link", { name: /^Keys/ }).getAttribute("href")).toBe(
      "/settings/credentials",
    );
  });

  test("apps that need something typed first wait behind one button, or a search", async () => {
    const { view, user } = draw("personal");
    await view.findByTestId("account-notion");
    expect(view.queryByTestId("account-google-drive")).toBeNull();
    expect(view.queryByTestId("account-exa-authenticated")).toBeNull();
    await user.click(
      view.getByRole("button", { name: "Show 2 apps that need setup" }),
    );
    expect(tile(view, "google-drive")).toBeTruthy();
    expect(
      within(tile(view, "exa-authenticated")).getByText("Set up"),
    ).toBeTruthy();
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
    await user.click(
      await view.findByRole("button", { name: /apps that need setup/ }),
    );
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
    await user.click(
      await view.findByRole("button", { name: /apps that need setup/ }),
    );
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
  expect(within(browse).getByText("Browse Composio")).toBeTruthy();
  expect(browse.getAttribute("href")).toBe("/connections/browse/composio");
});

describe("an app under Connections in the personal edition", () => {
  test("Routines is always on, with no switch to turn it off", async () => {
    servers = [server("notion"), server("routines")];
    const { view } = draw("personal", "/connections/routines");
    expect(await view.findByText("Always on")).toBeTruthy();
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
