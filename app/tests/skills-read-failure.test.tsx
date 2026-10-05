import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
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
import type { ComponentType } from "react";
import { EditSkill } from "@/components/skills/edit-skill";
import { type PluginsPage, pluginKeys } from "@/lib/plugins/queries";
import { Route as SkillsRoute } from "@/routes/_authed/_app/skills";
import { Route as AdminSkillsRoute } from "@/routes/_authed/admin/skills";

/**
 * The three places skills are listed or opened, when `GET /api/plugins` fails.
 *
 * Each read `data?.skills ?? []` once `isPending` was false, and `isPending` goes false on a failed
 * fetch exactly as it does on a successful one: a request that never came back was drawn as "You
 * don't have any skills yet.", "No skills yet." and "That skill no longer exists", to people who
 * may have written a dozen. `agent-roster-error.test.tsx` is the same mistake on the agent screens.
 *
 * Only the plugins read fails here; who is signed in and the roster answer.
 *
 * THE HARNESS IS THIS REPOSITORY'S, as in `agent-roster-error.test.tsx` and
 * `boundaries-read-failure.test.tsx`: `GlobalRegistrator` in `beforeAll`/`afterAll`, `cleanup` in
 * `afterEach`, queries off `render()`'s own return, a `QueryClient` with `retry: false`, and the
 * exported `Route` singleton captured and restored around its `.update()`.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

const originalFetch = global.fetch;

beforeEach(() => {
  global.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0]) => {
      const path = String(input).split("?")[0];
      const json = (body: unknown) =>
        new Response(JSON.stringify(body), {
          headers: { "content-type": "application/json" },
        });
      if (path === "/api/me") {
        return json({
          user: {
            id: "user-1",
            email: "person@example.com",
            role: "admin",
            onboarding: null,
          },
        });
      }
      if (path === "/api/agents") return json({ agents: [] });
      // The one read under test: a 500 with no body, the shape a broken server sends.
      return new Response(null, { status: 500 });
    },
    { preconnect: originalFetch.preconnect },
  );
});

afterEach(() => {
  global.fetch = originalFetch;
});

/** A client the failing query settles on in one attempt, so no test waits on a retry. */
function failingQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

/** A client already holding a plugins page with no skills in it: the honest empty answer. */
function answeredEmpty() {
  const client = failingQueryClient();
  const page: PluginsPage = {
    catalogue: [],
    servers: [],
    skills: [],
    botsMayCallBack: true,
    redirectUri: null,
    composioConfigured: false,
  };
  client.setQueryData(pluginKeys.page(), page);
  return client;
}

async function waitForFailedRead(client: QueryClient) {
  await waitFor(() => {
    expect(client.getQueryState(pluginKeys.page())?.status).toBe("error");
  });
}

function captureRouteState(route: object): Record<string, unknown> {
  return { ...route, options: { ...(route as { options: object }).options } };
}

function restoreRouteState(
  route: object,
  snapshot: Record<string, unknown>,
): void {
  for (const key of Object.keys(route)) {
    if (!(key in snapshot)) {
      delete (route as Record<string, unknown>)[key];
    }
  }
  Object.assign(route, snapshot);
}

const pristineSkillsRouteState = captureRouteState(SkillsRoute);
let skillsRouteSnapshot: Record<string, unknown>;

beforeEach(() => {
  skillsRouteSnapshot = captureRouteState(pristineSkillsRouteState);
});

afterEach(() => {
  restoreRouteState(SkillsRoute, skillsRouteSnapshot);
});

/** `/skills`, at the id its `Route.useSearch()` reads: `/_authed/_app/skills`. */
function renderSkills(client: QueryClient) {
  const rootRoute = createRootRoute({ component: Outlet });
  const authedRoute = createRoute({
    id: "/_authed",
    getParentRoute: () => rootRoute,
    component: Outlet,
  });
  const appRoute = createRoute({
    id: "/_app",
    getParentRoute: () => authedRoute,
    component: Outlet,
  });
  const skills = (
    SkillsRoute as unknown as { update: (options: unknown) => unknown }
  ).update({
    path: "/skills",
    getParentRoute: () => appRoute,
  });
  const tree = rootRoute.addChildren([
    authedRoute.addChildren([appRoute.addChildren([skills as never])]),
  ]);
  const router = createRouter({
    routeTree: tree,
    history: createMemoryHistory({ initialEntries: ["/skills"] }),
  });
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

/** A component that reads no route of its own, drawn under a root route for `Link`/`useNavigate`. */
function renderAlone(client: QueryClient, Component: ComponentType) {
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: createRootRoute({ component: () => <Component /> }),
  });
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

test("a person's skills page says the skills failed to load, not that they have none", async () => {
  const client = failingQueryClient();
  const view = renderSkills(client);
  await waitForFailedRead(client);

  expect(
    await view.findByText("Your skills could not be loaded."),
  ).toBeTruthy();
  expect(view.queryByText("You don't have any skills yet.")).toBeNull();
});

test("a person with genuinely no skills is still told so", async () => {
  const client = answeredEmpty();
  const view = renderSkills(client);
  await waitForFailedRead(client);

  expect(await view.findByText("You don't have any skills yet.")).toBeTruthy();
  expect(view.queryByText("Your skills could not be loaded.")).toBeNull();
});

test("the admin skills page says the skills failed to load, not that there are none", async () => {
  const client = failingQueryClient();
  const view = renderAlone(
    client,
    AdminSkillsRoute.options.component as ComponentType,
  );
  await waitForFailedRead(client);

  expect(await view.findByText("Skills could not be loaded.")).toBeTruthy();
  expect(view.queryByText("No skills yet.")).toBeNull();
});

test("a deployment with genuinely no skills still says so on the admin page", async () => {
  const client = answeredEmpty();
  const view = renderAlone(
    client,
    AdminSkillsRoute.options.component as ComponentType,
  );
  await waitForFailedRead(client);

  expect(await view.findByText("No skills yet.")).toBeTruthy();
  expect(view.queryByText("Skills could not be loaded.")).toBeNull();
});

test("opening a skill to edit says it failed to load, not that it no longer exists", async () => {
  const client = failingQueryClient();
  const view = renderAlone(client, () => <EditSkill slug="triage" />);
  await waitForFailedRead(client);

  expect(await view.findByText("This skill could not be loaded.")).toBeTruthy();
  expect(
    view.queryByText(
      "That skill no longer exists, or it is not yours to edit.",
    ),
  ).toBeNull();
});
