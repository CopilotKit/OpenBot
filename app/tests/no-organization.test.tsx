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
 * Signed in, and in no organization here: removed from the last one, on a hosted OpenBot. Every app page showed the
 * router's raw "Something went wrong!" box with the sentence in it, the sign-in screen too, with no Sign out and no
 * way back in. Now every page answers with the page for somebody in no organization, and the sign-in screen shows as
 * for anybody.
 *
 * The OpenBot is a real HTTP server on this computer. It answers the person's organizations with none, and the
 * deployment as a hosted OpenBot does: `default`'s is not found for a session that isn't in it, and answers anybody
 * who asks as nobody. Its answers are checked against the schemas generated from the spec. The app is the real
 * sign-in gate and sign-in screen, with the app's own error screen.
 */

const NativeResponse = globalThis.Response;
let openbot: ReturnType<typeof Bun.serve>;
/** The person's organizations: none, until they are added again. */
let organizations: { id: string; slug: string; name: string }[];
let signedIn: boolean;
let requests: string[];

const problem = (status: number, code: string, detail: string) =>
  new NativeResponse(JSON.stringify({ status, code, detail, title: detail }), {
    status,
    headers: { "content-type": "application/problem+json" },
  });

async function answer(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  requests.push(`${request.method} ${path}`);
  if (/^\/api\/v2\/organizations\/default\/deployment$/.test(path)) {
    // Asked with the session of somebody who isn't in `default`: not found. Asked as nobody: what it offers.
    if (request.headers.get("x-test-session") === "yes")
      return problem(
        404,
        "ORGANIZATION_NOT_FOUND",
        "Couldn't find that organization.",
      );
    return NativeResponse.json(
      GetDeploymentResponse.parse({
        ...getGetDeploymentResponseMock(),
        edition: "team",
        authProviders: ["google"],
        hostedSignIn: true,
        ssoConfigured: false,
        ssoRequired: false,
      }),
    );
  }
  if (path === "/api/auth/sign-out" && request.method === "POST") {
    signedIn = false;
    return NativeResponse.json({ success: true });
  }
  if (!signedIn) return problem(401, "UNAUTHENTICATED", "Sign in to OpenBot.");
  if (path === "/api/v2/people/me/organizations")
    return NativeResponse.json(
      ListOrganizationsResponse.parse({
        organizations: organizations.map((one) => ({
          ...one,
          role: "member",
          active: true,
          personal: false,
        })),
        canCreate: false,
        nextCursor: null,
      }),
    );
  const mine = organizations[0];
  if (mine && path === `/api/v2/organizations/${mine.id}/people/me`)
    return NativeResponse.json({
      person: {
        id: "bea",
        email: "bea@example.com",
        name: "Bea Lund",
        needsName: false,
        image: null,
        role: "member",
        onboarding: null,
      },
      openbotVersion: null,
    });
  if (mine && path === `/api/v2/organizations/${mine.id}/shortened-tool-names`)
    return NativeResponse.json({ tools: [] });
  return problem(
    404,
    "ORGANIZATION_NOT_FOUND",
    "Couldn't find that organization.",
  );
}

beforeAll(() => {
  openbot = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: answer });
  GlobalRegistrator.register({ url: `http://127.0.0.1:${openbot.port}/` });
});
beforeEach(() => {
  organizations = [];
  signedIn = true;
  requests = [];
  setCurrentOrganization(undefined);
  queryClient.clear();
  const page = pageFetch();
  // The browser sends the session's cookie unless the request asks as nobody; this marks which it was.
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
});
afterAll(async () => {
  await settleReactWork();
  await GlobalRegistrator.unregister();
  openbot.stop(true);
  setCurrentOrganization("default");
});

/** The app opened at `start`: the real sign-in gate in front of a home, the sign-in screen, the app's error screen. */
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
    component: () => <p>The app</p>,
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

const HOSTED = "Continue with OpenBot by CopilotKit";

test("an app page answers with the page for somebody in no organization: the sentence, the hosted sign-in, Try again and Sign out", async () => {
  const { view } = openApp("/");
  await view.findByRole("heading", { name: "You're not in an organization" });
  expect(view.getByRole("status").textContent).toBe(
    "You aren't a member of an organization here. Ask an admin to add you.",
  );
  const hosted = await view.findByRole("link", { name: HOSTED });
  expect(hosted.getAttribute("href")).toBe(
    `/api/auth/hosted/sign-in?returnTo=${encodeURIComponent(location.origin)}`,
  );
  expect(view.getByRole("button", { name: "Try again" })).toBeTruthy();
  expect(view.getByRole("button", { name: "Sign out" })).toBeTruthy();
  expect(view.queryByText(/Something went wrong/)).toBeNull();
});

/** OpenBot Cloud's sign-in screen's way in (components/auth/cloud-sign-in.tsx). */
const CLOUD_SIGN_IN = "Sign in or create an account";

test("the sign-in screen shows as for anybody, with OpenBot Cloud's sign-in", async () => {
  const { view } = openApp("/sign");
  const signIn = await view.findByRole("link", { name: CLOUD_SIGN_IN });
  expect(signIn.getAttribute("href")).toBe(
    `/api/auth/hosted/sign-in?returnTo=${encodeURIComponent(location.origin)}`,
  );
  expect(view.queryByText(/Something went wrong/)).toBeNull();
  // What it offers anybody was read as nobody, once the session's own read was not found.
  expect(requests).toContain("GET /api/v2/organizations/default/deployment");
});

test("Sign out signs out of OpenBot and OpenBot by CopilotKit, and comes back to the sign-in screen", async () => {
  const left: string[] = [];
  const assign = window.location.assign;
  // The browser leaving for another page is where this test stops following it, as the person's browser would.
  window.location.assign = ((address: string) => {
    left.push(address);
  }) as typeof window.location.assign;
  try {
    const { view, router, person } = openApp("/");
    await person.click(await view.findByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(requests).toContain("POST /api/auth/sign-out"));
    // A hosted OpenBot: the browser goes on to sign out of OpenBot by CopilotKit too, and is sent back here.
    await waitFor(() =>
      expect(left).toEqual([
        `/api/auth/hosted/sign-out?returnTo=${encodeURIComponent(`${location.origin}/sign`)}`,
      ]),
    );
    await router.navigate({ to: "/sign" });
    await view.findByRole("link", { name: CLOUD_SIGN_IN });
  } finally {
    window.location.assign = assign;
  }
});

test("added to an organization again, Try again opens the app", async () => {
  const { view, person } = openApp("/");
  await view.findByRole("heading", { name: "You're not in an organization" });
  organizations = [{ id: "org_acme", slug: "acme", name: "Acme" }];
  await person.click(view.getByRole("button", { name: "Try again" }));
  await waitFor(() => expect(view.getByText("The app")).toBeTruthy());
});
