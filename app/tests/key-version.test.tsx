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
import type * as React from "react";
import { PluginPage } from "@/components/manage/plugin-page";
import {
  BrokerDirectory,
  type DirectoryPlace,
} from "@/components/plugins/broker-directory";
import { agentKeys } from "@/lib/agents/queries";
import { authKeys } from "@/lib/auth/queries";
import { deploymentKeys } from "@/lib/deployment/queries";
import {
  APPS_PATH,
  answerAppsApi,
  appBody,
  type TodayDirectoryApp,
  type TodayServer,
} from "./apps-api";
import {
  connectionPage,
  connectionsCall,
  startResponse,
} from "./connections-api";
import { settleReactWork } from "./settle-react-work";

/**
 * AN APP LISTED AS A SIGN-IN IN PLACE OF ITS KEY CAN STILL BE ADDED WITH ITS KEY.
 *
 * The directory offers some apps that connect with a key as a sign-in through the vendor instead,
 * and the sign-in stays the row's own action. The key version often offers far more actions, so a
 * quiet second action adds the same app with its key, as an app of its own: "Connect with a key
 * instead" opens its key form on the same press, Admin's directory only adds it, and a member, who
 * asks for apps rather than adding them, is offered nothing. An app with no key version is drawn
 * exactly as before.
 *
 * Every response is the shape the real API answers: listAppDirectory's entries with `keyVersion`,
 * and the app createApp returns (201), with `connectsWith: "key"` on the request for the key version.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const KEY_APP = "composio-posthog-key";

function posthog(keyAppId: string | null): TodayDirectoryApp {
  return {
    slug: "posthog",
    name: "PostHog",
    description: "Product analytics.",
    logo: null,
    categories: [],
    actionCount: 1,
    classifiedCount: null,
    permissionCount: null,
    scopedActionCount: null,
    connection: { kind: "consent" },
    enabled: false,
    keyVersion: { appId: keyAppId, title: "PostHog (key)", actionCount: 690 },
  };
}

const linear: TodayDirectoryApp = {
  slug: "linear",
  name: "Linear",
  description: "Issues and projects.",
  logo: null,
  categories: [],
  actionCount: 40,
  classifiedCount: null,
  permissionCount: null,
  scopedActionCount: null,
  connection: { kind: "consent" },
  enabled: false,
};

/** The sign-in version, as the directory adds it. */
function signInServer(slug: string, title: string): TodayServer {
  return {
    id: `composio-${slug}`,
    title,
    url: `composio://${slug}`,
    summary: "",
    provenance: "composio",
    authScheme: "OAUTH2",
    accountMode: "personal",
    tools: [],
    withdrawn: [],
  };
}

/** The key version, as `connectsWith: "key"` adds it: its own app, under the title the server gave. */
const keyServer: TodayServer = {
  id: KEY_APP,
  title: "PostHog (key)",
  summary: "",
  provenance: "composio",
  authScheme: "API_KEY",
  accountMode: "personal",
  tools: [],
  withdrawn: [],
};

let directory: TodayDirectoryApp[] = [];
let servers: TodayServer[] = [];
/** Every createApp body the screen sent, in order. */
const adds: Record<string, unknown>[] = [];

const originalFetch = global.fetch;
beforeEach(() => {
  adds.length = 0;
  servers = [];
  global.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const path = String(input).split("?")[0] ?? "";
      if (init?.method === "POST" && path === APPS_PATH) {
        const body = JSON.parse(String(init.body)) as {
          directoryEntryId: string;
          connectsWith?: "key";
        };
        adds.push(body);
        const slug = body.directoryEntryId.replace(/^directory:/, "");
        if (body.connectsWith === "key") {
          servers = [...servers, keyServer];
          directory = directory.map((row) =>
            row.slug === slug && row.keyVersion
              ? { ...row, keyVersion: { ...row.keyVersion, appId: KEY_APP } }
              : row,
          );
          return Response.json(appBody(keyServer), { status: 201 });
        }
        const added = signInServer(
          slug,
          directory.find((row) => row.slug === slug)?.name ?? slug,
        );
        servers = [...servers, added];
        directory = directory.map((row) =>
          row.slug === slug ? { ...row, enabled: true } : row,
        );
        return Response.json(appBody(added), { status: 201 });
      }
      const call = connectionsCall(path, init);
      if (call?.operation === "connect")
        return startResponse({
          authorizationUrl: `https://sign-in.example/${call.appId ?? ""}`,
        });
      const answered = answerAppsApi(input, init, {
        servers,
        directory,
        botsMayCallBack: true,
        composioConfigured: true,
        provider: "composio",
      });
      if (answered) return answered;
      if (call?.operation === "list") return connectionPage([]);
      return new Response(null, { status: 404 });
    },
    { preconnect: originalFetch.preconnect },
  );
});
afterEach(() => {
  global.fetch = originalFetch;
});

