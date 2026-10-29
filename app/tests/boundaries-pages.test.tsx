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
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { RULE_TEMPLATES } from "@/lib/boundaries/rules";
import type { ActionPolicy } from "@/lib/computers/queries";
import { Route as BoundariesRoute } from "@/routes/_authed/admin/boundaries";
import { Route as RuleRoute } from "@/routes/_authed/admin/boundaries_.$index";
import { Route as NewRuleRoute } from "@/routes/_authed/admin/boundaries_.new";

/**
 * The Boundaries screens: the list reads rules by name, adding one saves its name beside it, and
 * removing one takes its name with it. The server is a fake that stores what it is sent.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(async () => {
  await new Promise((resolve) => setTimeout(resolve, 50));
  await GlobalRegistrator.unregister();
});

type Routed = { options: object };
const routes = [
  BoundariesRoute,
  NewRuleRoute,
  RuleRoute,
] as unknown as Routed[];
const pristine = routes.map((route) => ({
  ...route,
  options: { ...route.options },
}));
beforeEach(() => {
  routes.forEach((route, index) => {
    for (const key of Object.keys(route))
      if (!(key in pristine[index]!))
        delete (route as Record<string, unknown>)[key];
    Object.assign(route, pristine[index], {
      options: { ...pristine[index]!.options },
    });
  });
});

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

const custom = 'tool.name == "computer_run" && contains(command, "rm")';
const template = RULE_TEMPLATES[1]!;

let stored: ActionPolicy;
const saved: ActionPolicy[] = [];
function serving(policy: ActionPolicy) {
  stored = policy;
  saved.length = 0;
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path.endsWith("/api/computers/policy") && init?.method === "PUT") {
      stored = JSON.parse(String(init.body)) as ActionPolicy;
      saved.push(stored);
      return Response.json({ policy: stored });
    }
    if (path.endsWith("/api/computers/policy"))
      return Response.json({ policy: stored });
    if (path.endsWith("/api/computers/policy-dry-run"))
      return Response.json({
        report: {
          scanned: 0,
          wouldRefuse: 0,
          wouldAllow: 0,
          unchanged: 0,
          changes: [],
        },
      });
    return Response.json({ error: "unexpected" }, { status: 404 });
  }) as typeof fetch;
}

function open(path: string) {
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
  const wire = (route: unknown, id: string, at: string) =>
    (route as { update: (options: unknown) => never }).update({
      id,
      path: at,
      getParentRoute: () => admin,
    });
  const audit = createRoute({
    path: "/audit",
    getParentRoute: () => admin,
    component: () => null,
  });
  const router = createRouter({
    routeTree: root.addChildren([
      authed.addChildren([
        admin.addChildren([
          wire(BoundariesRoute, "/boundaries", "/boundaries"),
          wire(NewRuleRoute, "/boundaries_/new", "/boundaries/new"),
          wire(RuleRoute, "/boundaries_/$index", "/boundaries/$index"),
          audit,
        ]),
      ]),
    ]),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  const view = render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
  return { view, router };
}

test("the list shows each rule by its name, a template's own name, or as a custom rule", async () => {
  serving({
    mode: "enforce",
    deny: ["true", template.rule, custom],
    allow: ["true"],
    labels: { true: { name: "Stop everything", description: "All of it." } },
  });
  const { view } = open("/admin/boundaries");

  expect(await view.findByText("Stop everything")).toBeTruthy();
  expect(view.getByText("All of it.")).toBeTruthy();
  expect(view.getByText(template.name)).toBeTruthy();
  expect(view.getByText("Custom rule")).toBeTruthy();
  expect(view.getByText(custom)).toBeTruthy();
});

test("adding from a template saves the rule with its name and returns to the list", async () => {
  serving({ mode: "enforce", deny: [], allow: ["true"] });
  const { view, router } = open("/admin/boundaries/new");

  fireEvent.click(await view.findByText(template.name));
  fireEvent.click(view.getByRole("button", { name: "Add rule" }));

  await waitFor(() => expect(saved).toHaveLength(1));
  expect(saved[0]).toEqual({
    mode: "enforce",
    deny: [template.rule],
    allow: ["true"],
    labels: {
      [template.rule]: {
        name: template.name,
        description: template.description,
      },
    },
  });
  await waitFor(() =>
    expect(router.state.location.pathname).toBe("/admin/boundaries"),
  );
});

test("removing a rule is confirmed, and takes its name with it", async () => {
  serving({
    mode: "enforce",
    deny: [template.rule, custom],
    allow: ["true"],
    labels: { [custom]: { name: "No rm", description: "" } },
  });
  const { view } = open("/admin/boundaries/1");

  fireEvent.click(await view.findByRole("button", { name: "Remove rule" }));
  expect(saved).toHaveLength(0);
  fireEvent.click(await view.findByRole("button", { name: "Remove" }));

  await waitFor(() => expect(saved).toHaveLength(1));
  expect(saved[0]?.deny).toEqual([template.rule]);
  expect(saved[0]?.labels).toEqual({});
});
