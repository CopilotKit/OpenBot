import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { connectAppRefusal } from "@openbot/shared/connect-prompt";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render } from "@testing-library/react";
import type { ComponentType } from "react";
import { agentKeys } from "@/lib/agents/queries";
import { deploymentKeys } from "@/lib/deployment/queries";
import { Route as AdminAuditRoute } from "@/routes/_authed/admin/audit";
import { Route as ActivityRoute } from "@/routes/_authed/settings/_personal/activity";
import { seedAuditPage } from "./seed-audit-page";
import { settleReactWork } from "./settle-react-work";

/*
 * Seen on Windows, personal edition: Gmail turned on and not connected, a Bot asked to check the
 * mail. The chat drew the Connect card, and Settings > Activity read "Fetch emails / Gmail /
 * Personal Assistant" with the Decision "The server didn't answer", followed by the refusal as the
 * Bot was given it: `[connect-app]{"serverId":"composio-gmail","title":"Gmail"} You have not
 * connected your Gmail account. Connect it and ask again.` The server had answered: not connected.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(() => cleanup());
afterAll(async () => {
  await settleReactWork();
  await GlobalRegistrator.unregister();
});

const BOT = "personal-assistant";
const REF = "composio-gmail/GMAIL_FETCH_EMAILS";

/** What Activity asks the server to leave out, as the page writes it into its query. */
const LEAVE_OUT =
  "excludeEventType=mcp.tools_discovered%2Cchannel.routed%2Ccomponent.published%2Ccomponent.description_updated%2Ccomputer.policy_loaded%2Ccomputer.isolation_loaded&excludeCalls=routines%2Fcreate_routine%2Croutines%2Fupdate_routine%2Croutines%2Fdelete_routine";

/** An `mcp.call_failed` row as `callTool` writes it when the call's credential was refused. */
function failedCall(id: string, minute: number, failure: string) {
  return {
    id,
    actorUserId: "dev-local-user",
    initiatorKind: "person",
    initiatorId: null,
    eventType: "mcp.call_failed",
    targetType: "mcp_tool",
    targetId: REF,
    payload: {
      actor: "dev-local-user",
      bot: BOT,
      server: "composio-gmail",
      tool: "GMAIL_FETCH_EMAILS",
      effect: "read",
      reachedAs: "dev-local-user",
      decision: {
        allowed: true,
        mode: "enforce",
        rule: null,
        source: "default",
        carriedOut: true,
      },
      failure,
    },
    createdAt: `2026-11-08T18:${String(minute).padStart(2, "0")}:00Z`,
  };
}

/** The refusal the server writes today, built by the same function the server builds it with. */
const NOT_CONNECTED = failedCall(
  "now",
  3,
  connectAppRefusal({
    serverId: "composio-gmail",
    title: "Gmail",
    message:
      "You have not connected your Gmail account. Connect it and ask again.",
  }),
);
/** The row as it was stored on the Windows install, character for character. */
const STORED_BEFORE = failedCall(
  "before",
  2,
  '[connect-app]{"serverId":"composio-gmail","title":"Gmail"} You have not connected your Gmail account. Connect it and ask again.',
);
/** An account the vendor stopped honouring, which the server words as a reconnect. */
const WITHDRAWN = failedCall(
  "withdrawn",
  1,
  connectAppRefusal({
    serverId: "composio-gmail",
    title: "Gmail",
    message:
      "Your Gmail access was withdrawn at the vendor, so this was not done. Reconnect it and ask again.",
    reason: "reconnect",
    at: "2026-11-08T18:01:00.000Z",
  }),
);

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
    decision: lines(tr.querySelector("[data-column=decision]")),
  }));
}

/** Nothing of the marker, the app's id or the provider behind it reaches the page. */
function expectInWords(container: HTMLElement) {
  const text = container.querySelector("tbody")?.textContent ?? "";
  expect(text).not.toContain("[connect-app]");
  expect(text).not.toContain("{");
  expect(text).not.toContain("serverId");
  expect(text).not.toMatch(/composio/i);
  expect(text).not.toContain("didn't answer");
}

test("an app the person hasn't connected reads as not connected on Activity, the rows stored before included", async () => {
  const view = await renderPage("personal", {
    [`?${LEAVE_OUT}`]: [NOT_CONNECTED, STORED_BEFORE, WITHDRAWN],
  });
  const notConnected = {
    what: ["Fetch emails", "Gmail"],
    decision: [
      "Not connected",
      "Gmail isn't connected. Connect it in Connections.",
    ],
  };
  expect(drawn(view.container)).toEqual([
    notConnected,
    notConnected,
    {
      what: ["Fetch emails", "Gmail"],
      decision: [
        "No longer connected",
        "Gmail is no longer connected. Reconnect it in Connections.",
      ],
    },
  ]);
  expectInWords(view.container);
});

test("Admin reads the refusal's own sentence, without the marker", async () => {
  const view = await renderPage("team", { "": [STORED_BEFORE] });
  expect(drawn(view.container)[0]?.decision).toEqual([
    "Not connected",
    "You have not connected your Gmail account. Connect it and ask again.",
    // Admin asks the controls about the row: see what-if/why-button.tsx.
    "Why?",
  ]);
  const decision =
    view.container.querySelector("tbody [data-column=decision]")?.textContent ??
    "";
  expect(decision).not.toContain("[connect-app]");
  expect(decision).not.toContain("{");
  expect(decision).not.toMatch(/composio/i);
});
