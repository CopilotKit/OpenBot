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
import {
  type AnyRoute,
  createMemoryHistory,
  createRootRouteWithContext,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useSignOut } from "@/components/app-sidebar/use-sign-out";
import { getGetDeploymentResponseMock } from "@/lib/api/generated/organization-settings/organization-settings.msw";
import { GetDeploymentResponse } from "@/lib/api/generated/organization-settings/organization-settings.zod";
import { ListOrganizationsResponse } from "@/lib/api/generated/organizations/organizations.zod";
import { ReportedErrorComponent } from "@/lib/error-reporting";
import { setCurrentOrganization } from "@/lib/organizations/current";
import { queryClient } from "@/query-client";
import type { RouterContext } from "@/router-context";
import { Route as AuthedRoute } from "@/routes/_authed";
import { Route as SignRoute } from "@/routes/sign";
import { nativeFetch, pageFetch } from "./page-fetch";
import { settleReactWork } from "./settle-react-work";

/**
 * Signing out on a hosted OpenBot with many organizations (OpenBot Cloud). The person works in their own
 * organization, not `default`, and the server answers an organization's deployment only to its members; anybody
 * else, signed out included, is told it isn't found. Asked as nobody, `default`'s says what this OpenBot offers
 * anybody.
 *
 * Signing out kept the organization the person had been working in, so the sign-in screen asked that
 * organization's deployment as nobody, was told it wasn't found, and showed the router's "Something went wrong!
 * Couldn't find that organization." in place of the sign-in screen. Now it shows the sign-in screen.
 *
 * The OpenBot is a real HTTP server on this computer, its answers checked against the schemas generated from the
 * spec. The app is the real sign-in gate, the real sign-in screen, the app's own error screen, and Sign out as the
 * account menu has it.
 */

const NativeResponse = globalThis.Response;
const ORGANIZATION = "org_acme";
let openbot: ReturnType<typeof Bun.serve>;
let signedIn: boolean;
let requests: string[];
/** Whether this OpenBot is a hosted one (`hostedSignIn`), signing people in with OpenBot by CopilotKit. */
let hosted: boolean;
/** Each address the browser was sent to as a page (`window.location.assign`), in order. */
let left: string[];
let assign: typeof window.location.assign;

const problem = (status: number, code: string, detail: string) =>
  new NativeResponse(JSON.stringify({ status, code, detail, title: detail }), {
    status,
    headers: { "content-type": "application/problem+json" },
  });

const NOT_FOUND = () =>
  problem(404, "ORGANIZATION_NOT_FOUND", "Couldn't find that organization.");

const deployment = () =>
  NativeResponse.json(
    GetDeploymentResponse.parse({
      ...getGetDeploymentResponseMock(),
      edition: "team",
      authProviders: ["google"],
      hostedSignIn: hosted,
      ssoConfigured: false,
      ssoRequired: false,
    }),
  );

async function answer(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const session = request.headers.get("x-test-session") === "yes";
  requests.push(`${request.method} ${path}${session ? "" : " (as nobody)"}`);
  const deploymentOf = /^\/api\/v2\/organizations\/([^/]+)\/deployment$/.exec(
    path,
  )?.[1];
  if (deploymentOf === "default")
    // Asked as nobody: what this OpenBot offers anybody. Asked by somebody who isn't in `default`: not found.
    return session ? NOT_FOUND() : deployment();
  if (deploymentOf === ORGANIZATION)
    // Only a member is told an organization exists.
    return session ? deployment() : NOT_FOUND();
  if (path === "/api/auth/sign-out" && request.method === "POST") {
    signedIn = false;
    return NativeResponse.json({ success: true });
  }
  if (!signedIn) return problem(401, "UNAUTHENTICATED", "Sign in to OpenBot.");
  if (path === "/api/v2/people/me/organizations")
    return NativeResponse.json(
      ListOrganizationsResponse.parse({
        organizations: [
          {
            id: ORGANIZATION,
            slug: "acme",
            name: "Acme",
            role: "admin",
            active: true,
            personal: false,
          },
        ],
        canCreate: true,
        nextCursor: null,
      }),
    );
  if (path === `/api/v2/organizations/${ORGANIZATION}/people/me`)
    return NativeResponse.json({
      person: {
        id: "dana",
        email: "dana@example.com",
        name: "Dana Whitfield",
        needsName: false,
        image: null,
        role: "admin",
        onboarding: null,
      },
      openbotVersion: null,
    });
  if (path === `/api/v2/organizations/${ORGANIZATION}/shortened-tool-names`)
    return NativeResponse.json({ tools: [] });
  // No terms to agree to, as an OpenBot that isn't OpenBot Cloud answers.
  if (path === `/api/v2/organizations/${ORGANIZATION}/people/me/terms`)
    return NativeResponse.json({
      current: null,
      accepted: null,
      acceptanceNeeded: false,
    });
  return NOT_FOUND();
}

