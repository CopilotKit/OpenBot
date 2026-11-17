import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BotProfileRoutePage } from "@/components/bot-profile/page";
import type { AgentProfile } from "@/lib/agents/queries";
import { getGetComputerUrl } from "@/lib/api/generated/computers/computers";
import { organizationId } from "@/lib/api/request";
import { queryClient } from "@/query-client";
import {
  activityResponse,
  answerBotsList,
  BOTS_PATH,
  botOperationPath,
  botPath,
  botResponse,
  handoffResponse,
  lifecycleOf,
  lifecycleResponse,
  noContent,
  problemResponse,
} from "./bots-api";
import { pathOf } from "./schedules-api";
import { settleReactWork } from "./settle-react-work";

/*
 * Delete on a Bot's page reads nothing about that Bot again. The page stays up for a moment after
 * the delete, while the list of Bots is read again, and in that moment it used to ask once more for
 * the Bot and what its rows show (its state with the person, its handoffs, its sharing), each of
 * which could only answer that the Bot is not found. Its computer is left out here: what reads a
 * deleted Bot's computer is held by bot-delete-stops-computer-reads.test.tsx.
 */

const originalFetch = globalThis.fetch;
beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
afterEach(() => {
  cleanup();
  queryClient.clear();
  globalThis.fetch = originalFetch;
});
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const EXPENSES: AgentProfile = {
  assignedToMe: false,
  runsOnOpenBotModel: false,
  keyFromOpenBot: false,
  id: "expenses",
  name: "Expenses",
  title: "",
  roleDescription: "Review receipts.",
  avatarSeed: "expenses",
  visibility: "private",
  endpoint: null,
  builtIn: true,
  hasAuth: false,
  hasCallbackToken: false,
  isolated: false,
  isolationActive: false,
  isolationOffReason: null,
  hidden: false,
  pinned: false,
  systemOwned: false,
  canManage: true,
  mine: true,
};

/** How long the list of Bots takes to come back after the delete. */
const LIST_TAKES_MS = 1_500;

const computerOf = () => getGetComputerUrl(organizationId(), EXPENSES.id);
/** A request about the Expenses Bot: one of its own addresses, or one that names it. */
const aboutExpenses = (path: string) =>
  !path.startsWith(computerOf()) && path.split("/").includes(EXPENSES.id);

/**
 * The server: the Bot until it is deleted, and 404 for anything about it after, as the real one. It
 * keeps every request about the Bot from the moment its delete was asked for.
 */
function serving() {
  let deleted = false;
  const seen = {
    deleteAsked: false,
    deleteAnswered: false,
    listBackAfterDelete: false,
    /** What the page said as the list came back, the last moment it is up. */
    pageAsListCameBack: "",
    before: [] as string[],
    after: [] as string[],
  };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = pathOf(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (path === botPath(EXPENSES.id) && method === "DELETE") {
      seen.deleteAsked = true;
      await new Promise((resolve) => setTimeout(resolve, 50));
      seen.deleteAnswered = true;
      deleted = true;
      return noContent();
    }
    if (aboutExpenses(path)) {
      (seen.deleteAsked ? seen.after : seen.before).push(`${method} ${path}`);
      if (deleted) return problemResponse(404, "Bot not found.");
      return answerExpenses(path);
    }
    if (path === BOTS_PATH && seen.deleteAnswered) {
      // A real list takes a moment to come back, and the page is still up until it does.
      await new Promise((resolve) => setTimeout(resolve, LIST_TAKES_MS));
      const list = answerBotsList(input, init, { visible: [] });
      seen.pageAsListCameBack = document.body.textContent ?? "";
      seen.listBackAfterDelete = true;
      return list as Response;
    }
    return (
      answerBotsList(input, init, { visible: [EXPENSES] }) ?? Response.json({})
    );
  }) as unknown as typeof fetch;
  return seen;
}

/** What the Bot's own reads answer while it exists: itself, its state, its activity, its handoffs, its apps. */
function answerExpenses(path: string): Response {
  if (path === botPath(EXPENSES.id)) return botResponse(EXPENSES);
  if (path === botOperationPath(EXPENSES.id, "lifecycle"))
    return lifecycleResponse(lifecycleOf(EXPENSES.id));
  if (path === botOperationPath(EXPENSES.id, "activity"))
    return activityResponse();
  if (path === botOperationPath(EXPENSES.id, "handoff"))
    return handoffResponse();
  if (path === `${botPath(EXPENSES.id)}/grants`)
    return Response.json({ grants: [], nextCursor: null });
  if (path === `${botPath(EXPENSES.id)}/delegation`)
    return Response.json({
      botId: EXPENSES.id,
      mode: "self",
      model: null,
      effort: null,
      instructions: "",
      agents: [
        {
          id: "bag_openbot",
          name: "OpenBot",
          description: "OpenBot's own agent.",
          kind: "openbot",
          available: true,
        },
      ],
      canManage: true,
    });
  return Response.json({});
}

function drawAt(path: string) {
  const root = createRootRoute();
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: [path] }),
    routeTree: root.addChildren([
      createRoute({
        getParentRoute: () => root,
        path: "/bots/$agentId",
        component: () => <BotProfileRoutePage agentId={EXPENSES.id} />,
      }),
      createRoute({
        getParentRoute: () => root,
        path: "/bots",
        component: () => <h1>Bots</h1>,
      }),
    ]),
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
  return { view, router };
}

test("a deleted Bot is never asked about again", async () => {
  const seen = serving();
  const { view, router } = drawAt(`/bots/${EXPENSES.id}`);
  const user = userEvent.setup({ document });
  // The page is up and has read the Bot, as it does while the Bot exists.
  await view.findByRole("heading", { name: "Expenses" });
  await waitFor(() =>
    expect(seen.before).toContain(`GET ${botPath(EXPENSES.id)}`),
  );

  await user.click(view.getByRole("button", { name: /^Delete/ }));
  const dialog = await view.findByRole("dialog", { name: "Delete Expenses?" });
  await user.click(within(dialog).getByRole("button", { name: "Delete" }));
  // Through the list coming back without the Bot, and the page going back to Bots...
  await waitFor(() => expect(seen.listBackAfterDelete).toBe(true), {
    timeout: LIST_TAKES_MS + 3_000,
  });
  await waitFor(() => expect(router.state.location.pathname).toBe("/bots"), {
    timeout: 3_000,
  });
  // ...and long enough after for a read started by the delete to have gone out.
  await new Promise((resolve) => setTimeout(resolve, 300));

  // The Bot is gone, so asking about it could only answer that it is not found.
  expect(seen.after).toEqual([]);
  // Until the page went, it showed the Bot that was deleted, never that the Bot couldn't be opened.
  expect(seen.pageAsListCameBack).toContain("Expenses");
  expect(seen.pageAsListCameBack).not.toContain("Couldn't open this Bot");
}, 15_000);
