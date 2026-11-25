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
import type { AppAccessRequest } from "@/lib/app-access/queries";
import { authKeys } from "@/lib/auth/queries";
import { deploymentKeys } from "@/lib/deployment/queries";
import { identityKeys } from "@/lib/identity/queries";
import { Route as BrowseRoute } from "@/routes/_authed/_app/connections.browse.composio";
import { Route as ConnectionsRoute } from "@/routes/_authed/_app/connections.index";
import { APPS_SETTING_PATH, appsSettingResponse } from "./admin-settings-api";
import {
  APPS_PATH,
  answerAppsApi,
  appBody,
  type TodayCatalogueItem,
  type TodayDirectoryApp,
  type TodayServer,
} from "./apps-api";
import {
  APP_ACCESS_REQUESTS_PATH,
  appAccessRequest,
  appAccessRequestResponse,
  appAccessRequestsResponse,
} from "./bot-grants-api";
import {
  connectionPage,
  connectionsCall,
  startResponse,
} from "./connections-api";
import { settleReactWork } from "./settle-react-work";

/**
 * THE TEAM EDITION'S CONNECTIONS REACHES THE WHOLE DIRECTORY.
 *
 * Reported from OpenBot Cloud by an admin of their own organization: "Where do I find the 1000+
 * connectors? When I enter text in the search bar, I only get the options of what's on my screen."
 * Connections listed only the apps already added, its search filtered only those, and the directory
 * was reachable only through Admin, then Apps, then More apps. A member couldn't reach it at all.
 *
 * Now, in the team edition as in the personal one, Connections has Browse apps, and its search asks
 * the directory too, showing the apps nobody has added under Connect an app. One press of one of them
 * does what this person can do: an admin (or owner) adds it and connects their own account, and a
 * member asks an admin to add it. Every response is the shape the API answers.
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
    connection: { kind },
  };
}

/** What Jordan's screenshots showed added, and three apps of the directory nobody had added. */
const DIRECTORY = [
  directoryApp("notion", "Notion", "consent"),
  directoryApp("slack", "Slack", "consent"),
  directoryApp("posthog", "PostHog", "fields"),
  directoryApp("hackernews", "Hacker News", "no-auth"),
];

function added(slug: string): TodayServer {
  return {
    id: `composio-${slug}`,
    title: DIRECTORY.find((app) => app.slug === slug)?.name ?? slug,
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
    authScheme:
      slug === "posthog"
        ? "API_KEY"
        : slug === "hackernews"
          ? "NO_AUTH"
          : "OAUTH2",
    tools: [],
    withdrawn: [],
    accountMode: "personal",
  };
}

/** One app of OpenBot's own catalogue nobody has added: no account, so one press uses it. */
const CATALOGUE: TodayCatalogueItem[] = [
  {
    key: "exa",
    title: "Exa",
    summary: "Search the web.",
    auth: "none",
    oneStep: true,
  },
];

let servers: TodayServer[] = [];
let connected: string[] = [];
let requests: AppAccessRequest[] = [];
const writes: string[] = [];
/** Every directory read, with its search, so a test can see nothing read the whole directory. */
const directoryReads: string[] = [];
/**
 * The organization's apps switch. Locked down unless a test opens it: every test here that pins a
 * member's Request pins it locked down.
 */
let lockedDown = true;

