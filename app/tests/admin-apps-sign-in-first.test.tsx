import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  CONNECT_APP_MARKER,
  connectAppRefusal,
} from "@openbot/shared/connect-prompt";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render } from "@testing-library/react";
import type * as React from "react";
import { PluginBotPage } from "@/components/manage/plugin-bot-page";
import { PluginPage } from "@/components/manage/plugin-page";
import { PluginsListPage } from "@/components/manage/plugins-list-page";
import { agentKeys } from "@/lib/agents/queries";
import { deploymentKeys } from "@/lib/deployment/queries";
import { pluginKeys } from "@/lib/plugins/queries";
import {
  type AppsFixture,
  answerAppsApi,
  seedAppReads,
  type TodayCatalogueItem,
  type TodayServer,
} from "./apps-api";
import { connectionPage, MY_CONNECTIONS_PATH } from "./connections-api";
import { settleReactWork } from "./settle-react-work";

/*
 * An app whose own server signs each person in lists its tools only as somebody who has signed in.
 * When an admin adds one, nobody has, so the server records the refusal a Bot would get as the app's
 * last error. Admin > Apps drew that refusal on the app's row, in red: "You have not connected your
 * Sanity account. Connect it and ask again." That tells the admin to connect their own account,
 * which they never have to do. The member who wants the app connects, and the tools are listed then.
 *
 * This draws the real team-edition admin screens with the refusal exactly as the server writes it.
 */

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
afterEach(() => cleanup());
afterAll(async () => {
  await settleReactWork();
  await GlobalRegistrator.unregister();
});

let served: AppsFixture | null = null;

const originalFetch = global.fetch;
beforeAll(() => {
  global.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input).split("?")[0] ?? "";
      const apps = served && answerAppsApi(input, init, served);
      if (apps) return apps;
      if (path === MY_CONNECTIONS_PATH) return connectionPage([]);
      return Response.json({ error: "not served" }, { status: 404 });
    },
    { preconnect: originalFetch.preconnect },
  );
});
afterAll(() => {
  global.fetch = originalFetch;
});

/** Sanity added by its address: its own server signs each person in. */
const sanity: TodayServer = {
  id: "sanity",
  title: "Sanity",
  vendor: "Sanity",
  url: "https://mcp.sanity.io",
  summary: "",
  docsUrl: "",
  provenance: "custom",
  hasCredential: false,
  toolsRefreshedAt: null,
  lastError: null,
  addedBy: "admin@example.com",
  dynamicClient: true,
  signIn: true,
  authScheme: null,
  tools: [],
  withdrawn: [],
  accountMode: null,
  sharedVendorConnected: false,
  ownerGrants: "any",
  ownerGrantsChosen: null,
};

/** Notion from the catalogue, reached as the person asking. */
const notion: TodayServer = {
  ...sanity,
  id: "notion",
  title: "Notion",
  vendor: "Notion",
  url: "https://mcp.notion.com/mcp",
  provenance: "first-party",
  hasCredential: true,
  signIn: false,
};

const notionEntry: TodayCatalogueItem = {
  key: "notion",
  title: "Notion",
  vendor: "Notion",
  summary: "Pages and databases.",
  docsUrl: "",
  auth: "user-oauth",
  perInstance: false,
};

/** The refusal the server records when it asks as somebody who hasn't connected. */
function notConnected(title: string, id: string): string {
  return connectAppRefusal({
    serverId: id,
    title,
    message: `You have not connected your ${title} account. Connect it and ask again.`,
  });
}

/** The same, for an account the vendor no longer holds. */
function withdrawn(title: string, id: string): string {
  return connectAppRefusal({
    serverId: id,
    title,
    reason: "reconnect",
    message: `Your ${title} access was withdrawn. Reconnect it and ask again.`,
  });
}

