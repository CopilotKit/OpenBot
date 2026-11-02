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
import {
  type AuditEvent,
  botText,
  subjectText,
} from "@/components/audit/audit-cells";
import { agentKeys } from "@/lib/agents/queries";
import { auditKeys } from "@/lib/audit/queries";
import { Route as AuditRoute } from "@/routes/_authed/admin/audit";

/**
 * Admin → Audit as a log viewer: one window tall, the table across the whole pane and the only thing
 * that scrolls, searchable and sortable by time, each row coloured by what
 * happened.
 */
beforeAll(() => GlobalRegistrator.register());
afterEach(() => cleanup());
// The filter test leaves a menu open; let React finish closing it before `window` goes away.
afterAll(async () => {
  await new Promise((resolve) => setTimeout(resolve, 50));
  await GlobalRegistrator.unregister();
});

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

test("the page is one viewport tall and only the table scrolls", async () => {
  const view = await renderAudit();
  const heading = view.getByRole("heading", { name: "Audit" });
  const page = heading.closest(".h-dvh");
  expect(page).not.toBeNull();
  expect(page?.className).toContain("overflow-hidden");
  expect(heading.closest(".max-w-3xl")).toBeNull();
  const scroller = view.container.querySelector(
    "[data-slot=table-container]",
  ) as HTMLElement;
  expect(scroller.className).toContain("overflow-auto");
  expect(scroller.className).toContain("flex-1");
  expect(scroller.contains(heading)).toBe(false);
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

test("a row about a Bot names it under Bot, not under On", () => {
  const routed = {
    ...event("e4", "channel.routed", "2026-10-27T11:00:00Z"),
    targetType: "agent",
    targetId: "general-assistant",
    payload: {
      chosen: "general-assistant",
      reason: "named by the person asking",
    },
  } as unknown as AuditEvent;
  const nameFor = (id: string) =>
    id === "general-assistant" ? "General Assistant" : id;
  expect(botText(routed, nameFor)).toBe("General Assistant");
  expect(subjectText(routed)).toBe("");
});

test("the Outcome button narrows the rows to the outcomes ticked", async () => {
  const view = await renderAudit();
  const user = userEvent.setup({ document });
  await user.click(view.getByRole("button", { name: /Outcome/ }));
  await user.click(
    await view.findByRole("menuitemcheckbox", { name: /Blocked/ }),
  );
  await waitFor(() => expect(whats(view.container)).toEqual(["navigate"]));
  expect(view.getByText("1 of 3 events")).toBeTruthy();
});
