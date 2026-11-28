import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { AUDIT_EVENT_WORDS } from "@openbot/shared/audit-words";
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
  AuditPage,
  withoutOpenBotWorking,
} from "@/components/manage/audit-page";
import { agentKeys } from "@/lib/agents/queries";
import { OPENBOT_WORKING_EVENT_TYPES } from "@/lib/audit/outcome";
import { authKeys } from "@/lib/auth/queries";
import { deploymentKeys } from "@/lib/deployment/queries";
import { seedAuditPage } from "./seed-audit-page";
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
    actorUserId: "dev" as string | null,
    initiatorKind: "person",
    initiatorId: null,
    eventType,
    targetType,
    targetId,
    payload: { bot: "personal-assistant", ...payload } as Record<
      string,
      unknown
    >,
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

/** What Activity's query leaves out: OpenBot's own working. */
const LEFT_OUT = new Set<string>(OPENBOT_WORKING_EVENT_TYPES);

/** Each row's words and stored name, for the rows Activity is answered with. */
const ACTIVITY = ROWS.map((row, index) => ({
  type: row.eventType,
  words: WORDS[index],
  stored: STORED[index],
})).filter((row) => !LEFT_OUT.has(row.type));

async function renderAs(
  edition: "team" | "personal",
  rows = ROWS,
  /** The signed-in person's email, as the current-user query answers it. */
  viewer = "dev@example.com",
) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
    },
  });
  queryClient.setQueryData(authKeys.currentUser(), {
    id: "dev",
    email: viewer,
    name: "Sam",
    role: "admin",
  });
  queryClient.setQueryData(deploymentKeys.capabilities(), {
    generativeUi: true,
    selfHostBanner: false,
    localEvaluation: edition === "personal",
    edition,
  });
  // Activity asks without OpenBot's own working, and the server answers without it.
  if (edition === "personal")
    seedAuditPage(queryClient, withoutOpenBotWorking(""), {
      events: rows.filter((row) => !LEFT_OUT.has(row.eventType)),
    });
  else seedAuditPage(queryClient, "", { events: rows });
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
  // Every row but OpenBot's own working (choosing tools, choosing a Bot, starting the computer).
  expect(lines.map((line) => line.textContent)).toEqual(
    ACTIVITY.map((row) => row.words),
  );
  expect(lines.map((line) => line.getAttribute("title"))).toEqual(
    ACTIVITY.map(() => null),
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
      "parallel/web_search",
    );
  await waitFor(() =>
    expect(whats(view.container).map((line) => line.textContent)).toEqual([
      "Search the web",
    ]),
  );
});

/**
 * What happens to an organization is on its own trail: made, renamed, a person invited, an
 * invitation cancelled, joining, a member removed or given another role. Each reads in words, and as something that happened, never as
 * something OpenBot blocked.
 */
test("what happened to an organization reads in words, and none of it as blocked", async () => {
  const ORGANIZATION_WORDS: Record<string, string> = {
    "organization.created": "Create an organization",
    "organization.renamed": "Rename an organization",
    "organization.member_invited": "Invite a person",
    "organization.invitation_canceled": "Cancel an invitation",
    "organization.member_joined": "Join an organization",
    "organization.member_removed": "Remove a member",
    "organization.member_role_changed": "Change a member's role",
  };
  const types = Object.keys(ORGANIZATION_WORDS);
  /*
   * Short enough for Activity's What column, as the people events are: at 700px the longer words
   * ("Change a person's role in an organization") ran to three lines. Each still differs from every
   * other event's words, so a filter chip never names two kinds of row.
   */
  for (const type of types) {
    const words = ORGANIZATION_WORDS[type] as string;
    expect(words.length).toBeLessThanOrEqual(
      AUDIT_EVENT_WORDS["person.role_changed"]?.length ?? 0,
    );
    const shared = Object.entries(AUDIT_EVENT_WORDS).filter(
      ([other, said]) => other !== type && said === words,
    );
    expect(shared).toEqual([]);
  }
  const view = await renderAs(
    "team",
    types.map((eventType, index) => ({
      ...row(`o${index}`, 40 - index, eventType, "organization", {}, "org_2"),
      payload: {},
    })),
  );
  const lines = whats(view.container);
  expect(lines.map((line) => line.textContent)).toEqual(
    types.map((type) => ORGANIZATION_WORDS[type]),
  );
  // Admin still finds each row's stored name on hover.
  expect(lines.map((line) => line.getAttribute("title"))).toEqual(types);
  const decisions = [
    ...view.container.querySelectorAll("tbody [data-column=decision]"),
  ].map((cell) => cell.textContent);
  expect(decisions).toHaveLength(types.length);
  for (const decision of decisions) {
    expect(decision).not.toContain("Blocked");
    expect(decision).not.toContain("Did not happen");
  }
});

/*
 * Found in testing: a Bot's owner switching an app on for their own Bot read "Share an app", and
 * off "Stop sharing an app". Nothing was shared with anybody: they gave their Bot the app.
 */
