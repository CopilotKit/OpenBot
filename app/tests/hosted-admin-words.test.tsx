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
import { cleanup, render, within } from "@testing-library/react";
import type { ComponentType } from "react";
import { deploymentKeys } from "@/lib/deployment/queries";
import { enterpriseKeys } from "@/lib/enterprise/queries";
import { setCurrentOrganization } from "@/lib/organizations/current";
import { organizationKeys } from "@/lib/organizations/queries";
import {
  brokeredKeyMissing,
  brokeredReach,
  moreAppsRow,
} from "@/lib/plugins/provider-vocabulary";
import { queryClient as appQueryClient } from "@/query-client";
import { Route as IdentityProvidersRoute } from "@/routes/_authed/admin/identity-providers";
import { settleReactWork } from "./settle-react-work";

/**
 * What an organization admin reads on a hosted OpenBot (`hostedSignIn`), where OpenBot by
 * CopilotKit runs the deployment and holds its environment. Found on a hosted stack: Identity
 * providers said "Google, Microsoft and Okta are set in the environment", told the admin about
 * INITIAL_ADMIN_EMAILS and SCIM_BEARER_TOKEN, and Apps told them to set COMPOSIO_API_KEY. None of
 * that is theirs to set, and there people sign in with their OpenBot by CopilotKit account.
 *
 * A company's own OpenBot reads exactly as before, asserted beside each.
 */

const HARBOR = { id: "org_harbor", slug: "harbor", name: "Harbor Legal" };
const FACTS = {
  generativeUi: true,
  selfHostBanner: false,
  localEvaluation: false,
  edition: "team",
  authProviders: [],
  ssoConfigured: false,
  ssoRequired: false,
};

/** The identity providers the server lists in Harbor. */
let providers: unknown[] = [];

const originalFetch = globalThis.fetch;
beforeAll(() => GlobalRegistrator.register({ url: "http://127.0.0.1:3010/" }));
beforeEach(() => {
  setCurrentOrganization(HARBOR.id);
  providers = [];
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL) => {
      const url = new URL(
        input instanceof Request ? input.url : String(input),
        "http://127.0.0.1:3010",
      );
      return url.pathname ===
        `/api/v2/organizations/${HARBOR.id}/identity-providers`
        ? Response.json({ identityProviders: providers, nextCursor: null })
        : Response.json({ detail: "not served" }, { status: 404 });
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

/** Admin's Identity providers page in Harbor, with what the deployment and its controls answered. */
function identityProviders(hostedSignIn: boolean) {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
    },
  });
  client.setQueryData(deploymentKeys.capabilities(), {
    ...FACTS,
    hostedSignIn,
  });
  client.setQueryData(enterpriseKeys.overview(), {
    settings: { ssoRequired: false },
    scim: { configured: false, baseUrl: null },
    capabilities: [],
    networkPolicies: [],
  });
  client.setQueryData(organizationKeys.mine(), {
    organizations: [
      { ...HARBOR, role: "owner", personal: false, active: true },
    ],
    canCreate: true,
    currentId: HARBOR.id,
  });
  const Page = IdentityProvidersRoute.options.component as ComponentType;
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

function section(view: ReturnType<typeof render>, name: string) {
  return view.getByRole("heading", { name }).closest("section") as HTMLElement;
}

test("on a hosted OpenBot, Identity providers names the OpenBot by CopilotKit sign-in and no setting", async () => {
  const view = identityProviders(true);
  await view.findByText("No identity providers yet");
  await view.findByText("SCIM provisioning");

  expect(
    within(section(view, "Registered")).getByText(
      "Signing in with an OpenBot by CopilotKit account is built in, so it doesn't show here.",
    ),
  ).toBeTruthy();
  const signIn = section(view, "Sign-in");
  expect(
    within(signIn).getByText(
      "While Require SSO is on, admins sign in through an identity provider too.",
    ),
  ).toBeTruthy();
  expect(
    within(signIn).getByText(
      "Members can also sign in with their OpenBot by CopilotKit account.",
    ),
  ).toBeTruthy();
  expect(
    within(signIn).getByText(
      "Off. Directory provisioning isn't available here.",
    ),
  ).toBeTruthy();
  expect(document.body.textContent).not.toMatch(
    /environment|INITIAL_ADMIN_EMAILS|SCIM_BEARER_TOKEN|Google|Microsoft|Okta/,
  );
});

