import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render } from "@testing-library/react";
import {
  KEY_FOR_OWN_CALLS,
  PluginToolPage,
} from "@/components/manage/plugin-tool-page";
import { agentKeys } from "@/lib/agents/queries";
import { deploymentKeys } from "@/lib/deployment/queries";
import { pluginKeys } from "@/lib/plugins/queries";
import {
  type AppsFixture,
  answerAppsApi,
  seedAppReads,
  type TodayServer,
} from "./apps-api";
import { settleReactWork } from "./settle-react-work";

/**
 * A tool's page lists every Bot with whether it can call the tool. A key is not what lets a Bot
 * call one: OpenBot offers the tool over AG-UI and runs each call the Bot hands back. The page used
 * to say "Every call is refused" under a connected Bot with no key, which had just used the tool.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const shop: TodayServer = {
  id: "fernhill-seed-shop",
  title: "Fernhill Seed Shop",
  vendor: "Fernhill",
  url: "https://shop.example/mcp",
  summary: "Seed stock.",
  docsUrl: "",
  provenance: "first-party",
  hasCredential: true,
  toolsRefreshedAt: null,
  lastError: null,
  addedBy: "me",
  dynamicClient: false,
  authScheme: null,
  tools: [
    {
      name: "look_up_stock",
      ref: "fernhill-seed-shop/look_up_stock",
      description: "Look up seed stock.",
      serverId: "fernhill-seed-shop",
      inputSchema: {},
      effect: "read",
      destructive: false,
      grantedTo: ["connected", "in-openbot", "connected-with-key"],
    },
  ],
  withdrawn: [],
  accountMode: null,
  sharedVendorConnected: false,
  ownerGrants: "any",
  ownerGrantsChosen: null,
} as TodayServer;

/** No shared key: the case where the page used to say every call is refused. */
const fixture: AppsFixture = {
  catalogue: [],
  servers: [shop],
  botsMayCallBack: false,
  redirectUri: null,
  composioConfigured: true,
  provider: "composio",
  authorizesPerAction: false,
};

const bots = [
  {
    id: "connected",
    name: "Fernhill Ranger",
    hidden: false,
    endpoint: "http://127.0.0.1:20450/chat/",
    builtIn: false,
    keyFromOpenBot: false,
    hasCallbackToken: false,
  },
  {
    id: "in-openbot",
    name: "Personal Assistant",
    hidden: false,
    endpoint: null,
    builtIn: true,
    keyFromOpenBot: false,
    hasCallbackToken: false,
  },
  {
    id: "connected-with-key",
    name: "Fernhill Warden",
    hidden: false,
    endpoint: "http://127.0.0.1:20451/",
    builtIn: false,
    keyFromOpenBot: false,
    hasCallbackToken: true,
  },
];

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

function draw() {
  global.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) =>
      answerAppsApi(input, init, fixture) ??
      new Response(null, { status: 404 }),
    { preconnect: originalFetch.preconnect },
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData(deploymentKeys.capabilities(), {
    generativeUi: true,
    selfHostBanner: false,
    localEvaluation: false,
    edition: "team",
  });
  seedAppReads(client, fixture);
  client.setQueryData(pluginKeys.connections(), { connections: [] });
  client.setQueryData(agentKeys.list(false), bots);
  client.setQueryData(agentKeys.list(true), []);
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: createRootRoute({
      component: () => (
        <PluginToolPage pluginKey={shop.id} toolName="look_up_stock" />
      ),
    }),
  });
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

function rowOf(view: ReturnType<typeof draw>, name: string): string {
  const title = view.getByText(name);
  return title.closest('[data-slot="item"]')?.textContent ?? "";
}

test("a Bot without a key that holds the tool can call it, and only a connected one is told what a key is for", async () => {
  const view = draw();
  await view.findByText("Fernhill Ranger");

  expect(view.container.textContent).not.toContain("Every call is refused");
  expect(view.container.textContent).not.toContain("callback token");

  const connected = rowOf(view, "Fernhill Ranger");
  expect(connected).toContain("Can call this tool.");
  expect(connected).toContain(KEY_FOR_OWN_CALLS);

  const inOpenBot = rowOf(view, "Personal Assistant");
  expect(inOpenBot).toContain("Can call this tool.");
  expect(inOpenBot).not.toContain(KEY_FOR_OWN_CALLS);

  const withKey = rowOf(view, "Fernhill Warden");
  expect(withKey).toContain("Can call this tool.");
  expect(withKey).not.toContain(KEY_FOR_OWN_CALLS);
});
