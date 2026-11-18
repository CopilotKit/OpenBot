import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
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
import type { ComponentType } from "react";
import { agentKeys } from "@/lib/agents/queries";
import { authKeys } from "@/lib/auth/queries";
import { readThreadMessages } from "@/lib/copilot/thread-messages";
import { CopilotProvider } from "@/lib/copilot/provider";
import {
  deploymentCapabilitiesQueryOptions,
  deploymentKeys,
} from "@/lib/deployment/queries";
import { setCurrentOrganization } from "@/lib/organizations/current";
import { organizationKeys } from "@/lib/organizations/queries";
import { queryClient as appQueryClient } from "@/query-client";
import { Route as AdminAuditRoute } from "@/routes/_authed/admin/audit";
import { Route as IdentityProvidersRoute } from "@/routes/_authed/admin/identity-providers";
import { seedAuditPage } from "./seed-audit-page";
import { settleReactWork } from "./settle-react-work";

/**
 * What an admin of a second organization met on a real deployment, with the server's own answers:
 * Harbor Legal is an organization of its own beside the deployment's first, `default`, and Ines
 * runs it. Each test answers the requests the page makes the way the server does.
 *
 * - Identity providers are the deployment's, so the server refuses Harbor's admin the list
 *   (`PERMISSION_DENIED`). The page says so plainly, with nothing to press that would be refused.
 * - What the deployment offers is answered in an organization the person is in, and not found at
 *   `default` when they are not in it. The app still learns it, from one of their own.
 * - A tab still drawn in Harbor after a switch elsewhere names Harbor on every runtime request, so
 *   its Bot runs where its message was written.
 * - Activity names the person a Bot acted for, where the row says who only by id.
 */

const HARBOR = { id: "org_harbor", slug: "ines-duarte", name: "Harbor Legal" };
const INES = { id: "ines", email: "ines@harbor.test" };
const MALLORY = { id: "mallory", email: "mallory@harbor.test" };
const BOT = "agent_harbor_contracts";

/** The deployment's refusal of an admin of any organization but `default` (organizations/request.ts). */
const DEPLOYMENT_ADMINS_ONLY = {
  type: "https://open.bot/errors/permission-denied",
  title: "Permission denied.",
  status: 403,
  code: "PERMISSION_DENIED",
  detail:
    "Only an admin of the default organization can do this for now, because it applies to every organization here. Ask one of them.",
  retryable: false,
};
const NOT_FOUND = {
  type: "https://open.bot/errors/organization-not-found",
  title: "Organization not found.",
  status: 404,
  code: "ORGANIZATION_NOT_FOUND",
  detail: "Couldn't find that organization.",
  retryable: false,
};
const FACTS = {
  generativeUi: true,
  selfHostBanner: false,
  localEvaluation: false,
  edition: "team",
  authProviders: ["google"],
  ssoConfigured: false,
  ssoRequired: false,
};

const problem = (body: { status: number }) =>
  new Response(JSON.stringify(body), {
    status: body.status,
    headers: { "content-type": "application/problem+json" },
  });

/** Every request the app made, with the headers it sent. */
let sent: { path: string; headers: Headers }[] = [];
let answer: (path: string) => Response | Promise<Response> = () =>
  problem(NOT_FOUND);

const originalFetch = globalThis.fetch;
beforeAll(() => GlobalRegistrator.register({ url: "http://127.0.0.1:3010/" }));
beforeEach(() => {
  sent = [];
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(
        input instanceof Request ? input.url : String(input),
        "http://127.0.0.1:3010",
      );
      const headers = new Headers(
        input instanceof Request ? input.headers : init?.headers,
      );
      sent.push({ path: url.pathname, headers });
      return answer(url.pathname);
    },
    { preconnect: originalFetch.preconnect },
  );
});
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  appQueryClient.clear();
});
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
  setCurrentOrganization("default");
});

function freshClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
    },
  });
}

/** The Identity providers page as Admin draws it, in the team edition. */
function identityProviders() {
  const client = freshClient();
  client.setQueryData(deploymentKeys.capabilities(), FACTS);
  return show(
    IdentityProvidersRoute.options.component as ComponentType,
    client,
  );
}

