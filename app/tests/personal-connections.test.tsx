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
import { cleanup, render, within } from "@testing-library/react";
import { deploymentKeys } from "@/lib/deployment/queries";
import { identityKeys } from "@/lib/identity/queries";
import {
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

const originalFetch = global.fetch;
beforeEach(() => {
  global.fetch = Object.assign(
    async () => new Response(null, { status: 404 }),
    { preconnect: originalFetch.preconnect },
  );
});
afterEach(() => {
  global.fetch = originalFetch;
});

const notion: PluginServer = {
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
} as unknown as PluginServer;

const page = {
  catalogue: [
    {
      key: "notion",
      title: "Notion",
      vendor: "Notion",
      summary: "Pages and databases.",
      docsUrl: "",
      auth: "user-oauth",
      perInstance: false,
    },
    {
      key: "google-drive",
      title: "Google Drive",
      vendor: "Google",
      summary: "Your files.",
      docsUrl: "",
      auth: "user-oauth",
      perInstance: false,
    },
  ],
  servers: [notion],
  skills: [],
  botsMayCallBack: true,
  redirectUri: null,
  composioConfigured: false,
  authorizesPerAction: false,
} as unknown as PluginsPage;

function draw(edition: "team" | "personal", at = "/connections") {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData(deploymentKeys.capabilities(), {
    generativeUi: true,
    selfHostBanner: false,
    localEvaluation: edition === "personal",
    edition,
  });
  client.setQueryData(pluginKeys.page(), page);
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
  const router = createRouter({
    routeTree: root.addChildren([
      authed.addChildren([app.addChildren([list as never, one as never])]),
    ]),
    history: createMemoryHistory({ initialEntries: [at] }),
  });
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

describe("Connections in the personal edition", () => {
  test("lists the apps you have and the ones you can add, each opening under Connections", async () => {
    const view = draw("personal");
    expect(await view.findByText("Your apps")).toBeTruthy();
    expect(view.getByText("Add an app")).toBeTruthy();
    const added = view.getByTestId("plugin-notion");
    expect(added.getAttribute("href")).toBe("/connections/notion");
    // Not turned on yet, and still listed: adding it is opening it.
    const available = view.getByTestId("plugin-google-drive");
    expect(available.getAttribute("href")).toBe("/connections/google-drive");
    expect(within(available).getByText("Google Drive")).toBeTruthy();
  });

  test("never says an admin has to turn an app on", async () => {
    const view = draw("personal");
    await view.findByText("Your apps");
    expect(view.container.textContent).not.toContain("admin");
  });
});

test("the team edition's Connections still lists only what an admin turned on", async () => {
  const view = draw("team");
  expect(await view.findByText("Notion")).toBeTruthy();
  expect(view.queryByText("Google Drive")).toBeNull();
  expect(view.queryByText("Add an app")).toBeNull();
});

describe("an app under Connections in the personal edition", () => {
  test("is one page: turning it on, your account, and which Bots use it", async () => {
    const view = draw("personal", "/connections/notion");
    expect(await view.findByText("Turned on")).toBeTruthy();
    expect(view.getByText("Your account")).toBeTruthy();
  });

  test("an app not added yet opens on Connect", async () => {
    const view = draw("personal", "/connections/google-drive");
    expect(
      await view.findByRole("button", { name: "Connect Google Drive" }),
    ).toBeTruthy();
  });
});

test("the team edition's app under Connections is still only your account", async () => {
  const view = draw("team", "/connections/notion");
  await view.findAllByText("Notion");
  expect(view.queryByText("Turned on")).toBeNull();
  expect(view.queryByText("Enable for this deployment")).toBeNull();
});
