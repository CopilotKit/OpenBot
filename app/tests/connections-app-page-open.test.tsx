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
import { cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { authKeys } from "@/lib/auth/queries";
import { deploymentKeys } from "@/lib/deployment/queries";
import { Route as ConnectionRoute } from "@/routes/_authed/_app/connections.$key";
import { APPS_SETTING_PATH, appsSettingResponse } from "./admin-settings-api";
import {
  APPS_PATH,
  answerAppsApi,
  appBody,
  type TodayCatalogueItem,
  type TodayServer,
} from "./apps-api";
import {
  connectionPage,
  connectionsCall,
  startResponse,
} from "./connections-api";
import { settleReactWork } from "./settle-react-work";

/*
 * An app's page under Connections, for an app of OpenBot's catalogue nobody here has added, opened by
 * a member. With apps open (the organization's default) the member's Connect adds it for everyone and
 * goes straight on to their own account, as an admin's does. Locked down, the page says an admin has
 * to turn it on first and Connect does nothing, as before. The API is answered in its own shapes.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const LINEAR: TodayCatalogueItem = {
  key: "linear",
  title: "Linear",
  vendor: "Linear",
  summary: "Plan and track work.",
  auth: "user-oauth",
  oneStep: true,
};

let servers: TodayServer[] = [];
let lockedDown = false;
const writes: string[] = [];

const originalFetch = global.fetch;
beforeEach(() => {
  servers = [];
  lockedDown = false;
  writes.length = 0;
  global.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = new URL(String(input), "http://openbot.invalid");
      const method = (init?.method ?? "GET").toUpperCase();
      if (url.pathname === APPS_SETTING_PATH)
        return appsSettingResponse(lockedDown);
      if (method === "POST" && url.pathname === APPS_PATH) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        writes.push(`add ${String(body.directoryEntryId)}`);
        const app: TodayServer = {
          id: "linear",
          title: "Linear",
          vendor: "Linear",
          dynamicClient: true,
        };
        servers = [...servers, app];
        return Response.json(appBody(app), { status: 201 });
      }
      const call = connectionsCall(url.pathname, init);
      if (call?.operation === "list") return connectionPage([]);
      if (call?.operation === "connect") {
        writes.push(`connect ${call.appId}`);
        return startResponse({ connected: true });
      }
      const answered = answerAppsApi(input, init, {
        servers,
        catalogue: [LINEAR],
      });
      if (answered) return answered;
      return new Response(null, { status: 404 });
    },
    { preconnect: originalFetch.preconnect },
  );
});
afterEach(() => {
  global.fetch = originalFetch;
});

function draw() {
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
    id: "usr_member",
    email: "member@example.com",
    name: "member",
    role: "member",
  } as never);
  const root = createRootRoute({ component: Outlet });
  const authed = createRoute({
    id: "/_authed",
    getParentRoute: () => root,
    component: Outlet,
  });
  const shell = createRoute({
    id: "/_app",
    getParentRoute: () => authed,
    component: Outlet,
  });
  const list = createRoute({
    path: "/connections",
    getParentRoute: () => shell,
    component: () => <p data-testid="connections">Connections</p>,
  });
  const page = (
    ConnectionRoute as unknown as { update: (o: unknown) => unknown }
  ).update({
    id: "/connections/$key",
    path: "/connections/$key",
    getParentRoute: () => shell,
  });
  const router = createRouter({
    routeTree: root.addChildren([
      authed.addChildren([shell.addChildren([list, page as never])]),
    ]),
    history: createMemoryHistory({ initialEntries: ["/connections/linear"] }),
  });
  const view = render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
  return { view, user: userEvent.setup({ document }) };
}

describe("a catalogue app nobody has added, on its Connections page, for a member", () => {
  test("apps open: Connect adds it for everyone and connects the member's own account", async () => {
    const { view, user } = draw();
    await view.findByText(
      "No Bot can use this yet. Connecting makes it available to everyone in the organization and takes you to Linear to approve access.",
    );
    expect(view.container.textContent).not.toMatch(/\badmin\b/i);
    const connect = view.getByRole("button", { name: "Connect" });
    expect(connect.hasAttribute("disabled")).toBe(false);
    await user.click(connect);
    await waitFor(() =>
      expect(writes).toEqual(["add catalogue:linear", "connect linear"]),
    );
  });

  test("apps locked down: an admin has to turn it on first, and Connect does nothing", async () => {
    lockedDown = true;
    const { view } = draw();
    await view.findByText(
      "Not available yet. An admin has to turn this on first.",
      { exact: false },
    );
    expect(
      view.getByRole("button", { name: "Connect" }).hasAttribute("disabled"),
    ).toBe(true);
    expect(writes).toEqual([]);
  });
});
