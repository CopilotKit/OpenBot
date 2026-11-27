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
import { forgetSignedIn, rememberSignedIn } from "@/lib/auth/was-signed-in";
import { ReportedErrorComponent } from "@/lib/error-reporting";
import { setCurrentOrganization } from "@/lib/organizations/current";
import { queryClient } from "@/query-client";
import type { RouterContext } from "@/router-context";
import { Route as AuthedRoute } from "@/routes/_authed";
import { Route as SignRoute } from "@/routes/sign";
import { nativeFetch, pageFetch } from "./page-fetch";
import { settleReactWork } from "./settle-react-work";

/**
 * OpenBot holding off (a 503 with a sentence and Retry-After) on one of the sign-in gate's questions shows the calm
 * "Back in a moment" page. Trying again, by the button or by itself after the Retry-After, loaded the route again,
 * and the router put the gate's pending component in its place at once: the app's empty frame for somebody who was
 * signed in, a blank page for anybody else, and "Trying again…" was never seen. The page stays now, saying
 * "Trying again…", until the app is there, and stays as it was when OpenBot is still holding off.
 *
 * The OpenBot is a real HTTP server on this computer. The app is the real sign-in gate, with its pending component
 * and the app's error screen, in front of a stub home. The person was signed in before, so a skeleton would draw.
 */

const NativeResponse = globalThis.Response;
const HELD = "OpenBot is moving this organization. Try again in a moment.";
let openbot: ReturnType<typeof Bun.serve>;
/** How many more times the gate's question about the terms is refused with a hold. */
let holdsLeft: number;
/** The Retry-After the hold answers with, in seconds. */
let retryAfterSeconds: number;
/** Whether the person is in no organization here, until they are added again. */
let inNone: boolean;

