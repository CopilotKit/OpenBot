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
import { afterAll, afterEach, expect, test } from "bun:test";
import type { ReactNode } from "react";

/**
 * The Boundaries screen, and the one thing an administrator must not be able to conclude from it.
 *
 * Two kinds of rule are enforced by one engine and stored in two places, and the storage is the
 * security property rather than an implementation detail. The deny list an administrator edits is
 * an array this screen POSTs: `policyStore.set` replaces it wholesale with no version column, so a
 * generated clause rendered inside that list would be erased by the next ordinary save — silently,
 * and by somebody who was editing something else. Clauses an import applied therefore live in
 * `template_boundaries` and appear in their own read-only group.
 *
 * What is pinned here is that the group cannot be mistaken for the editable one: no control on any
 * row, a sentence saying why in prose rather than by a disabled button, and the clauses themselves
 * shown verbatim so an administrator can match one against the template it came from.
 *
 * NO MODULE MOCKS. `mock.module` in bun is process-wide and does not come back, so mocking
 * `@/lib/client` or the router here would change what every other file in the suite imports. The
 * transport is stubbed at `fetch` and restored afterwards, and the router is a real one over a
 * memory history.
 */
/*
 * Registered with an address, and only if nothing else has registered already.
 *
 * `register()` throws outright when a DOM is installed and bun walks every test file into one
 * process, so an unguarded call takes down whichever browser-side file happens to load second. The
 * address matters separately: Happy DOM defaults to `about:blank`, whose origin is the STRING
 * "null", and Better Auth throws `Invalid base URL: null` while it is being imported under one.
 */
if (!GlobalRegistrator.isRegistered) {
  GlobalRegistrator.register({ url: "http://localhost:3010" });
}
/*
 * A DOM before Testing Library. `screen` binds its queries to `document.body` at import time, so a
 * static import would be hoisted above the registration and bind to nothing.
 */
const { cleanup, render, screen, waitFor } = await import(
  "@testing-library/react"
);

/** The shipped policy: the state in which the deny list an administrator owns is empty. */
const POLICY = { mode: "enforce", deny: [], allow: ["true"] };

const SHELL_CLAUSE = 'bot.id == "agent-renewal" && (intent == "run_command")';
const HOST_CLAUSE =
  'bot.id == "agent-renewal" && (intent == "navigate" && !(page.host == "billing.acme.example"))';
const OTHER_CLAUSE = 'bot.id == "agent-research" && (intent == "write_file")';

/**
 * Two Bots, deliberately out of alphabetical order and interleaved.
 *
 * The screen groups these itself, so an order the server did not sort is the input that catches a
 * grouping that only works when the rows arrive already gathered.
 */
const APPLIED = [
  {
    importId: "import-1",
    agentId: "agent-renewal",
    agentName: "Renewal Desk",
    expression: SHELL_CLAUSE,
    sourceKey: "shell",
    appliedAt: "2026-08-30T10:00:00.000Z",
  },
  {
    importId: "import-2",
    agentId: "agent-research",
    agentName: "Research Desk",
    expression: OTHER_CLAUSE,
    sourceKey: "files",
    appliedAt: "2026-08-29T10:00:00.000Z",
  },
  {
    importId: "import-1",
    agentId: "agent-renewal",
    agentName: "Renewal Desk",
    expression: HOST_CLAUSE,
    sourceKey: "navigate_hosts",
    appliedAt: "2026-08-30T10:00:00.000Z",
  },
];

/*
 * Testing Library's automatic cleanup hooks into a global `afterEach` that bun does not provide, so
 * without this every test renders a second Boundaries screen into the same document and every query
 * finds each string twice. The failure looks like a duplicate-render bug in the page, which it is
 * not.
 */
let servedClauses: unknown[] = APPLIED;
let clausesStatus = 200;
afterEach(() => {
  cleanup();
  servedClauses = APPLIED;
  clausesStatus = 200;
});

const realFetch = globalThis.fetch;
afterAll(() => {
  globalThis.fetch = realFetch;
});
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const path = typeof input === "string" ? input : String(input);
  if (path === "/api/computers/policy")
    return Response.json({ policy: POLICY });
  if (path === "/api/templates/boundaries") {
    if (clausesStatus !== 200) {
      return Response.json(
        { error: "The clauses applied by imports could not be read." },
        { status: clausesStatus },
      );
    }
    return Response.json({ boundaries: servedClauses });
  }
  return Response.json({ error: "not found" }, { status: 404 });
}) as typeof fetch;

