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
import { setCurrentOrganization } from "@/lib/organizations/current";
import { queryClient } from "@/query-client";
import type { RouterContext } from "@/router-context";
import { Route as AuthedRoute } from "@/routes/_authed";
import { Route as SignRoute } from "@/routes/sign";
import { personBody } from "./accounts-api";
import { nativeFetch, pageFetch } from "./page-fetch";
import { settleReactWork } from "./settle-react-work";

/**
 * Signing out lands on the sign-in screen, not on an error.
 *
 * FOUND ON OPENBOT CLOUD. A person works in an organization of their own, not `default`. After
 * signing out, the sign-in screen asked for the deployment in that organization, as somebody no
 * longer signed in, and the server answered that it couldn't find it: the page read "Something went
 * wrong! Couldn't find that organization." until a reload, which asked at `default` as nobody.
 *
 * The OpenBot is a real HTTP server on this computer answering as the real one does: the person's
 * organizations and their own person only while they are signed in, the deployment in their
 * organization only to its members, and at `default` to anybody. Answers are checked against the
 * schemas generated from the spec. The app is the real sign-in gate, sign-in screen and Sign out.
 */

const ORGANIZATION = "acme";
const NativeResponse = globalThis.Response;
let openbot: ReturnType<typeof Bun.serve>;
let signedIn: boolean;
let signOuts: number;

const deployment = () =>
  GetDeploymentResponse.parse({
    ...getGetDeploymentResponseMock(),
    authProviders: ["google"],
    hostedSignIn: false,
    ssoConfigured: false,
    ssoRequired: false,
  });

function problem(status: number, code: string, detail: string): Response {
  return new NativeResponse(JSON.stringify({ status, code, detail }), {
    status,
    headers: { "content-type": "application/problem+json" },
  });
}

function answer(request: Request): Response {
  const path = new URL(request.url).pathname;
  if (path === "/api/auth/sign-out" && request.method === "POST") {
    signedIn = false;
    signOuts += 1;
    return NativeResponse.json({ success: true });
  }
  if (path === "/api/v2/organizations/default/deployment")
    return NativeResponse.json(deployment());
  if (path === `/api/v2/organizations/${ORGANIZATION}/deployment`)
    return signedIn
      ? NativeResponse.json(deployment())
      : problem(
          404,
          "ORGANIZATION_NOT_FOUND",
          "Couldn't find that organization.",
        );
  if (!signedIn)
    return problem(401, "AUTH_UNAUTHENTICATED", "Authentication required.");
  if (path === "/api/v2/people/me/organizations")
    return NativeResponse.json(
      ListOrganizationsResponse.parse({
        organizations: [
          {
            personal: true,
            id: ORGANIZATION,
            slug: ORGANIZATION,
            name: "Acme",
            role: "owner",
            active: true,
          },
        ],
        canCreate: true,
        nextCursor: null,
      }),
    );
  if (path === `/api/v2/organizations/${ORGANIZATION}/people/me`)
    return NativeResponse.json({
      person: personBody({
        id: "dana",
        email: "dana@example.com",
        name: "Dana Whitfield",
        role: "owner",
      }),
      openbotVersion: null,
    });
  return problem(404, "NOT_FOUND", "Not found.");
}

beforeAll(() => {
  openbot = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: answer });
  GlobalRegistrator.register({ url: `http://127.0.0.1:${openbot.port}/` });
});
beforeEach(() => {
  signedIn = true;
  signOuts = 0;
  setCurrentOrganization(undefined);
  queryClient.clear();
  globalThis.fetch = pageFetch();
});
afterEach(async () => {
  cleanup();
  await settleReactWork();
  queryClient.clear();
  setCurrentOrganization(undefined);
  globalThis.fetch = nativeFetch;
});
afterAll(async () => {
  await settleReactWork();
  await GlobalRegistrator.unregister();
  openbot.stop(true);
});

/** Home with the account menu's Sign out: the same hook every Sign out in the app runs. */
function Home() {
  const signOut = useSignOut();
  return (
    <main>
      <p>The app</p>
      <button onClick={signOut.run} type="button">
        Sign out
      </button>
    </main>
  );
}

/** The app opened at home: the real sign-in gate in front of it, and the sign-in screen. */
function openApp() {
  const root = createRootRouteWithContext<RouterContext>()({
    component: Outlet,
    // A route that fails says why, as the app's error screen does.
    errorComponent: ({ error }) => (
      <p role="alert">Something went wrong! {error.message}</p>
    ),
  });
  const gate = AuthedRoute.options as unknown as Record<string, unknown>;
  const authed = createRoute({
    id: "_authed",
    getParentRoute: () => root,
    component: Outlet,
    ...{ beforeLoad: gate.beforeLoad },
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
    history: createMemoryHistory({ initialEntries: ["/"] }),
    context: { queryClient },
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
  return Object.assign(view, { router });
}

test("signing out from an organization of their own lands on the sign-in screen, not an error", async () => {
  const view = openApp();
  await view.findByText("The app");
  await userEvent.click(view.getByRole("button", { name: "Sign out" }));

  // The sign-in screen, with the deployment's ways in.
  await view.findByRole(
    "button",
    { name: /Continue with Google/ },
    { timeout: 5_000 },
  );
  expect(view.router.state.location.pathname).toBe("/sign");
  expect(signOuts).toBe(1);
  await waitFor(() =>
    expect(view.queryByText(/Couldn't find that organization/)).toBeNull(),
  );
  expect(view.queryByText(/Something went wrong/)).toBeNull();
});
