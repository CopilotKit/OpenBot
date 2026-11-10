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
import { AuditPage } from "@/components/manage/audit-page";
import { agentKeys } from "@/lib/agents/queries";
import { Route as WhatIfRoute } from "@/routes/_authed/admin/what-if";
import { settleReactWork } from "./settle-react-work";
import answers from "./what-if.fixture.json";

/**
 * Admin > What would happen, and Audit's "Why?".
 *
 * The page through its real data functions, with `fetch` answering as the server answered for the
 * same OpenBot (`what-if.fixture.json`, captured through the functions the routes call). A question
 * becomes chips; Check draws each control in order, with the one that decides marked and the ones a
 * real action never reaches faded. On Audit, a row a control decided carries "Why?", which explains it
 * from the row alone.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(() => cleanup());

const originalFetch = globalThis.fetch;
afterAll(async () => {
  globalThis.fetch = originalFetch;
  await settleReactWork();
  await GlobalRegistrator.unregister();
});

const QUESTION =
  "Could the Sales Bot send an email from Gmail when a routine runs it?";

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

function client() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
    },
  });
  queryClient.setQueryData(agentKeys.list(false), [
    { id: "whatif-sales", name: "Sales" },
  ]);
  queryClient.setQueryData(agentKeys.list(true), []);
  return queryClient;
}

function renderWhatIf() {
  /*
   * The page reads its search through its own route, `/_authed/admin/what-if`, so it is mounted at
   * that id, under the same layout routes the app has. Mounted at `/admin/what-if`, its
   * `Route.useSearch()` found no match and threw whenever the shard ran it after other route tests.
   */
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
  // The pages the rows link to, so a link resolves; nothing here opens them.
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
  const router = createRouter({
    routeTree: root.addChildren([
      authed.addChildren([admin.addChildren([page, ...pages])]),
    ]),
    history: createMemoryHistory({ initialEntries: ["/admin/what-if"] }),
  });
  return render(
    <QueryClientProvider client={client()}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

test("a question becomes chips, and Check shows every control in order with the one that decides", async () => {
  const asked = serve({
    "/api/admin/what-if/vocabulary": answers.vocabulary,
    "/api/admin/what-if/ask": {
      understood: "yes",
      action: answers.checked.action,
      labels: answers.checked.labels,
      missing: null,
    },
    "/api/admin/what-if/check": answers.checked,
  });
  const view = renderWhatIf();
  const user = userEvent.setup({ document });

  // Nothing set yet: the action says what to choose, and Check waits.
  await view.findByText("Choose a Bot.");
  expect(
    (view.getByRole("button", { name: "Check" }) as HTMLButtonElement).disabled,
  ).toBe(true);

  await user.type(view.getByLabelText("Ask what would happen"), QUESTION);
  await user.click(view.getByRole("button", { name: "Ask" }));

  await waitFor(() =>
    expect(
      [...view.container.querySelectorAll("[data-what-if-chip]")].map(
        (chip) => chip.textContent,
      ),
    ).toEqual([
      "Bot:Sales",
      "Runs as:Sam Lee",
      "Started by:A routine",
      "Uses:An app",
      "App:Gmail",
      "Tool:Send email",
      "Effect:Changes something",
    ]),
  );
  expect(asked.find((call) => call.path.endsWith("/ask"))?.body).toEqual({
    question: QUESTION,
  });

  await user.click(view.getByRole("button", { name: "Check" }));
  await view.findByText("What happens");
  // The confirmed action is what is checked, with the question it came from.
  expect(asked.find((call) => call.path.endsWith("/check"))?.body).toEqual({
    action: answers.checked.action,
    question: QUESTION,
  });

  const rows = [...view.container.querySelectorAll("[data-layer]")];
  expect(rows.map((row) => row.getAttribute("data-layer"))).toEqual([
    "grant",
    "app_allowlist",
    "capabilities",
    "boundaries",
    "safety",
    "approvals",
  ]);
  const boundaries = rows[3] as HTMLElement;
  expect(boundaries.getAttribute("data-decides")).toBe("true");
  expect(within(boundaries).getByText("Refuses")).toBeTruthy();
  expect(boundaries.textContent).toContain(
    "Rule: No email when nobody is watching",
  );
  // The safety floor would ask, but a refused action never reaches it.
  expect(rows[4]?.getAttribute("data-unreached")).toBe("true");
  expect(rows[4]?.textContent).toContain("Not reached");
  expect(
    view.container.querySelector("[data-what-if-headline]")?.textContent,
  ).toContain("Refused");

  // Changing a chip makes the answer stale, so it goes.
  await user.click(
    within(
      view.container.querySelector(
        '[data-what-if-chip="initiator"]',
      ) as HTMLElement,
    ).getByRole("button"),
  );
  await user.click(
    await view.findByRole("menuitemradio", { name: "A person chatting" }),
  );
  await waitFor(() =>
    expect(view.container.querySelector("[data-layer]")).toBeNull(),
  );
});

test("an Audit row a control decided carries Why?, which explains it from the row with today's settings", async () => {
  const asked = serve({
    "/api/admin/audit-events": { events: [answers.event] },
    [`/api/admin/what-if/explain/${answers.event.id}`]: answers.explained,
  });
  const router = createRouter({
    routeTree: createRootRoute({ component: () => <AuditPage ask /> }),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  const view = render(
    <QueryClientProvider client={client()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  const user = userEvent.setup({ document });

  const why = await view.findByRole("button", { name: "Why?" });
  await user.click(why);

  const dialog = await view.findByRole("dialog");
  await within(dialog).findByText("Why did this happen?");
  await waitFor(() =>
    expect(dialog.querySelector("[data-why-recorded]")?.textContent).toContain(
      'Refused by the boundary "No email when nobody is watching".',
    ),
  );
  expect(
    dialog
      .querySelector('[data-layer="boundaries"]')
      ?.getAttribute("data-decides"),
  ).toBe("true");
  // The same answer then and now, so nothing says a setting changed.
  expect(dialog.textContent).not.toContain(
    "Today's settings decide this differently",
  );
  expect(
    asked.some(
      (call) => call.path === `/api/admin/what-if/explain/${answers.event.id}`,
    ),
  ).toBe(true);
});

test("a row no control decides has no Why?", async () => {
  serve({
    "/api/admin/audit-events": {
      events: [
        {
          ...answers.event,
          id: "00000000-0000-4000-8000-0000000000aa",
          eventType: "configuration.changed",
          targetType: "mcp_tool",
          payload: { change: "plugin_granted", ref: "whatif-gmail/send_email" },
        },
      ],
    },
  });
  const router = createRouter({
    routeTree: createRootRoute({ component: () => <AuditPage ask /> }),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  const view = render(
    <QueryClientProvider client={client()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  await view.findByText("1 event");
  expect(view.queryByRole("button", { name: "Why?" })).toBeNull();
});
