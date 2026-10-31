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
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as NewBotSheetModule from "@/components/agents/new-bot-sheet";
import * as SidebarToggleModule from "@/components/layout/sidebar-toggle";
import { type AgentProfile, agentKeys } from "@/lib/agents/queries";
import { Route as ChannelNewRoute } from "@/routes/_authed/_app/channel/new";
import {
  NewBotCreationStub,
  SidebarToggleStub,
} from "./channel-new-error-state.fixture";
import { settleReactWork } from "./settle-react-work";

beforeAll(() => GlobalRegistrator.register());

// The shared preload supplies the Vite-only marks module before importing the real sheet.
// Namespace spies can be restored; mock.module would leak these handoff stubs into later suites.
const realNewBotSheet = NewBotSheetModule.NewBotSheet;
const realSidebarToggle = SidebarToggleModule.SidebarToggle;
let restoreComponents = () => {};

beforeEach(() => {
  const newBotSheetSpy = spyOn(
    NewBotSheetModule,
    "NewBotSheet",
  ).mockImplementation(NewBotCreationStub);
  const sidebarToggleSpy = spyOn(
    SidebarToggleModule,
    "SidebarToggle",
  ).mockImplementation(SidebarToggleStub);
  restoreComponents = () => {
    newBotSheetSpy.mockRestore();
    sidebarToggleSpy.mockRestore();
  };
});

afterEach(() => {
  try {
    cleanup();
  } finally {
    restoreComponents();
    expect(NewBotSheetModule.NewBotSheet).toBe(realNewBotSheet);
    expect(SidebarToggleModule.SidebarToggle).toBe(realSidebarToggle);
  }
});

afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

function agent(
  overrides: Partial<AgentProfile> & { id: string },
): AgentProfile {
  return {
    avatarSeed: "seed",
    builtIn: true,
    canManage: true,
    endpoint: null,
    hasAuth: false,
    hasCallbackToken: false,
    isolated: false,
    isolationActive: false,
    isolationOffReason: null,
    hidden: false,
    pinned: false,
    mine: true,
    name: "Agent",
    roleDescription: "Role",
    systemOwned: false,
    title: "Title",
    visibility: "private",
    ...overrides,
  };
}

function queryClientWithAgents(agents: AgentProfile[]) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        staleTime: Number.POSITIVE_INFINITY,
      },
    },
  });
  queryClient.setQueryData(agentKeys.list(false), agents);
  return queryClient;
}

function queryClientWithFailingAgents() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  queryClient.setQueryData(agentKeys.list(false), undefined);
  queryClient.setQueryDefaults(agentKeys.list(false), {
    queryFn: async () => {
      throw new Error("roster exploded");
    },
    retry: false,
  });
  return queryClient;
}

function queryClientWithHiddenDetail(
  agents: AgentProfile[],
  agentId: string,
  queryFn: () => Promise<AgentProfile>,
) {
  const queryClient = queryClientWithAgents(agents);
  queryClient.setQueryDefaults(agentKeys.detail(agentId), {
    queryFn,
    retry: false,
  });
  return queryClient;
}

const rootRoute = createRootRoute({ component: Outlet });
const authedRoute = createRoute({
  id: "/_authed",
  getParentRoute: () => rootRoute,
  component: Outlet,
});
const appRoute = createRoute({
  id: "/_app",
  getParentRoute: () => authedRoute,
  component: Outlet,
});
type TestFileRouteWiring = Parameters<typeof ChannelNewRoute.update>[0] & {
  id: string;
  path: string;
  getParentRoute: () => typeof appRoute;
};
const testChannelNewRoute = ChannelNewRoute.update({
  id: "/channel/new",
  path: "/channel/new",
  getParentRoute: () => appRoute,
} as TestFileRouteWiring);
const routeTree = rootRoute.addChildren([
  authedRoute.addChildren([appRoute.addChildren([testChannelNewRoute])]),
]);