/** Tabs `window.open` handed out: a sign-in opens one, the key form never does. */
let tabs: { url: string | null }[] = [];
let originalOpen: typeof window.open;
beforeEach(() => {
  tabs = [];
  originalOpen = window.open;
  window.open = (() => {
    const tab = { url: null as string | null, closed: false };
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

function client(
  edition: "team" | "personal",
  role: "owner" | "admin" | "member",
) {
  const queries = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  queries.setQueryData(deploymentKeys.capabilities(), {
    generativeUi: true,
    selfHostBanner: false,
    localEvaluation: edition === "personal",
    edition,
  });
  queries.setQueryData(authKeys.currentUser(), {
    id: "u1",
    email: "person@example.com",
    role,
    onboarding: null,
  });
  queries.setQueryData(agentKeys.list(false), []);
  queries.setQueryData(agentKeys.list(true), []);
  return queries;
}

/** The screen at `start`, with the pages a press can lead to drawn as stubs. */
function draw(
  start: string,
  screen: () => React.ReactNode,
  queries: QueryClient,
) {
  const root = createRootRoute({ component: Outlet });
  const browse = createRoute({
    path: "/browse",
    getParentRoute: () => root,
    component: screen,
  });
  const appPage = createRoute({
    path: "/app",
    getParentRoute: () => root,
    component: screen,
  });
  const connection = createRoute({
    path: "/connections/$key",
    getParentRoute: () => root,
    validateSearch: (search: Record<string, unknown>) => search,
    component: () => <p data-testid="key-form">the app's page</p>,
  });
  const adminApp = createRoute({
    path: "/admin/plugins/$key",
    getParentRoute: () => root,
    component: () => <p data-testid="admin-app">the app's page</p>,
  });
  const history = createMemoryHistory({ initialEntries: [start] });
  const router = createRouter({
    routeTree: root.addChildren([browse, appPage, connection, adminApp]),
    history,
  });
  const view = render(
    <QueryClientProvider client={queries}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
  return { view, history, user: userEvent.setup({ document }) };
}

function browse(
  edition: "team" | "personal",
  place: DirectoryPlace,
  role: "owner" | "admin" | "member" = "owner",
) {
  return draw(
    "/browse",
    () => <BrokerDirectory place={place} provider="composio" />,
    client(edition, role),
  );
}

describe("Browse apps, for somebody who connects as they add", () => {
  test("a routed app keeps its sign-in as the action and offers Connect with a key instead, which adds the key version and opens its key form", async () => {
    directory = [posthog(null), linear];
    const { view, user, history } = browse("personal", "connections");

    const row = await view.findByTestId("directory-posthog");
    // The sign-in is still the row's own action, and its count is the sign-in's.
    expect(
      within(row).getByRole("button", { name: "Connect PostHog" }),
    ).toBeTruthy();
    const keyInstead = within(row).getByRole("button", {
      name: "Connect with a key instead",
    });
    expect(within(row).getByTestId("key-version").textContent).toBe(
      "Connect with a key instead for 690 actions.",
    );

    await user.click(keyInstead);

    await waitFor(() =>
      expect(history.location.pathname).toBe(`/connections/${KEY_APP}`),
    );
    expect(history.location.search).toContain("connect=true");
    expect(adds).toEqual([
      {
        from: "directory",
        directoryEntryId: "directory:posthog",
        connectsWith: "key",
      },
    ]);
    // A key typed in, not a sign-in: no tab.
    expect(tabs).toHaveLength(0);
  });

  test("an app with no key version offers nothing more, and Connect still starts its sign-in", async () => {
    directory = [posthog(null), linear];
    const { view, user } = browse("personal", "connections");

    const row = await view.findByTestId("directory-linear");
    expect(within(row).queryByTestId("key-version")).toBeNull();
    expect(row.textContent).not.toContain("with a key instead");

    await user.click(within(row).getByRole("button", { name: /^Connect / }));
    await waitFor(() => expect(tabs).toHaveLength(1));
    expect(adds).toEqual([
      { from: "directory", directoryEntryId: "directory:linear" },
    ]);
  });

  test("once the key version is added, the row links to it by its own title", async () => {
    servers = [keyServer];
    directory = [posthog(KEY_APP)];
    const { view } = browse("personal", "connections");

    const row = await view.findByTestId("directory-posthog");
    const link = await within(row).findByRole("link", {
      name: "PostHog (key)",
    });
    expect(within(row).getByTestId("key-version").textContent).toBe(
      "Also added with a key as PostHog (key).",
    );
    // Not connected yet, so its page opens on the key form.
    await waitFor(() =>
      expect(link.getAttribute("href")).toBe(
        `/connections/${KEY_APP}?connect=true`,
      ),
    );
    expect(
      within(row).queryByRole("button", { name: /with a key instead/ }),
    ).toBeNull();
    // The sign-in is still offered as the row's own action.
    expect(
      within(row).getByRole("button", { name: "Connect PostHog" }),
    ).toBeTruthy();
  });
});

describe("Admin's directory", () => {
  /*
   * One press here too: Admin's line used to say "Add with a key instead" and only add, so the
   * admin then had to find the key version and connect it as a second step.
   */
  test("Connect with a key instead adds the key version and opens its key form", async () => {
    directory = [posthog(null)];
    const { view, user, history } = browse("team", "admin");

    const row = await view.findByTestId("directory-posthog");
    expect(row.textContent).not.toContain("Add with a key instead");
    await user.click(
      within(row).getByRole("button", { name: "Connect with a key instead" }),
    );

    await waitFor(() =>
      expect(history.location.pathname).toBe(`/connections/${KEY_APP}`),
    );
    expect(history.location.search).toContain("connect=true");
    expect(adds).toEqual([
      {
        from: "directory",
        directoryEntryId: "directory:posthog",
        connectsWith: "key",
      },
    ]);
  });
});

test("a member, who asks for apps, is offered no key version", async () => {
  directory = [posthog(null)];
  const { view } = browse("team", "connections", "member");

  const row = await view.findByTestId("directory-posthog");
  expect(
    within(row).getByRole("button", { name: "Request PostHog" }),
  ).toBeTruthy();
  expect(within(row).queryByTestId("key-version")).toBeNull();
});

describe("the sign-in version's own page", () => {
  test("offers Connect with a key instead, which adds the key version and opens its key form", async () => {
    servers = [signInServer("posthog", "PostHog")];
    directory = [{ ...posthog(null), enabled: true }];
    const { view, user, history } = draw(
      "/app",
      () => <PluginPage pluginKey="composio-posthog" />,
      client("personal", "owner"),
    );

    await user.click(
      await view.findByRole("button", { name: "Connect with a key instead" }),
    );

    await waitFor(() =>
      expect(history.location.pathname).toBe(`/connections/${KEY_APP}`),
    );
    expect(history.location.search).toContain("connect=true");
    expect(adds).toEqual([
      {
        from: "directory",
        directoryEntryId: "directory:posthog",
        connectsWith: "key",
      },
    ]);
  });

  test("offers nothing once the key version is added", async () => {
    servers = [signInServer("posthog", "PostHog"), keyServer];
    directory = [{ ...posthog(KEY_APP), enabled: true }];
    const { view } = draw(
      "/app",
      () => <PluginPage pluginKey="composio-posthog" />,
      client("personal", "owner"),
    );

    await view.findByText("How this is reached");
    await settleReactWork();
    expect(view.queryByText(/with a key instead/)).toBeNull();
  });
});
