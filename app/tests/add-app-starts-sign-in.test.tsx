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
import { BrokerDirectory } from "@/components/plugins/broker-directory";
import { connectionRows } from "@/lib/connections/rows";
import { deploymentKeys } from "@/lib/deployment/queries";
import type { PluginsProvider } from "@/lib/plugins/provider-vocabulary";
import type { ComposioApp, PluginServer } from "@/lib/plugins/queries";
import { settleReactWork } from "./settle-react-work";

/**
 * ADDING AN APP THAT SIGNS IN IS NOT THE SAME AS BEING SIGNED IN TO IT.
 *
 * Reported from OpenBot Desktop 1.0.0, the personal edition: Connections > Browse apps > Slack >
 * Add turned the row to "Added" and never signed the person in, so the Bot then said Slack wasn't
 * connected and sent them to sign in. The same happened with GitHub. The one person is also the
 * admin there, so Add now adds the app and starts their own sign-in in a new tab on the same press,
 * as a Bot's Connect card does. And an app that is added and not signed in to says "Not connected"
 * beside Connect, in either edition, never "Added" on its own.
 *
 * Every response below is the shape the real route answers: the directory's rows, the `server` the
 * add route returns (201), and the `authorizationUrl` the connect route returns for a sign-in app.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

type Kind = ComposioApp["connection"]["kind"];

function app(slug: string, name: string, kind: Kind, enabled: boolean) {
  return {
    slug,
    name,
    description: `${name} for your Bots.`,
    logo: null,
    categories: [],
    actionCount: 12,
    classifiedCount: null,
    permissionCount: null,
    scopedActionCount: null,
    connection: { kind },
    enabled,
  } satisfies ComposioApp;
}

function server(provider: PluginsProvider, slug: string): PluginServer {
  return {
    id: `${provider}-${slug}`,
    title: slug,
    vendor: provider,
    url: `${provider}://${slug}`,
    summary: "",
    docsUrl: "",
    provenance: provider,
    hasCredential: false,
    toolsRefreshedAt: null,
    lastError: null,
    addedBy: "me",
    dynamicClient: false,
    authScheme: "OAUTH2",
    tools: [],
    withdrawn: [],
    accountMode: "personal",
  } as unknown as PluginServer;
}

let apps: ComposioApp[] = [];
let servers: PluginServer[] = [];
let connected: string[] = [];
let provider: PluginsProvider = "composio";
const writes: string[] = [];

const originalFetch = global.fetch;
beforeEach(() => {
  writes.length = 0;
  connected = [];
  servers = [];
  global.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const path = String(input).split("?")[0] ?? "";
      if (init?.method === "POST" && path === "/api/plugins/composio/apps") {
        const { slug } = JSON.parse(String(init.body)) as { slug: string };
        writes.push(`add ${slug}`);
        servers = [...servers, server(provider, slug)];
        apps = apps.map((row) =>
          row.slug === slug ? { ...row, enabled: true } : row,
        );
        return Response.json(
          { server: { id: `${provider}-${slug}` } },
          { status: 201 },
        );
      }
      if (init?.method === "POST" && path.endsWith("/connect")) {
        const id = decodeURIComponent(path.split("/")[4] ?? "");
        writes.push(`connect ${id}`);
        return Response.json({
          authorizationUrl: `https://sign-in.example/${id}`,
        });
      }
      if (path === "/api/plugins/composio/apps") return Response.json({ apps });
      if (path === "/api/plugins")
        return Response.json({
          catalogue: [],
          servers,
          skills: [],
          botsMayCallBack: true,
          redirectUri: null,
          composioConfigured: true,
          provider,
        });
      if (path === "/api/plugins/connections")
        return Response.json({
          connections: connected.map((serverId) => ({
            serverId,
            scope: "",
            connectedAt: "2026-11-09T00:00:00.000Z",
            holder: "person",
          })),
          redirectUri: null,
        });
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

function draw(edition: "team" | "personal") {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(deploymentKeys.capabilities(), {
    generativeUi: true,
    selfHostBanner: false,
    localEvaluation: edition === "personal",
    edition,
  });
  const root = createRootRoute({ component: Outlet });
  const browse = createRoute({
    path: "/browse",
    getParentRoute: () => root,
    component: () => <BrokerDirectory provider={provider} />,
  });
  const page = createRoute({
    path: "/connections/$key",
    getParentRoute: () => root,
    validateSearch: (search: Record<string, unknown>) => search,
    component: () => <p data-testid="app-page">the app's page</p>,
  });
  const history = createMemoryHistory({ initialEntries: ["/browse"] });
  const router = createRouter({
    routeTree: root.addChildren([browse, page]),
    history,
  });
  const view = render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
  return { view, history, user: userEvent.setup({ document }) };
}

/*
 * More than one app and both brokers: the report named Slack, the same happened with GitHub, and
 * the fix is about every app that signs in, wherever it comes from.
 */
const SIGN_IN_APPS: {
  provider: PluginsProvider;
  slug: string;
  name: string;
}[] = [
  { provider: "composio", slug: "slack", name: "Slack" },
  { provider: "composio", slug: "github", name: "GitHub" },
  { provider: "arcade", slug: "Gmail", name: "Gmail" },
];

