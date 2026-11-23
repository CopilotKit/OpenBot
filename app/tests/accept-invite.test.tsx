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
import { parseSearchText } from "@/lib/search-text";
import { queryClient } from "@/query-client";
import type { RouterContext } from "@/router-context";
import { Route as AuthedRoute } from "@/routes/_authed";
import { Route as AcceptInviteRoute } from "@/routes/accept-invite";
import { nativeFetch, pageFetch } from "./page-fetch";
import { settleReactWork } from "./settle-react-work";

/**
 * The button in a hosted OpenBot's invitation email opens /accept-invite with the invitation's
 * ticket and organization. Signed out, the page leaves for the hosted sign-in carrying both, and
 * asks to come back to this OpenBot's own origin. Without a ticket it says so and offers a way in.
 *
 * The OpenBot is a real HTTP server on this computer answering `deployment` with an answer checked
 * against the schema generated from the spec, and refusing everything else as nobody is signed in.
 * The app is the real route and the real sign-in gate, on the app's query client and transport;
 * the page leaving is the page's own address changing.
 */

let deployment: Record<string, unknown>;
const NativeResponse = globalThis.Response;
let openbot: ReturnType<typeof Bun.serve>;

function answer(request: Request): Response {
  const path = new URL(request.url).pathname;
  if (/^\/api\/v2\/organizations\/[^/]+\/deployment$/.test(path))
    return NativeResponse.json(GetDeploymentResponse.parse(deployment));
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

const origin = () => `http://127.0.0.1:${openbot.port}`;
const setPageAddress = (url: string) =>
  (
    window as unknown as { happyDOM: { setURL(url: string): void } }
  ).happyDOM.setURL(url);

beforeAll(() => {
  openbot = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: answer });
  GlobalRegistrator.register({ url: `${origin()}/` });
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
  setPageAddress(`${origin()}/`);
});
afterAll(async () => {
  await settleReactWork();
  await GlobalRegistrator.unregister();
  openbot.stop(true);
});

/** The app opened at `start`: the real sign-in gate in front of a home, and /accept-invite. */
function openApp(start: string) {
  setPageAddress(`${origin()}${start}`);
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
  const sign = createRoute({
    getParentRoute: () => root,
    path: "/sign",
    component: () => <p>Sign in</p>,
  } as never) as unknown as AnyRoute;
  const accept = AcceptInviteRoute.options as unknown as Record<
    string,
    unknown
  >;
  const acceptInvite = createRoute({
    getParentRoute: () => root,
    path: "/accept-invite",
    ...{
      validateSearch: accept.validateSearch,
      beforeLoad: accept.beforeLoad,
      component: accept.component,
    },
  } as never) as unknown as AnyRoute;
  const router = createRouter({
    routeTree: root.addChildren([
      authed.addChildren([home]),
      sign,
      acceptInvite,
    ]),
    history: createMemoryHistory({ initialEntries: [start] }),
    context: { queryClient },
    // The app's own search parsing (router.tsx).
    parseSearch: parseSearchText,
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

test("signed out, the invitation's link says it is joining and leaves for the hosted sign-in with the ticket and organization", async () => {
  const view = openApp("/accept-invite?ticket=T%201&organization=org_O");
  await view.findByRole("heading", { name: "Joining your organization…" });
  await waitFor(() =>
    expect(new URL(window.location.href).pathname).toBe(
      "/api/auth/hosted/sign-in",
    ),
  );
  const left = new URL(window.location.href);
  expect(left.origin).toBe(origin());
  expect(left.searchParams.get("invitationTicket")).toBe("T 1");
  expect(left.searchParams.get("organizationId")).toBe("org_O");
  // Back to this OpenBot, never anywhere else.
  expect(new URL(left.searchParams.get("returnTo") as string).origin).toBe(
    origin(),
  );
});

test("the hosted sign-in's own ticket name works too, and a ticket of digits stays the ticket it was", async () => {
  openApp(
    "/accept-invite?organization=O&__clerk_ticket=12345678901234567890&__clerk_status=sign_up",
  );
  await waitFor(() =>
    expect(new URL(window.location.href).pathname).toBe(
      "/api/auth/hosted/sign-in",
    ),
  );
  const left = new URL(window.location.href);
  expect(left.searchParams.get("invitationTicket")).toBe(
    "12345678901234567890",
  );
  expect(left.searchParams.get("organizationId")).toBe("O");
});

test("an invitation the hosted sign-in already accepted signs in to that organization without the spent ticket", async () => {
  const view = openApp(
    "/accept-invite?organization=O&__clerk_ticket=spent&__clerk_status=complete",
  );
  await view.findByRole("heading", { name: "Joining your organization…" });
  await waitFor(() =>
    expect(new URL(window.location.href).pathname).toBe(
      "/api/auth/hosted/sign-in",
    ),
  );
  const left = new URL(window.location.href);
  expect(left.searchParams.has("invitationTicket")).toBe(false);
  expect(left.searchParams.get("organizationId")).toBe("O");
  expect(new URL(left.searchParams.get("returnTo") as string).origin).toBe(
    origin(),
  );
});

test("with no ticket the page says so and offers a way into OpenBot, and goes nowhere", async () => {
  const view = openApp("/accept-invite?organization=O");
  await view.findByText(/This link is missing part of the invitation/);
  const way = view.getByRole("link", { name: /^Open / });
  expect(way.getAttribute("href")).toBe("/");
  await settleReactWork();
  expect(new URL(window.location.href).pathname).toBe("/accept-invite");
});

test("an OpenBot that doesn't sign in through the hosted sign-in keeps the ticket to itself", async () => {
  deployment = { ...deployment, hostedSignIn: false };
  const view = openApp("/accept-invite?ticket=T&organization=O");
  await view.findByText("Sign in to see your invitations.");
  await settleReactWork();
  expect(new URL(window.location.href).pathname).toBe("/accept-invite");
});
