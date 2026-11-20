import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  spyOn,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render } from "@testing-library/react";
import type { ComponentType } from "react";
import { GALLERY as ACTIVITY } from "@/components/gallery/activity";
import { GALLERY as TABLE } from "@/components/gallery/table";
import { agentKeys } from "@/lib/agents/queries";
import * as gallery from "@/lib/copilot/gallery-registry";
import { deploymentKeys } from "@/lib/deployment/queries";
import { Route as AdminAuditRoute } from "@/routes/_authed/admin/audit";
import { Route as ActivityRoute } from "@/routes/_authed/settings/_personal/activity";
import { seedAuditPage } from "./seed-audit-page";
import { settleReactWork } from "./settle-react-work";

/*
 * What a fresh personal install showed on Settings > Activity after one message. Seen locally:
 * "Choose a Bot for a message / Sent to the default Bot / fallback: one-candidate" on every message,
 * fifteen "Publish a component / showTable" rows and two "Start the computer" rows that OpenBot
 * wrote setting itself up, and ids where words belong: "showActivityReport · botActivity" over a
 * reason sending the person to an admin, "find-a-notion-page" under a skill, a key's id under
 * "Save a credential", and "Change a setting" for OpenBot setting up Learning. Admin keeps all of it
 * as it was.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(() => cleanup());
afterAll(async () => {
  await settleReactWork();
  await GlobalRegistrator.unregister();
});

/*
 * `import.meta.glob` is Vite's, so under `bun test` the registry finds no gallery modules; the
 * lookup Activity uses is answered from the same modules Vite loads.
 */
const compiled = spyOn(gallery, "galleryComponent");
beforeEach(() => {
  compiled.mockImplementation((name) =>
    [...ACTIVITY, ...TABLE].find((spec) => spec.name === name),
  );
});
afterAll(() => compiled.mockRestore());

const BOT = "personal-assistant";

/** Every query Activity sends leaves these out, as the page writes it. */
const LEAVE_OUT =
  "?excludeEventType=mcp.tools_discovered%2Cchannel.routed%2Ccomponent.published%2Ccomponent.description_updated%2Ccomputer.policy_loaded%2Ccomputer.isolation_loaded&excludeCalls=routines%2Fcreate_routine%2Croutines%2Fupdate_routine%2Croutines%2Fdelete_routine";

function row(
  id: string,
  minute: number,
  fields: {
    eventType: string;
    targetType: string;
    targetId?: string | null;
    initiatorKind?: string;
    payload: Record<string, unknown>;
  },
) {
  return {
    id,
    actorUserId: "dev-local-user",
    initiatorKind: "person",
    initiatorId: null,
    targetId: null,
    ...fields,
    createdAt: `2026-11-07T19:${String(minute).padStart(2, "0")}:00Z`,
  };
}

/** OpenBot's own working, as the server records it: what Activity no longer asks for. */
const ROUTED = row("routed", 30, {
  eventType: "channel.routed",
  targetType: "agent",
  targetId: BOT,
  payload: {
    chosen: BOT,
    reason: "fallback: one-candidate",
    fallback: true,
    undecided: "one-candidate",
  },
});
const PUBLISHED = row("published", 20, {
  eventType: "component.published",
  targetType: "component",
  targetId: "showTable",
  initiatorKind: "deployment",
  payload: {
    note: "First seen in a build, published and available to every Bot.",
  },
});
const BOUNDARY = row("boundary", 10, {
  eventType: "computer.policy_loaded",
  targetType: "policy",
  initiatorKind: "deployment",
  payload: { allow: ["true"], deny: [], mode: "enforce" },
});

/** Rows a person keeps, each recorded with an id where a person reads words. */
const KEPT = [
  row("refused", 29, {
    eventType: "component.function_refused",
    targetType: "component",
    targetId: "showActivityReport",
    payload: {
      bot: BOT,
      function: "botActivity",
      reason:
        "showActivityReport can't use the function botActivity. An admin has to give it to this component.",
    },
  }),
  row("not-shown", 28, {
    eventType: "component.refused",
    targetType: "component",
    targetId: "showTable",
    payload: {
      bot: BOT,
      reason:
        "Data table has been withheld from this Bot in this deployment, though other Bots may use it. Answer in prose instead.",
    },
  }),
  row("key", 27, {
    eventType: "credential.created",
    targetType: "credential",
    targetId: "9869ac62-2f72-4ffc-b39d-8faf84702828",
    payload: { kind: "model", provider: "Anthropic", keyId: "personal" },
  }),
  row("key-gone", 26, {
    eventType: "credential.revoked",
    targetType: "credential",
    targetId: "9869ac62-2f72-4ffc-b39d-8faf84702828",
    payload: {},
  }),
  row("blocked", 25, {
    eventType: "computer.action_refused",
    targetType: "computer",
    targetId: BOT,
    payload: {
      bot: BOT,
      action: "computer_navigate",
      page: "https://example.com/",
      reason: "Local computer access is off for you.",
      decision: {
        allowed: false,
        mode: "enforce",
        source: "deny",
        rule: "capability:localComputer",
      },
    },
  }),
  row("skill", 9, {
    eventType: "configuration.changed",
    targetType: "skill",
    targetId: "find-a-document",
    initiatorKind: "deployment",
    payload: {
      actor: "openbot:personal-defaults",
      change: "plugin_granted",
      kind: "skill",
      ref: "find-a-document",
      bot: BOT,
    },
  }),
  row("learning", 8, {
    eventType: "configuration.changed",
    targetType: "learning",
    initiatorKind: "deployment",
    payload: {
      change: "default_container_assigned_automatically",
      defaultContainerId: "openbot",
    },
  }),
];

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

