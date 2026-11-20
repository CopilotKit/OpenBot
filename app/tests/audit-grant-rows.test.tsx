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
import { OPENBOT_WORKING_EVENT_TYPES } from "@/lib/audit/outcome";
import { deploymentKeys } from "@/lib/deployment/queries";
import { seedAuditPage } from "./seed-audit-page";
import { settleReactWork } from "./settle-react-work";

/*
 * Seen on Windows after an upgrade: Settings > Activity listed 21 rows, each "Change a setting" over
 * `routines/complete_goal` and the rest, each "Started by a person", for the goal tools the upgrade
 * itself gave three Bots. Older rows showed `composio-gmail/GMAIL_SEND_EMAIL` under their title.
 * Activity says what changed and on which app in words, and who started it; Admin keeps the stored
 * names it showed before.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(() => cleanup());
afterAll(async () => {
  await settleReactWork();
  await GlobalRegistrator.unregister();
});

const BOT = "chatgpt-plan-check";
const GOAL_TOOLS = [
  "routines/complete_goal",
  "routines/create_goal",
  "routines/list_goals",
  "routines/pause_goal",
  "routines/resume_goal",
  "routines/run_goal",
  "routines/update_goal",
];

function row(
  id: string,
  minute: number,
  fields: {
    eventType: string;
    targetType: string;
    targetId: string;
    initiatorKind: string;
    payload: Record<string, unknown>;
  },
) {
  return {
    id,
    actorUserId: null,
    initiatorId: null,
    ...fields,
    payload: { bot: BOT, ...fields.payload },
    createdAt: `2026-11-07T17:${String(minute).padStart(2, "0")}:32Z`,
  };
}

/** Newest first, as the table draws them. */
const ROWS = [
  // What a start writes now: one row per Bot, every tool it was given, started by OpenBot.
  row("given", 59, {
    eventType: "configuration.changed",
    targetType: "mcp_server",
    targetId: "routines",
    initiatorKind: "deployment",
    payload: {
      actor: "openbot:always-on",
      change: "plugin_granted",
      kind: "mcp",
      app: "routines",
      refs: GOAL_TOOLS,
    },
  }),
  // What the upgrade wrote before: one row per tool, recorded as started by a person.
  row("legacy", 58, {
    eventType: "configuration.changed",
    targetType: "mcp_tool",
    targetId: "routines/complete_goal",
    initiatorKind: "person",
    payload: {
      actor: "openbot:always-on",
      change: "plugin_granted",
      kind: "mcp",
      ref: "routines/complete_goal",
    },
  }),
  // A person really giving a Bot an app's tool.
  row("person-grant", 57, {
    eventType: "configuration.changed",
    targetType: "mcp_tool",
    targetId: "composio-gmail/GMAIL_SEND_EMAIL",
    initiatorKind: "person",
    payload: {
      actor: "dev",
      change: "plugin_granted",
      kind: "mcp",
      ref: "composio-gmail/GMAIL_SEND_EMAIL",
    },
  }),
  // The Bot using that tool.
  row("call", 56, {
    eventType: "mcp.call_succeeded",
    targetType: "mcp_tool",
    targetId: "composio-gmail/GMAIL_SEND_EMAIL",
    initiatorKind: "person",
    payload: { actor: "dev" },
  }),
  // A component a build brought, published on arrival when a page announced it, recorded as the
  // person whose page that was.
  row("component", 55, {
    eventType: "component.published",
    targetType: "component",
    targetId: "showTable",
    initiatorKind: "person",
    payload: {
      actor: "dev@openbot.local",
      note: "First seen in a build, published and available to every Bot.",
    },
  }),
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
  // Activity asks without OpenBot's own working; Admin asks for everything.
  seedAuditPage(
    queryClient,
    edition === "personal" ? withoutOpenBotWorking("") : "",
    // What the server answers each: Activity's query leaves a build's components out.
    {
      events:
        edition === "personal"
          ? ROWS.filter(
              (row) =>
                !(OPENBOT_WORKING_EVENT_TYPES as readonly string[]).includes(
                  row.eventType,
                ),
            )
          : ROWS,
    },
  );
  queryClient.setQueryData(agentKeys.list(false), [
    { id: BOT, name: "ChatGPT Plan Check" },
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

/** Each row's What, the line under it, and who started it, as drawn. */
function drawn(container: HTMLElement) {
  return [...container.querySelectorAll("tbody tr")].map((tr) => {
    const what = [
      ...(tr.querySelector("[data-column=what]")?.children ?? []),
    ].map((line) => line.textContent);
    const who = [...(tr.querySelector("[data-column=bot]")?.children ?? [])];
    return {
      what: what[0],
      on: what[1],
      startedBy: who[1]?.textContent,
    };
  });
}

test("Activity says what changed in words, and that OpenBot started what it did by itself", async () => {
  const view = await renderAs("personal");
  expect(drawn(view.container)).toEqual([
    {
      what: "Give a Bot tools",
      on: "Complete goal, create goal and 5 more on Routines",
      startedBy: "Started by OpenBot",
    },
    {
      // Recorded as a person's before the fix. Its own actor says it was OpenBot's.
      what: "Give a Bot a tool",
      on: "Complete goal on Routines",
      startedBy: "Started by OpenBot",
    },
    {
      what: "Give a Bot a tool",
      on: "Send email on Gmail",
      startedBy: "Started by a person",
    },
    { what: "Send email", on: "Gmail", startedBy: "Started by a person" },
  ]);
  const table = view.container.querySelector("tbody")?.textContent ?? "";
  for (const stored of [
    "routines/",
    "_goal",
    "composio-gmail",
    "GMAIL_SEND_EMAIL",
    "Change a setting",
  ])
    expect(table).not.toContain(stored);
});

test("Admin keeps each tool's stored name under the words", async () => {
  const view = await renderAs("team");
  expect(drawn(view.container)).toEqual([
    {
      what: "Give a Bot tools",
      on: GOAL_TOOLS.join(", "),
      startedBy: "Started by this deployment",
    },
    {
      what: "Give a Bot a tool",
      on: "routines/complete_goal",
      startedBy: "Started by this deployment",
    },
    {
      what: "Give a Bot a tool",
      on: "composio-gmail/GMAIL_SEND_EMAIL",
      startedBy: "Started by a person",
    },
    {
      what: "Send email",
      on: "composio-gmail/GMAIL_SEND_EMAIL",
      startedBy: "Started by a person",
    },
    {
      what: "Publish a component",
      on: "showTable",
      startedBy: "Started by this deployment",
    },
  ]);
});
