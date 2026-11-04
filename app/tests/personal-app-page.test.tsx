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
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type * as React from "react";
import { PluginBotPage } from "@/components/manage/plugin-bot-page";
import { PluginPage } from "@/components/manage/plugin-page";
import { PluginToolPage } from "@/components/manage/plugin-tool-page";
import { agentKeys } from "@/lib/agents/queries";
import { deploymentKeys } from "@/lib/deployment/queries";
import {
  type PluginServer,
  type PluginsPage,
  pluginKeys,
} from "@/lib/plugins/queries";
import { settleReactWork } from "./settle-react-work";

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const catalogueNotion = {
  key: "notion",
  title: "Notion",
  vendor: "Notion",
  summary: "Pages and databases.",
  docsUrl: "",
  auth: "user-oauth",
  perInstance: false,
};

const notionServer = {
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

function pageWith(servers: PluginServer[]): PluginsPage {
  return {
    catalogue: [catalogueNotion],
    servers,
    skills: [],
    botsMayCallBack: true,
    redirectUri: null,
    composioConfigured: false,
    authorizesPerAction: false,
  } as unknown as PluginsPage;
}

/**
 * Every write the page sends, in order. The plugin list answers with whatever the test drew until
 * the page adds Notion, and with Notion turned on after.
 */
const writes: string[] = [];
let servers: PluginServer[] = [];
const originalFetch = global.fetch;
beforeEach(() => {
  writes.length = 0;
  global.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const path = String(input).split("?")[0];
      if (init?.method && init.method !== "GET") {
        writes.push(`${init.method} ${path}`);
        if (path === "/api/plugins/servers") servers = [notionServer];
        if (path.endsWith("/connect"))
          return Response.json({ connected: true });
        return Response.json({ ok: true });
      }
      if (path === "/api/plugins") return Response.json(pageWith(servers));
      if (path === "/api/plugins/connections")
        return Response.json({ connections: [] });
      return new Response(null, { status: 404 });
    },
    { preconnect: originalFetch.preconnect },
  );
});
afterEach(() => {
  global.fetch = originalFetch;
});

function draw(
  edition: "team" | "personal",
  drawn: PluginServer[],
  pluginKey = "notion",
  page: () => React.ReactNode = () => <PluginPage pluginKey={pluginKey} />,
  bots: unknown[] = [],
) {
  servers = drawn;
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(deploymentKeys.capabilities(), {
    generativeUi: true,
    selfHostBanner: false,
    localEvaluation: edition === "personal",
    edition,
  });
  client.setQueryData(pluginKeys.page(), pageWith(drawn));
  client.setQueryData(pluginKeys.connections(), { connections: [] });
  client.setQueryData(agentKeys.list(false), bots);
  client.setQueryData(agentKeys.list(true), bots);
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: createRootRoute({
      component: page,
    }),
  });
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

describe("an app's page in the personal edition", () => {
  test("offers Connect for an app that isn't added, instead of a switch for everybody", async () => {
    const view = draw("personal", []);
    expect(
      await view.findByRole("button", { name: "Connect Notion" }),
    ).toBeTruthy();
    expect(view.queryByText("Enable for this deployment")).toBeNull();
  });

  test("turns the app on and starts connecting your account in one press", async () => {
    const view = draw("personal", []);
    const user = userEvent.setup({ document });
    await user.click(
      await view.findByRole("button", { name: "Connect Notion" }),
    );
    await waitFor(() =>
      expect(writes).toEqual([
        "POST /api/plugins/servers",
        "POST /api/plugins/servers/notion/connect",
      ]),
    );
  });

  test("has no choices that only matter with other people", async () => {
    const view = draw("personal", [notionServer]);
    await view.findByText("Your account");
    expect(view.queryByText("Bot owners can give it to their Bots")).toBeNull();
    expect(view.queryByText("Whose account")).toBeNull();
    expect(view.container.textContent).not.toContain("this deployment");
  });

  test("lists the app's tools for every Bot, with nothing to give one at a time", async () => {
    const withTools = {
      ...notionServer,
      tools: [
        {
          ref: "notion/search",
          name: "search",
          description: "Search your pages.",
          effect: "read",
          grantedTo: [],
        },
      ],
    } as unknown as PluginServer;
    const view = draw("personal", [withTools]);
    expect(await view.findByText("search")).toBeTruthy();
    expect(view.getByText(/Every Bot can use these/)).toBeTruthy();
    expect(view.queryByRole("button", { name: "Grant tools…" })).toBeNull();
    expect(view.queryByText("By Bot")).toBeNull();
    expect(view.queryByRole("link", { name: /search/ })).toBeNull();
  });

  test("goes back to Connections", async () => {
    const view = draw("personal", [notionServer]);
    const back = await view.findByRole("button", { name: /Connections/ });
    expect(back.getAttribute("href")).toBe("/connections");
  });
});

test("the team edition's page is unchanged", async () => {
  const view = draw("team", [notionServer]);
  expect(await view.findByText("Enable for this deployment")).toBeTruthy();
  expect(view.getByText("Bot owners can give it to their Bots")).toBeTruthy();
});

test("Routines' tool and per-Bot pages say always on, rather than offer a switch the server refuses", async () => {
  const routines = {
    ...notionServer,
    id: "routines",
    title: "Routines",
    url: "builtin://routines/",
    dynamicClient: false,
    tools: [
      {
        name: "schedule",
        ref: "routines/schedule",
        description: "Schedule work.",
        serverId: "routines",
        inputSchema: {},
        effect: "write",
        destructive: false,
        grantedTo: ["bot-1"],
      },
    ],
  } as unknown as PluginServer;
  const bots = [{ id: "bot-1", name: "Expenses", hidden: false }];
  for (const page of [
    () => <PluginToolPage pluginKey="routines" toolName="schedule" />,
    () => <PluginBotPage agentId="bot-1" pluginKey="routines" />,
  ]) {
    const view = draw("team", [routines], "routines", page, bots);
    expect(await view.findByText("Always on")).toBeTruthy();
    expect(view.queryByRole("switch")).toBeNull();
    cleanup();
  }
});

test("Routines is always on in the team edition too, with no switch to turn it off", async () => {
  const routines = {
    ...notionServer,
    id: "routines",
    title: "Routines",
    url: "builtin://routines/",
    dynamicClient: false,
  } as PluginServer;
  const view = draw("team", [routines], "routines");
  expect(await view.findByText("Always on")).toBeTruthy();
  expect(view.queryByText("Enable for this deployment")).toBeNull();
  expect(view.queryByRole("switch", { name: /Routines/ })).toBeNull();
});
