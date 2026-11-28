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
import { cleanup, render } from "@testing-library/react";
import { getGetDeploymentResponseMock } from "@/lib/api/generated/organization-settings/organization-settings.msw";
import { GetDeploymentResponse } from "@/lib/api/generated/organization-settings/organization-settings.zod";
import { signOutMutationOptions } from "@/lib/auth/mutations";
import { ListOrganizationsResponse } from "@/lib/api/generated/organizations/organizations.zod";
import {
  forgetSignedIn,
  rememberSignedIn,
  wasSignedIn,
} from "@/lib/auth/was-signed-in";
import { ReportedErrorComponent } from "@/lib/error-reporting";
import { setCurrentOrganization } from "@/lib/organizations/current";
import { queryClient } from "@/query-client";
import type { RouterContext } from "@/router-context";
import { Route as AuthedRoute } from "@/routes/_authed";
import { Route as SignRoute } from "@/routes/sign";
import { nativeFetch, pageFetch } from "./page-fetch";
import { settleReactWork } from "./settle-react-work";

/**
 * The sign-in gate keeps a flag of whether somebody was signed in, which lets the next visit draw the app's frame while
 * the checks run (lib/auth/was-signed-in.ts). It is set once every check has passed and cleared on the way to the
 * sign-in screen, and a preload, which only reads, does neither.
 *
 * The OpenBot is a real HTTP server on this computer. The app is the real sign-in gate in front of a stub home.
 */

const NativeResponse = globalThis.Response;
let openbot: ReturnType<typeof Bun.serve>;
let signedIn: boolean;
/** Where the person is in onboarding: null for somebody who never had it to do. */
let onboarding: { step: number; completedAt: string | null } | null;
/** What the terms and AI connection questions answer: required, or a hold (503) where OpenBot is moving. */
let termsNeeded: boolean;
let aiNeeded: boolean;
let held: boolean;

async function answer(request: Request): Promise<Response> {
  const path = new URL(request.url).pathname;
  // What the sign-in screen offers anybody, read as nobody.
  if (path === "/api/v2/organizations/default/deployment")
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
        onboarding,
      },
      openbotVersion: null,
    });
  if (path === "/api/v2/organizations/org_acme/shortened-tool-names")
    return NativeResponse.json({ names: {} });
  if (path === "/api/v2/organizations/org_acme/people/me/terms") {
    if (held)
      return NativeResponse.json(
        {
          status: 503,
          code: "ORGANIZATION_UNAVAILABLE",
          detail: "OpenBot is moving. Back in a moment.",
        },
        {
          status: 503,
          headers: {
            "content-type": "application/problem+json",
            "retry-after": "60",
          },
        },
      );
    return NativeResponse.json({
      current: null,
      accepted: null,
      acceptanceNeeded: termsNeeded,
    });
  }
  if (path === "/api/v2/organizations/org_acme/people/me/ai-connection")
    return NativeResponse.json({
      connection: null,
      organization: { ready: false, provider: null },
      uses: aiNeeded ? "none" : "personal",
      required: true,
      available: true,
      signIns: [],
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
  onboarding = null;
  termsNeeded = false;
  aiNeeded = false;
  held = false;
  setCurrentOrganization(undefined);
  queryClient.clear();
  localStorage.clear();
  sessionStorage.clear();
  globalThis.fetch = pageFetch();
});
afterEach(async () => {
  cleanup();
  await settleReactWork();
  queryClient.clear();
  localStorage.clear();
  globalThis.fetch = nativeFetch;
});
afterAll(async () => {
  await settleReactWork();
  await GlobalRegistrator.unregister();
  openbot.stop(true);
  setCurrentOrganization("default");
});

