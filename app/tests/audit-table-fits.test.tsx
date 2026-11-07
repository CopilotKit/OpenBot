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
import { AuditPage } from "@/components/manage/audit-page";
import { agentKeys } from "@/lib/agents/queries";
import { auditKeys } from "@/lib/audit/queries";

/**
 * The Audit page in the Desktop's default window, about 1000px wide with Settings' own column
 * beside it: the table had seven columns side by side, Started by and Decision sat past the right
 * edge, and a reader scrolled sideways to see whether an action was allowed.
 *
 * The table now has five: what was done with what it was done to beneath it, the Bot with what
 * started it beneath it, and Decision, whose reason lines are capped rather than fixed at 22rem.
 * happy-dom lays nothing out, so this pins the shape that makes it fit; the width itself was
 * measured in the real app (scroll width equal to client width at 1000px and 1440px).
 */
beforeAll(() => GlobalRegistrator.register());
afterEach(() => cleanup());
afterAll(async () => {
  await new Promise((resolve) => setTimeout(resolve, 50));
  await GlobalRegistrator.unregister();
});

const ROWS = [
  {
    id: "e1",
    actorUserId: "person",
    initiatorKind: "person",
    initiatorId: null,
    eventType: "computer.action_refused",
    targetType: "computer",
    targetId: "bot-a",
    payload: {
      bot: "bot-a",
      action: "computer_write_file",
      file: "reports/refused.txt",
    },
    createdAt: "2026-11-06T09:00:00Z",
  },
  {
    id: "e3",
    actorUserId: "person",
    initiatorKind: "person",
    initiatorId: null,
    eventType: "mcp.call_rejected",
    targetType: "mcp_tool",
    targetId: "notes/create_note",
    payload: {
      bot: "bot-a",
      reason:
        "A refusal's reason can be a whole sentence, long enough to push a fixed column past the window: https://example.test/a/very/long/address/with/no/spaces/in/it",
    },
    createdAt: "2026-11-06T07:00:00Z",
  },
  {
    id: "e2",
    actorUserId: null,
    initiatorKind: "routine",
    initiatorId: "routine-1",
    eventType: "computer.action_allowed",
    targetType: "computer",
    targetId: "bot-a",
    payload: { bot: "bot-a", action: "computer_read_file", file: "notes.md" },
    createdAt: "2026-11-06T08:00:00Z",
  },
];

async function renderAudit() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
    },
  });
  queryClient.setQueryData([...auditKeys.all, ""], { events: ROWS });
  queryClient.setQueryData(agentKeys.list(false), [
    { id: "bot-a", name: "Claude Agent SDK" },
  ]);
  const router = createRouter({
    routeTree: createRootRoute({ component: () => <AuditPage /> }),
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

test("five columns, not seven: what it acted on sits under the action, and who started it under the Bot", async () => {
  const view = await renderAudit();
  const headers = [...view.container.querySelectorAll("thead th")].map(
    (th) => th.textContent,
  );
  expect(headers).toEqual([
    "Outcome",
    "When, newest first",
    "What",
    "Bot",
    "Decision",
  ]);

  const [refused, routine] = [...view.container.querySelectorAll("tbody tr")];
  const cell = (row: Element | undefined, column: string) =>
    [...(row?.querySelectorAll(`[data-column=${column}] > div`) ?? [])].map(
      (line) => line.textContent,
    );
  expect(cell(refused, "what")).toEqual(["write_file", "reports/refused.txt"]);
  expect(cell(refused, "bot")).toEqual([
    "Claude Agent SDK",
    "Started by a person",
  ]);
  expect(cell(routine, "bot")).toEqual([
    "Claude Agent SDK",
    "Started by a routine",
  ]);
});

test("a long reason wraps inside Decision instead of setting its width", async () => {
  const view = await renderAudit();
  const reason = view.getByText(/A refusal's reason/);
  const classes = [...reason.classList];
  expect(classes).not.toContain("w-[22rem]");
  expect(classes).toContain("max-w-[22rem]");
  expect(classes).toContain("[overflow-wrap:anywhere]");
  // Nothing in the What or Bot columns refuses to wrap.
  const cells = view.container.querySelectorAll(
    "[data-column=what], [data-column=bot]",
  );
  expect(cells.length).toBeGreaterThan(0);
  for (const td of cells)
    expect([...td.classList]).not.toContain("whitespace-nowrap");
});

test("the Started by filter still narrows the rows, though it is no longer a column", async () => {
  const view = await renderAudit();
  const user = userEvent.setup({ document });
  await user.click(view.getByRole("button", { name: /Started by/ }));
  await user.click(
    await view.findByRole("menuitemcheckbox", { name: /A routine/ }),
  );
  await waitFor(() =>
    expect(view.container.querySelectorAll("tbody tr")).toHaveLength(1),
  );
  expect(view.getByText("notes.md")).toBeTruthy();
});
