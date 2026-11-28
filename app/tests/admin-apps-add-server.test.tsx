import {
  afterAll,
  afterEach,
  beforeAll,
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
import { cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { authKeys } from "@/lib/auth/queries";
import { deploymentKeys } from "@/lib/deployment/queries";
import { Route as AdminAppsRoute } from "@/routes/_authed/admin/plugins/index";
import { Route as AdminAddServerRoute } from "@/routes/_authed/admin/plugins/new";
import {
  APPS_PATH,
  answerAppsApi,
  appBody,
  type TodayServer,
} from "./apps-api";
import {
  APP_ACCESS_REQUESTS_PATH,
  appAccessRequestsResponse,
} from "./bot-grants-api";
import { connectionPage, MY_CONNECTIONS_PATH } from "./connections-api";
import { settleReactWork } from "./settle-react-work";

/**
 * AN ADMIN ADDS AN MCP SERVER FROM ADMIN'S APPS PAGE.
 *
 * Reported in dogfooding: adding a server by its address was hard to find, because it was only on
 * Connections and an admin looked for it where apps are set up. Apps now has Add custom MCP too,
 * named as on Connections. It opens the same form as Connections, and an admin who adds a server
 * there comes back to Apps with the server listed under Connected. The apps API is answered in its own shapes, and adding a server is
 * the one write it sees.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

/** The apps added so far, which the API's list answers with, and every add it was sent. */
let servers: TodayServer[] = [];
let adds: Record<string, unknown>[] = [];

function serve() {
  servers = [];
  adds = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), "http://openbot.invalid").pathname;
    if (path === APPS_PATH && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      adds.push(body);
      const added: TodayServer = {
        id: String(body.title).toLowerCase(),
        title: String(body.title),
        url: String(body.url),
        provenance: "custom",
        summary: "",
        signIn: false,
        tools: [],
      };
      servers.push(added);
      return Response.json(appBody(added), { status: 201 });
    }
    const apps = answerAppsApi(input, init, { servers, catalogue: [] });
    if (apps) return apps;
    if (path === MY_CONNECTIONS_PATH) return connectionPage([]);
    if (path === APP_ACCESS_REQUESTS_PATH) return appAccessRequestsResponse([]);
    return Response.json({ error: "not served" }, { status: 404 });
  }) as typeof fetch;
}

function draw(role: "admin" | "member", at = "/admin/plugins") {
  serve();
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
    id: `usr_${role}`,
    email: `${role}@example.com`,
    name: role,
    role,
  } as never);
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
  const add = (
    AdminAddServerRoute as unknown as { update: (o: unknown) => unknown }
  ).update({
    id: "/plugins/new",
    path: "/plugins/new",
    getParentRoute: () => admin,
  });
  // Where a server's own page would open: reaching it means the form went to the wrong place.
  const serverPage = createRoute({
    path: "/plugins/$key",
    getParentRoute: () => admin,
    component: () => <p>A server's page</p>,
  });
  // Connections, where the form went back to before it could be opened from Apps.
  const connections = createRoute({
    path: "/connections",
    getParentRoute: () => authed,
    component: () => <p>Connections</p>,
  });
  const router = createRouter({
    routeTree: root.addChildren([
      authed.addChildren([
        admin.addChildren([apps as never, add as never, serverPage]),
        connections,
      ]),
    ]),
    history: createMemoryHistory({ initialEntries: [at] }),
  });
  const view = render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
  return { view, router };
}

describe("Admin, Apps, Add custom MCP", () => {
  test("an admin adds a server by its address and comes back to Apps with it listed", async () => {
    const { view, router } = draw("admin");
    await view.findByRole("heading", { name: "Connected" });
    expect(view.getByText("Nothing connected yet")).toBeTruthy();

    const user = userEvent.setup({ document });
    await user.click(view.getByRole("button", { name: "Add custom MCP" }));

    // Connections' own form, with its way back named for Apps.
    await view.findByRole("heading", { name: "Add custom MCP", level: 1 });
    expect(router.state.location.pathname).toBe("/admin/plugins/new");
    expect(view.getByRole("button", { name: "Apps" })).toBeTruthy();
    expect(
      view.getByRole("button", { name: "Cancel" }).getAttribute("href"),
    ).toBe("/admin/plugins");

    await user.type(view.getByLabelText("Name"), "Figma");
    await user.type(
      view.getByLabelText("Server address"),
      "https://mcp.figma.com/mcp",
    );
    await user.click(view.getByRole("button", { name: "Add custom MCP" }));

    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/admin/plugins"),
    );
    expect(adds).toEqual([
      { from: "address", title: "Figma", url: "https://mcp.figma.com/mcp" },
    ]);
    const row = await view.findByTestId("plugin-figma");
    expect(row.textContent).toContain("Figma");
    expect(view.queryByText("Nothing connected yet")).toBeNull();
  });

  test("Cancel goes back to Apps", async () => {
    const { view, router } = draw("admin", "/admin/plugins/new");
    const user = userEvent.setup({ document });
    await user.click(await view.findByRole("button", { name: "Cancel" }));
    await view.findByRole("heading", { name: "Connected" });
    expect(router.state.location.pathname).toBe("/admin/plugins");
    expect(adds).toEqual([]);
  });

  test("a member is offered no Add custom MCP on Apps", async () => {
    const { view } = draw("member");
    await view.findByRole("heading", { name: "Connected" });
    expect(view.queryByRole("button", { name: "Add custom MCP" })).toBeNull();
    expect(view.queryByText("Add custom MCP")).toBeNull();
  });
});
