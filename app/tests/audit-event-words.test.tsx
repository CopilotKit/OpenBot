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
import { deploymentKeys } from "@/lib/deployment/queries";
import { settleReactWork } from "./settle-react-work";

/*
 * The What column reads as words. Seen on Windows: Settings > Activity listed "mcp.tools_discovered",
 * "write_file" and "read_file", the names the trail stores them under. The export keeps those names,
 * the search box still finds a row by them, and Admin shows one on hover.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(() => cleanup());
afterAll(async () => {
  await settleReactWork();
  await GlobalRegistrator.unregister();
});

function row(
  id: string,
  minute: number,
  eventType: string,
  targetType: string,
  payload: Record<string, unknown>,
  targetId: string | null = "personal-assistant",
) {
  return {
    id,
    actorUserId: "dev",
    initiatorKind: "person",
    initiatorId: null,
    eventType,
    targetType,
    targetId,
    payload: { bot: "personal-assistant", ...payload },
    createdAt: `2026-11-07T11:${String(minute).padStart(2, "0")}:00Z`,
  };
}

/** Newest first, as the table draws them. */
const ROWS = [
  row("e1", 59, "mcp.tools_discovered", "agent", {
    offered: 85,
    granted: 85,
    reason: "unavailable",
  }),
  row("e2", 58, "computer.action_failed", "computer", {
    action: "computer_read_file",
    file: "missing-file-9481.txt",
    failure: "There is no file at missing-file-9481.txt.",
  }),
  row("e3", 57, "computer.action_allowed", "computer", {
    action: "computer_write_file",
    file: "allow-test.txt",
  }),
  row("e4", 56, "approval.person_decided", "approval", {
    decision: "allow_once",
    tool: "computer_write_file",
    file: "allow-test.txt",
  }),
  row("e5", 55, "mcp.call_succeeded", "mcp_tool", {}, "parallel/web_search"),
  row("e6", 54, "channel.routed", "agent", { viaMention: true }),
  row("e7", 53, "computer.policy_loaded", "computer", {}),
];

const WORDS = [
  "Choose tools for a run",
  "Read a file",
  "Save a file",
  "Save a file",
  "Search the web",
  "Choose a Bot for a message",
  "Start the computer",
];

const STORED = [
  "mcp.tools_discovered",
  "computer_read_file",
  "computer_write_file",
  "computer_write_file",
  "parallel/web_search",
  "channel.routed",
  "computer.policy_loaded",
];

async function renderAs(edition: "team" | "personal") {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
    },
  });
  queryClient.setQueryData(deploymentKeys.capabilities(), {
    generativeUi: true,
    selfHostBanner: false,
    localEvaluation: edition === "personal",
    edition,
  });
  queryClient.setQueryData([...auditKeys.all, ""], { events: ROWS });
  queryClient.setQueryData(agentKeys.list(false), [
    { id: "personal-assistant", name: "Personal Assistant" },
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

const whats = (container: HTMLElement) =>
  [...container.querySelectorAll("tbody tr")].map(
    (tr) => tr.querySelector("[data-column=what] > div") as HTMLElement,
  );

test("each row says in words what it was about, and no stored name shows in Activity", async () => {
  const view = await renderAs("personal");
  const lines = whats(view.container);
  expect(lines.map((line) => line.textContent)).toEqual(WORDS);
  expect(lines.map((line) => line.getAttribute("title"))).toEqual(
    STORED.map(() => null),
  );
  const table = view.container.querySelector("tbody")?.textContent ?? "";
  for (const stored of ["mcp.tools_discovered", "write_file", "read_file"])
    expect(table).not.toContain(stored);
});

test("Admin shows the stored name on hover, for matching a row against the export", async () => {
  const view = await renderAs("team");
  const lines = whats(view.container);
  expect(lines.map((line) => line.textContent)).toEqual(WORDS);
  expect(lines.map((line) => line.getAttribute("title"))).toEqual(STORED);
});

test("the search box still finds a row by its stored name", async () => {
  const view = await renderAs("personal");
  await userEvent
    .setup({ document })
    .type(
      view.getByRole("searchbox", { name: "Search events" }),
      "tools_discovered",
    );
  await waitFor(() =>
    expect(whats(view.container).map((line) => line.textContent)).toEqual([
      "Choose tools for a run",
    ]),
  );
});
