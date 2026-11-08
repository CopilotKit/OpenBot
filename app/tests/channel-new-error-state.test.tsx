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
  Link,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as NewBotSheetModule from "@/components/agents/new-bot-sheet";
import * as SidebarToggleModule from "@/components/layout/sidebar-toggle";
import { type AgentProfile, agentKeys } from "@/lib/agents/queries";
import {
  type DeploymentCapabilities,
  deploymentKeys,
} from "@/lib/deployment/queries";
import { Route as ChannelNewRoute } from "@/routes/_authed/_app/channel/new";
import {
  NewBotCreationStub,
  SidebarToggleStub,
} from "./channel-new-error-state.fixture";
import { settleReactWork } from "./settle-react-work";

const NativeResponse = globalThis.Response;

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

/** The roster, and which edition this is, as `/api/capabilities` says it. */
function queryClientWithEdition(
  agents: AgentProfile[],
  edition: DeploymentCapabilities["edition"],
) {
  const queryClient = queryClientWithAgents(agents);
  queryClient.setQueryData(deploymentKeys.capabilities(), {
    generativeUi: true,
    selfHostBanner: false,
    localEvaluation: edition === "personal",
    edition,
  } satisfies DeploymentCapabilities);
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

/**
 * The page with the sidebar's + beside it, as the app draws them: a plain link to `/channel/new`
 * that sits outside the To: picker, so pressing it is an outside press the picker reacts to.
 */
function PlusBesidePage() {
  return (
    <>
      <Link aria-label="New conversation" to="/channel/new">
        +
      </Link>
      <Outlet />
    </>
  );
}

const rootRoute = createRootRoute({ component: PlusBesidePage });
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
  return Object.assign(
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    ),
    { router },
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
/**
 * A team's Bots: more than one, so a new conversation starts with nobody in To: and asks. With
 * only one there is nobody to choose between, and it starts with that Bot picked.
 */
const SEVERAL_BOTS = [
  GENERAL_ASSISTANT,
  agent({ id: "research-assistant", name: "Research Assistant" }),
];

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
  await expectSendHeldForABot(view);
});