/** The real sign-in gate in front of a stub home, stub onboarding and terms screens, and a stub sign-in screen. */
function memoryRouter(start = "/") {
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
  const page = (path: string, name: string) =>
    createRoute({
      getParentRoute: () => authed,
      path,
      component: () => <p>{name}</p>,
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
  return createRouter({
    routeTree: root.addChildren([
      authed.addChildren([
        home,
        page("/onboarding", "Onboarding"),
        page("/terms", "The terms"),
      ]),
      signIn,
    ]),
    history: createMemoryHistory({ initialEntries: [start] }),
    context: { queryClient },
    defaultErrorComponent: ReportedErrorComponent,
  });
}

function openApp(start = "/") {
  const router = memoryRouter(start);
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
  return { view, router };
}

test("passing every gate remembers", async () => {
  expect(wasSignedIn()).toBe(false);
  const { view } = openApp();
  await view.findByText("The app", {}, { timeout: 5000 });
  expect(wasSignedIn()).toBe(true);
});

test("a redirect to sign-in forgets", async () => {
  rememberSignedIn();
  signedIn = false;
  const { view } = openApp();
  await view.findByRole("heading", { name: /sign in/i }, { timeout: 5000 });
  expect(wasSignedIn()).toBe(false);
});

test("a preload neither remembers nor forgets", async () => {
  const router = memoryRouter();
  await router.preloadRoute({ to: "/" } as never);
  expect(wasSignedIn()).toBe(false);

  signedIn = false;
  queryClient.clear();
  rememberSignedIn();
  await router.preloadRoute({ to: "/" } as never);
  expect(wasSignedIn()).toBe(true);
  forgetSignedIn();
});

test("passing the gates on onboarding doesn't remember", async () => {
  // Somebody partway through onboarding: the gates admit them to onboarding and nowhere else.
  onboarding = { step: 1, completedAt: null };
  const { view } = openApp("/onboarding");
  await view.findByText("Onboarding", {}, { timeout: 5000 });
  await settleReactWork();
  expect(wasSignedIn()).toBe(false);
});

test("passing the gates on the terms screen doesn't remember", async () => {
  const { view } = openApp("/terms");
  await view.findByText("The terms", {}, { timeout: 5000 });
  await settleReactWork();
  expect(wasSignedIn()).toBe(false);
});

test("a redirect to the terms forgets", async () => {
  rememberSignedIn();
  termsNeeded = true;
  const { view } = openApp();
  await view.findByText("The terms", {}, { timeout: 5000 });
  expect(wasSignedIn()).toBe(false);
});

test("a redirect to onboarding forgets", async () => {
  rememberSignedIn();
  onboarding = { step: 1, completedAt: null };
  const { view } = openApp();
  await view.findByText("Onboarding", {}, { timeout: 5000 });
  expect(wasSignedIn()).toBe(false);
});

test("a redirect to Connect your AI forgets", async () => {
  rememberSignedIn();
  aiNeeded = true;
  const { view, router } = openApp();
  await view.findByText("Onboarding", {}, { timeout: 5000 });
  expect(router.state.location.search).toMatchObject({ step: "ai" });
  expect(wasSignedIn()).toBe(false);
});

test("a preload that would redirect to the terms leaves the flag alone", async () => {
  rememberSignedIn();
  termsNeeded = true;
  await memoryRouter().preloadRoute({ to: "/" } as never);
  expect(wasSignedIn()).toBe(true);
});

test("a hold on a gate's question leaves the flag alone", async () => {
  rememberSignedIn();
  held = true;
  const { view } = openApp();
  await view.findByText(
    "OpenBot is moving. Back in a moment.",
    {},
    { timeout: 5000 },
  );
  expect(wasSignedIn()).toBe(true);
});

test("a gate pass while the sign-out request is out does not leave the flag set", async () => {
  rememberSignedIn();
  const { view } = openApp();
  await view.findByText("The app", {}, { timeout: 5000 });
  const realFetch = globalThis.fetch;
  // The sign-out answers only after another gate pass has remembered them again.
  globalThis.fetch = Object.assign(
    async (...args: Parameters<typeof fetch>) => {
      const url = String(args[0] instanceof Request ? args[0].url : args[0]);
      if (!url.includes("sign-out")) return realFetch(...args);
      rememberSignedIn();
      return Response.json({ success: true });
    },
    { preconnect: realFetch.preconnect },
  ) as typeof fetch;
  const { mutationFn } = signOutMutationOptions(queryClient);
  await (mutationFn as () => Promise<unknown>)();
  expect(wasSignedIn()).toBe(false);
});