const { Route } = await import("@/routes/_authed/admin/boundaries");
const BoundariesPage = Route.options.component;
if (!BoundariesPage) {
  throw new Error("The boundaries route has no component to render.");
}

/** A real router over a memory history, so every `Link` on the page resolves without a mock. */
function routed(node: ReactNode) {
  const rootRoute = createRootRoute({ component: Outlet });
  const routeTree = rootRoute.addChildren([
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/",
      component: () => node,
    }),
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/admin/audit",
      component: () => null,
    }),
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/agents",
      component: () => null,
    }),
  ]);
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  // The app's router is registered globally for typing; this one is a different instance and only
  // has to resolve the handful of paths this screen links to.
  return <RouterProvider router={router as never} />;
}

async function renderBoundaries() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    routed(
      <QueryClientProvider client={client}>
        <BoundariesPage />
      </QueryClientProvider>,
    ),
  );
  await waitFor(() =>
    expect(screen.getByText("Applied by an import")).toBeDefined(),
  );
}

test("the clauses an import applied are listed under the Bot they are about", async () => {
  await renderBoundaries();
  await screen.findByText("Renewal Desk");

  const body = document.body.textContent ?? "";
  expect(body).toContain(SHELL_CLAUSE);
  expect(body).toContain(HOST_CLAUSE);
  expect(body).toContain(OTHER_CLAUSE);
  expect(body).toContain("Research Desk");

  // The line of the file each clause came from, so it can be matched against the template.
  expect(body).toContain("navigate_hosts");
});

/**
 * Interleaved input, gathered. Two rows for one Bot arriving either side of another Bot's row is
 * what a grouping that merely de-duplicates adjacent rows gets wrong, and it is the shape the
 * store's ordering makes likely.
 */
test("a Bot with two clauses gets one group, not two", async () => {
  await renderBoundaries();
  await screen.findByText("Renewal Desk");

  expect(screen.getAllByText("Renewal Desk").length).toBe(1);
  expect(screen.getAllByText("Research Desk").length).toBe(1);
});

/** Each group names its import by linking to the coworker the import created. */
test("each group is linked to the coworker its import created", async () => {
  await renderBoundaries();
  const link = await screen.findByText("Renewal Desk");

  expect(link.closest("a")?.getAttribute("href")).toContain(
    "agent=agent-renewal",
  );
});

/**
 * The property this group exists for: it must be impossible to reach for a control on one of these
 * rows and impossible to conclude the absence of one is a bug.
 *
 * Counted rather than queried by name, because the failure worth catching is a Remove button
 * arriving with any label at all. The editable list on this screen has one per rule, so the count
 * before and after the group renders is the assertion — an empty deny list means every button on
 * the page belongs to something other than a rule.
 */
test("no clause an import applied offers a way to edit or remove it", async () => {
  await renderBoundaries();
  await screen.findByText("Renewal Desk");

  expect(screen.queryAllByText("Remove").length).toBe(0);

  const group = screen.getByText("Applied by an import").closest("section");
  expect(group).not.toBeNull();
  // Asserted first, so that a renamed heading cannot turn the two counts below into a vacuous pass
  // against an element holding nothing.
  expect(group?.textContent).toContain(SHELL_CLAUSE);
  expect(group?.querySelectorAll("button").length).toBe(0);
  expect(group?.querySelectorAll("input").length).toBe(0);
  expect(group?.querySelectorAll("textarea").length).toBe(0);
});

/** And the screen says so in words, rather than leaving the absence to be interpreted. */
test("the screen says in a sentence why these cannot be edited here", async () => {
  await renderBoundaries();

  const body = document.body.textContent ?? "";
  expect(body).toContain("They are not in the list you edit");
  expect(body).toContain(
    "nothing you do here adds, changes or removes any of these",
  );
});

test("a deployment nothing has been imported into says so plainly", async () => {
  servedClauses = [];
  await renderBoundaries();

  await screen.findByText("No import has applied a ceiling here.");
});

/**
 * A read that failed says it failed. The alternative — falling through to the empty sentence — tells
 * an administrator that no ceiling is applied anywhere, which on this screen is the one wrong
 * answer: it is the sentence somebody would act on by loosening something else.
 */
test("a failed read is not rendered as an absence of clauses", async () => {
  clausesStatus = 500;
  await renderBoundaries();

  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain(
    "The clauses applied by imports could not be read.",
  );
  expect(document.body.textContent ?? "").not.toContain(
    "No import has applied a ceiling here.",
  );
});