const originalFetch = global.fetch;
beforeEach(() => {
  servers = [added("notion")];
  connected = ["composio-notion"];
  requests = [];
  writes.length = 0;
  directoryReads.length = 0;
  lockedDown = true;
  global.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = new URL(String(input), "http://openbot.invalid");
      const path = url.pathname;
      const method = (init?.method ?? "GET").toUpperCase();
      if (path === APPS_SETTING_PATH) return appsSettingResponse(lockedDown);
      if (method === "POST" && path === APPS_PATH) {
        const { directoryEntryId } = JSON.parse(String(init?.body)) as {
          directoryEntryId: string;
        };
        const entry = CATALOGUE.find(
          (item) => directoryEntryId === `catalogue:${item.key}`,
        );
        if (entry) {
          writes.push(`add ${directoryEntryId}`);
          const app: TodayServer = { id: entry.key, title: entry.title };
          servers = [...servers, app];
          return Response.json(appBody(app), { status: 201 });
        }
        const slug = directoryEntryId.replace(/^directory:/, "");
        writes.push(`add ${slug}`);
        const app = added(slug);
        servers = [...servers, app];
        return Response.json(appBody(app), { status: 201 });
      }
      if (path === APP_ACCESS_REQUESTS_PATH) {
        if (method === "POST") {
          const body = JSON.parse(String(init?.body)) as Record<string, string>;
          writes.push(`request ${JSON.stringify(body)}`);
          const filed = appAccessRequest({
            id: `req_${body.appId}`,
            appKey: body.appId ?? "",
            appTitle:
              DIRECTORY.find((app) => app.slug === body.appId)?.name ?? "",
            kind: "enable",
            agentId: null,
            botName: null,
          });
          requests = [...requests, filed];
          return appAccessRequestResponse(filed);
        }
        return appAccessRequestsResponse(requests);
      }
      const call = connectionsCall(path, init);
      if (call?.operation === "connect") {
        writes.push(`connect ${call.appId}`);
        return startResponse({
          authorizationUrl: `https://sign-in.example/${call.appId}`,
        });
      }
      if (call?.operation === "list")
        return connectionPage(
          connected.map((serverId) => ({
            serverId,
            connectedAt: "2026-11-23T00:00:00.000Z",
          })),
        );
      if (
        path.endsWith("/app-directory") &&
        url.searchParams.get("source") === "directory"
      )
        directoryReads.push(url.searchParams.get("search") ?? "");
      const answered = answerAppsApi(input, init, {
        servers,
        catalogue: CATALOGUE,
        directory: DIRECTORY,
        composioConfigured: true,
        provider: "composio",
        botsMayCallBack: true,
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

type Role = "owner" | "admin" | "member";

/** OpenBot Cloud: the team edition, signed in through OpenBot, as `role` of the organization. */
function draw(role: Role, at = "/connections") {
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
  const browse = (
    BrowseRoute as unknown as { update: (o: unknown) => unknown }
  ).update({
    id: "/connections/browse/composio",
    path: "/connections/browse/composio",
    getParentRoute: () => app,
  });
  const page = createRoute({
    path: "/connections/$key",
    getParentRoute: () => app,
    validateSearch: (search: Record<string, unknown>) => search,
    component: () => <p data-testid="app-page">the app's page</p>,
  });
  const history = createMemoryHistory({ initialEntries: [at] });
  const router = createRouter({
    routeTree: root.addChildren([
      authed.addChildren([
        app.addChildren([list as never, browse as never, page]),
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

async function search(
  drawn: ReturnType<typeof draw>,
  term: string,
): Promise<HTMLElement> {
  const box = await drawn.view.findByRole("textbox", {
    name: "Search connections",
  });
  await drawn.user.type(box, term);
  return box;
}

describe("team-edition Connections search finds an app not yet added", () => {
  for (const role of ["owner", "admin", "member"] as const) {
    test(`for an organization's ${role}`, async () => {
      const drawn = draw(role);
      await search(drawn, "slack");
      // Under Connect an app, asked of the directory's own search, never the whole directory.
      const tile = await drawn.view.findByTestId("directory-slack", undefined, {
        timeout: 3_000,
      });
      expect(tile.textContent).toContain("Slack");
      expect(drawn.view.getByText("Connect an app")).toBeTruthy();
      expect(directoryReads.length).toBeGreaterThan(0);
      expect(directoryReads.every((term) => term !== "")).toBe(true);
      expect(drawn.view.queryByText("No matches")).toBeNull();
      // An app already added is the person's own tile, never a second one from the directory.
      await drawn.user.clear(
        drawn.view.getByRole("textbox", { name: "Search connections" }),
      );
      await drawn.user.type(
        drawn.view.getByRole("textbox", { name: "Search connections" }),
        "notion",
      );
      await waitFor(() => {
        expect(drawn.view.getByTestId("account-composio-notion")).toBeTruthy();
      });
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(drawn.view.queryByTestId("directory-notion")).toBeNull();
    });
  }

  test("says No matches only once the directory has nothing either", async () => {
    const drawn = draw("admin");
    await search(drawn, "zzz-nothing");
    await drawn.view.findByText("No matches", undefined, { timeout: 3_000 });
    expect(drawn.view.queryByTestId("account-browse")).toBeNull();
  });
});

describe("Browse apps on the team edition's Connections", () => {
  test("is there for an admin, and opens Browse apps under Connections, where one Connect adds and connects", async () => {
    const drawn = draw("admin");
    const browse = await drawn.view.findByTestId("account-browse");
    expect(browse.textContent).toContain("Browse apps");
    expect(browse.getAttribute("href")).toBe("/connections/browse/composio");
    await drawn.user.click(browse);
    await drawn.view.findByRole("heading", { name: "Browse apps" });
    expect(drawn.history.location.pathname).toBe(
      "/connections/browse/composio",
    );
    const row = await drawn.view.findByTestId("directory-slack");
    await drawn.user.click(
      within(row).getByRole("button", { name: "Connect Slack" }),
    );
    await waitFor(() => {
      expect(writes).toEqual(["add slack", "connect composio-slack"]);
      expect(tabs).toHaveLength(1);
    });
  });

  test("apps locked down: is there for a member, says they ask an admin, and Request asks with no Bot", async () => {
    const drawn = draw("member");
    const browse = await drawn.view.findByTestId("account-browse");
    expect(browse.textContent).toContain("ask an admin");
    await drawn.user.click(browse);
    await drawn.view.findByRole("heading", { name: "Browse apps" });
    const row = await drawn.view.findByTestId("directory-slack");
    await drawn.user.click(
      within(row).getByRole("button", { name: "Request Slack" }),
    );
    await waitFor(() => {
      expect(writes).toEqual([`request ${JSON.stringify({ appId: "slack" })}`]);
      expect(within(row).getByText("Requested")).toBeTruthy();
    });
  });
});

describe("one press of an app found by searching Connections", () => {
  for (const role of ["owner", "admin"] as const) {
    test(`adds a sign-in app and opens the ${role}'s sign-in in a new tab`, async () => {
      const drawn = draw(role);
      await search(drawn, "slack");
      const tile = await drawn.view.findByTestId("directory-slack", undefined, {
        timeout: 3_000,
      });
      expect(tile.textContent).toContain("Connect");
      await drawn.user.click(tile);
      await waitFor(() => {
        expect(writes).toEqual(["add slack", "connect composio-slack"]);
        expect(tabs).toHaveLength(1);
        // Through Composio the tab shows OpenBot's step first, which then goes on to the sign-in.
        expect(tabs[0]?.url).toContain("/connecting#");
      });
      // Signed in at the other tab: Slack is the person's own tile, connected.
      connected = [...connected, "composio-slack"];
      await waitFor(
        () => {
          const own = drawn.view.getByTestId("account-composio-slack");
          expect(own.textContent).toContain("Connected");
        },
        { timeout: 5_000 },
      );
    });
  }

  test("adds an app that takes a key and opens its key form", async () => {
    const drawn = draw("admin");
    await search(drawn, "posthog");
    const tile = await drawn.view.findByTestId("directory-posthog", undefined, {
      timeout: 3_000,
    });
    expect(tile.textContent).toContain("Needs a key from PostHog");
    await drawn.user.click(tile);
    await waitFor(() => {
      expect(drawn.history.location.pathname).toBe(
        "/connections/composio-posthog",
      );
    });
    expect(drawn.history.location.search).toContain("connect=true");
    expect(writes).toEqual(["add posthog"]);
    expect(tabs).toHaveLength(0);
  });

  test("adds an app with no account in one press", async () => {
    const drawn = draw("admin");
    await search(drawn, "hacker");
    const tile = await drawn.view.findByTestId(
      "directory-hackernews",
      undefined,
      { timeout: 3_000 },
    );
    // Connect, never Add: an app with no account is still one press to use.
    expect(tile.textContent).toContain("Connect");
    expect(tile.textContent).not.toContain("Add");
    await drawn.user.click(tile);
    await waitFor(() => expect(writes).toEqual(["add hackernews"]));
    expect(tabs).toHaveLength(0);
  });

  test("apps locked down: asks an admin for it, for a member, and says Requested after a reload", async () => {
    const drawn = draw("member");
    await search(drawn, "slack");
    const tile = await drawn.view.findByTestId("directory-slack", undefined, {
      timeout: 3_000,
    });
    expect(tile.textContent).toContain("Request");
    await drawn.user.click(tile);
    await waitFor(() => {
      expect(writes).toEqual([`request ${JSON.stringify({ appId: "slack" })}`]);
      expect(drawn.view.getByTestId("directory-slack").textContent).toContain(
        "Requested",
      );
    });
    expect(tabs).toHaveLength(0);
    cleanup();

    const again = draw("member");
    await search(again, "slack");
    await waitFor(
      () => {
        const tile = again.view.getByTestId("directory-slack");
        expect(tile.textContent).toContain("Requested");
        // A plain tile with nothing to press, never a faded, disabled button.
        expect(tile.tagName).not.toBe("BUTTON");
      },
      { timeout: 3_000 },
    );
  });
});

/*
 * APPS OPEN, the organization's default: a member adds an app nobody has added and connects their
 * own account in the same one press an admin makes, from a search, from Browse apps and from the
 * catalogue, and is never sent to ask an admin.
 */
describe("apps open, a member adds and connects in one press", () => {
  test("from a search of Connections", async () => {
    lockedDown = false;
    const drawn = draw("member");
    await search(drawn, "slack");
    const tile = await drawn.view.findByTestId("directory-slack", undefined, {
      timeout: 3_000,
    });
    await waitFor(() => expect(tile.textContent).toContain("Connect"));
    expect(tile.textContent).not.toContain("Request");
    await drawn.user.click(tile);
    await waitFor(() => {
      expect(writes).toEqual(["add slack", "connect composio-slack"]);
      expect(tabs).toHaveLength(1);
    });
  });

  test("from Browse apps, which says nothing about asking an admin", async () => {
    lockedDown = false;
    const drawn = draw("member");
    const browse = await drawn.view.findByTestId("account-browse");
    await waitFor(() => expect(browse.textContent).not.toContain("admin"));
    await drawn.user.click(browse);
    await drawn.view.findByRole("heading", { name: "Browse apps" });
    expect(drawn.view.container.textContent).not.toContain("ask an admin");
    const row = await drawn.view.findByTestId("directory-slack");
    await drawn.user.click(
      await within(row).findByRole("button", { name: "Connect Slack" }),
    );
    await waitFor(() => {
      expect(writes).toEqual(["add slack", "connect composio-slack"]);
      expect(tabs).toHaveLength(1);
    });
    expect(writes.some((write) => write.startsWith("request"))).toBe(false);
  });

  test("from the catalogue's tile for an app nobody has added", async () => {
    lockedDown = false;
    const drawn = draw("member");
    const tile = await drawn.view.findByTestId("account-exa", undefined, {
      timeout: 3_000,
    });
    expect(tile.textContent).toContain("Connect");
    await drawn.user.click(tile);
    await waitFor(() => expect(writes).toEqual(["add catalogue:exa"]));
  });

  test("Add custom MCP is offered to a member with apps open, and not locked down", async () => {
    lockedDown = false;
    const open = draw("member");
    const add = await open.view.findByRole("button", {
      name: "Add custom MCP",
    });
    expect(add.getAttribute("href")).toBe("/connections/new");
    cleanup();

    lockedDown = true;
    const locked = draw("member");
    await locked.view.findByTestId("account-browse");
    await settleReactWork();
    expect(
      locked.view.queryByRole("button", { name: "Add custom MCP" }),
    ).toBeNull();
  });

  test("locked down, the catalogue's apps nobody has added aren't offered to anybody", async () => {
    for (const role of ["member", "admin"] as const) {
      const drawn = draw(role);
      await drawn.view.findByTestId("account-browse");
      await settleReactWork();
      expect(drawn.view.queryByTestId("account-exa")).toBeNull();
      cleanup();
    }
  });
});
