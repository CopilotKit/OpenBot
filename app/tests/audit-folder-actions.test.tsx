import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render } from "@testing-library/react";
import {
  AuditPage,
  withoutOpenBotWorking,
} from "@/components/manage/audit-page";
import { agentKeys } from "@/lib/agents/queries";
import { deploymentKeys } from "@/lib/deployment/queries";
import { seedAuditPage } from "./seed-audit-page";
import { settleReactWork } from "./settle-react-work";

/*
 * Seen on Windows with folder access on: every folder call a Bot made showed in Settings > Activity
 * as "Change a setting / Configuration changed". They are a computer's actions now
 * (`server/src/host-access/tools.ts`), and read as one: what was done, to which file or with which
 * command, and what came of it, a person's Deny as Blocked.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(() => cleanup());
afterAll(async () => {
  await settleReactWork();
  await GlobalRegistrator.unregister();
});

const BOT = "personal-assistant";

function row(
  id: string,
  minute: number,
  eventType: string,
  payload: Record<string, unknown>,
) {
  return {
    id,
    actorUserId: "dev-local-user",
    initiatorKind: "person",
    initiatorId: null,
    eventType,
    targetType: "host_access",
    targetId: "grant-notes",
    payload: {
      bot: BOT,
      actor: "dev-local-user",
      grant: "grant-notes",
      ...payload,
    },
    createdAt: `2026-11-07T17:${String(minute).padStart(2, "0")}:00Z`,
  };
}

/** Newest first, as the server answers. */
const ROWS = [
  row("none", 59, "computer.action_refused", {
    action: "host/list_folders",
    reason: "No host folders are granted to this Bot.",
  }),
  row("command", 58, "computer.action_allowed", {
    action: "host/run_command",
    command: "dir",
    attempt: "a3",
  }),
  // The person pressed Deny on the desktop: the row written as it went there, and the refusal.
  row("denied", 57, "computer.action_refused", {
    action: "host/write_file",
    file: "todo.txt",
    attempt: "a2",
    refusal: "person_declined",
    reason: "The local owner denied this operation.",
  }),
  row("asked", 57, "computer.action_allowed", {
    action: "host/write_file",
    file: "todo.txt",
    attempt: "a2",
  }),
  row("read", 56, "computer.action_allowed", {
    action: "host/read_file",
    file: "todo.txt",
    attempt: "a1",
  }),
  // As they were recorded before: a setting changed, the operation and how it went in the payload.
  row("old-refused", 50, "configuration.changed", {
    change: "host_access_tool_call",
    operation: "write_file",
    outcome: "refused",
    reason: "The local owner denied this operation.",
  }),
  row("old-requested", 50, "configuration.changed", {
    change: "host_access_tool_call",
    operation: "write_file",
    outcome: "requested",
  }),
  row("old-read", 49, "configuration.changed", {
    change: "host_access_tool_call",
    operation: "read_file",
    outcome: "succeeded",
  }),
];

async function renderActivity() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
    },
  });
  queryClient.setQueryData(deploymentKeys.capabilities(), {
    generativeUi: true,
    selfHostBanner: false,
    localEvaluation: true,
    edition: "personal",
  });
  seedAuditPage(queryClient, withoutOpenBotWorking(""), {
    events: ROWS,
  });
  queryClient.setQueryData(agentKeys.list(false), [
    { id: BOT, name: "Personal Assistant" },
  ]);
  queryClient.setQueryData(agentKeys.list(true), []);
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

const lines = (cell: Element | null) =>
  [...(cell?.children ?? [])].map((line) => line.textContent);

test("a Bot's folder actions read as what it did, on which file, and what came of it", async () => {
  const view = await renderActivity();
  const drawn = [...view.container.querySelectorAll("tbody tr")].map((tr) => ({
    what: lines(tr.querySelector("[data-column=what]")),
    who: lines(tr.querySelector("[data-column=bot]")),
    decision: lines(tr.querySelector("[data-column=decision]")),
    outcome: tr.getAttribute("data-outcome"),
  }));
  const bot = ["Personal Assistant", "Started by a person"];
  expect(drawn).toEqual([
    {
      what: ["Check your folders"],
      who: bot,
      decision: ["Blocked", "No host folders are granted to this Bot."],
      outcome: "refused",
    },
    {
      what: ["Run a command", "dir"],
      who: bot,
      decision: ["Allowed"],
      outcome: "allowed",
    },
    // One row for the denied write, not "Allowed" beside "Blocked".
    {
      what: ["Save a file", "todo.txt"],
      who: bot,
      decision: ["Blocked", "A person denied it when asked."],
      outcome: "refused",
    },
    {
      what: ["Read a file", "todo.txt"],
      who: bot,
      decision: ["Allowed"],
      outcome: "allowed",
    },
    // Older rows read in the same words, though they cannot say which file.
    {
      what: ["Save a file"],
      who: bot,
      decision: ["Blocked"],
      outcome: "refused",
    },
    {
      what: ["Save a file"],
      who: bot,
      decision: ["Asked for"],
      outcome: "allowed",
    },
    {
      what: ["Read a file"],
      who: bot,
      decision: ["Allowed"],
      outcome: "allowed",
    },
  ]);
  expect(view.container.textContent).not.toContain("Change a setting");
});
