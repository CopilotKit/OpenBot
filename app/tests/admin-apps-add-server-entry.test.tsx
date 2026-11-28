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
import { cleanup, render } from "@testing-library/react";
import { authKeys } from "@/lib/auth/queries";
import { deploymentKeys } from "@/lib/deployment/queries";
import { Route as AdminAppsRoute } from "@/routes/_authed/admin/plugins/index";
import { answerAppsApi } from "./apps-api";
import {
  APP_ACCESS_REQUESTS_PATH,
  appAccessRequestsResponse,
} from "./bot-grants-api";
import { connectionPage, MY_CONNECTIONS_PATH } from "./connections-api";
import { settleReactWork } from "./settle-react-work";

/**
 * ADMIN'S APPS PAGE OFFERS ADD CUSTOM MCP.
 *
 * Reported in dogfooding: adding an MCP server by its address was hard to find. An admin looked for
 * it where apps are set up, Admin then Apps, and it wasn't there: its button was only on
 * Connections. Apps now offers it too, as Add custom MCP, the same words as Connections. It is
 * offered to exactly the people Connections offers it to, and it opens Apps' own add page.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

function serve() {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const apps = answerAppsApi(input, init, { servers: [], catalogue: [] });
    if (apps) return apps;
    const path = new URL(String(input), "http://openbot.invalid").pathname;
    if (path === MY_CONNECTIONS_PATH) return connectionPage([]);
    if (path === APP_ACCESS_REQUESTS_PATH) return appAccessRequestsResponse([]);
    return Response.json({ error: "not served" }, { status: 404 });
  }) as typeof fetch;
}

function draw(
  role: "owner" | "admin" | "member",
  edition: "team" | "personal",
) {
  serve();
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(deploymentKeys.capabilities(), {
    generativeUi: true,
    selfHostBanner: false,
    localEvaluation: false,
    edition,
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

describe("Admin, Apps", () => {
  for (const role of ["admin", "owner"] as const) {
    test(`offers an ${role} Add custom MCP, which opens its add page`, async () => {
      const view = draw(role, "team");
      await view.findByRole("heading", { name: "Connected" });
      const add = view.getByRole("button", { name: "Add custom MCP" });
      expect(add.getAttribute("href")).toBe("/admin/plugins/new");
    });
  }

  test("offers the one person of a personal OpenBot Add custom MCP", async () => {
    const view = draw("member", "personal");
    await view.findByRole("heading", { name: "Connected" });
    expect(view.getByRole("button", { name: "Add custom MCP" })).toBeTruthy();
  });

  test("offers a member no Add custom MCP, as Connections doesn't", async () => {
    const view = draw("member", "team");
    await view.findByRole("heading", { name: "Connected" });
    expect(view.queryByRole("button", { name: "Add custom MCP" })).toBeNull();
  });
});
