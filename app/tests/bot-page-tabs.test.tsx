import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  isRedirect,
  RouterProvider,
  useSearch,
} from "@tanstack/react-router";
import { cleanup, render } from "@testing-library/react";
import { BotSubpage } from "@/components/bot-profile/bot-subpage";
import { BotProfileRoutePage } from "@/components/bot-profile/page";
import { type BotTab, parseBotTab } from "@/lib/agents/bot-tabs";
import type { AgentProfile } from "@/lib/agents/queries";
import type { ActivityItem } from "@/lib/bot-lifecycle/queries";
import { Route as ActivityRoute } from "@/routes/_authed/_app/bots.$agentId.activity";
import { Route as BotRoute } from "@/routes/_authed/_app/bots.$agentId.index";
import { ME_PATH, meResponse } from "./accounts-api";
import {
  activityResponse,
  botOperationPath,
  botPath,
  botResponse,
  lifecycleOf,
  lifecycleResponse,
} from "./bots-api";
import { ORGANIZATION_PATH, pathOf } from "./schedules-api";
import { settleReactWork } from "./settle-react-work";

/**
 * A Bot's page is three tabs: Profile, what it is for and its state with the person; Activity, what
 * the Activity page used to list; and Settings, its settings rows and what can be done to it. The
 * open tab is in the address, and the old Activity address and a settings page's back link both
 * land on the tab that holds what they used to.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

const BOT: AgentProfile = {
  assignedToMe: false,
  runsOnOpenBotModel: false,
  keyFromOpenBot: false,
  id: "expenses",
  name: "Expenses",
  title: "Finance",
  roleDescription: "Receipts.",
  avatarSeed: "e",
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

const FINISHED: ActivityItem = {
  id: "routine-1",
  kind: "routine",
  title: "Filed last week's receipts",
  detail: null,
  status: "completed",
  at: "2026-10-09T10:00:00Z",
  channelId: null,
  needsYou: false,
  stoppable: false,
  cancellable: false,
};

/** The Bot, its state with the person, its activity and the person's tasks; nothing else is found. */
function serving() {
  global.fetch = (async (input: RequestInfo | URL) => {
    const path = pathOf(input);
    if (path === botPath(BOT.id)) return botResponse(BOT);
    if (path === botOperationPath(BOT.id, "lifecycle"))
      return lifecycleResponse(lifecycleOf(BOT.id));
    if (path === botOperationPath(BOT.id, "activity"))
      return activityResponse({ completed: [FINISHED] });
    if (path === `${ORGANIZATION_PATH}/tasks`)
      return Response.json({ tasks: [], nextCursor: null });
    if (path.includes(ME_PATH))
      return meResponse({
        user: { id: "me", role: "user", email: "me@example.test", name: "Me" },
      });
    return Response.json({ error: "unexpected" }, { status: 404 });
  }) as unknown as typeof fetch;
}

const validateSearch = BotRoute.options.validateSearch as (
  search: Record<string, unknown>,
) => { tab?: BotTab };

/** The Bot's page at an address, its tab read from the address as the app's own route reads it. */
function drawAt(path: string) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const root = createRootRoute();
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: [path] }),
    routeTree: root.addChildren([
      createRoute({
        getParentRoute: () => root,
        path: "/bots/$agentId",
        validateSearch,
        component: function Page() {
          const { tab } = useSearch({ strict: false }) as { tab?: BotTab };
          return <BotProfileRoutePage agentId={BOT.id} tab={tab} />;
        },
      }),
      createRoute({
        getParentRoute: () => root,
        path: "/bots/$agentId/sharing",
        component: () => (
          <BotSubpage
            agentId={BOT.id}
            description="Who uses it."
            title="Sharing"
          >
            {() => null}
          </BotSubpage>
        ),
      }),
    ]),
  });
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

const headings = (view: ReturnType<typeof drawAt>) =>
  view.getAllByRole("heading").map((heading) => heading.textContent);