function drawn(container: HTMLElement) {
  return [...container.querySelectorAll("tbody tr")].map((tr) => ({
    what: lines(tr.querySelector("[data-column=what]")),
    who: lines(tr.querySelector("[data-column=bot]")),
    decision: lines(tr.querySelector("[data-column=decision]")),
  }));
}

test("Activity asks without routing, a build's components or the computer's start-up, and says the rest in words", async () => {
  // Seeded only under the query that leaves them out: rows drawn mean the page asked for exactly that.
  const view = await renderPage("personal", { [LEAVE_OUT]: KEPT });
  const person = "Started by a person";
  const openbot = "Started by OpenBot";
  expect(drawn(view.container)).toEqual([
    {
      what: [
        "Read data for a component",
        "Activity report · your Bots' activity",
      ],
      who: ["Personal Assistant", person],
      decision: ["Refused", "It isn't allowed to read that data."],
    },
    {
      what: ["Show a component", "Data table"],
      who: ["Personal Assistant", person],
      decision: ["Refused", "This Bot can't show it."],
    },
    {
      what: ["Save a credential", "Anthropic · personal"],
      who: ["-", person],
      decision: ["Credential saved"],
    },
    // A removed key's row keeps nothing but its id, which is never shown.
    {
      what: ["Remove a credential"],
      who: ["-", person],
      decision: ["Allowed"],
    },
    {
      what: ["Open a page", "example.com"],
      who: ["Personal Assistant", person],
      decision: ["Blocked", "Local computer access is off for you."],
    },
    {
      what: ["Give a Bot a skill", "Find a document"],
      who: ["Personal Assistant", openbot],
      decision: ["Configuration changed"],
    },
    {
      what: ["Set up Learning"],
      who: ["-", openbot],
      decision: ["Configuration changed"],
    },
  ]);
  const table = view.container.querySelector("tbody")?.textContent ?? "";
  for (const stored of [
    "showActivityReport",
    "botActivity",
    "showTable",
    "An admin",
    "9869ac62",
    "capability:",
    "find-a-document",
    "Change a setting",
  ])
    expect(table).not.toContain(stored);
});

test("Admin keeps routing, a build's components, the computer's start-up and the stored names", async () => {
  const view = await renderPage("team", {
    "": [ROUTED, ...KEPT.slice(0, 5), PUBLISHED, BOUNDARY],
  });
  expect(drawn(view.container)).toEqual([
    {
      what: ["Choose a Bot for a message"],
      who: ["Personal Assistant", "Started by a person"],
      decision: ["Sent to the default Bot", "fallback: one-candidate"],
    },
    {
      what: ["Read data for a component", "showActivityReport · botActivity"],
      who: ["Personal Assistant", "Started by a person"],
      decision: [
        "Refused",
        "showActivityReport can't use the function botActivity. An admin has to give it to this component.",
      ],
    },
    {
      what: ["Show a component", "showTable"],
      who: ["Personal Assistant", "Started by a person"],
      decision: [
        "Refused",
        "Data table has been withheld from this Bot in this deployment, though other Bots may use it. Answer in prose instead.",
      ],
    },
    {
      what: ["Save a credential", "9869ac62-2f72-4ffc-b39d-8faf84702828"],
      who: ["-", "Started by a person"],
      decision: ["Credential saved"],
    },
    {
      what: ["Remove a credential", "9869ac62-2f72-4ffc-b39d-8faf84702828"],
      who: ["-", "Started by a person"],
      decision: ["Allowed"],
    },
    {
      what: ["Open a page", "example.com"],
      who: ["Personal Assistant", "Started by a person"],
      decision: [
        "Blocked",
        "Local computer access is off for you.",
        "capability:localComputer",
        // Admin asks the controls about the row: see what-if/why-button.tsx.
        "Why?",
      ],
    },
    {
      what: ["Publish a component", "showTable"],
      who: ["-", "Started by this deployment"],
      decision: ["Published. Every Bot can use it"],
    },
    {
      what: ["Start the computer"],
      who: ["-", "Started by this deployment"],
      decision: ["Boundary at start-up"],
    },
  ]);
});
