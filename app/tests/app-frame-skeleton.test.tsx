import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import { readFileSync } from "node:fs";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  type AnyRoute,
  createMemoryHistory,
  createRoute,
  createRootRoute,
  createRootRouteWithContext,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, waitFor, within } from "@testing-library/react";
import { AppFrameSkeleton } from "@/components/layout/app-frame-skeleton";
import { getGetDeploymentResponseMock } from "@/lib/api/generated/organization-settings/organization-settings.msw";
import { GetDeploymentResponse } from "@/lib/api/generated/organization-settings/organization-settings.zod";
import { ListOrganizationsResponse } from "@/lib/api/generated/organizations/organizations.zod";
import {
  beforeCapabilities,
  navigationFor,
  isNavigationLink,
} from "@/lib/navigation";
import { forgetSignedIn, rememberSignedIn } from "@/lib/auth/was-signed-in";
import { ReportedErrorComponent } from "@/lib/error-reporting";
import { setCurrentOrganization } from "@/lib/organizations/current";
import { queryClient } from "@/query-client";
import type { RouterContext } from "@/router-context";
import { Route as AuthedRoute } from "@/routes/_authed";
import { Route as SignRoute } from "@/routes/sign";
import { clearSkin, setSkin } from "@/skins/store";
import { nativeFetch, pageFetch } from "./page-fetch";
import { settleReactWork } from "./settle-react-work";

/*
 * The frame drawn while the sign-in checks run, for somebody who was signed in last time. It is
 * drawn at whatever address is being opened, so each test opens the skeleton at one.
 */

const NativeResponse = globalThis.Response;
let openbot: ReturnType<typeof Bun.serve>;
let signedIn: boolean;
/** While set, the answer to `people/me` waits for it: the sign-in checks are running. */
let holdPerson: Promise<void> | null;

async function answer(request: Request): Promise<Response> {
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
  if (!signedIn) {
    // Held like the person's answer, so a visitor's checks are also still running while it is.
    await holdPerson;
    return NativeResponse.json(
      { status: 401, code: "UNAUTHENTICATED", detail: "Sign in to OpenBot." },
      { status: 401, headers: { "content-type": "application/problem+json" } },
    );
  }
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
  if (path === "/api/v2/organizations/org_acme/people/me") {
    await holdPerson;
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
  }
  if (path === "/api/v2/organizations/org_acme/shortened-tool-names")
    return NativeResponse.json({ tools: [] });
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
  holdPerson = null;
  setCurrentOrganization(undefined);
  queryClient.clear();
  localStorage.clear();
  sessionStorage.clear();
  globalThis.fetch = pageFetch();
  rememberSignedIn();
});
afterEach(async () => {
  cleanup();
  await settleReactWork();
  forgetSignedIn();
  clearSkin();
  queryClient.clear();
  globalThis.fetch = nativeFetch;
});
afterAll(async () => {
  await settleReactWork();
  await GlobalRegistrator.unregister();
  openbot.stop(true);
  setCurrentOrganization("default");
});

