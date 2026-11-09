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
import type { ReactNode } from "react";
import { BotActivitySections } from "@/components/bot-profile/activity";
import {
  AuditPage,
  withBot,
  withoutOpenBotWorking,
} from "@/components/manage/audit-page";
import { agentKeys } from "@/lib/agents/queries";
import { authKeys } from "@/lib/auth/queries";
import { botLifecycleKeys } from "@/lib/bot-lifecycle/queries";
import { deploymentKeys } from "@/lib/deployment/queries";
import { seedAuditPage } from "./seed-audit-page";
import { settleReactWork } from "./settle-react-work";

/**
 * A Bot's Activity page after a day of work in conversations and no tasks: it used to say "Nothing
 * has finished yet", because it lists tasks, routines and goals and a saved file is none of them.
 * It now says what it lists, and links to every action the Bot took, in the trail narrowed to it.
 */
beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const BOT = "bot-claude";

async function renderWith(
  ui: ReactNode,
  options: {
    edition: "personal" | "team";
    role: "admin" | "user";
    audit?: Record<string, unknown[]>;
    ready?: string;
  },
) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
    },
  });
  queryClient.setQueryData(botLifecycleKeys.activity(BOT), {
    inProgress: [],
    scheduled: [],
    completed: [],
  });
  queryClient.setQueryData(deploymentKeys.capabilities(), {
    edition: options.edition,
  });
  queryClient.setQueryData(authKeys.currentUser(), {
    id: "person",
    email: "person@example.test",
    role: options.role,
  });
  queryClient.setQueryData(agentKeys.list(false), [
    { id: BOT, name: "Claude Agent SDK" },
  ]);
  for (const [search, events] of Object.entries(options.audit ?? {}))
    seedAuditPage(queryClient, search, { events });
  const router = createRouter({
    routeTree: createRootRoute({ component: () => ui }),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  await view.findByText(options.ready ?? "Completed");
  return view;
}

test("says what it lists, and does not claim the Bot has done nothing", async () => {
  const view = await renderWith(<BotActivitySections agentId={BOT} />, {
    edition: "personal",
    role: "admin",
  });
  expect(view.queryByText("Nothing has finished yet.")).toBeNull();
  expect(
    view.getByText("No tasks, routines or goals have finished yet."),
  ).toBeTruthy();
});

test("in the personal edition, links to Settings › Activity narrowed to this Bot", async () => {
  const view = await renderWith(<BotActivitySections agentId={BOT} />, {
    edition: "personal",
    role: "admin",
  });
  const link = view
    .getByText("Every action this Bot took")
    .closest("a") as HTMLAnchorElement;
  expect(link.getAttribute("href")).toBe(`/settings/activity?bot=${BOT}`);
});

test("for a team admin, links to Admin › Audit narrowed to this Bot", async () => {
  const view = await renderWith(<BotActivitySections agentId={BOT} />, {
    edition: "team",
    role: "admin",
  });
  const link = view
    .getByText("Every action this Bot took")
    .closest("a") as HTMLAnchorElement;
  expect(link.getAttribute("href")).toBe(`/admin/audit?bot=${BOT}`);
});

test("a team member, who cannot open the trail, is not sent to it", async () => {
  const view = await renderWith(<BotActivitySections agentId={BOT} />, {
    edition: "team",
    role: "user",
  });
  expect(view.queryByText("Every action this Bot took")).toBeNull();
});

test("the trail opened for one Bot asks the server for that Bot's rows, and says so", async () => {
  const search = withBot("", BOT);
  expect(search).toBe(`?bot=${BOT}`);
  // Beside a saved view's types, it narrows that view.
  expect(
    withBot("?eventType=computer.action_refused,mcp.call_rejected", BOT),
  ).toBe(`?eventType=computer.action_refused%2Cmcp.call_rejected&bot=${BOT}`);
  // Seeded only under the narrowed query: rows drawn mean the page asked for exactly that.
  const view = await renderWith(<AuditPage bot={BOT} />, {
    edition: "personal",
    role: "admin",
    ready: "Decision",
    audit: {
      [withoutOpenBotWorking(search)]: [
        {
          id: "e1",
          actorUserId: "person",
          initiatorKind: "person",
          initiatorId: null,
          eventType: "computer.action_allowed",
          targetType: "computer",
          targetId: BOT,
          payload: { bot: BOT, action: "computer_write_file", file: "a.txt" },
          createdAt: "2026-11-06T09:00:00Z",
        },
      ],
    },
  });
  expect(view.getByText("a.txt")).toBeTruthy();
  expect(
    view.getByRole("button", {
      name: "Show every Bot, not only Claude Agent SDK",
    }).textContent,
  ).toBe("Only Claude Agent SDK");
});
