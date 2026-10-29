import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, waitFor } from "@testing-library/react";
import { Route as ArcadeRoute } from "@/routes/_authed/admin/plugins/arcade";
import fixture from "../../server/tests/fixtures/arcade-catalogue.json";

/**
 * THE MEASURED LINES, ON A SCREEN SOMEBODY CAN REACH.
 *
 * The coverage warning and the consent-breadth line were computed, unit-tested and rendered by
 * nothing: they live on the directory row, and the only directory route redirected away on every
 * Arcade deployment while the only provider that publishes the counts is Arcade. A warning computed
 * and never shown is the same as no warning, and a feature nobody can navigate to is not shipped.
 *
 * So this renders the ARCADE route against an Arcade payload and reads the two sentences out of the
 * markup. Nothing here imports a pure function: a passing pure function is exactly what this defect
 * already had.
 *
 * The app under test is `AirtableApi`, folded out of `server/tests/fixtures/arcade-catalogue.json`
 * the way `listApps` folds it — 2 actions, 0 classified, 1 distinct scope set over 1 scoped action.
 * The fixture is evidence of what Arcade returns and is read, never appended to.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

type FixtureTool = {
  toolkit: { name: string };
  metadata?: { behavior?: unknown };
  requirements?: { authorization?: { oauth2?: { scopes?: string[] } } };
};

/** `AirtableApi` as the SERVER measures it, out of the recorded catalogue. */
function airtableFromFixture() {
  const tools = (Object.values(fixture.tools) as FixtureTool[]).filter(
    (tool) => tool.toolkit.name === "AirtableApi",
  );
  const sets = tools
    .map((tool) => tool.requirements?.authorization?.oauth2?.scopes ?? [])
    .filter((scopes) => scopes.length > 0);
  return {
    slug: "airtableapi",
    name: "AirtableApi",
    description: "Airtable, generated.",
    logo: null,
    categories: [],
    actionCount: tools.length,
    classifiedCount: tools.filter((tool) => tool.metadata?.behavior).length,
    permissionCount: new Set(sets.map((s) => [...s].sort().join(" "))).size,
    scopedActionCount: sets.length,
    enabled: false,
  };
}

/*
 * Capture and restore of the exported `Route` singleton, verbatim from
 * `composio-route-plugins-error.test.tsx` and for the reason recorded there: `.update()` merges into
 * the live object and nothing re-runs `init()` on a replay.
 */
const originalOptions = { ...ArcadeRoute.options };
afterEach(() => {
  Object.assign(ArcadeRoute.options, originalOptions);
});

function renderDirectory() {
  const rootRoute = createRootRoute({ component: Outlet });
  const authedRoute = createRoute({
    id: "/_authed",
    getParentRoute: () => rootRoute,
    component: Outlet,
  });
  const adminRoute = createRoute({
    path: "/admin",
    getParentRoute: () => authedRoute,
    component: Outlet,
  });
  const pluginsRoute = createRoute({
    path: "/plugins/",
    getParentRoute: () => adminRoute,
    component: () => <p>the plugins index</p>,
  });
  const wired = (
    ArcadeRoute as unknown as {
      update: (options: unknown) => typeof ArcadeRoute;
    }
  ).update({
    id: "/plugins/arcade",
    path: "/plugins/arcade",
    getParentRoute: () => adminRoute,
  });
  const tree = rootRoute.addChildren([
    authedRoute.addChildren([adminRoute.addChildren([pluginsRoute, wired])]),
  ]);
  const router = createRouter({
    routeTree: tree,
    history: createMemoryHistory({ initialEntries: ["/admin/plugins/arcade"] }),
  });
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

/** A stub answering the page read with `provider`, and the directory with one app. */
function stubFetch(provider: string | undefined, apps: unknown[]) {
  global.fetch = (async (input: RequestInfo | URL) => {
    const path = String(input).split("?")[0] ?? "";
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    if (path === "/api/plugins/composio/apps") return json({ apps });
    if (path === "/api/plugins") {
      return json({
        catalogue: [],
        servers: [],
        skills: [],
        botsMayCallBack: false,
        redirectUri: null,
        composioConfigured: true,
        provider,
      });
    }
    return json({ connections: [] });
  }) as unknown as typeof fetch;
}

test("the Arcade directory renders the coverage warning and the breadth line on a measured app", async () => {
  stubFetch("arcade", [airtableFromFixture()]);
  const view = renderDirectory();

  const row = await view.findByTestId("directory-airtableapi");

  // Not pending, not a redirect: the screen itself.
  expect(view.queryByText("the plugins index")).toBeNull();
  expect(view.getByText("Browse Arcade")).toBeTruthy();

  await waitFor(() => {
    expect(row.textContent).toContain(
      "This provider has not said which of its actions only read, so every action is treated as a destructive write and every call will ask for approval.",
    );
  });
  expect(row.textContent).toContain(
    "This app uses 1 separate permission across 2 actions. A further 1 requests no permission of its own and becomes callable with any approval here.",
  );
});

test("the Arcade directory redirects on a Composio deployment", async () => {
  stubFetch("composio", []);
  const view = renderDirectory();

  await waitFor(() => {
    expect(view.getByText("the plugins index")).toBeTruthy();
  });
  expect(view.queryByLabelText("Search Arcade apps")).toBeNull();
});

test("the Arcade directory draws nothing until the page names a provider", async () => {
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  global.fetch = (async (input: RequestInfo | URL) => {
    if (String(input).split("?")[0] === "/api/plugins") await held;
    return new Response(JSON.stringify({ apps: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;

  const view = renderDirectory();
  expect(view.queryByLabelText("Search Arcade apps")).toBeNull();
  expect(view.queryByText("the plugins index")).toBeNull();
  expect(view.queryByRole("alert")).toBeNull();
  release();
  // Drain what the release started. The deferred stub answers `{ apps: [] }`, which carries no
  // `provider`, so `pluginsProvider` defaults to "composio" and this route redirects to the decoy.
  // Awaiting that here is what keeps React's scheduled work INSIDE the test: released and then
  // abandoned, the render lands after `cleanup` and after `GlobalRegistrator.unregister()` has
  // removed `window`, and `scheduler`'s `window.event` throws into the runner — three passes and
  // an exit code of 1, on the one file that proves wave 8's deliverable.
  await view.findByText("the plugins index");
});
