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
import { queryClient } from "@/query-client";
import type { RouterContext } from "@/router-context";
import { Route as AuthedRoute } from "@/routes/_authed";
import { connectionsProblem } from "./connections-api";
import { settleReactWork } from "./settle-react-work";

/**
 * A browser opened at the address of OpenBot on one computer, outside its app.
 *
 * The personal edition only admits requests carrying its install's token, which only its app has, so
 * every request from that browser is refused with the sentence below. The app's first question, who
 * is signed in, meets it, and the page says to open OpenBot from its app instead of showing the bare
 * error screen. Any other refusal is shown as it always was.
 */

const ONLY_ITS_OWN_APP =
  "This OpenBot only answers its own app. Open it from the OpenBot app, or use an API key.";

const originalFetch = globalThis.fetch;
const defaults = queryClient.getDefaultOptions();
let refusal: () => Response;

beforeAll(() => GlobalRegistrator.register({ url: "http://127.0.0.1:3010/" }));
beforeEach(() => {
  queryClient.clear();
  queryClient.setDefaultOptions({
    ...defaults,
    queries: { ...defaults.queries, retry: false },
  });
  globalThis.fetch = Object.assign(async () => refusal(), {
    preconnect: originalFetch.preconnect,
  });
});
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  queryClient.clear();
  queryClient.setDefaultOptions(defaults);
});
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

/** Home behind the real sign-in gate. */
function open() {
  const rootRoute = createRootRouteWithContext<RouterContext>()({
    component: Outlet,
  });
  /*
   * The real sign-in gate's own steps, on a route of this test's own: re-parenting the app's route
   * object would take it out of the app's route tree for every test that runs after this one.
   */
  const gate = AuthedRoute.options as unknown as Record<string, unknown>;
  const authed = createRoute({
    id: "_authed",
    getParentRoute: () => rootRoute,
    component: Outlet,
    ...{ beforeLoad: gate.beforeLoad, errorComponent: gate.errorComponent },
  } as never) as unknown as AnyRoute;
  const home = createRoute({
    path: "/",
    getParentRoute: () => authed,
    component: () => <p>Home</p>,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([authed.addChildren([home])]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
    context: { queryClient },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

test("refused for not being its app, it says to open OpenBot from the app, with the link that opens it", async () => {
  refusal = () => connectionsProblem(403, ONLY_ITS_OWN_APP);
  const view = open();

  expect(
    await view.findByRole("heading", { name: "Open OpenBot from its app" }),
  ).toBeTruthy();
  expect(
    view.getByText("This OpenBot only answers its own app, not a browser."),
  ).toBeTruthy();
  expect(
    view.getByRole("link", { name: "Open OpenBot" }).getAttribute("href"),
  ).toBe("openbot://open");
  expect(view.queryByText("Something went wrong!")).toBeNull();
  expect(view.queryByText("Home")).toBeNull();
});

test("the same sentence outside the API, as `{ error }`, is the same refusal", async () => {
  refusal = () => Response.json({ error: ONLY_ITS_OWN_APP }, { status: 403 });
  const view = open();

  expect(
    await view.findByRole("heading", { name: "Open OpenBot from its app" }),
  ).toBeTruthy();
});

test("any other 403 is the error screen it always was", async () => {
  refusal = () =>
    connectionsProblem(403, "You don't have permission to do that.");
  const view = open();

  expect(await view.findByText("Something went wrong!")).toBeTruthy();
  expect(
    view.queryByRole("heading", { name: "Open OpenBot from its app" }),
  ).toBeNull();
});

test("the sentence with another status is not the refusal either", async () => {
  refusal = () => connectionsProblem(500, ONLY_ITS_OWN_APP);
  const view = open();

  expect(await view.findByText("Something went wrong!")).toBeTruthy();
  expect(
    view.queryByRole("heading", { name: "Open OpenBot from its app" }),
  ).toBeNull();
});
