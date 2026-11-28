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
import { cleanup, render, waitFor, within } from "@testing-library/react";
import type { ComponentType } from "react";
import { agentKeys } from "@/lib/agents/queries";
import { ListIdentityProvidersResponse } from "@/lib/api/generated/identity-providers/identity-providers.zod";
import { authKeys, signedInUser } from "@/lib/auth/queries";
import { CopilotProvider } from "@/lib/copilot/provider";
import { readThreadMessages } from "@/lib/copilot/thread-messages";
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
 * - Harbor's identity providers are Harbor's own, which its admin registers, and they sign in its members. Only
 *   `default`'s are the deployment's, refused to an admin there who doesn't run OpenBot (`PERMISSION_DENIED`). The
 *   page says so plainly, with nothing to press that would be refused.
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

/** The deployment's refusal, in `default`, of an admin there who doesn't run OpenBot. */
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

/** The server's answer to a request made with no session. */
const UNSIGNED = {
  type: "https://open.bot/errors/unauthenticated",
  title: "Sign in required.",
  status: 401,
  code: "UNAUTHENTICATED",
  detail: "Sign in to continue.",
  retryable: false,
};

/** Every request the app made, with the headers it sent, and each one the server refused. */
let sent: { path: string; headers: Headers }[] = [];
let refused: string[] = [];
/** `asNobody`: the request was made without the page's cookies, as a browser sends `credentials: "omit"`. */
let answer: (path: string, asNobody: boolean) => Response | Promise<Response> =
  () => problem(NOT_FOUND);

