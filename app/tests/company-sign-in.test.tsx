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
import { act, cleanup, render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ServerWebSocket } from "bun";
import {
  HeldOutGate,
  heldPageDeps,
} from "@/components/auth/company-sign-in-page";
import { CompanySignInSection } from "@/components/settings/company-sign-in";
import type { CompanySignIn, Problem } from "@/lib/api/generated/model";
import { getGetDeploymentResponseMock } from "@/lib/api/generated/organization-settings/organization-settings.msw";
import { GetDeploymentResponse } from "@/lib/api/generated/organization-settings/organization-settings.zod";
import { ListOrganizationsResponse } from "@/lib/api/generated/organizations/organizations.zod";
import { GetCompanySignInResponse } from "@/lib/api/generated/people/people.zod";
import { HELD_OUT_NOW, releaseHold } from "@/lib/auth/held-out";
import { useChannelEvents } from "@/lib/channels/use-channel-events";
import { ReportedErrorComponent } from "@/lib/error-reporting";
import {
  currentOrganizationId,
  setCurrentOrganization,
} from "@/lib/organizations/current";
import { queryClient } from "@/query-client";
import type { RouterContext } from "@/router-context";
import { Route as AuthedRoute } from "@/routes/_authed";
import { nativeFetch, pageFetch } from "./page-fetch";
import { settleReactWork } from "./settle-react-work";

/**
 * A member Harbor Legal holds out until they sign in through their company (Require SSO): Ines joined by invitation,
 * signed in with Google, and Harbor requires its Okta. Every request she makes in Harbor is refused with
 * SSO_REQUIRED, and the app showed the router's raw error box with no way in. Now the app answers with a page that says
 * why and offers Link your company account, which signs her in through Harbor's provider while she is signed in, so
 * the server links it to her account. Settings, General offers the same.
 *
 * The OpenBot is a real HTTP server on this computer, whose answers are checked against the schemas generated from the
 * spec. The app is the real sign-in gate with the app's own error screen, and the real auth client.
 */

const NativeResponse = globalThis.Response;
const HARBOR = { id: "org_harbor", slug: "harbor", name: "Harbor Legal" };
const HELD_OUT =
  "This organization requires signing in through your company's identity provider. Sign in with your work email to continue.";

/** Ines's own organization, beside Harbor, which requires nothing of how she signs in. */
const OWN = { id: "org_ines", slug: "ines", name: "Ines's organization" };

let openbot: ReturnType<typeof Bun.serve>;
let heldOut: boolean;
/** Whether she has her own organization too, and which one her session works in. */
let ownToo: boolean;
let active: string;
let signIn: CompanySignIn;
let requests: string[];
let linked: unknown[];

