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
import { getGetDeploymentResponseMock } from "@/lib/api/generated/organization-settings/organization-settings.msw";
import { GetDeploymentResponse } from "@/lib/api/generated/organization-settings/organization-settings.zod";
import { queryClient } from "@/query-client";
import type { RouterContext } from "@/router-context";
import { Route as AuthedRoute } from "@/routes/_authed";
import { Route as SignRoute } from "@/routes/sign";
import { nativeFetch, pageFetch } from "./page-fetch";
import { settleReactWork } from "./settle-react-work";

/**
 * A hosted OpenBot's sign-in: the deployment says people sign in through the hosted sign-in
 * (`Deployment.hostedSignIn`, api/openapi/admin-settings.yaml), and the sign-in screen offers it as a
 * link to /api/auth/hosted/sign-in, which brings the person back where sign-in would have.
 *
 * The OpenBot is a real HTTP server on this computer answering `deployment` with an answer checked
 * against the schema generated from the spec, and refusing everything else as nobody is signed in.
 * The app is the real sign-in gate and sign-in screen, on the app's query client and transport.
 */

let deployment: Record<string, unknown>;
const NativeResponse = globalThis.Response;
let openbot: ReturnType<typeof Bun.serve>;

function answer(request: Request): Response {
  const path = new URL(request.url).pathname;
  if (/^\/api\/v2\/organizations\/[^/]+\/deployment$/.test(path))
    return NativeResponse.json(GetDeploymentResponse.parse(deployment));
  // Nobody is signed in.
  return new NativeResponse(
    JSON.stringify({
      status: 401,
      code: "UNAUTHENTICATED",
      detail: "Sign in to OpenBot.",
    }),
    {
      status: 401,
      headers: { "content-type": "application/problem+json" },
    },
  );
}

beforeAll(() => {
  openbot = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: answer });
  GlobalRegistrator.register({ url: `http://127.0.0.1:${openbot.port}/` });
});
beforeEach(() => {
  deployment = {
    ...getGetDeploymentResponseMock(),
    authProviders: ["google"],
    hostedSignIn: true,
    ssoConfigured: false,
    ssoRequired: false,
  };
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
});

/** The app opened at `start`: the real sign-in gate in front of a home, and the sign-in screen. */
function openApp(start: string) {
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
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

const origin = () => `http://127.0.0.1:${openbot.port}`;

test("a hosted OpenBot offers its own sign-in, first, as a link that brings the person back to the app", async () => {
  const view = openApp("/");
  const hosted = await view.findByRole("link", {
    name: "Continue with OpenBot by CopilotKit",
  });
  expect(hosted.getAttribute("href")).toBe(
    `/api/auth/hosted/sign-in?returnTo=${encodeURIComponent(origin())}`,
  );
  // Beside the deployment's other ways in, ahead of them.
  const google = view.getByRole("button", { name: /Continue with Google/ });
  expect(
    hosted.compareDocumentPosition(google) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
});

test("sent to sign in while finishing an app's account, the hosted sign-in brings the person back to finish it", async () => {
  const view = openApp("/sign?flow_id=f%201");
  const hosted = await view.findByRole("link", {
    name: "Continue with OpenBot by CopilotKit",
  });
  const returnTo = new URL(
    hosted.getAttribute("href") as string,
    origin(),
  ).searchParams.get("returnTo");
  expect(returnTo).toBe(`${origin()}/api/plugins/arcade/verify?flow_id=f%201`);
});

test("an OpenBot that doesn't say so, or says not, offers no hosted sign-in", async () => {
  for (const hostedSignIn of [false, undefined]) {
    deployment = { ...deployment, hostedSignIn };
    if (hostedSignIn === undefined) delete deployment.hostedSignIn;
    queryClient.clear();
    const view = openApp("/");
    await view.findByRole("button", { name: /Continue with Google/ });
    expect(
      view.queryByRole("link", { name: /OpenBot by CopilotKit/ }),
    ).toBeNull();
    cleanup();
  }
});

test("a hosted OpenBot with no other way in still offers its own, and doesn't say sign-in isn't set up", async () => {
  deployment = { ...deployment, authProviders: [] };
  const view = openApp("/");
  await view.findByRole("link", {
    name: "Continue with OpenBot by CopilotKit",
  });
  await waitFor(() =>
    expect(view.queryByText(/Sign-in isn't set up yet/)).toBeNull(),
  );
});
