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
import { QueryClientProvider } from "@tanstack/react-query";
import { isRedirect } from "@tanstack/react-router";
import { cleanup, render, waitFor } from "@testing-library/react";
import {
  adminSections,
  useAdminSections,
} from "@/components/admin/admin-sections";
import { CompanySignInSection } from "@/components/settings/company-sign-in";
import type { CompanySignIn } from "@/lib/api/generated/model";
import { companySignInKeys } from "@/lib/auth/company-sign-in";
import { deploymentKeys } from "@/lib/deployment/queries";
import { setCurrentOrganization } from "@/lib/organizations/current";
import { queryClient } from "@/query-client";
import { Route as IdentityProvidersRoute } from "@/routes/_authed/admin/identity-providers";
import { settleReactWork } from "./settle-react-work";

/*
 * On OpenBot by CopilotKit (the server's `hostedSignIn`), people sign in with their CopilotKit
 * account, so an organization's admin has no identity provider of its own to set up. Admin lists no
 * Identity providers page there, an old link to it lands on the Admin overview, and Settings offers
 * no company sign-in. A self-hosted OpenBot keeps all three as they were.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const originalFetch = global.fetch;
let requested: string[];

beforeEach(() => {
  queryClient.clear();
  setCurrentOrganization("default");
  requested = [];
  // Nothing here is read from the network: every answer the screens need is already on the client.
  global.fetch = (async (input: RequestInfo | URL) => {
    requested.push(String(input));
    return Response.json({ detail: "not served" }, { status: 404 });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  global.fetch = originalFetch;
  // The app's one query client is shared with every other test file: leave its defaults as found.
  for (const key of [deploymentKeys.capabilities(), companySignInKeys.mine()])
    queryClient.setQueryDefaults(key, {});
  queryClient.clear();
});

function deployment(hostedSignIn: boolean) {
  queryClient.setQueryDefaults(deploymentKeys.capabilities(), {
    staleTime: Number.POSITIVE_INFINITY,
  });
  queryClient.setQueryData(deploymentKeys.capabilities(), {
    generativeUi: true,
    selfHostBanner: false,
    localEvaluation: false,
    edition: "team",
    transcription: false,
    voice: false,
    builtInBots: true,
    isolatedBots: false,
    botComputers: true,
    hostedSignIn,
  });
}

const titles = (management: boolean, hosted: boolean) =>
  adminSections(management, hosted).flatMap((section) =>
    section.items.map((item) => item.title),
  );

describe("Admin's pages", () => {
  test("leave out Identity providers on OpenBot by CopilotKit, and keep it self-hosted", () => {
    expect(titles(false, true)).not.toContain("Identity providers");
    expect(titles(true, true)).not.toContain("Identity providers");
    expect(titles(false, false)).toContain("Identity providers");
    expect(titles(true, false)).toContain("Identity providers");
    // Only that one page goes: the rest of the organization's pages, and Managed updates, stay.
    expect(titles(true, true)).toEqual(
      titles(true, false).filter((title) => title !== "Identity providers"),
    );
    expect(titles(true, true)).toContain("Managed updates");
  });

  function Rail() {
    return (
      <ul>
        {useAdminSections().flatMap((section) =>
          section.items.map((item) => <li key={item.title}>{item.title}</li>),
        )}
      </ul>
    );
  }

  test("the rail and the overview read it from the server's answer", async () => {
    deployment(true);
    const hosted = render(
      <QueryClientProvider client={queryClient}>
        <Rail />
      </QueryClientProvider>,
    );
    await hosted.findByText("People");
    expect(hosted.queryByText("Identity providers")).toBeNull();
    hosted.unmount();

    deployment(false);
    const selfHosted = render(
      <QueryClientProvider client={queryClient}>
        <Rail />
      </QueryClientProvider>,
    );
    expect(await selfHosted.findByText("Identity providers")).toBeTruthy();
  });
});

describe("an old link to Identity providers", () => {
  const beforeLoad = IdentityProvidersRoute.options.beforeLoad as (
    match: unknown,
  ) => Promise<unknown>;

  test("lands on the Admin overview on OpenBot by CopilotKit", async () => {
    deployment(true);
    const thrown = await beforeLoad({ context: { queryClient } }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(isRedirect(thrown)).toBe(true);
    expect((thrown as { options: { to: string } }).options.to).toBe("/admin");
  });

  test("opens the page on a self-hosted OpenBot", async () => {
    deployment(false);
    await expect(
      beforeLoad({ context: { queryClient } }),
    ).resolves.toBeUndefined();
  });
});

describe("Settings' company sign-in", () => {
  const OKTA: CompanySignIn = {
    required: false,
    met: false,
    providers: [{ id: "acme-okta", domain: "acme.com" }],
  } as CompanySignIn;

  /** Kept fresh, or stale, so a query that may run asks the server again when the section draws. */
  function settings(fresh: boolean) {
    queryClient.setQueryDefaults(companySignInKeys.mine(), {
      staleTime: fresh ? Number.POSITIVE_INFINITY : 0,
    });
    queryClient.setQueryData(companySignInKeys.mine(), OKTA);
    return render(
      <QueryClientProvider client={queryClient}>
        <CompanySignInSection />
      </QueryClientProvider>,
    );
  }

  test("isn't offered on OpenBot by CopilotKit, and isn't asked for", async () => {
    deployment(true);
    const view = settings(false);
    await settleReactWork();
    expect(view.queryByText("Company sign-in")).toBeNull();
    expect(view.queryByText("Company account")).toBeNull();
    expect(requested.filter((url) => url.includes("company-sign-in"))).toEqual(
      [],
    );
  });

  test("is offered on a self-hosted OpenBot whose organization has a provider", async () => {
    deployment(false);
    const view = settings(true);
    await waitFor(() => expect(view.getByText("Company account")).toBeTruthy());
  });
});
