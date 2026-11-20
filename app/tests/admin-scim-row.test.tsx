import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render } from "@testing-library/react";
import { SignInSection } from "@/components/admin/controls/sign-in-section";
import { deploymentKeys } from "@/lib/deployment/queries";
import { enterpriseKeys } from "@/lib/enterprise/queries";
import { organizationKeys } from "@/lib/organizations/queries";
import { queryClient } from "@/query-client";
import { settleReactWork } from "./settle-react-work";

/*
 * Admin, Identity providers, SCIM provisioning: what the company's directory deactivating somebody
 * does, said to the admin who set it up. Where everybody has an organization of their own, it takes
 * the person out of this organization alone; where OpenBot keeps one, it ends their access to
 * OpenBot. Answers are set on the app's one query client as the API gives them.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
  // The app's one query client is shared with every other test file: leave its defaults as found.
  for (const key of [
    enterpriseKeys.overview(),
    deploymentKeys.capabilities(),
    organizationKeys.mine(),
  ])
    queryClient.setQueryDefaults(key, {});
  queryClient.clear();
});

const OVERVIEW = {
  settings: { ssoRequired: false },
  scim: {
    configured: true,
    baseUrl: "https://openbot.acme.test/api/auth/scim/v2",
  },
  capabilities: [],
  networkPolicies: [],
};

beforeEach(() => {
  queryClient.clear();
  // Nothing here is read from the network: every answer is already on the client.
  global.fetch = (async () =>
    Response.json(
      { detail: "not served" },
      { status: 404 },
    )) as unknown as typeof fetch;
  queryClient.setQueryDefaults(enterpriseKeys.overview(), {
    staleTime: Number.POSITIVE_INFINITY,
  });
  queryClient.setQueryData(enterpriseKeys.overview(), OVERVIEW);
  queryClient.setQueryDefaults(deploymentKeys.capabilities(), {
    staleTime: Number.POSITIVE_INFINITY,
  });
  queryClient.setQueryData(deploymentKeys.capabilities(), {
    generativeUi: true,
    selfHostBanner: false,
    localEvaluation: false,
    edition: "team",
  });
});

function scimRow(view: ReturnType<typeof render>) {
  const title = view.getByText("SCIM provisioning");
  return title.closest("[data-slot=item]")?.textContent ?? "";
}

test("with several organizations, deprovisioning takes the person out of this organization alone", async () => {
  queryClient.setQueryDefaults(organizationKeys.mine(), {
    staleTime: Number.POSITIVE_INFINITY,
  });
  queryClient.setQueryData(organizationKeys.mine(), {
    organizations: [
      {
        id: "default",
        slug: "acme",
        name: "Acme Freight",
        role: "admin",
        personal: false,
        active: true,
      },
    ],
    canCreate: true,
    currentId: "default",
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <SignInSection />
    </QueryClientProvider>,
  );
  await view.findByText("SCIM provisioning");
  const said = scimRow(view);
  expect(said).toContain("removes the person from this organization");
  expect(said).toContain("own organization");
  expect(said).not.toContain("ends sessions");
  expect(said).not.toContain("blocks the address");
});

test("where OpenBot keeps one organization, deprovisioning still ends their access", async () => {
  queryClient.setQueryDefaults(organizationKeys.mine(), {
    staleTime: Number.POSITIVE_INFINITY,
  });
  queryClient.setQueryData(organizationKeys.mine(), {
    organizations: [],
    canCreate: false,
    currentId: "default",
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <SignInSection />
    </QueryClientProvider>,
  );
  await view.findByText("SCIM provisioning");
  const said = scimRow(view);
  expect(said).toContain("ends sessions");
  expect(said).toContain("blocks the address");
});