const originalFetch = globalThis.fetch;
beforeAll(() => GlobalRegistrator.register({ url: "http://127.0.0.1:3010/" }));
beforeEach(() => {
  sent = [];
  refused = [];
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
      const asNobody =
        (input instanceof Request ? input.credentials : init?.credentials) ===
        "omit";
      const response = await answer(url.pathname, asNobody);
      if (response.status >= 400)
        refused.push(`${response.status} ${url.pathname}`);
      return response;
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

test("Harbor's admin registers Harbor's own identity providers, which sign in Harbor's members", async () => {
  setCurrentOrganization(HARBOR.id);
  answer = (path) =>
    path === `/api/v2/organizations/${HARBOR.id}/identity-providers`
      ? Response.json({ identityProviders: [], nextCursor: null })
      : problem(NOT_FOUND);
  const view = identityProviders();
  await view.findByText("No identity providers yet");
  // Not everybody who signs in to OpenBot: this organization's members.
  view.getByText(
    "Configure your company’s SAML or OpenID Connect provider for this organization’s members. Email domains determine which provider people use to sign in.",
  );
  expect(
    view.getAllByRole("button", { name: "Add a provider" }).length,
  ).toBeGreaterThan(0);
  expect(view.queryByText("Set up for all of OpenBot")).toBeNull();
  expect(document.body.textContent).not.toMatch(
    /apply to everyone who signs in here/,
  );
});

test("in Harbor, the providers set up for all of OpenBot are listed read-only, and while Harbor has its own each says it isn't used for Harbor's rule", async () => {
  setCurrentOrganization(HARBOR.id);
  answer = (path) =>
    path === `/api/v2/organizations/${HARBOR.id}/identity-providers`
      ? Response.json(
          ListIdentityProvidersResponse.parse({
            identityProviders: [
              {
                id: "harbor-okta",
                issuer: "https://harbor.okta.com",
                domain: "harborlegal.com",
                protocol: "oidc",
                registeredBy: INES.id,
                deployment: false,
              },
              {
                id: "company-entra",
                issuer: "https://login.microsoftonline.com/tenant/v2.0",
                domain: "example.com",
                protocol: "oidc",
                registeredBy: null,
                deployment: true,
              },
            ],
            nextCursor: null,
          }),
        )
      : problem(NOT_FOUND);
  const view = identityProviders();
  await view.findByText("harbor-okta");
  // Harbor's own, to remove; the deployment's, read-only in a section of its own.
  expect(view.getByRole("button", { name: "Remove" })).toBeTruthy();
  const everybody = view
    .getByRole("heading", { name: "For all of OpenBot" })
    .closest("section") as HTMLElement;
  expect(within(everybody).getByText("company-entra")).toBeTruthy();
  // Harbor has its own, so only those count for its Require SSO: each of the deployment's says so.
  expect(
    within(everybody).getByText(
      "Set up for everyone who signs in to OpenBot. This organization has its own, so only those count for its Require SSO. Ask whoever runs OpenBot to change one of these.",
    ),
  ).toBeTruthy();
  const entra = within(everybody)
    .getByText("company-entra")
    .closest("[data-slot=item]") as HTMLElement;
  expect(
    within(entra).getByText("Not used for this organization's rule"),
  ).toBeTruthy();
  expect(within(everybody).queryByRole("button")).toBeNull();
  expect(view.getAllByRole("button", { name: "Remove" })).toHaveLength(1);
});

test("in Harbor with none of its own, the deployment's providers count for it and say nothing more", async () => {
  setCurrentOrganization(HARBOR.id);
  answer = (path) =>
    path === `/api/v2/organizations/${HARBOR.id}/identity-providers`
      ? Response.json(
          ListIdentityProvidersResponse.parse({
            identityProviders: [
              {
                id: "company-entra",
                issuer: "https://login.microsoftonline.com/tenant/v2.0",
                domain: "example.com",
                protocol: "oidc",
                registeredBy: null,
                deployment: true,
              },
            ],
            nextCursor: null,
          }),
        )
      : problem(NOT_FOUND);
  const view = identityProviders();
  await view.findByText("company-entra");
  expect(
    view.getByText(
      "Set up for everyone who signs in to OpenBot. They count for this organization too. Ask whoever runs OpenBot to change one.",
    ),
  ).toBeTruthy();
  expect(view.queryByText("Not used for this organization's rule")).toBeNull();
});

test("an admin of `default` who doesn't run OpenBot reads that its identity providers are set up for all of OpenBot, with no error and nothing to press", async () => {
  setCurrentOrganization("default");
  answer = (path) =>
    path === "/api/v2/organizations/default/identity-providers"
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

test("signed in outside `default`, the app's first load learns what OpenBot offers and who she is with nothing refused", async () => {
  // The self-hosted end-to-end run: before the organization was known, the deployment was asked at `default` with
  // Ines's session, and a signed-in person outside `default` is told "not found" there. The page worked; the console
  // showed the 404. Asked as nobody it is answered, and then everything is asked in Harbor.
  setCurrentOrganization(undefined);
  answer = (path, asNobody) => {
    if (path === "/api/v2/organizations/default/deployment")
      return asNobody ? Response.json(FACTS) : problem(NOT_FOUND);
    if (asNobody) return problem(UNSIGNED);
    if (path === "/api/v2/people/me/organizations")
      return Response.json({
        organizations: [{ ...HARBOR, role: "owner", active: true }],
        canCreate: true,
        nextCursor: null,
      });
    if (path === `/api/v2/organizations/${HARBOR.id}/deployment`)
      return Response.json(FACTS);
    if (path === `/api/v2/organizations/${HARBOR.id}/people/me`)
      return Response.json({
        person: {
          ...INES,
          name: "Ines Duarte",
          needsName: false,
          image: null,
          role: "owner",
          onboarding: null,
        },
        openbotVersion: null,
      });
    return problem(NOT_FOUND);
  };
  const client = freshClient();
  expect(await signedInUser(client)).toMatchObject({ id: INES.id });
  const capabilities = await client.fetchQuery(
    deploymentCapabilitiesQueryOptions(),
  );
  expect(capabilities).toMatchObject({ edition: "team", generativeUi: true });
  expect(refused).toEqual([]);
  expect(sent.map((request) => request.path)).toEqual([
    "/api/v2/organizations/default/deployment",
    "/api/v2/people/me/organizations",
    `/api/v2/organizations/${HARBOR.id}/people/me`,
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