beforeAll(() => {
  openbot = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: answer });
  GlobalRegistrator.register({ url: `http://127.0.0.1:${openbot.port}/` });
});
beforeEach(() => {
  signedIn = true;
  requests = [];
  hosted = true;
  left = [];
  // The browser leaving for another page is where this test stops following it, as the person's browser would.
  assign = window.location.assign;
  window.location.assign = ((address: string) => {
    requests.push(`leave for ${address}`);
    left.push(address);
  }) as typeof window.location.assign;
  setCurrentOrganization(undefined);
  queryClient.clear();
  const page = pageFetch();
  // The browser sends the session's cookie while there is one, unless the request asks as nobody.
  globalThis.fetch = Object.assign(
    (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      if (signedIn && init?.credentials !== "omit")
        headers.set("x-test-session", "yes");
      return page(input, { ...init, headers });
    },
    { preconnect: nativeFetch.preconnect },
  ) as typeof fetch;
});
afterEach(async () => {
  cleanup();
  await settleReactWork();
  queryClient.clear();
  globalThis.fetch = nativeFetch;
  window.location.assign = assign;
});
afterAll(async () => {
  await settleReactWork();
  await GlobalRegistrator.unregister();
  openbot.stop(true);
  setCurrentOrganization("default");
});

/** The app as somebody signed in sees it: home, with Sign out as the account menu has it. */
function Home() {
  const signOut = useSignOut();
  return (
    <div>
      <p>The app</p>
      <button disabled={signOut.pending} onClick={signOut.run} type="button">
        Sign out
      </button>
    </div>
  );
}

/** The app opened at `start`: the real sign-in gate in front of home, the sign-in screen, the app's error screen. */
function openApp(start: string) {
  const root = createRootRouteWithContext<RouterContext>()({
    component: Outlet,
  });
  const gate = AuthedRoute.options as unknown as Record<string, unknown>;
  const authed = createRoute({
    id: "_authed",
    getParentRoute: () => root,
    component: Outlet,
    ...{ beforeLoad: gate.beforeLoad, errorComponent: gate.errorComponent },
  } as never) as unknown as AnyRoute;
  const home = createRoute({
    getParentRoute: () => authed,
    path: "/",
    component: Home,
  } as never) as unknown as AnyRoute;
  const sign = SignRoute.options as unknown as Record<string, unknown>;
  const signIn = createRoute({
    getParentRoute: () => root,
    path: "/sign",
    ...{
      validateSearch: sign.validateSearch,
      beforeLoad: sign.beforeLoad,
      component: sign.component,
    },
  } as never) as unknown as AnyRoute;
  const router = createRouter({
    routeTree: root.addChildren([authed.addChildren([home]), signIn]),
    history: createMemoryHistory({ initialEntries: [start] }),
    context: { queryClient },
    defaultErrorComponent: ReportedErrorComponent,
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
  return { view, router, person: userEvent.setup({ document }) };
}

test("on a hosted OpenBot, signing out also signs this browser out of OpenBot by CopilotKit, then comes back to sign-in", async () => {
  const { view, person } = openApp("/");
  await view.findByText("The app");
  await person.click(view.getByRole("button", { name: "Sign out" }));
  await waitFor(() => expect(left).toHaveLength(1));
  // OpenBot's own sign-out first, then the hosted one, which brings the browser back to the sign-in screen. Left
  // signed in to OpenBot by CopilotKit, the next "Continue with OpenBot by CopilotKit" here signed the last person in.
  const back = `${window.location.origin}/sign`;
  expect(left).toEqual([
    `/api/auth/hosted/sign-out?returnTo=${encodeURIComponent(back)}`,
  ]);
  const signedOutAt = requests.indexOf("POST /api/auth/sign-out");
  expect(signedOutAt).toBeGreaterThanOrEqual(0);
  expect(requests.indexOf(`leave for ${left[0]}`)).toBeGreaterThan(signedOutAt);
}, 15_000);

test("on an OpenBot that isn't hosted, signing out goes straight to the sign-in screen", async () => {
  hosted = false;
  const { view, router, person } = openApp("/");
  await view.findByText("The app");
  await person.click(view.getByRole("button", { name: "Sign out" }));
  await waitFor(() => expect(requests).toContain("POST /api/auth/sign-out"));
  await waitFor(() => expect(router.state.location.pathname).toBe("/sign"));
  expect(left).toEqual([]);
}, 15_000);

test("signed out of an organization that isn't default, the sign-in screen shows, not an error", async () => {
  const { view, router, person } = openApp("/");
  await view.findByText("The app");
  await person.click(view.getByRole("button", { name: "Sign out" }));
  await waitFor(() => expect(requests).toContain("POST /api/auth/sign-out"));
  // The hosted sign-out brings the browser back here.
  await waitFor(() => expect(left).toHaveLength(1));
  await router.navigate({ to: "/sign" });
  await view.findByRole(
    "link",
    // OpenBot Cloud's sign-in screen (components/auth/cloud-sign-in.tsx).
    { name: "Sign in or create an account" },
    { timeout: 5_000 },
  );
  expect(router.state.location.pathname).toBe("/sign");
  expect(view.queryByText(/Something went wrong/)).toBeNull();
  expect(view.queryByText("Couldn't find that organization.")).toBeNull();
  // What the sign-in screen offers was asked as nobody, of what this OpenBot offers anybody.
  expect(requests).toContain(
    "GET /api/v2/organizations/default/deployment (as nobody)",
  );
}, 15_000);