async function answer(request: Request): Promise<Response> {
  const path = new URL(request.url).pathname;
  if (path === "/api/v2/organizations/default/deployment")
    return NativeResponse.json(
      GetDeploymentResponse.parse({
        ...getGetDeploymentResponseMock(),
        edition: "team",
        authProviders: ["google"],
        hostedSignIn: false,
        ssoConfigured: false,
        ssoRequired: false,
      }),
    );
  if (path === "/api/v2/people/me/organizations")
    return NativeResponse.json(
      ListOrganizationsResponse.parse({
        organizations: inNone
          ? []
          : [
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
    return NativeResponse.json({ tools: [] });
  if (path === "/api/v2/organizations/org_acme/people/me/terms") {
    if (holdsLeft > 0) {
      holdsLeft--;
      return NativeResponse.json(
        { status: 503, code: "ORGANIZATION_UNAVAILABLE", detail: HELD },
        {
          status: 503,
          headers: {
            "content-type": "application/problem+json",
            "retry-after": String(retryAfterSeconds),
          },
        },
      );
    }
    return NativeResponse.json({
      current: null,
      accepted: null,
      acceptanceNeeded: false,
    });
  }
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
  holdsLeft = 1;
  retryAfterSeconds = 60;
  inNone = false;
  setCurrentOrganization(undefined);
  queryClient.clear();
  localStorage.clear();
  sessionStorage.clear();
  globalThis.fetch = pageFetch();
  // Somebody who was signed in last time: the gate's pending component draws the app's frame for them.
  rememberSignedIn();
});
afterEach(async () => {
  cleanup();
  await settleReactWork();
  forgetSignedIn();
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

/** The real sign-in gate, with its pending options and error screen, in front of a stub home. */
function openApp() {
  const root = createRootRouteWithContext<RouterContext>()({
    component: Outlet,
  });
  const gate = AuthedRoute.options as unknown as Record<string, unknown>;
  const authed = createRoute({
    id: "_authed",
    getParentRoute: () => root,
    component: Outlet,
    ...{
      beforeLoad: gate.beforeLoad,
      errorComponent: gate.errorComponent,
      pendingComponent: gate.pendingComponent,
      pendingMs: gate.pendingMs,
      pendingMinMs: gate.pendingMinMs,
    },
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

/** Whether `element` is in the document and not hidden by an ancestor (React hides a suspended tree with display: none). */
function shown(element: Element | null | undefined): boolean {
  for (let node = element ?? null; node; node = node.parentElement)
    if (node instanceof HTMLElement && node.style.display === "none")
      return false;
  return !!element?.isConnected;
}

/** Whether a "Back in a moment" page is shown. */
const holdShown = () =>
  [...document.querySelectorAll("h1")].some(
    (heading) => heading.textContent === "Back in a moment" && shown(heading),
  );
/** Whether the page for somebody in no organization is shown. */
const noneShown = () =>
  [...document.querySelectorAll("h1")].some(
    (heading) =>
      heading.textContent === "You're not in an organization" && shown(heading),
  );
/** Whether the app is shown. */
const appShown = () =>
  [...document.querySelectorAll("p")].some(
    (line) => line.textContent === "The app" && shown(line),
  );

/**
 * Watches the document from now on: every time the skeleton's busy page-area is added, however briefly, and every
 * change after which neither the page standing in for the app (the hold page unless said) nor the app is shown.
 */
function watch(standingIn = holdShown) {
  const seen = { skeletons: 0, gaps: 0 };
  const observer = new MutationObserver((records) => {
    for (const record of records)
      for (const node of record.addedNodes)
        if (
          node instanceof Element &&
          (node.matches('[aria-busy="true"]') ||
            node.querySelector('[aria-busy="true"]'))
        )
          seen.skeletons++;
    if (!standingIn() && !appShown()) seen.gaps++;
  });
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["style"],
  });
  return { seen, stop: () => observer.disconnect() };
}

test("a retry after a hold never shows the frame skeleton or a blank page", async () => {
  const { view, person } = openApp();
  await view.findByRole(
    "heading",
    { name: "Back in a moment" },
    {
      timeout: 5000,
    },
  );
  await settleReactWork();

  const watching = watch();
  await person.click(view.getByRole("button", { name: "Try again" }));
  await view.findByText("The app", {}, { timeout: 5000 });
  await settleReactWork();
  watching.stop();
  expect(watching.seen).toEqual({ skeletons: 0, gaps: 0 });
});

test("still held, Try again leaves the hold page as it was, and the next try opens the app", async () => {
  holdsLeft = 2;
  const { view, person } = openApp();
  await view.findByRole(
    "heading",
    { name: "Back in a moment" },
    {
      timeout: 5000,
    },
  );
  await settleReactWork();

  const watching = watch();
  await person.click(view.getByRole("button", { name: "Try again" }));
  // Asked once more and refused: the page is back to its button, with OpenBot's sentence.
  await waitFor(() => expect(holdsLeft).toBe(0));
  await view.findByRole("button", { name: "Try again" }, { timeout: 5000 });
  expect(holdShown()).toBe(true);
  expect(view.getByRole("status").textContent).toBe(HELD);

  await person.click(view.getByRole("button", { name: "Try again" }));
  await view.findByText("The app", {}, { timeout: 5000 });
  await settleReactWork();
  watching.stop();
  expect(watching.seen).toEqual({ skeletons: 0, gaps: 0 });
});

test("the try after the Retry-After goes the same way", async () => {
  retryAfterSeconds = 1;
  const { view } = openApp();
  await view.findByRole(
    "heading",
    { name: "Back in a moment" },
    {
      timeout: 5000,
    },
  );
  await settleReactWork();

  const watching = watch();
  await view.findByText("The app", {}, { timeout: 5000 });
  await settleReactWork();
  watching.stop();
  expect(watching.seen).toEqual({ skeletons: 0, gaps: 0 });
});

test("added to an organization again, Try again keeps the page up until the app shows", async () => {
  holdsLeft = 0;
  inNone = true;
  const { view, person } = openApp();
  await view.findByRole(
    "heading",
    { name: "You're not in an organization" },
    {
      timeout: 5000,
    },
  );
  await settleReactWork();

  const watching = watch(noneShown);
  inNone = false;
  await person.click(view.getByRole("button", { name: "Try again" }));
  await view.findByText("The app", {}, { timeout: 5000 });
  await settleReactWork();
  watching.stop();
  expect(watching.seen).toEqual({ skeletons: 0, gaps: 0 });
});