const json = (body: unknown, status = 200) =>
  new NativeResponse(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const refused: Problem = {
  type: "https://open.bot/errors/sso-required",
  title: "Company sign-in required.",
  status: 403,
  detail: HELD_OUT,
  code: "SSO_REQUIRED",
  category: "permission",
  retryable: false,
  requestId: "req_test",
  traceId: "trace_test",
};

async function answer(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  requests.push(`${request.method} ${path}`);
  // As a real OpenBot answers it: a signed-in person held out of Harbor is refused its deployment read too.
  if (heldOut && path === `/api/v2/organizations/${HARBOR.id}/deployment`)
    return new NativeResponse(JSON.stringify(refused), {
      status: 403,
      headers: { "content-type": "application/problem+json" },
    });
  if (path.endsWith("/deployment"))
    return json(
      GetDeploymentResponse.parse({
        ...getGetDeploymentResponseMock(),
        edition: "team",
        hostedSignIn: false,
      }),
    );
  if (path === "/api/v2/people/me/organizations")
    return json(
      ListOrganizationsResponse.parse({
        organizations: [
          {
            ...HARBOR,
            role: "member",
            active: active === HARBOR.id,
            personal: false,
          },
          ...(ownToo
            ? [
                {
                  ...OWN,
                  role: "owner",
                  active: active === OWN.id,
                  personal: true,
                },
              ]
            : []),
        ],
        canCreate: true,
        nextCursor: null,
      }),
    );
  if (
    path === "/api/auth/organization/set-active" &&
    request.method === "POST"
  ) {
    active = ((await request.json()) as { organizationId: string })
      .organizationId;
    return json({ id: active });
  }
  // Her own organization requires nothing: the app opens there.
  if (path === `/api/v2/organizations/${OWN.id}/people/me`)
    return json({
      person: {
        id: "ines",
        email: "ines@gmail.example",
        name: "Ines Duarte",
        needsName: false,
        image: null,
        role: "owner",
        onboarding: null,
      },
      openbotVersion: null,
    });
  if (path === `/api/v2/organizations/${OWN.id}/shortened-tool-names`)
    return json({ tools: [] });
  // As a real OpenBot answered it for an organization with no company sign-in.
  if (path === `/api/v2/organizations/${OWN.id}/people/me/company-sign-in`)
    return json(
      GetCompanySignInResponse.parse({
        required: false,
        met: false,
        providers: [],
      }),
    );
  if (path === `/api/v2/organizations/${HARBOR.id}/people/me/company-sign-in`)
    // Answered even while she is held out: it is how the page knows the way in.
    return json(GetCompanySignInResponse.parse(signIn));
  if (path === "/api/auth/sign-in/sso" && request.method === "POST") {
    linked.push(await request.json());
    // Better Auth's answer: where the company's sign-in is, which the page is not sent to here.
    return json({ url: "about:blank", redirect: false });
  }
  if (heldOut && path.startsWith(`/api/v2/organizations/${HARBOR.id}/`))
    return new NativeResponse(JSON.stringify(refused), {
      status: 403,
      headers: { "content-type": "application/problem+json" },
    });
  // Not held out (yet): Harbor opens for her as any organization does.
  if (path === `/api/v2/organizations/${HARBOR.id}/people/me`)
    return json({
      person: {
        id: "ines",
        email: "ines@gmail.example",
        name: "Ines Duarte",
        needsName: false,
        image: null,
        role: "member",
        onboarding: null,
      },
      openbotVersion: null,
    });
  if (path === `/api/v2/organizations/${HARBOR.id}/shortened-tool-names`)
    return json({ tools: [] });
  if (path === `/api/v2/organizations/${HARBOR.id}/conversations`)
    return json({ conversations: [], nextCursor: null });
  return json({ code: "NOT_FOUND", detail: "Not found.", status: 404 }, 404);
}

/** The app's conversation events sockets the server has open, which it ends when Harbor begins to hold her out. */
let sockets: ServerWebSocket<unknown>[] = [];

beforeAll(() => {
  openbot = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request, server) => {
      const path = new URL(request.url).pathname;
      if (path === `/api/v2/organizations/${HARBOR.id}/conversation-events`) {
        // As a real OpenBot refuses it: held out, the socket is never opened.
        if (heldOut) return answer(request);
        requests.push(`GET ${path}`);
        if (server.upgrade(request, { data: undefined })) return undefined;
      }
      return answer(request);
    },
    websocket: {
      open: (socket) => {
        sockets.push(socket);
      },
      message: () => {},
      close: (socket) => {
        sockets = sockets.filter((open) => open !== socket);
      },
    },
  });
  GlobalRegistrator.register({ url: `http://127.0.0.1:${openbot.port}/` });
});
beforeEach(() => {
  releaseHold();
  heldOut = true;
  ownToo = false;
  active = HARBOR.id;
  signIn = {
    required: true,
    met: false,
    providers: [{ id: "harbor-okta", domain: "harborlegal.com" }],
  };
  requests = [];
  linked = [];
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

/** Home, with the conversation events socket every page of the app keeps open. */
function Home() {
  useChannelEvents();
  return <p>The app</p>;
}

/**
 * The app opened at home: the real sign-in gate in front of it, the gate that gives way to the held page while it is
 * open, and the app's error screen.
 */
function openApp() {
  const root = createRootRouteWithContext<RouterContext>()({
    component: Outlet,
  });
  const gate = AuthedRoute.options as unknown as Record<string, unknown>;
  const authed = createRoute({
    id: "_authed",
    getParentRoute: () => root,
    component: () => (
      <HeldOutGate>
        <Outlet />
      </HeldOutGate>
    ),
    ...{ beforeLoad: gate.beforeLoad, errorComponent: gate.errorComponent },
  } as never) as unknown as AnyRoute;
  const home = createRoute({
    getParentRoute: () => authed,
    path: "/",
    component: Home,
  } as never) as unknown as AnyRoute;
  const router = createRouter({
    routeTree: root.addChildren([authed.addChildren([home])]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
    context: { queryClient },
    defaultErrorComponent: ReportedErrorComponent,
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
  return { view, person: userEvent.setup({ document }) };
}

test("a member held out by Require SSO is told why, in the server's sentence, and offered Link your company account and Sign out", async () => {
  const { view } = openApp();
  await view.findByRole("heading", { name: "Sign in with your company" });
  expect(view.getByRole("status").textContent).toBe(HELD_OUT);
  expect(
    await view.findByRole("button", { name: "Link your company account" }),
  ).toBeTruthy();
  expect(view.getByRole("button", { name: "Sign out" })).toBeTruthy();
  expect(view.queryByText(/Something went wrong/)).toBeNull();
  // An answer, not a fault: asked once, never again a second later, and nothing reported.
  await settleReactWork();
  expect(
    requests.filter(
      (request) =>
        request === `GET /api/v2/organizations/${HARBOR.id}/people/me`,
    ),
  ).toHaveLength(1);
  expect(requests.some((request) => request.endsWith("/app-errors"))).toBe(
    false,
  );
});

test("Link your company account signs in through the organization's provider by its id, while signed in, and comes back here", async () => {
  const { view, person } = openApp();
  await person.click(
    await view.findByRole("button", { name: "Link your company account" }),
  );
  await waitFor(() => expect(linked).toHaveLength(1));
  expect(linked[0]).toEqual({
    providerId: "harbor-okta",
    callbackURL: location.href,
  });
});

test("a company with two providers offers a link through each, by the domain each signs in", async () => {
  signIn = {
    ...signIn,
    providers: [
      { id: "harbor-okta", domain: "harborlegal.com" },
      { id: "anchor-entra", domain: "anchorlaw.com" },
    ],
  };
  const { view, person } = openApp();
  await view.findByRole("button", { name: "Link through harborlegal.com" });
  await person.click(
    view.getByRole("button", { name: "Link through anchorlaw.com" }),
  );
  await waitFor(() =>
    expect(linked).toEqual([
      { providerId: "anchor-entra", callbackURL: location.href },
    ]),
  );
});

test("held out of one organization, she switches to another of hers from the page, and the app is loaded afresh at home there", async () => {
  // The self-hosted end-to-end run: the switch took (her own organization answered), but the page went on showing
  // the gate's refusal from before it, with the Link gone. Leaving the page loads the app afresh, as a reload did.
  ownToo = true;
  const opened: { active: string; working: string | undefined }[] = [];
  const openHome = heldPageDeps.openHome;
  heldPageDeps.openHome = () =>
    opened.push({ active, working: currentOrganizationId() });
  try {
    const { view, person } = openApp();
    await view.findByRole("heading", { name: "Sign in with your company" });
    await person.click(
      await view.findByRole("button", { name: "Switch organization" }),
    );
    const menu = await view.findByRole("menu");
    // Her other organizations, not the one holding her out.
    expect(within(menu).queryByText(HARBOR.name)).toBeNull();
    await person.click(
      within(menu).getByRole("menuitem", { name: "Ines's organization" }),
    );
    // Loaded afresh, once, only after the server and the app both work in the one she picked.
    await waitFor(() => expect(opened).toHaveLength(1));
    expect(opened[0]).toEqual({ active: OWN.id, working: OWN.id });
  } finally {
    heldPageDeps.openHome = openHome;
  }
});

test("held out of her only organization, the page offers no switch", async () => {
  const { view } = openApp();
  await view.findByRole("button", { name: "Link your company account" });
  await settleReactWork();
  expect(
    view.queryByRole("button", { name: "Switch organization" }),
  ).toBeNull();
});

/*
 * The self-hosted end-to-end run: Harbor's admin turned on Require SSO while Ines had OpenBot open. The server closed
 * her sockets with 4403, but the page stayed on Home until the next load while every request failed.
 */
test("Harbor begins to hold her out while the app is open: the socket's close moves her to the held page at once", async () => {
  heldOut = false;
  const { view } = openApp();
  await view.findByText("The app");
  await waitFor(() => expect(sockets).toHaveLength(1));

  heldOut = true;
  await act(async () => {
    sockets[0]?.close(4403, "SSO_REQUIRED");
    await settleReactWork();
  });
  await view.findByRole("heading", { name: "Sign in with your company" });
  expect(view.getByRole("status").textContent).toBe(HELD_OUT_NOW);
  expect(
    await view.findByRole("button", { name: "Link your company account" }),
  ).toBeTruthy();
  expect(view.queryByText("The app")).toBeNull();
  // Not reconnected: the server would refuse it again.
  await settleReactWork();
  expect(
    requests.filter((request) => request.endsWith("/conversation-events")),
  ).toHaveLength(1);
});

test("Harbor begins to hold her out while the app is open: the first request refused for it moves her to the held page, in the server's sentence", async () => {
  heldOut = false;
  const { view } = openApp();
  await view.findByText("The app");

  heldOut = true;
  // Anything the page asks next, as it would on its next read.
  await act(() => queryClient.refetchQueries());
  await view.findByRole("heading", { name: "Sign in with your company" });
  expect(view.getByRole("status").textContent).toBe(HELD_OUT);
  expect(view.queryByText("The app")).toBeNull();
});

/** Settings, General's section, in Harbor. */
function settings() {
  setCurrentOrganization(HARBOR.id);
  return render(
    <QueryClientProvider client={queryClient}>
      <CompanySignInSection />
    </QueryClientProvider>,
  );
}

test("in Settings, a member who hasn't linked their company account is offered the link, and one who has reads that it's linked", async () => {
  heldOut = false;
  signIn = { ...signIn, required: false };
  const view = settings();
  expect(
    await view.findByText(
      "Link it to sign in to this organization through your company.",
    ),
  ).toBeTruthy();
  expect(
    view.getByRole("button", { name: "Link your company account" }),
  ).toBeTruthy();
  cleanup();
  queryClient.clear();

  signIn = { ...signIn, required: true, met: true };
  const linkedView = settings();
  expect(
    await linkedView.findByText(
      "Linked. You sign in to this organization through your company.",
    ),
  ).toBeTruthy();
  expect(linkedView.queryByRole("button")).toBeNull();
});

test("in Settings, an organization with no identity providers shows no company sign-in at all", async () => {
  heldOut = false;
  signIn = { required: false, met: false, providers: [] };
  const view = settings();
  await waitFor(() =>
    expect(requests).toContain(
      `GET /api/v2/organizations/${HARBOR.id}/people/me/company-sign-in`,
    ),
  );
  await settleReactWork();
  expect(view.queryByText("Company sign-in")).toBeNull();
});