function draw(servers: TodayServer[], page: () => React.ReactNode) {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
    },
  });
  client.setQueryData(deploymentKeys.capabilities(), {
    generativeUi: true,
    selfHostBanner: false,
    localEvaluation: false,
    edition: "team",
  });
  served = {
    catalogue: [notionEntry],
    servers,
    botsMayCallBack: true,
    redirectUri: "https://openbot.example/callback",
    composioConfigured: true,
    authorizesPerAction: false,
    provider: "composio",
  };
  seedAppReads(client, served);
  client.setQueryData(pluginKeys.connections(), { connections: [] });
  const bots = [{ id: "bot-1", name: "Expenses", hidden: false }];
  client.setQueryData(agentKeys.list(false), bots);
  client.setQueryData(agentKeys.list(true), bots);
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: createRootRoute({ component: page }),
  });
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

const TELLS_ADMIN_TO_CONNECT =
  /have not connected|connect it and ask again|connect your|reconnect it/i;

/** The row's second line on Admin > Apps. */
async function rowDescription(
  view: ReturnType<typeof draw>,
  id: string,
): Promise<HTMLElement> {
  const row = await view.findByTestId(`plugin-${id}`);
  const description = row.querySelector<HTMLElement>(
    "[data-slot='item-description']",
  );
  if (!description) throw new Error(`no description on ${id}'s row`);
  return description;
}

test("Admin > Apps says an app lists its tools once someone connects, not in red, and never tells the admin to connect", async () => {
  const view = draw(
    [
      { ...sanity, lastError: notConnected("Sanity", "sanity") },
      { ...notion, lastError: notConnected("Notion", "notion") },
    ],
    () => <PluginsListPage />,
  );
  for (const [id, title] of [
    ["sanity", "Sanity"],
    ["notion", "Notion"],
  ] as const) {
    const description = await rowDescription(view, id);
    expect(description.textContent).toBe(
      `${title} lists its tools once someone connects their account.`,
    );
    expect(description.className).not.toContain("text-destructive");
  }
  const text = view.container.textContent ?? "";
  expect(text).not.toMatch(TELLS_ADMIN_TO_CONNECT);
  expect(text).not.toContain(CONNECT_APP_MARKER);
});

test("an account the vendor withdrew reads the same on Admin > Apps", async () => {
  const view = draw(
    [{ ...sanity, lastError: withdrawn("Sanity", "sanity") }],
    () => <PluginsListPage />,
  );
  const description = await rowDescription(view, "sanity");
  expect(description.textContent).toBe(
    "Sanity lists its tools once someone connects their account.",
  );
  expect(description.className).not.toContain("text-destructive");
});

test("a real failure on Admin > Apps is still the server's sentence, in red", async () => {
  const view = draw(
    [{ ...sanity, lastError: "Sanity took too long to answer." }],
    () => <PluginsListPage />,
  );
  const description = await rowDescription(view, "sanity");
  expect(description.textContent).toBe("Sanity took too long to answer.");
  expect(description.className).toContain("text-destructive");
});

test("the app's own admin page says the same under No tools listed", async () => {
  for (const server of [
    // Nobody has refreshed it yet: the empty list alone, on a server that signs each person in.
    sanity,
    { ...sanity, lastError: notConnected("Sanity", "sanity") },
  ]) {
    const view = draw([server], () => <PluginPage pluginKey="sanity" />);
    await view.findByText("No tools listed");
    const text = view.container.textContent ?? "";
    expect(text).toContain(
      "Sanity lists its tools once someone connects their account.",
    );
    expect(text).not.toContain("to see its tools");
    expect(text).not.toContain("have not connected");
    expect(text).not.toContain(CONNECT_APP_MARKER);
    cleanup();
  }
  const view = draw(
    [{ ...notion, lastError: notConnected("Notion", "notion") }],
    () => <PluginPage pluginKey="notion" />,
  );
  await view.findByText("No tools listed");
  expect(view.container.textContent).toContain(
    "Notion lists its tools once someone connects their account.",
  );
  expect(view.container.textContent).not.toContain("have not connected");
});

test("an app's page for one Bot says the same under No actions listed", async () => {
  const view = draw(
    [{ ...sanity, lastError: notConnected("Sanity", "sanity") }],
    () => <PluginBotPage agentId="bot-1" pluginKey="sanity" />,
  );
  await view.findByText("No actions listed");
  const text = view.container.textContent ?? "";
  expect(text).toContain(
    "Sanity lists its tools once someone connects their account.",
  );
  expect(text).not.toMatch(TELLS_ADMIN_TO_CONNECT);
});