test("on a company's own OpenBot, Identity providers reads as before", async () => {
  const view = identityProviders(false);
  await view.findByText("No identity providers yet");
  await view.findByText("SCIM provisioning");

  expect(
    within(section(view, "Registered")).getByText(
      "Google, Microsoft and Okta are set in the environment. They don't show here.",
    ),
  ).toBeTruthy();
  const signIn = section(view, "Sign-in");
  expect(
    within(signIn).getByText(
      "Addresses in INITIAL_ADMIN_EMAILS can always use social sign-in as an emergency way in. Each of those sign-ins shows in Activity.",
    ),
  ).toBeTruthy();
  expect(
    within(signIn).getByText(
      "Members can also sign in with Google, Microsoft or Okta.",
    ),
  ).toBeTruthy();
  expect(
    within(signIn).getByText(
      "Off. Set SCIM_BEARER_TOKEN to accept provisioning from Okta, Entra or another directory.",
    ),
  ).toBeTruthy();
});

/*
 * Found on a hosted OpenBot's end-to-end run: sentences on these screens told an organization admin
 * to ask "whoever runs OpenBot". There that is OpenBot by CopilotKit, whom they have no way to ask.
 */
test("on a hosted OpenBot, the providers set up for all of OpenBot send nobody to ask whoever runs it", async () => {
  providers = [
    {
      id: "company-entra",
      issuer: "https://login.microsoftonline.com/tenant/v2.0",
      domain: "example.com",
      protocol: "oidc",
      registeredBy: null,
      deployment: true,
    },
  ];
  const hosted = identityProviders(true);
  await hosted.findByText("company-entra");
  expect(
    within(section(hosted, "For all of OpenBot")).getByText(
      "Set up for everyone who signs in to OpenBot. They count for this organization too.",
    ),
  ).toBeTruthy();
  expect(document.body.textContent).not.toMatch(/whoever runs|Ask them/);
  cleanup();

  const own = identityProviders(false);
  await own.findByText("company-entra");
  expect(
    within(section(own, "For all of OpenBot")).getByText(
      "Set up for everyone who signs in to OpenBot. They count for this organization too. Ask whoever runs OpenBot to change one.",
    ),
  ).toBeTruthy();
});

test("on a hosted OpenBot, Apps never tells an organization admin to set a variable", () => {
  expect(moreAppsRow("composio", false, "team", true).description).toBe(
    "Not set up yet. OpenBot by CopilotKit sets it up.",
  );
  expect(brokeredKeyMissing("composio", "team", "admin", true)).toBe(
    "Connecting apps isn't set up yet, so this account can't be connected or disconnected here. OpenBot by CopilotKit sets it up. The app stays turned on, and its tool grants still stand.",
  );
  expect(brokeredReach("composio", undefined, false, true).description).toBe(
    "OpenBot holds one key for every app like this. Each person connects their own account, and a Bot sees only what that person can see. There is no token to paste.",
  );

  // A company's own OpenBot keeps naming the setting its admin sets.
  expect(moreAppsRow("composio", false).description).toBe(
    "Not set up. Set COMPOSIO_API_KEY on this deployment to browse its apps.",
  );
  expect(brokeredKeyMissing("composio", "team", "admin")).toBe(
    "Set COMPOSIO_API_KEY on this deployment. Until then, this account can't be connected or disconnected here. The app stays turned on, and its tool grants still stand.",
  );
  expect(brokeredReach("composio").description).toBe(
    "This deployment holds one key for every app like this. Each person connects their own account, and a Bot sees only what that person can see. There is no token to paste.",
  );
});
