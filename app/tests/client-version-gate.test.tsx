/**
 * When this app and the OpenBot it talks to can't work together, the person reads one sentence in
 * place of the app: "Update OpenBot" when the app is too old, "Ask whoever runs your OpenBot to
 * update it" when the OpenBot is. Before sign-in as well as after, and nothing that fails behind it.
 *
 * The app is the real one at its root: the root route's own component, the sign-in screen and the
 * sign-in gate, the app's query client and its transport. The OpenBot is a real HTTP server on this
 * computer answering `deployment` with the real answers in shared/fixtures/client-version/cases.json,
 * and refusing every other v2 operation the way an OpenBot does: an app the header names below the
 * minimum its `deployment` publishes gets 400 CLIENT_UPDATE_REQUIRED, with the rules the server uses
 * (shared/client-version.ts). A tab left open across an upgrade meets that refusal on any request,
 * and the screen comes up the same; the spec's own example of the refusal is served for that.
 */
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
  APP_UPDATE_SENTENCE,
  belowMinimum,
  CLIENT_HEADER,
  CLIENT_UPDATE_REQUIRED,
  type ClientKind,
  clientUpdateDetail,
  compatibility,
  parseClientHeader,
  RELEASE,
  SECURITY_UPDATE_SENTENCE,
  SERVER_UPDATE_SENTENCE,
} from "@openbot/shared/client-version";
import { DOESNT_UPDATE_ITSELF } from "@openbot/shared/desktop-updates";
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
import { ClientVersionGate } from "@/components/layout/client-version-gate";
import { forgetClientRefusal } from "@/lib/client-version/refusal";
import type { CompatibleApp } from "@/lib/deployment/queries";
import { queryClient } from "@/query-client";
import type { RouterContext } from "@/router-context";
import { Route as RootRoute } from "@/routes/__root";
import { Route as AuthedRoute } from "@/routes/_authed";
import { Route as SignRoute } from "@/routes/sign";
import cases from "../../shared/fixtures/client-version/cases.json";
import { nativeFetch, pageFetch } from "./page-fetch";
import { settleReactWork } from "./settle-react-work";

type DeploymentName = keyof typeof cases.deployments;

/** This app, as it names itself. */
const THIS_WEB = { kind: "web" as const, version: RELEASE };

/** The spec's example of the refusal (api/openapi/common.yaml, `clientUpdateRequired`), as is. */
const SPEC_REFUSAL = {
  type: "https://open.bot/errors/client-update-required",
  title: "This app is too old for this OpenBot.",
  status: 400,
  detail:
    "This OpenBot needs OpenBot Desktop 1.2.0 or later. Update OpenBot, then try again.",
  code: "CLIENT_UPDATE_REQUIRED",
  category: "validation",
  retryable: false,
  requestId: "req_example",
  traceId: "trace_example",
  client: "desktop",
  minimumVersion: "1.2.0",
};

/** The spec's example of a refusal for a security problem (`clientUpdateRequiredSecurity`), as is. */
const SPEC_SECURITY_REFUSAL = {
  ...SPEC_REFUSAL,
  detail:
    "This version of OpenBot has a security problem. Update to keep using it.",
  security: true,
};

/** What the OpenBot answers: its `deployment`, and whether it refuses every other v2 operation. */
let deployment: DeploymentName;
let refuseEverything: boolean;
/** What it refuses every other v2 operation with, when it does. */
let refusalBody: Record<string, unknown>;
const NativeResponse = globalThis.Response;
let openbot: ReturnType<typeof Bun.serve>;

function problem(status: number, body: Record<string, unknown>): Response {
  return new NativeResponse(JSON.stringify({ status, ...body }), {
    status,
    headers: { "content-type": "application/problem+json" },
  });
}

function answer(request: Request): Response {
  const path = new URL(request.url).pathname;
  const published = cases.deployments[deployment];
  if (/^\/api\/v2\/organizations\/[^/]+\/deployment$/.test(path))
    return NativeResponse.json(published);
  if (refuseEverything) return problem(400, refusalBody);
  // A later OpenBot that serves only v3 no longer answers at v2. One that names no API serves v2.
  if ("api" in published && !published.api.includes("v2"))
    return problem(404, { code: "NOT_FOUND" });
  // The server's own rule: an app below the minimum the deployment publishes is refused.
  const minimums =
    "minimumClients" in published
      ? (published.minimumClients as Partial<Record<ClientKind, string>>)
      : {};
  const below = belowMinimum(
    parseClientHeader(request.headers.get(CLIENT_HEADER)),
    minimums,
  );
  if (below)
    return problem(400, {
      code: CLIENT_UPDATE_REQUIRED,
      detail: clientUpdateDetail(below.kind, below.minimum),
      client: below.kind,
      minimumVersion: below.minimum,
    });
  // Nobody is signed in.
  return problem(401, {
    code: "UNAUTHENTICATED",
    detail: "Sign in to OpenBot.",
  });
}