function show(Page: ComponentType, client = freshClient()) {
  const router = createRouter({
    routeTree: createRootRoute({ component: () => <Page /> }),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

test("Harbor's admin reads that identity providers are set up for all of OpenBot, with no error and nothing to press", async () => {
  setCurrentOrganization(HARBOR.id);
  answer = (path) =>
    path === `/api/v2/organizations/${HARBOR.id}/identity-providers`
      ? problem(DEPLOYMENT_ADMINS_ONLY)
      : problem(NOT_FOUND);
  const view = identityProviders();
  await view.findByText("Set up for all of OpenBot");
  view.getByText(
    "Identity providers and SSO apply to everyone who signs in here, not to one organization. Ask whoever runs OpenBot to add or change one.",
  );
  expect(view.queryByRole("alert")).toBeNull();
  expect(view.queryByText(/Couldn't load identity providers/)).toBeNull();
  expect(view.queryByRole("button", { name: "Add a provider" })).toBeNull();
  expect(view.queryByRole("switch", { name: "Require SSO" })).toBeNull();
  // Nothing of the deployment's own settings is drawn to somebody who can't act on them.
  expect(document.body.textContent).not.toMatch(
    /INITIAL_ADMIN_EMAILS|SCIM_BEARER_TOKEN/,
  );
});

test("an admin of `default` still registers providers there", async () => {
  setCurrentOrganization("default");
  answer = (path) =>
    path === "/api/v2/organizations/default/identity-providers"
      ? Response.json({ identityProviders: [], nextCursor: null })
      : problem(NOT_FOUND);
  const view = identityProviders();
  await view.findByText("No identity providers yet");
  expect(
    view.getAllByRole("button", { name: "Add a provider" }).length,
  ).toBeGreaterThan(0);
  expect(view.queryByText("Set up for all of OpenBot")).toBeNull();
});

test("signed in outside `default`, the app learns what OpenBot offers from one of the person's own organizations", async () => {
  setCurrentOrganization(undefined);
  answer = (path) => {
    if (path === "/api/v2/organizations/default/deployment")
      return problem(NOT_FOUND);
    if (path === "/api/v2/people/me/organizations")
      return Response.json({
        organizations: [{ ...HARBOR, role: "owner", active: true }],
        canCreate: true,
        nextCursor: null,
      });
    if (path === `/api/v2/organizations/${HARBOR.id}/deployment`)
      return Response.json(FACTS);
    return problem(NOT_FOUND);
  };
  const capabilities = await freshClient().fetchQuery(
    deploymentCapabilitiesQueryOptions(),
  );
  expect(capabilities).toMatchObject({ edition: "team", generativeUi: true });
  expect(sent.map((request) => request.path)).toEqual([
    "/api/v2/organizations/default/deployment",
    "/api/v2/people/me/organizations",
    `/api/v2/organizations/${HARBOR.id}/deployment`,
  ]);
});

test("once the organization is known, what OpenBot offers is asked there, and nobody signed in asks at `default`", async () => {
  setCurrentOrganization(HARBOR.id);
  answer = (path) =>
    path === `/api/v2/organizations/${HARBOR.id}/deployment` ||
    path === "/api/v2/organizations/default/deployment"
      ? Response.json(FACTS)
      : problem(NOT_FOUND);
  await freshClient().fetchQuery(deploymentCapabilitiesQueryOptions());
  expect(sent.map((request) => request.path)).toEqual([
    `/api/v2/organizations/${HARBOR.id}/deployment`,
  ]);
  sent = [];
  setCurrentOrganization(undefined);
  await freshClient().fetchQuery(deploymentCapabilitiesQueryOptions());
  expect(sent.map((request) => request.path)).toEqual([
    "/api/v2/organizations/default/deployment",
  ]);
});

test("a tab working in Harbor names Harbor on every runtime request, whatever the session switched to elsewhere", async () => {
  setCurrentOrganization(HARBOR.id);
  answer = (path) => {
    if (path.endsWith("/deployment")) return Response.json(FACTS);
    if (path === "/api/copilotkit/info")
      return Response.json({ version: "1.88.0", agents: {}, mode: "sse" });
    if (path.startsWith("/api/copilotkit/threads/"))
      return Response.json({ messages: [] });
    return problem(NOT_FOUND);
  };
  appQueryClient.setQueryData(deploymentKeys.capabilities(), {
    ...FACTS,
    edition: "team",
  });
  render(
    <QueryClientProvider client={appQueryClient}>
      <CopilotProvider>
        <main>Harbor home</main>
      </CopilotProvider>
    </QueryClientProvider>,
  );
  await waitFor(() =>
    expect(
      sent.some((request) => request.path === "/api/copilotkit/info"),
    ).toBe(true),
  );
  await readThreadMessages("thread-harbor", BOT);
  const runtime = sent.filter((request) =>
    request.path.startsWith("/api/copilotkit"),
  );
  expect(runtime.length).toBeGreaterThan(1);
  for (const request of runtime)
    expect(request.headers.get("OpenBot-Organization")).toBe(HARBOR.id);
});

test("Activity names the person a Bot acted for, and the reader as you", async () => {
  setCurrentOrganization(HARBOR.id);
  answer = () => problem(NOT_FOUND);
  const client = freshClient();
  client.setQueryData(deploymentKeys.capabilities(), FACTS);
  client.setQueryData(authKeys.currentUser(), {
    id: INES.id,
    email: INES.email,
    name: "Ines Duarte",
    role: "owner",
    onboarding: null,
  });
  client.setQueryData(organizationKeys.members(HARBOR.id), [
    { id: INES.id, email: INES.email, name: "Ines Duarte", role: "owner" },
    { id: MALLORY.id, email: MALLORY.email, name: null, role: "member" },
  ]);
  client.setQueryData(agentKeys.list(false), [
    { id: BOT, name: "Harbor Contracts" },
  ]);
  client.setQueryData(agentKeys.list(true), []);
  // A Bot's actions, as the server records them: on the person's authority, with no address.
  const action = (id: string, minute: number, actorUserId: string | null) => ({
    id,
    actorUserId,
    initiatorKind: "person",
    initiatorId: null,
    eventType: "computer.action_refused",
    targetType: "computer",
    targetId: BOT,
    payload: {
      bot: BOT,
      action: "computer_navigate",
      page: "https://example.com/",
      reason: "Local computer access is off for you.",
    },
    createdAt: `2026-11-15T17:${String(minute).padStart(2, "0")}:00Z`,
  });
  // Northwind's kinds: rows whose writers named the person only in the payload, by address or id.
  const configured = {
    id: "app-switched-on",
    actorUserId: null,
    initiatorKind: "person",
    initiatorId: null,
    eventType: "configuration.changed",
    targetType: "mcp_server",
    targetId: "gmail",
    payload: {
      actor: MALLORY.email,
      change: "plugin_granted",
      kind: "mcp",
      ref: "gmail",
      bot: BOT,
    },
    createdAt: "2026-11-15T17:50:00Z",
  };
  const called = {
    id: "tool-called",
    actorUserId: null,
    initiatorKind: "person",
    initiatorId: null,
    eventType: "mcp.call_succeeded",
    targetType: "mcp_tool",
    targetId: "gmail/search",
    payload: { actor: INES.id, bot: BOT, server: "gmail", tool: "search" },
    createdAt: "2026-11-15T17:40:00Z",
  };
  // And one OpenBot wrote itself, which names OpenBot.
  const seeded = {
    id: "seeded",
    actorUserId: null,
    initiatorKind: "person",
    initiatorId: null,
    eventType: "configuration.changed",
    targetType: "mcp_server",
    targetId: "routines",
    payload: {
      actor: "openbot:always-on",
      change: "plugin_granted",
      kind: "mcp",
      ref: "routines",
      bot: BOT,
    },
    createdAt: "2026-11-15T17:35:00Z",
  };
  seedAuditPage(client, "", {
    events: [
      configured,
      called,
      seeded,
      action("by-mallory", 30, MALLORY.id),
      action("by-ines", 20, INES.id),
      action("by-somebody-gone", 10, "somebody-who-left"),
    ],
  });
  const view = show(AdminAuditRoute.options.component as ComponentType, client);
  await view.findByText("Decision");
  const startedBy = [
    ...view.container.querySelectorAll("tbody tr [data-column=bot]"),
  ].map((cell) => cell.children[1]?.textContent);
  expect(startedBy).toEqual([
    `Started by ${MALLORY.email}`,
    "Started by you",
    "Started by this deployment",
    `Started by ${MALLORY.email}`,
    "Started by you",
    // A former member named by id alone: the page has no name for them.
    "Started by a person",
  ]);
});