test("/channel/new in the team edition with several Bots leaves the To: field empty", async () => {
  const view = renderChannelNew(
    queryClientWithEdition(
      [
        agent({ id: "picked-harness", name: "Picked Harness" }),
        GENERAL_ASSISTANT,
      ],
      "team",
    ),
  );

  await expectSendHeldForABot(view);
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
  const view = renderChannelNew(queryClientWithAgents(SEVERAL_BOTS));
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

/** What the sidebar's + does: a plain link to `/channel/new`, no recipient, no state. */
async function pressPlus(view: ReturnType<typeof renderChannelNew>) {
  await view.router.navigate({ to: "/channel/new" });
}

async function typeDraft(
  text: string,
  view: ReturnType<typeof renderChannelNew>,
) {
  const editor = await view.findByRole("textbox", {
    hidden: true,
    name: "Message",
  });
  const user = userEvent.setup({ document });
  await user.click(editor);
  await user.keyboard(text);
  await waitFor(() => expect(editor.textContent).toBe(text));
}

test("+ while composing a new conversation with a Bot picked starts a fresh one", async () => {
  const view = renderChannelNew(queryClientWithAgents(SEVERAL_BOTS));
  // Picked in To:, as a person does, not handed over in the URL.
  await userEvent
    .setup({ document })
    .type(await view.findByRole("combobox"), "General");
  fireEvent.click(
    await view.findByRole("option", { name: /General Assistant/ }),
  );
  expect(
    await view.findByRole("button", { name: "Remove General Assistant" }),
  ).toBeTruthy();
  expect(view.router.state.location.search).toEqual({
    agent: "general-assistant",
  });
  await typeDraft("half a thought", view);

  await pressPlus(view);

  // The URL names no Bot, so neither does the screen, and the half-written message is gone.
  expect(view.router.state.location.href).toBe("/channel/new");
  // And the caret is back in To:, where the new conversation starts, not left in the old message.
  await expectPickerOpenAndFocused(view);
  await waitFor(() =>
    expect(
      view.queryByRole("button", {
        hidden: true,
        name: "Remove General Assistant",
      }),
    ).toBeNull(),
  );
  expect(
    (view.getByRole("combobox", { hidden: true }) as HTMLInputElement)
      .placeholder,
  ).toBe("Choose a Bot…");
  const editor = await view.findByRole("textbox", {
    hidden: true,
    name: "Message",
  });
  expect(editor.textContent).toBe("");
  await expectSendHeldForABot(view);
});

test("picking and removing Bots keeps the conversation being written", async () => {
  const second = agent({ id: "second-bot", name: "Second Bot" });
  const view = renderChannelNew(
    queryClientWithAgents([GENERAL_ASSISTANT, second]),
    "/channel/new?agent=general-assistant",
  );
  await typeDraft("for both of you", view);
  const input = await view.findByRole("combobox", { hidden: true });
  await userEvent.setup({ document }).type(input, "Second");
  fireEvent.click(await view.findByRole("option", { name: /Second Bot/ }));
  await view.findByRole("button", { hidden: true, name: "Remove Second Bot" });
  fireEvent.click(
    view.getByRole("button", {
      hidden: true,
      name: "Remove General Assistant",
    }),
  );

  // The page's own navigation moved the first Bot in the URL; nothing was thrown away.
  await waitFor(() =>
    expect(view.router.state.location.search).toEqual({ agent: "second-bot" }),
  );
  expect(
    view.getByRole("button", { hidden: true, name: "Remove Second Bot" }),
  ).toBeTruthy();
  expect(
    (await view.findByRole("textbox", { hidden: true, name: "Message" }))
      .textContent,
  ).toBe("for both of you");
});

/** The To: picker is open and the caret is in it, ready for a Bot's name: what one + press gives. */
async function expectPickerOpenAndFocused(
  view: ReturnType<typeof renderChannelNew>,
) {
  await waitFor(() => {
    const input = view.getByRole("combobox", { hidden: true });
    expect(input.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(input);
    expect(
      view.getByRole("option", { hidden: true, name: /General Assistant/ }),
    ).toBeTruthy();
  });
}

/**
 * Writing before choosing anybody: the picker is put away first, as a person does by pressing
 * Escape or clicking past it, and then the message is typed into the composer.
 */
async function typeDraftToNobody(
  text: string,
  view: ReturnType<typeof renderChannelNew>,
) {
  const user = userEvent.setup({ document });
  await waitFor(() =>
    expect(
      view
        .getByRole("combobox", { hidden: true })
        .getAttribute("aria-expanded"),
    ).toBe("true"),
  );
  await user.keyboard("{Escape}");
  await waitFor(() =>
    expect(
      view
        .getByRole("combobox", { hidden: true })
        .getAttribute("aria-expanded"),
    ).toBe("false"),
  );
  await typeDraft(text, view);
}

/**
 * Nobody is in To:, so nothing can be sent: the composer takes words, and Enter keeps them and asks
 * for a Bot rather than sending them anywhere.
 */
async function expectSendHeldForABot(
  view: ReturnType<typeof renderChannelNew>,
) {
  await expectMessageComposerDisabled(view, false);
  await typeDraftToNobody("for whoever", view);
  await userEvent.setup({ document }).keyboard("{Enter}");
  expect(await view.findByText("Choose a Bot first.")).toBeTruthy();
  expect(
    (await view.findByRole("textbox", { hidden: true, name: "Message" }))
      .textContent,
  ).toBe("for whoever");
}

function plusButton(view: ReturnType<typeof renderChannelNew>) {
  return view.getByLabelText("New conversation");
}

test("+ pressed twice fast opens the To: picker exactly as one press does", async () => {
  const view = renderChannelNew(queryClientWithAgents(SEVERAL_BOTS));
  await expectPickerOpenAndFocused(view);

  await userEvent.setup({ document }).dblClick(plusButton(view));

  await expectPickerOpenAndFocused(view);
});

test("+ pressed again after the screen has settled opens the To: picker again", async () => {
  const view = renderChannelNew(queryClientWithAgents(SEVERAL_BOTS));
  const user = userEvent.setup({ document });
  await expectPickerOpenAndFocused(view);
  await user.click(plusButton(view));
  await expectPickerOpenAndFocused(view);
  await settleReactWork();

  await user.click(plusButton(view));

  await expectPickerOpenAndFocused(view);
  expect(view.router.state.location.pathname).toBe("/channel/new");
});

test("+ while writing to nobody yet starts a fresh conversation", async () => {
  const view = renderChannelNew(queryClientWithAgents(SEVERAL_BOTS));
  await typeDraftToNobody("not for anyone yet", view);

  await userEvent.setup({ document }).click(plusButton(view));

  await expectPickerOpenAndFocused(view);
  expect(
    (await view.findByRole("textbox", { hidden: true, name: "Message" }))
      .textContent,
  ).toBe("");
});

test("Enter with no Bot chosen keeps the message, says so, and opens the To: picker", async () => {
  const view = renderChannelNew(queryClientWithAgents(SEVERAL_BOTS));
  await typeDraftToNobody("hello there", view);

  await userEvent.setup({ document }).keyboard("{Enter}");

  const hint = await view.findByText("Choose a Bot first.");
  expect(hint.getAttribute("role")).toBe("status");
  // Inset to the composer's text, not flush with the column's edge.
  expect(hint.className).toContain("px-3.5");
  await expectPickerOpenAndFocused(view);
  const editor = await view.findByRole("textbox", {
    hidden: true,
    name: "Message",
  });
  expect(editor.textContent).toBe("hello there");

  // Answering the question clears it, and the message is still there to send.
  fireEvent.click(
    await view.findByRole("option", {
      hidden: true,
      name: /General Assistant/,
    }),
  );
  await view.findByRole("button", {
    hidden: true,
    name: "Remove General Assistant",
  });
  await waitFor(() =>
    expect(view.queryByText("Choose a Bot first.")).toBeNull(),
  );
  expect(editor.textContent).toBe("hello there");
  await waitFor(() => expect(document.activeElement).toBe(editor));
  await expectMessageComposerDisabled(view, false);
});

/*
 * + asks who the message is for: To: starts empty with the Bot menu open, in either edition and
 * however many Bots there are. A Bot picked on the person's behalf was one they had to notice and
 * remove. FOUND ON WINDOWS: a message typed with nobody in To: once went nowhere; the open menu
 * says from the start that a Bot is needed, and Enter with nobody picked asks again (above).
 */
test("+ in the personal edition opens To: empty with the Bot menu open, and picks nobody for the person", async () => {
  const errandHelper = agent({ id: "picked-harness", name: "Errand Helper" });
  const view = renderChannelNew(
    queryClientWithEdition([GENERAL_ASSISTANT, errandHelper], "personal"),
  );

  await expectPickerOpenAndFocused(view);
  expect(
    view.getByRole("option", { hidden: true, name: /Errand Helper/ }),
  ).toBeTruthy();
  expect(
    view.queryByRole("button", { hidden: true, name: /^Remove / }),
  ).toBeNull();
  expect(view.router.state.location.href).toBe("/channel/new");
});

test("+ with only one Bot still opens the menu with it, and the Bot picked there is the one Enter sends to", async () => {
  const created: unknown[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (
    input: Parameters<typeof fetch>[0],
    init?: RequestInit,
  ) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
      "http://localhost",
    );
    if (url.pathname === "/api/channels" && init?.method === "POST") {
      created.push(JSON.parse(String(init.body)));
      return NativeResponse.json(
        {
          channel: {
            id: "assistant-channel",
            name: "General Assistant",
            agentIds: [GENERAL_ASSISTANT.id],
            threadId: "assistant-thread",
            active: true,
            lastMessageAt: null,
          },
        },
        { status: 201 },
      );
    }
    return NativeResponse.json({ error: "Not here." }, { status: 404 });
  }) as typeof fetch;
  try {
    const view = renderChannelNew(
      queryClientWithEdition([GENERAL_ASSISTANT], "team"),
    );
    await expectPickerOpenAndFocused(view);
    expect(
      view.queryByRole("button", { hidden: true, name: /^Remove / }),
    ).toBeNull();

    fireEvent.click(
      await view.findByRole("option", {
        hidden: true,
        name: /General Assistant/,
      }),
    );
    await view.findByRole("button", {
      hidden: true,
      name: "Remove General Assistant",
    });
    await typeDraft("what changed in the latest release?", view);
    await userEvent.setup({ document }).keyboard("{Enter}");

    await waitFor(() =>
      expect(created).toEqual([{ agentIds: [GENERAL_ASSISTANT.id] }]),
    );
    expect(view.queryByText("Choose a Bot first.")).toBeNull();
  } finally {
    globalThis.fetch = originalFetch;
  }
});
