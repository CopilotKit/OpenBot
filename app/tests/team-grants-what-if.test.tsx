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
import { cleanup, render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route as WhatIfRoute } from "@/routes/_authed/admin/what-if";
import { settleReactWork } from "./settle-react-work";
import answers from "./what-if.fixture.json";

/**
 * Admin > What would happen, asked about "anyone in" one of the organization's teams.
 *
 * The page through its real data functions, with `fetch` answering at the API's addresses as
 * `what-if.test.tsx` does. The vocabulary lists the organization's teams beside its directory groups.
 * A team is chosen by its name and sent as `team:<id>`; a directory group an action already names is
 * still shown and still checked; a team that is gone says so and asks for somebody else.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(() => cleanup());

const originalFetch = globalThis.fetch;
afterAll(async () => {
  globalThis.fetch = originalFetch;
  await settleReactWork();
  await GlobalRegistrator.unregister();
});

const VOCABULARY = "/api/v2/organizations/default/what-if/vocabulary";
const CHECK = "/api/v2/organizations/default/what-if/check";

const FIELD_SALES = { id: "team_7f3a9c", name: "Field Sales" };
const vocabulary = { ...answers.vocabulary, teams: [FIELD_SALES] };

type Served = { path: string; body: unknown };

function serve(routes: Record<string, unknown>) {
  const asked: Served[] = [];
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://127.0.0.1");
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      asked.push({ path: url.pathname, body });
      if (url.pathname in routes) return Response.json(routes[url.pathname]);
      return Response.json({ error: "not served" }, { status: 404 });
    },
    { preconnect: originalFetch.preconnect },
  );
  return asked;
}

/** The page at its own route, starting from an action handed over in the address. */
function renderWhatIf(action: Record<string, string>) {
  const root = createRootRoute({ component: Outlet });
  const authed = createRoute({
    id: "/_authed",
    getParentRoute: () => root,
    component: Outlet,
  });
  const admin = createRoute({
    path: "/admin",
    getParentRoute: () => authed,
    component: Outlet,
  });
  const page = (
    WhatIfRoute as unknown as { update: (options: unknown) => never }
  ).update({
    id: "/what-if",
    path: "/what-if",
    getParentRoute: () => admin,
  });
  const pages = [
    "plugins",
    "permissions",
    "computers",
    "boundaries",
    "approvals",
  ].map((name) =>
    createRoute({
      getParentRoute: () => admin,
      path: `/${name}`,
      component: () => null,
    }),
  );
  // The address carries the action as a string, the way "Try a change" on an Audit row writes it.
  const search = encodeURIComponent(JSON.stringify(JSON.stringify(action)));
  const router = createRouter({
    routeTree: root.addChildren([
      authed.addChildren([admin.addChildren([page, ...pages])]),
    ]),
    history: createMemoryHistory({
      initialEntries: [`/admin/what-if?action=${search}`],
    }),
  });
  return render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: {
            queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
          },
        })
      }
    >
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

const runsAs = (view: { container: HTMLElement }) =>
  view.container.querySelector('[data-what-if-chip="person"]') as HTMLElement;

test("choosing a team asks about anyone in it: the chip shows its name and Check sends team:<id>", async () => {
  const asked = serve({ [VOCABULARY]: vocabulary, [CHECK]: answers.checked });
  const view = renderWhatIf(answers.checked.action);
  const user = userEvent.setup({ document });

  await waitFor(() => expect(runsAs(view).textContent).toBe("Runs as:Sam Lee"));
  await user.click(within(runsAs(view)).getByRole("button"));
  // Teams are offered under their own heading, by name.
  await view.findByText("Anyone in a team");
  await user.click(
    await view.findByRole("menuitemradio", { name: "Field Sales" }),
  );

  await waitFor(() =>
    expect(runsAs(view).textContent).toBe("Runs as:Anyone in Field Sales"),
  );
  expect(view.container.textContent).not.toContain(FIELD_SALES.id);

  await user.click(view.getByRole("button", { name: "Check" }));
  await view.findByText("What happens");
  expect(asked.find((call) => call.path === CHECK)?.body).toEqual({
    action: {
      ...answers.checked.action,
      person: "",
      group: `team:${FIELD_SALES.id}`,
    },
  });
});

test("an action that names a directory group is still shown and checked", async () => {
  const asked = serve({ [VOCABULARY]: vocabulary, [CHECK]: answers.checked });
  const action = {
    ...answers.checked.action,
    person: "",
    group: "whatif-contractors",
  };
  const view = renderWhatIf(action);
  const user = userEvent.setup({ document });

  await waitFor(() =>
    expect(runsAs(view).textContent).toBe(
      "Runs as:Anyone in whatif-contractors",
    ),
  );
  // Directory groups keep a heading of their own, apart from teams.
  await user.click(within(runsAs(view)).getByRole("button"));
  await view.findByText("Anyone in a directory group");
  await user.keyboard("{Escape}");

  const check = view.getByRole("button", { name: "Check" });
  await waitFor(() =>
    expect((check as HTMLButtonElement).disabled).toBe(false),
  );
  await user.click(check);
  await view.findByText("What happens");
  expect(asked.find((call) => call.path === CHECK)?.body).toEqual({ action });
});

test("an action that names a team that is gone says so and asks whose account it runs on", async () => {
  serve({ [VOCABULARY]: vocabulary, [CHECK]: answers.checked });
  const view = renderWhatIf({
    ...answers.checked.action,
    person: "",
    group: "team:team_deleted",
  });

  await waitFor(() =>
    expect(runsAs(view).textContent).toBe(
      "Runs as:Anyone in a team that no longer exists",
    ),
  );
  await view.findByText("Choose whose account it runs on.");
  expect(
    (view.getByRole("button", { name: "Check" }) as HTMLButtonElement).disabled,
  ).toBe(true);
  expect(view.container.textContent).not.toContain("team_deleted");
});
