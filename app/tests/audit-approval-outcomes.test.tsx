import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { DECLINED_BY_PERSON } from "@openbot/shared/approval-outcomes";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render } from "@testing-library/react";
import { AuditPage } from "@/components/manage/audit-page";
import { agentKeys } from "@/lib/agents/queries";
import {
  COMPUTER_ACTION_EVENT_TYPES,
  eventTypeFilter,
  REFUSED_EVENT_TYPES,
} from "@/lib/audit/outcome";
import { seedAuditPage } from "./seed-audit-page";

/**
 * Settings › Activity after a Bot was asked to write two files with "Ask before making changes" on,
 * the person denied one and allowed the other, and a read of a missing file failed. The rows are
 * shaped as the server writes them (server/tests/audit-approval-outcomes.integration.test.ts).
 *
 * The page used to draw the denied write and the person's denial both as "Allowed", and the failed
 * read twice, once as "Allowed".
 */
beforeAll(() => GlobalRegistrator.register());
afterEach(() => cleanup());
afterAll(async () => {
  await new Promise((resolve) => setTimeout(resolve, 50));
  await GlobalRegistrator.unregister();
});

const BOT = "bot-claude";
const policy = {
  allowed: true,
  mode: "enforce",
  source: "allow",
  rule: "true",
  carriedOut: true,
};
const asked = {
  behaviour: "ask",
  source: "default",
  reason: "You asked to review changes before they happen.",
};

let clock = 0;
function row(
  eventType: string,
  targetType: string,
  payload: Record<string, unknown>,
) {
  clock += 1;
  return {
    id: `e${clock}`,
    actorUserId: "person",
    initiatorKind: "person",
    initiatorId: null,
    eventType,
    targetType,
    targetId: targetType === "approval" ? `approval-${clock}` : BOT,
    payload: { bot: BOT, ...payload },
    createdAt: new Date(Date.UTC(2026, 10, 6, 9, 0, clock)).toISOString(),
  };
}

const file = (path: string) => ({
  action: path.startsWith("missing")
    ? "computer_read_file"
    : "computer_write_file",
  file: path,
  page: "about:blank",
  ref: null,
});

const ROWS = [
  // Denied.
  row("approval.evaluated", "approval", {
    decidedBy: "policy",
    tool: "computer_write_file",
    effect: "write",
    scope: "workspace",
    file: "refused.txt",
    outcome: asked,
  }),
  row("approval.person_decided", "approval", {
    decidedBy: "person",
    decision: "deny",
    tool: "computer_write_file",
    scope: "workspace",
    file: "refused.txt",
  }),
  row("computer.action_refused", "computer", {
    ...file("refused.txt"),
    refusal: "person_declined",
    reason: DECLINED_BY_PERSON,
    decision: { ...policy, carriedOut: false },
  }),
  // Allowed.
  row("approval.evaluated", "approval", {
    decidedBy: "policy",
    tool: "computer_write_file",
    effect: "write",
    scope: "workspace",
    file: "allowed.txt",
    outcome: asked,
  }),
  row("approval.person_decided", "approval", {
    decidedBy: "person",
    decision: "allow_once",
    tool: "computer_write_file",
    scope: "workspace",
    file: "allowed.txt",
  }),
  row("computer.action_allowed", "computer", {
    ...file("allowed.txt"),
    attempt: "attempt-allowed",
    decision: policy,
  }),
  // Failed.
  row("computer.action_allowed", "computer", {
    ...file("missing-report.txt"),
    attempt: "attempt-missing",
    decision: policy,
  }),
  row("computer.action_failed", "computer", {
    ...file("missing-report.txt"),
    attempt: "attempt-missing",
    failure: "missing-report.txt does not exist in the workspace.",
    decision: policy,
  }),
];

async function renderActivity() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
    },
  });
  seedAuditPage(queryClient, "", { events: ROWS });
  queryClient.setQueryData(agentKeys.list(false), []);
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

/**
 * Each drawn row as what, on, decision, and the outcome it is coloured by. Newest first. The What
 * cell holds the action on its first line and what it acted on in the lines beneath.
 */
function drawn(container: HTMLElement) {
  return [...container.querySelectorAll("tbody tr")].map((tr) => {
    const cell = (column: string) =>
      tr.querySelector(`[data-column=${column}]`)?.textContent ?? "";
    const [what = "", ...on] = [
      ...tr.querySelectorAll("[data-column=what] > div"),
    ].map((line) => line.textContent ?? "");
    return {
      what,
      on: on.join(""),
      decision: cell("decision"),
      outcome: tr.getAttribute("data-outcome"),
    };
  });
}

test("a denied write reads as refused, and the person's answer as a denial", async () => {
  const rows = drawn((await renderActivity()).container).filter((entry) =>
    entry.on.startsWith("refused.txt"),
  );
  expect(rows).toEqual([
    {
      what: "Save a file",
      on: "refused.txt",
      decision: "BlockedA person denied it when asked.",
      outcome: "refused",
    },
    {
      what: "Save a file",
      on: "refused.txt",
      decision: "Denied by a person",
      outcome: "refused",
    },
    {
      what: "Save a file",
      on: "refused.txt",
      decision:
        "Asked a person firstYou asked to review changes before they happen.",
      outcome: "allowed",
    },
  ]);
});

test("an allowed write reads as allowed once, after the person allowed it", async () => {
  const rows = drawn((await renderActivity()).container).filter((entry) =>
    entry.on.startsWith("allowed.txt"),
  );
  expect(rows.map((entry) => entry.decision)).toEqual([
    "Allowed",
    "Allowed once by a person",
    "Asked a person firstYou asked to review changes before they happen.",
  ]);
});

test("a read that failed is one row that says it did not happen", async () => {
  const rows = drawn((await renderActivity()).container).filter((entry) =>
    entry.on.startsWith("missing-report.txt"),
  );
  expect(rows).toEqual([
    {
      what: "Read a file",
      on: "missing-report.txt",
      decision:
        "Did not happenmissing-report.txt does not exist in the workspace.",
      outcome: "did-not-happen",
    },
  ]);
});

test("the Blocked view asks for the denied write, and Computer actions for every outcome", () => {
  expect(eventTypeFilter(REFUSED_EVENT_TYPES)).toContain(
    "computer.action_refused",
  );
  expect(eventTypeFilter(COMPUTER_ACTION_EVENT_TYPES)).toBe(
    "?eventType=computer.action_allowed,computer.action_refused,computer.action_failed,computer.action_stopped",
  );
});
