import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, waitFor } from "@testing-library/react";
import { identityKeys } from "@/lib/identity/queries";
import { pluginKeys } from "@/lib/plugins/queries";
import { Route } from "@/routes/_authed/_app/connections.index";

/**
 * EVERY ONE-SHOT PARAMETER THIS SCREEN CONSUMES IS DROPPED FROM THE URL, NOT JUST `?linked=`.
 *
 * All three — `?connected=failed` from the Composio OAuth callback, `?authorized=<code>` from the
 * brokered per-action verifier, `?linked=` from the GitHub account-link callback — report something
 * that has already happened: read once, and then over. A parameter left in the address bar is read
 * again on every reload and on every back-navigation, so news that is minutes old is redrawn as
 * though it had just happened — somebody is told again that their account could not be connected,
 * or that there is no authorization in progress, about an attempt they have since finished.
 * `?linked=` was stripped and the other two were not.
 *
 * THE NOTICE STILL HAS TO BE DRAWN, which is the other half of the claim and the reason the strip
 * cannot be a bare navigate on mount: the screen reads each value once into state, draws the
 * sentence from that, and only the URL is cleaned. A test asserting an empty URL alone would be
 * satisfied by a screen that says nothing at all.
 */

const PATH = "/connections";

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(async () => {
  // Let React's scheduler drain before the DOM globals it reads go away.
  await new Promise((resolve) => setTimeout(resolve, 50));
  await GlobalRegistrator.unregister();
});

type TestRouter = { state: { location: { search: unknown; href: string } } };

function renderScreen(search: string) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  // Seeded rather than fetched: this screen's data is not what is under test here.
  queryClient.setQueryData(pluginKeys.page(), { servers: [], catalogue: [] });
  queryClient.setQueryData(pluginKeys.connections(), { connections: [] });
  queryClient.setQueryData(identityKeys.links(), []);
  queryClient.setQueryData(identityKeys.providers(), {
    slack: false,
    github: false,
  });

  const root = createRootRoute({ component: () => <Outlet /> });
  const screen = Route.update({
    id: PATH,
    path: PATH,
    getParentRoute: () => root,
  } as never);
  // The route tree is assembled by hand, so its types cannot describe it.
  const router = createRouter({
    routeTree: root.addChildren([screen]),
    context: { queryClient },
    history: createMemoryHistory({ initialEntries: [`${PATH}${search}`] }),
  } as never) as never;
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { view, router: router as TestRouter };
}

/** What the address bar holds now, as the router sees it. */
const searchOf = (router: TestRouter) => router.state.location.search;

test("?connected=failed is said once and then dropped from the URL", async () => {
  const { view, router } = renderScreen("?connected=failed");
  await view.findByText(/Couldn't connect that account/);
  await waitFor(() => expect(searchOf(router)).toEqual({}));
  // And the sentence survives the strip: the news is read once, not withdrawn.
  expect(view.queryByText(/Couldn't connect that account/)).not.toBeNull();
  expect(router.state.location.href).toBe(PATH);
});

test("?authorized= is said once and then dropped from the URL", async () => {
  const { view, router } = renderScreen("?authorized=no-attempt");
  await view.findByText(/There's no authorization in progress/);
  await waitFor(() => expect(searchOf(router)).toEqual({}));
  expect(
    view.queryByText(/There's no authorization in progress/),
  ).not.toBeNull();
  expect(router.state.location.href).toBe(PATH);
});

/** The one that was already stripped, kept here so the three are pinned in one place. */
test("?linked= is said once and then dropped from the URL", async () => {
  const { view, router } = renderScreen("?linked=failed");
  await view.findByText(/Couldn't link your GitHub account/);
  await waitFor(() => expect(searchOf(router)).toEqual({}));
  expect(view.queryByText(/Couldn't link your GitHub account/)).not.toBeNull();
});

/**
 * ALL THREE AT ONCE, because stripping them one at a time is the failure mode a per-parameter
 * effect invites: each navigate replaces the whole search, so one that drops `connected` while
 * rebuilding `authorized` leaves the second behind for ever.
 */
test("all three arriving together leave nothing behind", async () => {
  const { view, router } = renderScreen(
    "?connected=failed&authorized=no-attempt&linked=failed",
  );
  await view.findByText(/Couldn't connect that account/);
  await waitFor(() => expect(searchOf(router)).toEqual({}));
  expect(router.state.location.href).toBe(PATH);
  expect(
    view.queryByText(/There's no authorization in progress/),
  ).not.toBeNull();
  expect(view.queryByText(/Couldn't link your GitHub account/)).not.toBeNull();
});

/** Nothing to consume means nothing to clean up, and no navigation at all. */
test("an arrival with no one-shot parameter is left exactly as it came", async () => {
  const { router } = renderScreen("");
  await waitFor(() => expect(searchOf(router)).toEqual({}));
  expect(router.state.location.href).toBe(PATH);
});
