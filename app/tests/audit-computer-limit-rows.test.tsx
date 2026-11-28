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
import { AuditPage } from "@/components/manage/audit-page";
import { agentKeys } from "@/lib/agents/queries";
import { outcomeOf, REFUSED_EVENT_TYPES } from "@/lib/audit/outcome";
import { deploymentKeys } from "@/lib/deployment/queries";
import { LIMIT_BOT, LIMIT_ROWS } from "./computer-limit-audit-rows";
import { seedAuditPage } from "./seed-audit-page";
import { settleReactWork } from "./settle-react-work";

/*
 * Seen in Admin's Activity after a person was refused a computer because the organization had no room: the row read
 * "Start a new computer · A Bot no longer here · Started by a person · Allowed". A refusal drawn as Allowed is the
 * opposite of what happened. The row says it was blocked, by which limit and how many it allows, names the Bot that
 * asked where there is one, and says nothing about a Bot where the computer was the person's own browser.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(() => cleanup());
afterAll(async () => {
  await settleReactWork();
  await GlobalRegistrator.unregister();
});

const BOT = LIMIT_BOT;
const ROWS = LIMIT_ROWS;

async function renderAdmin() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
    },
  });
  queryClient.setQueryData(deploymentKeys.capabilities(), {
    generativeUi: true,
    selfHostBanner: false,
    localEvaluation: false,
    edition: "team",
  });
  seedAuditPage(queryClient, "", { events: ROWS });
  queryClient.setQueryData(agentKeys.list(false), [{ id: BOT, name: "Notes" }]);
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

/** Each row's What, its Bot, and its Decision with the lines under it, as drawn. */
function drawn(container: HTMLElement) {
  return [...container.querySelectorAll("tbody tr")].map((tr) => ({
    what: tr.querySelector("[data-column=what]")?.children[0]?.textContent,
    bot: tr.querySelector("[data-column=bot]")?.children[0]?.textContent,
    decision: [
      ...(tr.querySelector("[data-column=decision]")?.children ?? []),
    ].map((line) => line.textContent),
  }));
}

test("a computer refused at a limit is a refusal, in the Blocked view's list", () => {
  expect(outcomeOf("computer.limit_reached")).toBe("refused");
  expect(REFUSED_EVENT_TYPES as readonly string[]).toContain(
    "computer.limit_reached",
  );
});

test("Activity draws each refusal as blocked, by which limit, naming the Bot that asked and none for a person's own browser", async () => {
  const view = await renderAdmin();
  expect(drawn(view.container)).toEqual([
    {
      what: "Start a new computer",
      bot: "Notes",
      decision: ["Blocked", "This organization is at its limit of 1 computer."],
    },
    {
      what: "Start a new computer",
      bot: "Notes",
      decision: [
        "Blocked",
        "This person is at their limit of 2 computers in this organization.",
      ],
    },
    {
      what: "Start a new computer",
      bot: "-",
      decision: [
        "Blocked",
        "This organization is at its limit of 1 computer.",
        "The computer was for their own browser.",
      ],
    },
    {
      what: "Start a new computer",
      bot: "Notes",
      decision: ["Blocked", "OpenBot is at its limit of 8 computers."],
    },
  ]);
  expect(view.container.textContent).not.toContain("A Bot no longer here");
  expect(view.container.textContent).not.toContain("Allowed");
});