test("a tab that is not one opens Profile", () => {
  expect(parseBotTab("activity")).toBe("activity");
  expect(parseBotTab("settings")).toBe("settings");
  expect(parseBotTab("nonsense")).toBe("profile");
  expect(parseBotTab(undefined)).toBe("profile");
  // The address leaves Profile out, so a plain link to the Bot needs no search.
  expect(validateSearch({ tab: "profile" })).toEqual({});
  expect(validateSearch({ tab: "nonsense" })).toEqual({});
  expect(validateSearch({ tab: "settings" })).toEqual({ tab: "settings" });
});

test("the Profile tab does not draw the settings rows", async () => {
  serving();
  const view = drawAt(`/bots/${BOT.id}`);
  expect(await view.findByRole("switch", { name: "Active" })).toBeTruthy();
  expect(view.queryByRole("heading", { name: "When it works" })).toBeNull();
  expect(
    view.getByRole("link", { name: "Profile" }).getAttribute("aria-current"),
  ).toBe("page");
  expect(
    view.getByRole("link", { name: "Settings" }).getAttribute("aria-current"),
  ).toBeNull();
  expect(
    view.getByRole("link", { name: "Settings" }).getAttribute("href"),
  ).toBe(`/bots/${BOT.id}?tab=settings`);
  expect(view.getByRole("link", { name: "Profile" }).getAttribute("href")).toBe(
    `/bots/${BOT.id}`,
  );
});

test("the Settings tab draws the four groups in order", async () => {
  serving();
  const view = drawAt(`/bots/${BOT.id}?tab=settings`);
  await view.findByRole("heading", { name: "When it works" });
  const groups = ["When it works", "What it knows", "What it uses", "This Bot"];
  expect(headings(view).filter((name) => groups.includes(name ?? ""))).toEqual(
    groups,
  );
  // What can be done to the Bot is here too, and nothing of the Profile tab is.
  expect(view.getByRole("button", { name: /^Delete/ })).toBeTruthy();
  expect(view.queryByRole("switch", { name: "Active" })).toBeNull();
  expect(
    view.getByRole("link", { name: "Settings" }).getAttribute("aria-current"),
  ).toBe("page");
});

test("the Activity tab draws what the Activity page drew", async () => {
  serving();
  const view = drawAt(`/bots/${BOT.id}?tab=activity`);
  expect(await view.findByText(FINISHED.title)).toBeTruthy();
  expect(view.getByRole("heading", { name: "Done" })).toBeTruthy();
  expect(view.queryByRole("switch", { name: "Active" })).toBeNull();
  expect(view.queryByRole("heading", { name: "When it works" })).toBeNull();
  expect(
    view.getByRole("link", { name: "Activity" }).getAttribute("aria-current"),
  ).toBe("page");
});

test("the old Activity address opens the Activity tab", () => {
  const beforeLoad = ActivityRoute.options.beforeLoad as unknown as (input: {
    params: { agentId: string };
  }) => void;
  let thrown: unknown;
  try {
    beforeLoad({ params: { agentId: "b1" } });
  } catch (error) {
    thrown = error;
  }
  expect(isRedirect(thrown)).toBe(true);
  if (!isRedirect(thrown)) return;
  expect(thrown.options.to).toBe("/bots/$agentId");
  // Given as objects, never as functions of the address it came from.
  expect(thrown.options.params as unknown).toEqual({ agentId: "b1" });
  expect(thrown.options.search as unknown).toEqual({ tab: "activity" });
});

test("a settings page's back link goes to the Settings tab", async () => {
  serving();
  const view = drawAt(`/bots/${BOT.id}/sharing`);
  // The bar's Back is a link drawn as a button, named for the Bot once it is read.
  const back = await view.findByRole("button", { name: "Expenses" });
  expect(back.getAttribute("href")).toBe(`/bots/${BOT.id}?tab=settings`);
});