beforeAll(() => {
  openbot = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: answer });
  GlobalRegistrator.register({ url: `http://127.0.0.1:${openbot.port}/` });
});
beforeEach(() => {
  deployment = "current";
  refuseEverything = false;
  refusalBody = SPEC_REFUSAL;
  queryClient.clear();
  // The page is at the server.
  globalThis.fetch = pageFetch();
});
afterEach(async () => {
  cleanup();
  await settleReactWork();
  queryClient.clear();
  forgetClientRefusal();
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  globalThis.fetch = nativeFetch;
});
afterAll(async () => {
  await settleReactWork();
  await GlobalRegistrator.unregister();
  openbot.stop(true);
});

/**
 * The app at `/`: the root route's own component around the real sign-in gate and sign-in screen,
 * on routes of this test's own (re-parenting the app's route objects would take them out of the
 * app's tree for every test after this one). `app` replaces the root with the gate for another app.
 */
function openApp(app?: CompatibleApp) {
  const root = createRootRouteWithContext<RouterContext>()({
    component: app
      ? () => (
          <ClientVersionGate app={app}>
            <Outlet />
          </ClientVersionGate>
        )
      : (RootRoute.options.component as () => React.JSX.Element),
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
    history: createMemoryHistory({ initialEntries: ["/"] }),
    context: { queryClient },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

/** A deployment answer, as `compatibility` reads one. */
function publishedBy(name: DeploymentName): {
  api?: unknown;
  minimumClients?: unknown;
} {
  const answer: Record<string, unknown> = cases.deployments[name];
  return answer;
}

/** The fixture's verdict for an app, so the screen is held to the same cases as every other app. */
function expected(
  name: DeploymentName,
  client: { kind: ClientKind; version: string; speaks?: string[] },
) {
  const listed = cases.cases.find(
    (one) =>
      one.deployment === name &&
      one.client.kind === client.kind &&
      one.client.version === client.version &&
      JSON.stringify(one.client.speaks ?? null) ===
        JSON.stringify(client.speaks ?? null),
  );
  return listed?.fit ?? compatibility(publishedBy(name), client).fit;
}

test("an OpenBot of today: the sign-in screen, and no update screen", async () => {
  expect(RELEASE).toBe("1.1.0");
  expect(expected("current", THIS_WEB)).toBe("ok");
  const view = openApp();
  expect(
    await view.findByRole(
      "heading",
      { name: /Sign in to/ },
      { timeout: 5_000 },
    ),
  ).toBeTruthy();
  expect(view.queryByText(APP_UPDATE_SENTENCE)).toBeNull();
  expect(view.queryByText(SERVER_UPDATE_SENTENCE)).toBeNull();
}, 15_000);

test("an OpenBot whose oldest web app is newer than this one: Update OpenBot, before sign-in", async () => {
  deployment = "next";
  expect(expected("next", THIS_WEB)).toBe("app");
  const view = openApp();
  expect(
    await view.findByRole(
      "heading",
      { name: APP_UPDATE_SENTENCE },
      { timeout: 5_000 },
    ),
  ).toBeTruthy();
  expect(
    view.getByText("This page is from an older version of OpenBot."),
  ).toBeTruthy();
  expect(view.getByRole("button", { name: "Update" })).toBeTruthy();
  // Nothing behind it: no sign-in screen, no error screen.
  expect(view.queryByRole("heading", { name: /Sign in to/ })).toBeNull();
  expect(view.queryByRole("alert")).toBeNull();
}, 15_000);

test("an OpenBot that serves only a newer API: Update OpenBot", async () => {
  deployment = "v3-only";
  expect(compatibility(cases.deployments["v3-only"], THIS_WEB).fit).toBe("app");
  const view = openApp();
  expect(
    await view.findByRole(
      "heading",
      { name: APP_UPDATE_SENTENCE },
      { timeout: 5_000 },
    ),
  ).toBeTruthy();
  expect(view.queryByRole("heading", { name: /Sign in to/ })).toBeNull();
}, 15_000);

test("an app that speaks only a newer API than the OpenBot serves: ask whoever runs it", async () => {
  const app = { kind: "web" as const, version: "2.0.0", speaks: ["v3"] };
  expect(
    expected("current", { kind: "desktop", version: "2.0.0", speaks: ["v3"] }),
  ).toBe("server");
  const view = openApp(app);
  expect(
    await view.findByRole(
      "heading",
      { name: SERVER_UPDATE_SENTENCE },
      { timeout: 5_000 },
    ),
  ).toBeTruthy();
  expect(
    view.getByText("This OpenBot is on a release this page can't use yet."),
  ).toBeTruthy();
  expect(view.getByRole("button", { name: "Try again" })).toBeTruthy();
  expect(view.queryByRole("heading", { name: /Sign in to/ })).toBeNull();
}, 15_000);

test("any request refused with CLIENT_UPDATE_REQUIRED brings up Update OpenBot, in place of what failed", async () => {
  refuseEverything = true;
  const view = openApp();
  expect(
    await view.findByRole(
      "heading",
      { name: APP_UPDATE_SENTENCE },
      { timeout: 5_000 },
    ),
  ).toBeTruthy();
  expect(view.getByRole("button", { name: "Update" })).toBeTruthy();
  expect(view.queryByText(SPEC_REFUSAL.detail)).toBeNull();
  // A plain raise is not a security problem.
  expect(view.queryByText(SECURITY_UPDATE_SENTENCE)).toBeNull();
  expect(view.queryByRole("heading", { name: /Sign in to/ })).toBeNull();
}, 15_000);

test("a refusal for a security problem says so in place of Update OpenBot, with the same Update", async () => {
  refuseEverything = true;
  refusalBody = SPEC_SECURITY_REFUSAL;
  const view = openApp();
  expect(
    await view.findByRole(
      "heading",
      { name: SECURITY_UPDATE_SENTENCE },
      { timeout: 5_000 },
    ),
  ).toBeTruthy();
  expect(view.queryByText(APP_UPDATE_SENTENCE)).toBeNull();
  expect(view.getByRole("button", { name: "Update" })).toBeTruthy();
  expect(view.queryByRole("heading", { name: /Sign in to/ })).toBeNull();
}, 15_000);

test("an OpenBot whose deployment raised an app's minimum for a security problem: that app reads the security sentence", async () => {
  deployment = "security";
  const app = { kind: "recorder" as const, version: "1.1.0" };
  expect(compatibility(cases.deployments.security, app)).toEqual({
    fit: "app",
    minimum: "1.2.0",
    security: true,
  });
  const view = openApp(app);
  expect(
    await view.findByRole(
      "heading",
      { name: SECURITY_UPDATE_SENTENCE },
      { timeout: 5_000 },
    ),
  ).toBeTruthy();
  expect(view.getByRole("button", { name: "Update" })).toBeTruthy();
  cleanup();
  // The same OpenBot's plain raise, for an app it raised for no security problem, reads as before.
  deployment = "raised";
  queryClient.clear();
  const plain = openApp(app);
  expect(
    await plain.findByRole(
      "heading",
      { name: APP_UPDATE_SENTENCE },
      { timeout: 5_000 },
    ),
  ).toBeTruthy();
  expect(plain.queryByText(SECURITY_UPDATE_SENTENCE)).toBeNull();
}, 15_000);

/** OpenBot Desktop's window around the page, answering its plugin's update commands. */
function insideDesktop(updatesItself: boolean, installed: string[]) {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke: async (command: string) => {
      if (command === "plugin:openbot-desktop|connection")
        return { mode: "connected", address: openbot.url.origin };
      if (command === "plugin:openbot-desktop|update_offer")
        return {
          version: null,
          current: "1.0.1",
          installing: null,
          updatesItself,
          ready: null,
        };
      if (command === "plugin:openbot-desktop|install_update") {
        installed.push(command);
        throw "No update is available right now.";
      }
      throw `command ${command} not found`;
    },
    transformCallback: () => 0,
  };
}

test("inside OpenBot Desktop, a refusal naming OpenBot Desktop offers its own Update and restart", async () => {
  refuseEverything = true;
  const installed: string[] = [];
  insideDesktop(true, installed);
  const view = openApp();
  expect(
    await view.findByRole(
      "heading",
      { name: APP_UPDATE_SENTENCE },
      { timeout: 5_000 },
    ),
  ).toBeTruthy();
  expect(
    view.getByText("This OpenBot needs OpenBot Desktop 1.2.0 or later."),
  ).toBeTruthy();
  const update = await view.findByRole(
    "button",
    { name: "Update and restart" },
    { timeout: 5_000 },
  );
  await userEvent.click(update);
  await waitFor(() => expect(installed).toHaveLength(1));
  expect(
    (await view.findByRole("alert", {}, { timeout: 5_000 })).textContent,
  ).toBe("Couldn't install the update: No update is available right now.");
}, 15_000);

test("inside OpenBot Desktop, a refusal of it for a security problem says so, with its own Update and restart", async () => {
  refuseEverything = true;
  refusalBody = SPEC_SECURITY_REFUSAL;
  insideDesktop(true, []);
  const view = openApp();
  expect(
    await view.findByRole(
      "heading",
      { name: SECURITY_UPDATE_SENTENCE },
      { timeout: 5_000 },
    ),
  ).toBeTruthy();
  expect(
    view.getByText("This OpenBot needs OpenBot Desktop 1.2.0 or later."),
  ).toBeTruthy();
  expect(
    await view.findByRole(
      "button",
      { name: "Update and restart" },
      { timeout: 5_000 },
    ),
  ).toBeTruthy();
}, 15_000);

test("inside an OpenBot Desktop that never updates itself, it says what to do instead", async () => {
  refuseEverything = true;
  insideDesktop(false, []);
  const view = openApp();
  expect(
    await view.findByText(DOESNT_UPDATE_ITSELF, {}, { timeout: 5_000 }),
  ).toBeTruthy();
  expect(view.queryByRole("button", { name: "Update and restart" })).toBeNull();
}, 15_000);
