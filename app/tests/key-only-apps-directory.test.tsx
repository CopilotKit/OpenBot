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
import type { ComposioApp } from "@/lib/plugins/queries";
import { Route as ComposioRoute } from "@/routes/_authed/admin/plugins/composio";
import { displayName } from "../../server/src/plugins/app-names";
import captured from "../../server/tests/fixtures/composio-key-apps.json";

/**
 * THE DIRECTORY SAYS WHICH APPS TAKE A KEY, BEFORE ANYBODY PRESSES ADD OR CONNECT.
 *
 * Reported from OpenBot Desktop 0.3.3: a person browsing for apps expected a sign-in and kept
 * meeting a key form at Connect. Most of the catalogue has no sign-in, so the form is right; the
 * surprise is the bug. A key app's row now says "Needs a key from 1Password", and apps you sign in
 * to are listed first.
 *
 * The rows are Composio's own catalogue answer, captured read-only on 2026-11-08. Each one's
 * `connection` is the server's verdict for that exact row, which `server/tests/key-only-apps.test.ts`
 * pins against `connectionOf`: HubSpot and Gmail sign in, 1Password and PostHog take a key.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

const VERDICT: Record<string, ComposioApp["connection"]["kind"]> = {
  hubspot: "consent",
  gmail: "consent",
  _1password: "fields",
  posthog: "fields",
};

/** The captured rows, as the directory route answers them: the server's own projection. */
function directory(): ComposioApp[] {
  return captured.catalogue.map((row) => ({
    slug: row.slug,
    // The server's own naming, so 1Password arrives as its brand spells it and not "1password".
    name: displayName(row.slug, row.name),
    description: row.meta.description,
    logo: null,
    categories: [],
    actionCount: row.meta.tools_count,
    classifiedCount: null,
    permissionCount: null,
    scopedActionCount: null,
    connection: { kind: VERDICT[row.slug] ?? "unsupported" },
    enabled: false,
  }));
}

const originalOptions = { ...ComposioRoute.options };
afterEach(() => {
  Object.assign(ComposioRoute.options, originalOptions);
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
    ComposioRoute as unknown as {
      update: (options: unknown) => typeof ComposioRoute;
    }
  ).update({
    id: "/plugins/composio",
    path: "/plugins/composio",
    getParentRoute: () => adminRoute,
  });
  const tree = rootRoute.addChildren([
    authedRoute.addChildren([adminRoute.addChildren([pluginsRoute, wired])]),
  ]);
  const router = createRouter({
    routeTree: tree,
    history: createMemoryHistory({
      initialEntries: ["/admin/plugins/composio"],
    }),
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

function stubFetch(apps: ComposioApp[]) {
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
        provider: "composio",
      });
    }
    return json({ connections: [] });
  }) as unknown as typeof fetch;
}

test("a key-only app says it needs a key before Add, and a sign-in app does not", async () => {
  stubFetch(directory());
  const view = renderDirectory();

  const onePassword = await view.findByTestId("directory-_1password");
  expect(onePassword.textContent).toContain("Needs a key from 1Password");
  // Composio's catalogue spells it "1password"; the row never does.
  expect(onePassword.textContent).not.toContain("1password");
  expect((await view.findByTestId("directory-posthog")).textContent).toContain(
    "Needs a key from PostHog",
  );

  // HubSpot also takes a key, but it has a sign-in, and that is how it connects.
  const hubspot = await view.findByTestId("directory-hubspot");
  expect(hubspot.textContent).not.toContain("Needs a key");
  expect(
    (await view.findByTestId("directory-gmail")).textContent,
  ).not.toContain("Needs a key");

  // The page never names the broker.
  expect(view.container.textContent ?? "").not.toMatch(/composio/i);
});

test("apps you sign in to are listed ahead of apps that need a key", async () => {
  stubFetch(directory());
  const view = renderDirectory();

  await view.findByTestId("directory-_1password");
  await waitFor(() => {
    const order = Array.from(
      view.container.querySelectorAll("[data-testid^='directory-']"),
    ).map((row) => row.getAttribute("data-testid"));
    expect(order).toEqual([
      "directory-gmail",
      "directory-hubspot",
      "directory-_1password",
      "directory-posthog",
    ]);
  });
});
