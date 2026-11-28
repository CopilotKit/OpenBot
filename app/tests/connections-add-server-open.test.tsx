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
import { QueryClientProvider } from "@tanstack/react-query";
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
import { AddServerPage } from "@/components/connections/add-server-page";
import { authKeys } from "@/lib/auth/queries";
import { deploymentKeys } from "@/lib/deployment/queries";
import { queryClient } from "@/query-client";
import { APPS_SETTING_PATH, appsSettingResponse } from "./admin-settings-api";
import { APPS_PATH, appBody } from "./apps-api";
import { settleReactWork } from "./settle-react-work";

/*
 * Connections, Add custom MCP, for a member. With apps open (the organization's default) a member
 * adds a server by its address in one press, as an admin does, with no Key field: a key typed here
 * would be every Bot's, so giving one stays an admin's. Locked down, a member is told only an admin
 * adds a server, as before. The server is faked at the fetch boundary in the API's own shapes.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

let lockedDown = false;
const added: unknown[] = [];

beforeEach(() => {
  added.length = 0;
  lockedDown = false;
  queryClient.clear();
  queryClient.setQueryData(deploymentKeys.capabilities(), {
    generativeUi: true,
    selfHostBanner: false,
    localEvaluation: false,
    edition: "team",
  });
  queryClient.setQueryData(authKeys.currentUser(), {
    id: "usr_member",
    email: "member@example.com",
    name: "member",
    role: "member",
  } as never);
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), "http://openbot.invalid").pathname;
    const method = (init?.method ?? "GET").toUpperCase();
    if (path === APPS_SETTING_PATH) return appsSettingResponse(lockedDown);
    if (path === APPS_PATH && method === "POST") {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      added.push(body);
      return Response.json(
        appBody({
          id: "figma",
          title: String(body.title),
          url: String(body.url),
          provenance: "custom",
          signIn: false,
        }),
        { status: 201 },
      );
    }
    return Response.json({ error: "not served" }, { status: 404 });
  }) as unknown as typeof fetch;
});

function draw() {
  const root = createRootRoute({ component: Outlet });
  const form = createRoute({
    getParentRoute: () => root,
    path: "/connections/new",
    component: () => <AddServerPage />,
  });
  const page = createRoute({
    getParentRoute: () => root,
    path: "/connections/$key",
    component: () => <p data-testid="app-page">the server's page</p>,
  });
  const list = createRoute({
    getParentRoute: () => root,
    path: "/connections",
    component: () => null,
  });
  const history = createMemoryHistory({ initialEntries: ["/connections/new"] });
  const router = createRouter({
    routeTree: root.addChildren([form, page, list]),
    history,
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
  return { view, history, person: userEvent.setup({ document }) };
}

describe("Add custom MCP, for a member", () => {
  test("apps open: adds a server by its address in one press, with no key to give", async () => {
    const { view, history, person } = draw();
    const name = await view.findByLabelText("Name");
    await settleReactWork();
    expect(view.queryByTestId("add-server-admin-only")).toBeNull();
    expect(view.queryByLabelText(/^Key/)).toBeNull();
    await person.type(name, "Figma");
    await person.type(
      view.getByLabelText("Server address"),
      "https://mcp.figma.com/mcp",
    );
    await person.click(view.getByRole("button", { name: "Add custom MCP" }));
    await waitFor(() =>
      expect(added).toEqual([
        {
          from: "address",
          title: "Figma",
          url: "https://mcp.figma.com/mcp",
        },
      ]),
    );
    await waitFor(() =>
      expect(history.location.pathname).toBe("/connections/figma"),
    );
    expect(view.container.textContent).not.toMatch(/ask an admin/i);
  });

  test("apps locked down: only an admin adds a server, and there is no form", async () => {
    lockedDown = true;
    const { view } = draw();
    const said = await view.findByTestId("add-server-admin-only");
    expect(said.textContent).toContain("Only an admin can add a server");
    expect(view.queryByLabelText("Name")).toBeNull();
    expect(added).toEqual([]);
  });
});
