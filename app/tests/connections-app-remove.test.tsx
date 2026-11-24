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
import { ORGANIZATION_SWITCH } from "@/components/manage/organization-app-switch";
import { authKeys } from "@/lib/auth/queries";
import { deploymentKeys } from "@/lib/deployment/queries";
import { Route as ConnectionRoute } from "@/routes/_authed/_app/connections.$key";
import { APPS_PATH, answerAppsApi, type TodayServer } from "./apps-api";
import { connectionPage, connectionsCall } from "./connections-api";
import { settleReactWork } from "./settle-react-work";

/**
 * REMOVE AN APP WHERE YOU ADDED IT.
 *
 * Reported from OpenBot Cloud by the admin of their own organization: "How do I remove a connector,
 * once I've enabled it?" On the app's page under Connections there was no way to: only Admin, then
 * Apps, then the app, then "Enable for this organization". The same row and switch are now on the
 * app's Connections page for an organization's owner or admin, in the team edition. Turning it off
 * removes the app for everybody (deleteApp) and goes back to Connections. A member doesn't get it.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

function added(slug: string, authScheme: string): TodayServer {
  return {
    id: `composio-${slug}`,
    title: slug === "rootly" ? "Rootly" : "Slack",
    vendor: "composio",
    url: `composio://${slug}`,
    summary: "",
    docsUrl: "",
    provenance: "composio",
    hasCredential: false,
    toolsRefreshedAt: null,
    lastError: null,
    addedBy: "admin@example.com",
    dynamicClient: false,
    authScheme,
    tools: [],
    withdrawn: [],
    accountMode: "personal",
  };
}

let servers: TodayServer[] = [];
const writes: string[] = [];

const originalFetch = global.fetch;
beforeEach(() => {
  servers = [added("rootly", "API_KEY"), added("slack", "OAUTH2")];
  writes.length = 0;
  global.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = new URL(String(input), "http://openbot.invalid");
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "DELETE" && url.pathname.startsWith(`${APPS_PATH}/`)) {
        const id = decodeURIComponent(url.pathname.slice(APPS_PATH.length + 1));
        writes.push(`delete ${id}`);
        servers = servers.filter((server) => server.id !== id);
        return new Response(null, { status: 204 });
      }
      const call = connectionsCall(url.pathname, init);
      if (call?.operation === "list") return connectionPage([]);
      const answered = answerAppsApi(input, init, {
        servers,
        composioConfigured: true,
        provider: "composio",
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

function draw(role: "owner" | "admin" | "member", app: string) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(deploymentKeys.capabilities(), {
    generativeUi: true,
    selfHostBanner: false,
    localEvaluation: false,
    edition: "team",
    hostedSignIn: true,
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
  const history = createMemoryHistory({
    initialEntries: [`/connections/${app}`],
  });
  const router = createRouter({
    routeTree: root.addChildren([
      authed.addChildren([shell.addChildren([list, page as never])]),
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

describe("an app's page under Connections, in the team edition", () => {
  for (const role of ["owner", "admin"] as const) {
    for (const app of ["composio-rootly", "composio-slack"]) {
      test(`lets an organization's ${role} remove ${app} with Admin's own switch`, async () => {
        const { view, history, user } = draw(role, app);
        const row = await view.findByTestId("organization-app-switch");
        // Admin's row, word for word.
        expect(within(row).getByText(ORGANIZATION_SWITCH.title)).toBeTruthy();
        expect(within(row).getByText(ORGANIZATION_SWITCH.on)).toBeTruthy();
        // Under the person's own account row, in the same card.
        expect(view.getByText("Your account")).toBeTruthy();
        const toggle = within(row).getByRole("switch");
        expect(toggle.getAttribute("aria-checked")).toBe("true");
        await user.click(toggle);
        await waitFor(() => {
          expect(writes).toEqual([`delete ${app}`]);
          expect(history.location.pathname).toBe("/connections");
        });
      });
    }
  }

  test("never offers it to a member", async () => {
    const { view } = draw("member", "composio-rootly");
    await view.findByText("Your account");
    expect(view.queryByTestId("organization-app-switch")).toBeNull();
    expect(view.queryByText(ORGANIZATION_SWITCH.title)).toBeNull();
    expect(writes).toEqual([]);
  });
});