test("an owner giving their Bot an app, and taking it back, reads as that", async () => {
  const view = await renderAs("team", [
    row(
      "a1",
      41,
      "app_access.owner_granted",
      "mcp_server",
      {},
      "composio-gmail",
    ),
    row(
      "a2",
      40,
      "app_access.owner_revoked",
      "mcp_server",
      {},
      "composio-gmail",
    ),
  ]);
  const lines = whats(view.container);
  expect(lines.map((line) => line.textContent)).toEqual([
    "Give a Bot an app",
    "Take an app from a Bot",
  ]);
  expect(view.container.textContent).not.toContain("Share");
});

/**
 * A real-product pass read "Started by a person" on every row a person started, with nobody named,
 * and searching the person's email found nothing. The server sends who in `payload.by`.
 */
test("a row a person started names them, and searching their email finds it", async () => {
  const byPerson = (
    id: string,
    minute: number,
    eventType: string,
    payload: Record<string, unknown>,
  ) => ({
    ...row(id, minute, eventType, "organization", {}, "org_2"),
    payload,
  });
  const view = await renderAs("team", [
    byPerson("p1", 30, "organization.member_invited", {
      by: "priya@northwind.test",
    }),
    byPerson("p2", 29, "configuration.changed", {
      by: "priya@northwind.test",
      change: "skill_installed",
    }),
    // Nobody named anywhere on the row, its actor id included.
    { ...byPerson("p3", 28, "organization.renamed", {}), actorUserId: null },
  ]);
  const startedBy = () =>
    [...view.container.querySelectorAll("tbody [data-column=bot]")].map(
      (cell) => cell.lastElementChild?.textContent,
    );
  expect(startedBy()).toEqual([
    "Started by priya@northwind.test",
    "Started by priya@northwind.test",
    // A row that names nobody reads as it always has.
    "Started by a person",
  ]);
  await userEvent
    .setup({ document })
    .type(
      view.getByRole("searchbox", { name: "Search events" }),
      "priya@northwind.test",
    );
  await waitFor(() =>
    expect(whats(view.container).map((line) => line.textContent)).toEqual([
      "Invite a person",
      "Save a skill",
    ]),
  );
});

/**
 * A person who deleted their account: their rows stay for 180 days with their id, and any address
 * the row kept, replaced by a pseudonym (`deleted-user:` and a hash). The row says Deleted user,
 * never the pseudonym and never "a person", wherever the pseudonym is.
 */
test("a row a deleted person started says Deleted user", async () => {
  const GHOST = "deleted-user:8f14e45fceea167a5a36dedd4bea2543";
  const byGhost = (id: string, minute: number, more: object) => ({
    ...row(id, minute, "organization.renamed", "organization", {}, "org_2"),
    ...more,
  });
  const view = await renderAs("team", [
    byGhost("g1", 30, { actorUserId: GHOST, payload: {} }),
    byGhost("g2", 29, { actorUserId: null, payload: { by: GHOST } }),
    byGhost("g3", 28, { actorUserId: null, payload: { actor: GHOST } }),
  ]);
  const startedBy = [
    ...view.container.querySelectorAll("tbody [data-column=bot]"),
  ].map((cell) => cell.lastElementChild?.textContent);
  expect(startedBy).toEqual([
    "Started by Deleted user",
    "Started by Deleted user",
    "Started by Deleted user",
  ]);
  expect(view.container.textContent).not.toContain("deleted-user:");
});

/**
 * The person reading the page is "you", not their own email on every row: the personal edition's
 * one person started nearly everything there. Their email still finds the rows.
 */
test("a row the reader started says you, and their email still finds it", async () => {
  const view = await renderAs(
    "personal",
    [
      {
        ...row("y1", 30, "organization.renamed", "organization", {}, "org_2"),
        payload: { by: "sam@example.com" },
      },
      {
        ...row("y2", 29, "organization.renamed", "organization", {}, "org_2"),
        payload: { by: "priya@northwind.test" },
      },
    ],
    "sam@example.com",
  );
  const startedBy = () =>
    [...view.container.querySelectorAll("tbody [data-column=bot]")].map(
      (cell) => cell.lastElementChild?.textContent,
    );
  expect(startedBy()).toEqual([
    "Started by you",
    "Started by priya@northwind.test",
  ]);
  await userEvent
    .setup({ document })
    .type(
      view.getByRole("searchbox", { name: "Search events" }),
      "sam@example.com",
    );
  await waitFor(() => expect(startedBy()).toEqual(["Started by you"]));
});

/**
 * An app's tool is named the way its page names it: Windows showed "Update imap settings" and
 * "Fetch message by thread id" in Activity while the Gmail page said "Get IMAP settings".
 */
test("an app's tool reads in Activity as it does on the app's page", async () => {
  const gmail = (id: string, minute: number, tool: string) =>
    row(
      id,
      minute,
      "mcp.call_succeeded",
      "mcp_tool",
      {},
      `composio-gmail/${tool}`,
    );
  const view = await renderAs("personal", [
    gmail("g1", 50, "GMAIL_SETTINGS_GET_IMAP"),
    gmail("g2", 49, "GMAIL_UPDATE_POP_SETTINGS"),
    gmail("g3", 48, "GMAIL_FETCH_MESSAGE_BY_THREAD_ID"),
    gmail("g4", 47, "GMAIL_WHO_AM_I"),
  ]);
  expect(whats(view.container).map((line) => line.textContent)).toEqual([
    "Get IMAP settings",
    "Update POP settings",
    "Fetch thread messages",
    "Who am I",
  ]);
});
