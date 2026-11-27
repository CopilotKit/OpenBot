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
import { getGetPersonalAiConnectionResponseMock } from "@/lib/api/generated/models/models.msw";
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
 * The questions `_authed` asks after "who is signed in" (the terms, the AI connection, the shortened tool names) do
 * not depend on each other's answers, so they go out together and the gate decides from the answers in the order it
 * always did: terms, then onboarding, then Connect your AI. Somebody signed out asks nothing past who they are.
 *
 * The OpenBot is a real HTTP server on this computer that holds every answer for 100 ms and records when each
 * request started and ended. The app is the real sign-in gate and sign-in screen in front of stub pages.
 */

const NativeResponse = globalThis.Response;
const HOLD_MS = 100;
const ORGANIZATION = "/api/v2/organizations/default";
const TERMS = `${ORGANIZATION}/people/me/terms`;
const AI_CONNECTION = `${ORGANIZATION}/people/me/ai-connection`;
const TOOL_NAMES = `${ORGANIZATION}/shortened-tool-names`;

let openbot: ReturnType<typeof Bun.serve>;
let signedIn: boolean;
let onboardingFinished: boolean;
let termsToAgreeTo: boolean;
let aiConnectionRequired: boolean;
/** Every request, with when it started and ended (ms). */
let requests: { path: string; start: number; end: number }[];

const problem = (status: number, code: string, detail: string) =>
  new NativeResponse(JSON.stringify({ status, code, detail, title: detail }), {
    status,
    headers: { "content-type": "application/problem+json" },
  });

function answer(request: Request): Response {
  const path = new URL(request.url).pathname;
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
  if (!signedIn) return problem(401, "UNAUTHENTICATED", "Sign in to OpenBot.");
  if (path === "/api/v2/people/me/organizations")
    return NativeResponse.json(
      ListOrganizationsResponse.parse({
        organizations: [
          {
            id: "default",
            slug: "default",
            name: "Default",
            role: "member",
            active: true,
            personal: false,
          },
        ],
        canCreate: false,
        nextCursor: null,
      }),
    );
  if (path === `${ORGANIZATION}/people/me`)
    return NativeResponse.json({
      person: {
        id: "bea",
        email: "bea@example.com",
        name: "Bea Lund",
        needsName: false,
        image: null,
        role: "member",
        onboarding: {
          step: 3,
          completedAt: onboardingFinished ? "2026-11-01T09:00:00.000Z" : null,
        },
      },
      openbotVersion: null,
    });
  if (path === TERMS)
    return NativeResponse.json({
      current: null,
      accepted: null,
      acceptanceNeeded: termsToAgreeTo,
    });
  if (path === AI_CONNECTION)
    return NativeResponse.json({
      ...getGetPersonalAiConnectionResponseMock(),
      required: aiConnectionRequired,
      uses: aiConnectionRequired ? "none" : "personal",
    });
  if (path === TOOL_NAMES) return NativeResponse.json({ names: {} });
  return problem(404, "NOT_FOUND", "Couldn't find that.");
}

async function hold(request: Request): Promise<Response> {
  const entry = {
    path: new URL(request.url).pathname,
    start: performance.now(),
    end: 0,
  };
  requests.push(entry);
  await Bun.sleep(HOLD_MS);
  const response = answer(request);
  entry.end = performance.now();
  return response;
}

beforeAll(() => {
  openbot = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: hold });
  GlobalRegistrator.register({ url: `http://127.0.0.1:${openbot.port}/` });
});
beforeEach(() => {
  signedIn = true;
  onboardingFinished = true;
  termsToAgreeTo = false;
  aiConnectionRequired = false;
  requests = [];
  setCurrentOrganization(undefined);
  queryClient.clear();
  globalThis.fetch = pageFetch();
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

/** The app opened at `start`: the real sign-in gate in front of stub pages, and the real sign-in screen. */
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
  const page = (path: string, text: string) =>
    createRoute({
      getParentRoute: () => authed,
      path,
      component: () => <p>{text}</p>,
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
    routeTree: root.addChildren([
      authed.addChildren([
        page("/", "The app"),
        page("/bots", "Bots"),
        page("/terms", "Terms"),
        page("/onboarding", "Onboarding"),
      ]),
      signIn,
    ]),
    history: createMemoryHistory({ initialEntries: [start] }),
    context: { queryClient },
    defaultErrorComponent: ReportedErrorComponent,
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
  return { view, router };
}

test("the questions after who is signed in go out together", async () => {
  const { view } = openApp("/");
  await view.findByText("The app");
  const asked = [TERMS, AI_CONNECTION, TOOL_NAMES].map((path) => {
    const made = requests.filter((one) => one.path === path);
    expect(made).toHaveLength(1);
    return made[0];
  });
  expect(Math.max(...asked.map((one) => one.start))).toBeLessThan(
    Math.min(...asked.map((one) => one.end)),
  );
});

test("terms still come before onboarding", async () => {
  termsToAgreeTo = true;
  onboardingFinished = false;
  const { view, router } = openApp("/bots");
  await view.findByText("Terms");
  expect(router.state.location.pathname).toBe("/terms");
  expect(router.state.location.search).toEqual({ next: "/bots" });
});

test("onboarding still comes before Connect your AI", async () => {
  onboardingFinished = false;
  aiConnectionRequired = true;
  const { view, router } = openApp("/");
  await view.findByText("Onboarding");
  expect(router.state.location.pathname).toBe("/onboarding");
  expect(router.state.location.search).toEqual({});
});

test("a signed-out visitor asks nothing past who they are", async () => {
  signedIn = false;
  const { router } = openApp("/");
  await waitFor(() => expect(router.state.location.pathname).toBe("/sign"));
  await settleReactWork();
  const paths = requests.map((one) => one.path);
  expect(paths).not.toContain(TERMS);
  expect(paths).not.toContain(AI_CONNECTION);
  expect(paths).not.toContain(TOOL_NAMES);
});