describe("Add in the personal edition", () => {
  for (const target of SIGN_IN_APPS) {
    test(`Add on ${target.name} adds it and starts the sign-in in a new tab`, async () => {
      provider = target.provider;
      apps = [
        app(target.slug, target.name, "consent", false),
        app("posthog", "PostHog", "fields", false),
      ];
      const { view, user } = draw("personal");

      const row = await view.findByTestId(`directory-${target.slug}`);
      await user.click(within(row).getByRole("button", { name: "Add" }));

      const id = `${target.provider}-${target.slug}`;
      await waitFor(() => {
        expect(writes).toEqual([`add ${target.slug}`, `connect ${id}`]);
        expect(tabs).toHaveLength(1);
        expect(tabs[0]?.url).toBe(`https://sign-in.example/${id}`);
      });
      // Added and not yet signed in: said plainly, while the other tab is open.
      await waitFor(() => {
        expect(within(row).getByText("Not connected")).toBeTruthy();
        expect(row.textContent).toContain(`Waiting for ${target.name}…`);
      });
      expect(row.textContent).not.toContain("Added");

      // Signed in at the other tab: the row reads connected once the server says so.
      connected = [id];
      await waitFor(
        () => {
          expect(row.textContent).toContain("Connected");
          expect(row.textContent).not.toContain("Not connected");
        },
        { timeout: 5_000 },
      );
    });
  }

  test("Add on an app that takes a key adds it and opens its key form", async () => {
    provider = "composio";
    apps = [app("posthog", "PostHog", "fields", false)];
    const { view, user, history } = draw("personal");

    const row = await view.findByTestId("directory-posthog");
    await user.click(within(row).getByRole("button", { name: "Add" }));

    await waitFor(() => {
      expect(history.location.pathname).toBe("/connections/composio-posthog");
    });
    expect(history.location.search).toContain("connect=true");
    expect(writes).toEqual(["add posthog"]);
    expect(tabs).toHaveLength(0);
  });
});

describe("an added app nobody has signed in to", () => {
  for (const edition of ["personal", "team"] as const) {
    test(`says Not connected beside Connect in the ${edition} edition, never Added`, async () => {
      provider = "composio";
      apps = [
        app("slack", "Slack", "consent", true),
        app("github", "GitHub", "consent", true),
      ];
      servers = [server("composio", "slack"), server("composio", "github")];
      connected = ["composio-github"];
      const { view, user } = draw(edition);

      const slack = await view.findByTestId("directory-slack");
      await waitFor(() => {
        expect(
          within(slack).getByTestId("directory-not-connected").textContent,
        ).toBe(
          edition === "personal" ? "Not connected" : "Added, not connected",
        );
      });
      expect(
        within(slack).getByRole("button", { name: "Connect Slack" }),
      ).toBeTruthy();
      if (edition === "personal")
        expect(slack.textContent).not.toContain("Added");

      // The one this person did sign in to says so.
      const github = view.getByTestId("directory-github");
      expect(github.textContent).toContain("Connected");
      expect(github.textContent).not.toContain("Not connected");

      // Connect starts the person's own sign-in, the same as a Bot's card.
      await user.click(
        within(slack).getByRole("button", { name: "Connect Slack" }),
      );
      await waitFor(() => {
        expect(tabs[0]?.url).toBe("https://sign-in.example/composio-slack");
      });
    });
  }

  test("in the team edition Add stays the admin's act and starts no sign-in", async () => {
    provider = "composio";
    apps = [app("slack", "Slack", "consent", false)];
    const { view, user } = draw("team");

    const row = await view.findByTestId("directory-slack");
    await user.click(within(row).getByRole("button", { name: "Add" }));
    await waitFor(() => expect(writes).toEqual(["add slack"]));
    await settleReactWork();
    expect(tabs).toHaveLength(0);
  });
});

describe("the Connections tile", () => {
  test("an added app that signs in reads Not connected until it is", () => {
    const rows = connectionRows({
      catalogue: [],
      brokered: [server("composio", "slack"), server("arcade", "Gmail")],
      shared: [],
      connected: new Set(["arcade-Gmail"]),
      links: [],
      providers: { slack: false, github: false },
    });
    const slack = rows.find((row) => row.key === "composio-slack");
    const gmail = rows.find((row) => row.key === "arcade-Gmail");
    expect(slack?.notConnected).toBe(true);
    expect(slack?.state).toBe("available");
    expect(gmail?.state).toBe("connected");
    expect(gmail?.notConnected).toBe(false);
  });

  test("GitHub is not Connected off the sign-in link while its tools are not connected", () => {
    const github = server("composio", "github");
    const rows = connectionRows({
      catalogue: [],
      brokered: [github],
      shared: [],
      connected: new Set(),
      links: [
        {
          provider: "github",
          handle: "octocat",
          status: "connected",
        } as never,
      ],
      providers: { slack: false, github: true },
    });
    const tile = rows.find((row) => row.key === "github");
    expect(tile?.state).toBe("available");
    expect(tile?.notConnected).toBe(true);
    // One GitHub tile, not a second for the tools.
    expect(
      rows.filter((row) => row.title === "GitHub" || row.key === github.id),
    ).toHaveLength(1);
  });
});
