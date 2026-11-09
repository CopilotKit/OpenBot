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
import type { ComponentType, ReactNode } from "react";
import {
  AuditPage,
  withoutOpenBotWorking,
} from "@/components/manage/audit-page";
import { PluginPage } from "@/components/manage/plugin-page";
import { agentKeys } from "@/lib/agents/queries";
import { deploymentKeys } from "@/lib/deployment/queries";
import { managePaths } from "@/lib/manage-paths";
import {
  brokeredKeyMissing,
  brokeredReach,
} from "@/lib/plugins/provider-vocabulary";
import {
  type PluginServer,
  type PluginsPage,
  pluginKeys,
} from "@/lib/plugins/queries";
import { Route as ActivityRoute } from "@/routes/_authed/settings/_personal/activity";
import { seedAuditPage } from "./seed-audit-page";
import { settleReactWork } from "./settle-react-work";

/*
 * The personal edition calls the product OpenBot. Seen on Windows: Settings > Activity said
 * "Started by this deployment" under rows OpenBot itself started, and an app's page under
 * Connections said what "this deployment" registers and keeps. That is Admin's word, for the person
 * who runs OpenBot for everybody; Admin keeps it.
 */

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
afterEach(() => cleanup());
afterAll(async () => {
  await settleReactWork();
  await GlobalRegistrator.unregister();
});

const notion = {
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

const page = {
  catalogue: [
    {
      key: "notion",
      title: "Notion",
      vendor: "Notion",
      summary: "Pages and databases.",
      docsUrl: "",
      auth: "user-oauth",
      perInstance: false,
    },
  ],
  servers: [notion],
  skills: [],
  botsMayCallBack: true,
  redirectUri: null,
  composioConfigured: false,
  authorizesPerAction: false,
} as unknown as PluginsPage;

const startedByOpenBot = {
  id: "e1",
  actorUserId: null,
  initiatorKind: "deployment",
  initiatorId: null,
  // Every Bot given Routines' tools at a start; Activity leaves the computer's start-up rows out.
  eventType: "configuration.changed",
  targetType: "mcp_server",
  targetId: "routines",
  payload: {
    change: "plugin_granted",
    kind: "mcp",
    refs: ["routines/create_goal", "routines/list_goals"],
    actor: "openbot:always-on",
  },
  createdAt: "2026-11-07T11:00:00Z",
};

const originalFetch = global.fetch;
beforeAll(() => {
  // Nothing here is fetched that the cache does not already hold; anything else is not served.
  global.fetch = Object.assign(
    async () => Response.json({ error: "not served" }, { status: 404 }),
    { preconnect: originalFetch.preconnect },
  );
});
afterAll(() => {
  global.fetch = originalFetch;
});

function draw(edition: "team" | "personal", screen: () => ReactNode) {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
    },
  });
  client.setQueryData(deploymentKeys.capabilities(), {
    generativeUi: true,
    selfHostBanner: false,
    localEvaluation: edition === "personal",
    edition,
  });
  client.setQueryData(pluginKeys.page(), page);
  client.setQueryData(pluginKeys.connections(), { connections: [] });
  client.setQueryData(agentKeys.list(false), []);
  client.setQueryData(agentKeys.list(true), []);
  // Activity asks without OpenBot's own working; Admin asks for everything.
  seedAuditPage(
    client,
    edition === "personal" ? withoutOpenBotWorking("") : "",
    { events: [startedByOpenBot] },
  );
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: createRootRoute({ component: screen }),
  });
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

test("Activity says OpenBot started what OpenBot started", async () => {
  const Activity = ActivityRoute.options.component as ComponentType;
  const view = draw("personal", () => <Activity />);
  expect(await view.findByText("Started by OpenBot")).toBeTruthy();
  expect(view.container.textContent).not.toContain("deployment");
});

test("Admin's Audit still says this deployment", async () => {
  const view = draw("team", () => <AuditPage />);
  expect(await view.findByText("Started by this deployment")).toBeTruthy();
});

test("an app's page under Connections says what OpenBot does, not a deployment", async () => {
  const view = draw("personal", () => <PluginPage pluginKey="notion" />);
  await view.findByText("Connection");
  const text = view.container.textContent ?? "";
  expect(text).toContain("OpenBot registers an OAuth client");
  expect(text).toContain("OpenBot registers itself with the vendor");
  expect(text).toContain("OpenBot has no public URL");
  expect(text).not.toContain("deployment");
});

test("the same page in Admin keeps its word", async () => {
  const view = draw("team", () => <PluginPage pluginKey="notion" />);
  await view.findByText("Connection");
  const text = view.container.textContent ?? "";
  expect(text).toContain("The deployment registers an OAuth client");
  expect(text).toContain("This deployment registers itself with the vendor");
});

test("a brokered app's sentences name no deployment in personal, and keep it in Admin", () => {
  const personal = managePaths("personal").edition;
  expect(
    brokeredReach("composio", { title: "Gmail", kind: "consent" }).description,
  ).not.toContain("deployment");
  expect(brokeredKeyMissing("composio", personal)).not.toContain("deployment");
  expect(brokeredReach("composio").description).toContain(
    "This deployment holds one key",
  );
  expect(brokeredKeyMissing("composio")).toContain("on this deployment.");
});
