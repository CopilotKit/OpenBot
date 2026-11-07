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
import { AuditPage } from "@/components/manage/audit-page";
import { PluginPage } from "@/components/manage/plugin-page";
import { agentKeys } from "@/lib/agents/queries";
import { auditKeys } from "@/lib/audit/queries";
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
  eventType: "computer.policy_loaded",
  targetType: "computer",
  targetId: "shared",
  payload: {},
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
  client.setQueryData([...auditKeys.all, ""], { events: [startedByOpenBot] });
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

test("a brokered app's sentences name OpenBot where the page does", () => {
  const personal = managePaths("personal").deploymentName;
  expect(brokeredReach("composio", personal).description).toContain(
    "OpenBot sends one key",
  );
  expect(brokeredKeyMissing("composio", personal)).toContain("on OpenBot.");
  expect(brokeredReach("composio").description).toContain(
    "This deployment sends one key",
  );
  expect(brokeredKeyMissing("composio")).toContain("on this deployment.");
});
