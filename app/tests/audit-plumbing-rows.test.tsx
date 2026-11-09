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
import type { ComponentType } from "react";
import { agentKeys } from "@/lib/agents/queries";
import { deploymentKeys } from "@/lib/deployment/queries";
import { Route as AdminAuditRoute } from "@/routes/_authed/admin/audit";
import { Route as ActivityRoute } from "@/routes/_authed/settings/_personal/activity";
import { seedAuditPage } from "./seed-audit-page";
import { settleReactWork } from "./settle-react-work";

/*
 * Two rows Settings > Activity showed in the personal edition that a person could not read. Seen on
 * Windows: "Choose tools for a run / 96 of 96 tools / Couldn't choose, so all were offered" on every
 * turn, OpenBot's own working; and choosing a folder for a Bot on Settings > Computer read "Change a
 * setting" with no Bot and no folder.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(() => cleanup());
afterAll(async () => {
  await settleReactWork();
  await GlobalRegistrator.unregister();
});

const BOT = "personal-assistant";

/** What Activity asks the server to leave out, as the page writes it into its query. */
const LEAVE_OUT =
  "excludeEventType=mcp.tools_discovered%2Cchannel.routed%2Ccomponent.published%2Ccomponent.description_updated%2Ccomputer.policy_loaded%2Ccomputer.isolation_loaded&excludeCalls=routines%2Fcreate_routine%2Croutines%2Fupdate_routine%2Croutines%2Fdelete_routine";

function row(
  id: string,
  minute: number,
  eventType: string,
  targetType: string,
  payload: Record<string, unknown>,
) {
  return {
    id,
    actorUserId: "dev-local-user",
    initiatorKind: "person",
    initiatorId: null,
    eventType,
    targetType,
    targetId: id,
    payload,
    createdAt: `2026-11-07T18:${String(minute).padStart(2, "0")}:00Z`,
  };
}

const CHOOSE_TOOLS = row("tools", 2, "mcp.tools_discovered", "bot", {
  bot: BOT,
  reason: "unavailable",
  granted: 96,
  offered: 96,
  skills: [],
});
const READ = row("read", 1, "computer.action_allowed", "host_access", {
  bot: BOT,
  action: "host/read_file",
  file: "todo.txt",
});

async function renderPage(
  edition: "team" | "personal",
  audit: Record<string, unknown[]>,
) {
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
  for (const [search, events] of Object.entries(audit))
    seedAuditPage(queryClient, search, { events });
  queryClient.setQueryData(agentKeys.list(false), [
    { id: BOT, name: "Personal Assistant" },
  ]);
  queryClient.setQueryData(agentKeys.list(true), []);
  const Page = (edition === "personal" ? ActivityRoute : AdminAuditRoute)
    .options.component as ComponentType;
  const router = createRouter({
    routeTree: createRootRoute({ component: () => <Page /> }),
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

/** Each row as drawn: what, and what it was done to; the Bot, and who started it; the decision. */
function drawn(container: HTMLElement) {
  return [...container.querySelectorAll("tbody tr")].map((tr) => ({
    what: lines(tr.querySelector("[data-column=what]")),
    who: lines(tr.querySelector("[data-column=bot]")),
    decision: lines(tr.querySelector("[data-column=decision]")),
  }));
}

test("Activity leaves out choosing tools for a run, in every view", async () => {
  /*
   * Seeded only under the queries that leave it out: rows drawn mean the page asked the server for
   * exactly that, which is what lets a page of 50 be 50 rows a person reads.
   */
  const view = await renderPage("personal", {
    [`?${LEAVE_OUT}`]: [READ],
    [`?initiatorKind=routine%2Chandoff%2Cresponsibility%2Cmemory&${LEAVE_OUT}`]:
      [],
  });
  expect(drawn(view.container)).toEqual([
    {
      what: ["Read a file", "todo.txt"],
      who: ["Personal Assistant", "Started by a person"],
      decision: ["Allowed"],
    },
  ]);
  expect(view.container.textContent).not.toContain("Choose tools for a run");
  await userEvent
    .setup({ document })
    .click(view.getByRole("button", { name: "Nobody watching" }));
  await waitFor(() => expect(view.getByText("No matches")).toBeTruthy());
});

test("Admin keeps choosing tools for a run, as it read before", async () => {
  const view = await renderPage("team", { "": [CHOOSE_TOOLS, READ] });
  expect(drawn(view.container)[0]).toEqual({
    what: ["Choose tools for a run", "96 of 96 tools"],
    who: ["Personal Assistant", "Started by a person"],
    decision: [
      "Tools offered for one run",
      "Couldn't choose, so all were offered",
    ],
  });
});

/** A folder row as Settings > Computer writes it, and as it wrote it before it said so. */
const FOLDER_ROWS = [
  row("given", 9, "configuration.changed", "host_access", {
    change: "host_folder_granted",
    bot: BOT,
    folder: "share",
  }),
  row("taken", 8, "configuration.changed", "host_access", {
    change: "host_folder_revoked",
    bot: BOT,
    folder: "share",
  }),
  row("stopped", 7, "configuration.changed", "host_access", {
    change: "host_access_stopped",
    bot: BOT,
    folders: ["share", "Documents"],
  }),
  row("old-given", 3, "configuration.changed", "host_access", {
    actorUserId: "dev-local-user",
    targetId: "old-given",
    change: "host_folder_granted",
    botId: BOT,
  }),
  row("old-taken", 2, "configuration.changed", "host_access", {
    actorUserId: "dev-local-user",
    targetId: "old-given",
    change: "host_folder_revoked",
  }),
  row("old-stopped", 1, "configuration.changed", "host_access", {
    actorUserId: "dev-local-user",
    change: "host_access_stopped",
  }),
];

test("a folder given to a Bot, taken away or stopped reads in words, with the Bot and the folder", async () => {
  const view = await renderPage("personal", {
    [`?${LEAVE_OUT}`]: FOLDER_ROWS,
  });
  const person = "Started by a person";
  const changed = ["Configuration changed"];
  expect(drawn(view.container)).toEqual([
    {
      what: ["Give a Bot a folder", "share"],
      who: ["Personal Assistant", person],
      decision: changed,
    },
    {
      what: ["Take a folder from a Bot", "share"],
      who: ["Personal Assistant", person],
      decision: changed,
    },
    {
      what: ["Stop folder access", "share, Documents"],
      who: ["Personal Assistant", person],
      decision: changed,
    },
    // Older rows read as well as what they kept: the Bot a folder was given to, and no folder.
    {
      what: ["Give a Bot a folder"],
      who: ["Personal Assistant", person],
      decision: changed,
    },
    {
      what: ["Take a folder from a Bot"],
      who: ["-", person],
      decision: changed,
    },
    { what: ["Stop folder access"], who: ["-", person], decision: changed },
  ]);
  expect(view.container.textContent).not.toContain("Change a setting");
});