/** The skeleton as the whole app, at `path`, once the router has settled there. */
async function openAt(path: string) {
  const router = createRouter({
    routeTree: createRootRoute({ component: AppFrameSkeleton }),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  const view = render(<RouterProvider router={router as never} />);
  await waitFor(() => expect(router.state.status).toBe("idle"));
  await settleReactWork();
  return view;
}

const panelOf = (view: { container: HTMLElement }) =>
  view.container.querySelector('[data-slot="section-panel"]');
const stripOf = (view: { container: HTMLElement }) =>
  view.container.querySelector('[data-slot="strip"]');

test("the panel follows the address", async () => {
  const routines = await openAt("/routines");
  expect(stripOf(routines)).not.toBeNull();
  expect(panelOf(routines)).toBeNull();
  cleanup();

  const home = await openAt("/");
  expect(stripOf(home)).not.toBeNull();
  expect(panelOf(home)).not.toBeNull();
  expect(
    home.container.querySelector('[data-slot="sidebar-inset"]'),
  ).not.toBeNull();
});

test("a skin with its own frame gets nothing", async () => {
  setSkin("opendots");
  const view = await openAt("/");
  expect(view.container.innerHTML).toBe("");
});

test("the pages _app doesn't frame get nothing", async () => {
  // `/admin/teams` is under Admin's own frame, the case the sub-path match is there for.
  for (const path of [
    "/onboarding",
    "/terms",
    "/admin",
    "/admin/teams",
    "/settings",
    "/settings/sign-in",
  ]) {
    const view = await openAt(path);
    expect(view.container.innerHTML, path).toBe("");
    cleanup();
  }
});

test("Bots has its panel, titled", async () => {
  const view = await openAt("/bots/bea/activity");
  expect(panelOf(view)).not.toBeNull();
  expect(within(panelOf(view) as HTMLElement).getByText("Bots")).not.toBeNull();
});

test("a page no section owns opens on Conversations, with its panel", async () => {
  for (const path of ["/teams", "/invitations", "/start/x"]) {
    const view = await openAt(path);
    expect(panelOf(view), path).not.toBeNull();
    expect(
      within(panelOf(view) as HTMLElement).getByText("Conversations"),
      path,
    ).not.toBeNull();
    cleanup();
  }
});

test("the strip has the rows the real one starts with, and no Memory", async () => {
  // Before the edition is known the real strip lists neither Memory nor Teams (`useNavigationItems`).
  const view = await openAt("/");
  const sections = beforeCapabilities(navigationFor(undefined))
    .filter(isNavigationLink)
    .filter((item) => item.section === "primary");
  expect(sections.some((item) => item.id === "memory")).toBe(false);
  expect(stripOf(view)?.querySelectorAll("nav > *").length).toBe(
    sections.length + 1,
  );
  cleanup();

  // So /memory is no section yet, as in the personal edition: Conversations, with its panel.
  const memory = await openAt("/memory");
  expect(panelOf(memory)).not.toBeNull();
  expect(
    within(panelOf(memory) as HTMLElement).getByText("Conversations"),
  ).not.toBeNull();
});

test("a flag that was never set renders nothing", async () => {
  forgetSignedIn();
  const view = await openAt("/");
  expect(view.container.innerHTML).toBe("");
});

/**
 * The real sign-in gate, with its pending options, in front of two stub pages and a stub sign-in
 * screen. The gate's component is a bare outlet, so the only frame in the document is the skeleton.
 */
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
  const router = createRouter({
    routeTree: root.addChildren([
      authed.addChildren([page("/", "Page A"), page("/other", "Page B")]),
      signIn,
    ]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
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

const insetOf = (view: { container: HTMLElement }) =>
  view.container.querySelector('[data-slot="sidebar-inset"]');

test("a returning person sees the frame while the checks run", async () => {
  let release = () => {};
  holdPerson = new Promise((resolve) => {
    release = resolve;
  });
  const { view } = openApp();
  await waitFor(() => expect(stripOf(view)).not.toBeNull());
  expect(insetOf(view)).not.toBeNull();
  expect(view.queryByText("Page A")).toBeNull();

  release();
  await view.findByText("Page A", {}, { timeout: 5000 });
  expect(stripOf(view)).toBeNull();
});

test("a visitor never signed in sees no frame", async () => {
  forgetSignedIn();
  signedIn = false;
  let release = () => {};
  holdPerson = new Promise((resolve) => {
    release = resolve;
  });
  const { view, router } = openApp();
  await settleReactWork();
  // The checks are still running (the answer is held), and a skeleton would show if it could.
  expect(router.state.isLoading).toBe(true);
  expect(stripOf(view)).toBeNull();
  expect(insetOf(view)).toBeNull();

  release();
  await view.findByRole("heading", { name: /sign in/i }, { timeout: 5000 });
  expect(stripOf(view)).toBeNull();
  expect(insetOf(view)).toBeNull();
});

test("a page change never shows the frame skeleton", async () => {
  /*
   * Every time the skeleton's frame is added to the document, however briefly: only the skeleton's
   * page-area is marked busy, so a mount that a render would have shown and removed in one tick is
   * still counted.
   */
  let mounts = 0;
  const seen = new MutationObserver((records) => {
    for (const record of records)
      for (const node of record.addedNodes)
        if (
          node instanceof Element &&
          (node.matches('[aria-busy="true"]') ||
            node.querySelector('[aria-busy="true"]'))
        )
          mounts++;
  });
  // Watching from before the first render, so the first load's skeleton is counted too.
  seen.observe(document.body, { childList: true, subtree: true });
  const { view, router } = openApp();
  // The first load of a returning person does draw it, which proves the observer sees a mount.
  await view.findByText("Page A", {}, { timeout: 5000 });
  expect(mounts).toBeGreaterThan(0);
  await settleReactWork();

  mounts = 0;
  await router.navigate({ to: "/other" } as never);
  await view.findByText("Page B", {}, { timeout: 5000 });
  await router.navigate({ to: "/" } as never);
  await view.findByText("Page A", {}, { timeout: 5000 });
  await settleReactWork();
  seen.disconnect();
  expect(mounts).toBe(0);
  expect(stripOf(view)).toBeNull();
});

test("a page change never shows the frame skeleton, with slow gates", async () => {
  let mounts = 0;
  const seen = new MutationObserver((records) => {
    for (const record of records)
      for (const node of record.addedNodes)
        if (
          node instanceof Element &&
          (node.matches('[aria-busy="true"]') ||
            node.querySelector('[aria-busy="true"]'))
        )
          mounts++;
  });
  const { view, router } = openApp();
  await view.findByText("Page A", {}, { timeout: 5000 });
  await settleReactWork();

  // Nothing cached and the server slow, as a navigation long after the answers were collected.
  seen.observe(document.body, { childList: true, subtree: true });
  mounts = 0;
  for (const to of ["/other", "/"]) {
    queryClient.clear();
    let release = () => {};
    holdPerson = new Promise((resolve) => {
      release = resolve;
    });
    const arrived = router.navigate({ to } as never);
    await settleReactWork();
    // The gate is still asking, and the page it left is still the one on screen.
    expect(router.state.isLoading).toBe(true);
    expect(stripOf(view)).toBeNull();
    release();
    await arrived;
    await view.findByText(
      to === "/" ? "Page A" : "Page B",
      {},
      { timeout: 5000 },
    );
  }
  await settleReactWork();
  seen.disconnect();
  expect(mounts).toBe(0);
  expect(stripOf(view)).toBeNull();
});

test("the skeleton does not import the skin registry", () => {
  // The registry pulls every skin's frame into the main script, which the skeleton is part of.
  const source = readFileSync(
    new URL("../src/components/layout/app-frame-skeleton.tsx", import.meta.url),
    "utf8",
  );
  expect(source).not.toContain("skins/registry");
});
