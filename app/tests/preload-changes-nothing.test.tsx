import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  type AnyRoute,
  createMemoryHistory,
  createRootRouteWithContext,
  createRoute,
  createRouter,
  Outlet,
} from "@tanstack/react-router";
import { ListOrganizationsResponse } from "@/lib/api/generated/organizations/organizations.zod";
import { setCurrentOrganization } from "@/lib/organizations/current";
import {
  rememberInvitationLink,
  takeInvitationLink,
} from "@/lib/organizations/invitation-link";
import { queryClient } from "@/query-client";
import type { RouterContext } from "@/router-context";
import { Route as AuthedRoute } from "@/routes/_authed";
import { Route as HomeRoute } from "@/routes/_authed/_app/index";
import { nativeFetch, pageFetch } from "./page-fetch";
import { settleReactWork } from "./settle-react-work";

/**
 * Preloading a page, as a link does when a pointer rests on it, runs the page's `beforeLoad` and must therefore change
 * nothing the person did not choose. Of every `beforeLoad` under app/src/routes, only two write: the sign-in gate in
 * `_authed.tsx` remembers an invitation's link and signs out of OpenBot Desktop, and home in `_authed/_app/index.tsx`
 * takes the remembered invitation. Every other one only reads or throws a redirect. Here the real gate and the real
 * home are preloaded: a preload of home must leave the invitation for the visit, and a preload while signed out must
 * remember none.
 */

const NativeResponse = globalThis.Response;
let openbot: ReturnType<typeof Bun.serve>;
let signedIn: boolean;
let asked: string[];

async function answer(request: Request): Promise<Response> {
  const path = new URL(request.url).pathname;
  asked.push(path);
  if (!signedIn)
    return NativeResponse.json(
      { status: 401, code: "UNAUTHENTICATED", detail: "Sign in to OpenBot." },
      { status: 401, headers: { "content-type": "application/problem+json" } },
    );
  if (path === "/api/v2/people/me/organizations")
    return NativeResponse.json(
      ListOrganizationsResponse.parse({
        organizations: [
          {
            id: "org_acme",
            slug: "acme",
            name: "Acme",
            role: "member",
            active: true,
            personal: false,
          },
        ],
        canCreate: false,
        nextCursor: null,
      }),
    );
  if (path === "/api/v2/organizations/org_acme/people/me")
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
  if (path === "/api/v2/organizations/org_acme/shortened-tool-names")
    return NativeResponse.json({ names: {} });
  if (path === "/api/v2/organizations/org_acme/people/me/terms")
    return NativeResponse.json({
      current: null,
      accepted: null,
      acceptanceNeeded: false,
    });
  return NativeResponse.json(
    { status: 404, code: "NOT_FOUND", detail: "Not found." },
    { status: 404, headers: { "content-type": "application/problem+json" } },
  );
}

beforeAll(() => {
  openbot = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: answer });
  GlobalRegistrator.register({ url: `http://127.0.0.1:${openbot.port}/` });
});
beforeEach(() => {
  signedIn = true;
  asked = [];
  setCurrentOrganization(undefined);
  queryClient.clear();
  sessionStorage.clear();
  globalThis.fetch = pageFetch();
});
afterEach(async () => {
  await settleReactWork();
  queryClient.clear();
  sessionStorage.clear();
  globalThis.fetch = nativeFetch;
});
afterAll(async () => {
  await settleReactWork();
  await GlobalRegistrator.unregister();
  openbot.stop(true);
  setCurrentOrganization("default");
});

/** The real sign-in gate in front of the real home, with stubs for the pages a preload may be pointed at. */
function memoryRouter() {
  const root = createRootRouteWithContext<RouterContext>()({
    component: Outlet,
  });
  const gate = AuthedRoute.options as unknown as Record<string, unknown>;
  const authed = createRoute({
    id: "_authed",
    getParentRoute: () => root,
    component: Outlet,
    ...{ beforeLoad: gate.beforeLoad },
  } as never) as unknown as AnyRoute;
  const home = HomeRoute.options as unknown as Record<string, unknown>;
  const index = createRoute({
    getParentRoute: () => authed,
    path: "/",
    ...{ validateSearch: home.validateSearch, beforeLoad: home.beforeLoad },
    component: () => <p>Home</p>,
  } as never) as unknown as AnyRoute;
  const invitation = createRoute({
    getParentRoute: () => authed,
    path: "/invitations/$invitationId",
    component: () => <p>An invitation</p>,
  } as never) as unknown as AnyRoute;
  const signIn = createRoute({
    getParentRoute: () => root,
    path: "/sign",
    component: () => <p>Sign in</p>,
  } as never) as unknown as AnyRoute;
  return createRouter({
    routeTree: root.addChildren([
      authed.addChildren([index, invitation]),
      signIn,
    ]),
    history: createMemoryHistory({ initialEntries: ["/sign"] }),
    context: { queryClient },
  });
}

test("preloading home leaves a pending invitation for the visit", async () => {
  const router = memoryRouter();
  rememberInvitationLink("/invitations/inv_1");
  await router.preloadRoute({ to: "/" } as never);
  expect(asked).toContain("/api/v2/people/me/organizations");
  expect(takeInvitationLink()).toBe("inv_1");
});

test("preloading while signed out remembers no invitation", async () => {
  signedIn = false;
  const router = memoryRouter();
  await router.preloadRoute({ to: "/invitations/inv_2" } as never);
  expect(asked).toContain("/api/v2/people/me/organizations");
  expect(takeInvitationLink()).toBeUndefined();
});
