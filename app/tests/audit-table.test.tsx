import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { agentKeys } from "@/lib/agents/queries";
import { auditKeys } from "@/lib/audit/queries";
import { Route as AuditRoute } from "@/routes/_authed/admin/audit";

/**
 * Admin → Audit as a log viewer: the title in the same centred column as every other screen, the
 * table across the whole pane under it, searchable and sortable by time, each row coloured by what
 * happened.
 */
beforeAll(() => GlobalRegistrator.register());
afterEach(() => cleanup());
afterAll(() => GlobalRegistrator.unregister());

function event(
  id: string,
  eventType: string,
  at: string,
  payload: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    actorUserId: null,
    initiatorKind: "person",
    initiatorId: null,
    eventType,
    targetType: "computer",
    targetId: "bot-a",
    payload: { bot: "bot-a", ...payload },
    createdAt: at,
  };
}

const ROWS = [
  event("e1", "computer.action_allowed", "2026-10-27T09:00:00Z", {
    action: "computer_click",
    element: { name: "Save deal", role: "button" },
  }),
  event("e2", "computer.action_refused", "2026-10-27T10:00:00Z", {
    action: "computer_navigate",
    element: "https://evil.test",
  }),
  event("e3", "computer.action_failed", "2026-10-27T08:00:00Z", {
    action: "computer_type",
    element: { name: "Notes", role: "textbox" },
  }),
];

async function renderAudit() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
    },
  });
  queryClient.setQueryData([...auditKeys.all, ""], { events: ROWS });
  queryClient.setQueryData(agentKeys.list(false), []);
  const router = createRouter({
    routeTree: createRootRoute({ component: AuditRoute.options.component }),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  await view.findByText("Decision");
  return view;
}

const whats = (container: HTMLElement) =>
  [...container.querySelectorAll("tbody tr")].map(
    (row) => row.querySelector("[data-column=what]")?.textContent,
  );

test("the title sits in the centred column and the table spans the pane under it", async () => {
  const view = await renderAudit();
  const heading = view.getByRole("heading", { name: "Audit" });
  const table = view.container.querySelector("table") as HTMLElement;
  const column = heading.closest(".max-w-3xl");
  expect(column).not.toBeNull();
  expect(column?.contains(table)).toBe(false);
});

test("newest first, and a press on When turns it oldest first", async () => {
  const view = await renderAudit();
  expect(whats(view.container)).toEqual(["navigate", "click", "type"]);
  await userEvent
    .setup({ document })
    .click(view.getByRole("button", { name: /When/ }));
  await waitFor(() =>
    expect(whats(view.container)).toEqual(["type", "click", "navigate"]),
  );
});

test("search narrows the rows already loaded, and says how many match", async () => {
  const view = await renderAudit();
  await userEvent
    .setup({ document })
    .type(view.getByRole("searchbox", { name: "Search events" }), "save deal");
  await waitFor(() => expect(whats(view.container)).toEqual(["click"]));
  expect(view.getByText("1 of 3 events")).toBeDefined();
});

test("each row carries what happened, for its colour", async () => {
  const view = await renderAudit();
  const outcomes = [...view.container.querySelectorAll("tbody tr")].map((row) =>
    row.getAttribute("data-outcome"),
  );
  expect(outcomes).toEqual(["refused", "allowed", "did-not-happen"]);
});