function renderChannelNew(
  queryClient: QueryClient,
  initialEntry = "/channel/new",
) {
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

/**
 * `hidden: true` BECAUSE THE OPEN PICKER MAKES THE PAGE INERT, not because the composer is missing.
 *
 * `/channel/new` opens the recipient combobox by default whenever no recipient is settled, and Base
 * UI marks everything outside its popup `data-base-ui-inert` while it is open — so the composer is
 * removed from the accessibility tree and the default role query cannot see it at all. That is the
 * real browser behaviour, and it only shows up in a test once `app/tests/preload.ts` has evaluated
 * Base UI against a DOM: without it the isomorphic layout effect is a no-op, the popup never mounts,
 * nothing is inert, and this query found the composer by accident.
 *
 * The assertion itself is unchanged and is still the property under test: `aria-disabled` says
 * whether the composer would take a message. Being behind an open picker is a second reason it
 * cannot be typed into, not a substitute for the first.
 */
async function expectMessageComposerDisabled(
  view: ReturnType<typeof render>,
  disabled: boolean,
) {
  const editor = await view.findByRole("textbox", {
    hidden: true,
    name: "Message",
  });
  await waitFor(() =>
    expect(editor.getAttribute("aria-disabled") === "true").toBe(disabled),
  );
}

const GENERAL_ASSISTANT = agent({
  id: "general-assistant",
  name: "General Assistant",
  title: "Everyday work",
});

test("/channel/new reports a failed initial roster load", async () => {
  const view = renderChannelNew(queryClientWithFailingAgents());

  expect((await view.findByRole("alert")).textContent).toBe(
    "Couldn't load your Bots. Reload the page.",
  );
  expect(view.queryByText("No agents found.")).toBeNull();
  await expectMessageComposerDisabled(view, true);
});

test("/channel/new reports a failed URL-selected hidden detail load", async () => {
  const view = renderChannelNew(
    queryClientWithHiddenDetail([GENERAL_ASSISTANT], "hidden-bot", async () => {
      throw new Error("detail exploded");
    }),
    "/channel/new?agent=hidden-bot",
  );

  expect((await view.findByRole("alert")).textContent).toBe(
    "Couldn't load that Bot. Reload the page.",
  );
  expect(view.queryByText("No agents found.")).toBeNull();
  await expectMessageComposerDisabled(view, true);
});

test("/channel/new keeps a successful empty roster as an empty picker", async () => {
  const view = renderChannelNew(queryClientWithAgents([]));

  expect(view.queryByRole("alert")).toBeNull();
  await expectMessageComposerDisabled(view, true);
});

test("/channel/new without a URL recipient leaves the To: field empty", async () => {
  const view = renderChannelNew(
    queryClientWithAgents([
      agent({ id: "picked-harness", name: "Picked Harness" }),
      GENERAL_ASSISTANT,
    ]),
  );

  await expectMessageComposerDisabled(view, true);
  expect(
    view.queryByRole("button", { hidden: true, name: /^Remove / }),
  ).toBeNull();
});

test("/channel/new keeps a successful visible recipient enabled", async () => {
  const view = renderChannelNew(
    queryClientWithAgents([GENERAL_ASSISTANT]),
    "/channel/new?agent=general-assistant",
  );

  expect(view.queryByRole("alert")).toBeNull();
  await expectMessageComposerDisabled(view, false);
});

test("/channel/new ignores stale detail errors when the URL agent is listed", async () => {
  const queryClient = queryClientWithAgents([GENERAL_ASSISTANT]);
  await queryClient.prefetchQuery({
    queryKey: agentKeys.detail("general-assistant"),
    queryFn: async () => {
      throw new Error("stale detail exploded");
    },
    retry: false,
  });
  const view = renderChannelNew(
    queryClient,
    "/channel/new?agent=general-assistant",
  );

  expect(view.queryByRole("alert")).toBeNull();
  await expectMessageComposerDisabled(view, false);
});

test("/channel/new keeps a successful hidden URL recipient enabled", async () => {
  const hiddenBot = agent({
    hidden: true,
    id: "hidden-bot",
    name: "Hidden Bot",
    title: "Hidden Bot",
  });
  const queryClient = queryClientWithAgents([GENERAL_ASSISTANT]);
  queryClient.setQueryData(agentKeys.detail("hidden-bot"), hiddenBot);
  const view = renderChannelNew(queryClient, "/channel/new?agent=hidden-bot");

  expect(view.queryByRole("alert")).toBeNull();
  await expectMessageComposerDisabled(view, false);
});

test("/channel/new keeps a usable hidden detail when a background refetch fails", async () => {
  const hiddenBot = agent({
    hidden: true,
    id: "hidden-bot",
    name: "Hidden Bot",
    title: "Hidden Bot",
  });
  const queryClient = queryClientWithHiddenDetail(
    [GENERAL_ASSISTANT],
    "hidden-bot",
    async () => {
      throw new Error("background detail exploded");
    },
  );
  queryClient.setQueryData(agentKeys.detail("hidden-bot"), hiddenBot);
  const view = renderChannelNew(queryClient, "/channel/new?agent=hidden-bot");

  expect(view.queryByRole("alert")).toBeNull();
  await expectMessageComposerDisabled(view, false);
});

test("New Bot is a fixed action outside the auto-highlighted recipient options", async () => {
  const view = renderChannelNew(queryClientWithAgents([GENERAL_ASSISTANT]));
  const create = await view.findByRole("button", {
    name: "New Bot Create a new Bot",
  });
  expect(view.queryByRole("option", { name: /New Bot/ })).toBeNull();
  expect(create.hasAttribute("data-highlighted")).toBe(false);
  const input = view.getByRole("combobox");
  await userEvent.setup({ document }).type(input, "no matching recipient");
  await view.findByText("No Bots found.");
  expect(
    view.getByRole("button", { name: "New Bot Create a new Bot" }),
  ).toBeTruthy();
  fireEvent.click(create);
  expect(await view.findByRole("dialog", { name: "New Bot" })).toBeTruthy();
});

test("creating a Bot preserves existing recipients and selects the created Bot", async () => {
  const query = queryClientWithAgents([GENERAL_ASSISTANT]);
  query.setQueryData(
    agentKeys.detail("created-bot"),
    agent({ id: "created-bot", name: "Created Bot" }),
  );
  const view = renderChannelNew(query, "/channel/new?agent=general-assistant");
  const input = await view.findByRole("combobox");
  fireEvent.keyDown(input, { key: "ArrowDown" });
  fireEvent.click(
    await view.findByRole("button", { name: "New Bot Create a new Bot" }),
  );
  fireEvent.click(await view.findByRole("button", { name: "Finish creation" }));
  await waitFor(() => {
    expect(
      view.getByRole("button", { name: "Remove General Assistant" }),
    ).toBeTruthy();
    expect(
      view.getByRole("button", { name: "Remove Created Bot" }),
    ).toBeTruthy();
  });
});
