import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
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
  useRouterState,
} from "@tanstack/react-router";
import {
  cleanup,
  fireEvent,
  render,
  waitFor,
  within,
} from "@testing-library/react";
import type { AgentProfile } from "@/lib/agents/queries";
import type { ApprovalInboxData } from "@/lib/approvals";
import type { BotActivity, BotAttention } from "@/lib/bot-lifecycle/queries";
import type { ChannelSummary } from "@/lib/channels/queries";
import { appConfig } from "@/lib/generated/application-config";
import type { MemoryRecord } from "@/lib/memory";
import { navigationFor } from "@/lib/navigation";
import type { PluginsPage } from "@/lib/plugins/queries";
import type { ProactiveSetting, ProactiveSuggestion } from "@/lib/proactive";
import type { ResponsibilityRecord } from "@/lib/responsibilities";
import type { RoutineRecord } from "@/lib/routines/queries";
import { openmuse } from "@/skins/openmuse";
import {
  chooseBot,
  chosenBotKey,
  forgetChosenBots,
} from "@/skins/openmuse/chosen-bot";
import { OpenMuseFrame } from "@/skins/openmuse/frame";
import {
  centreBot,
  mainChannel,
  statusLine,
  tabFor,
} from "@/skins/openmuse/model";
import { SKINS } from "@/skins/registry";

/*
 * The OpenMuse frame against OpenBot's own API shapes. Every payload below is what the server's
 * route returns, envelope and all, so the frame reads it through the same query factories the rest
 * of the app uses. What is checked is what a person sees and can reach.
 */

/** The deployment's own name, from brand.yaml. The skin never names itself. */
const PRODUCT = appConfig.brand.productName;

beforeAll(() => GlobalRegistrator.register());
afterAll(() => GlobalRegistrator.unregister());

const originalFetch = globalThis.fetch;
const originalSocket = globalThis.WebSocket;

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  globalThis.WebSocket = originalSocket;
  window.localStorage.clear();
  forgetChosenBots();
});

const now = new Date().toISOString();
const earlier = new Date(Date.now() - 3_600_000).toISOString();

function agent(
  overrides: Partial<AgentProfile> & { id: string },
): AgentProfile {
  return {
    avatarSeed: overrides.id,
    builtIn: true,
    canManage: true,
    endpoint: null,
    hasAuth: false,
    hasCallbackToken: false,
    hidden: false,
    pinned: false,
    mine: true,
    name: overrides.id,
    roleDescription: "",
    systemOwned: false,
    title: "",
    visibility: "private",
    isolated: false,
    isolationActive: false,
    isolationOffReason: null,
    ...overrides,
  };
}

function channel(
  overrides: Partial<ChannelSummary> & { id: string; agentIds: string[] },
): ChannelSummary {
  return {
    name: "Conversation",
    threadId: `thread-${overrides.id}`,
    active: true,
    lastMessageAt: earlier,
    summary: null,
    lastMessage: null,
    lastMessageAgentId: null,
    createdAt: earlier,
    pinned: false,
    lastReadAt: earlier,
    ...overrides,
  };
}

const scout = agent({ id: "scout", name: "Scout", title: "Research" });
// OpenBot's default Bot: `defaultAgentProfile` prefers the picked harness over list order.
const muse = agent({
  id: "picked-harness",
  name: "Muse",
  title: "Your helper",
});

const channels = [
  channel({
    id: "c-muse",
    agentIds: [muse.id],
    name: "Muse",
    summary: "Planning the week",
  }),
  channel({
    id: "c-scout",
    agentIds: [scout.id],
    name: "Scout",
    summary: "Competitor notes",
    busy: true,
  }),
  channel({
    id: "g-team",
    agentIds: [muse.id, scout.id],
    name: "Team",
    summary: "Launch plan",
  }),
];

const inbox: ApprovalInboxData = {
  enabled: true,
  rules: [],
  teamRules: [],
  questions: [],
  requests: [
    {
      id: "r-pending",
      status: "pending",
      createdAt: now,
      action: {
        botId: muse.id,
        toolRef: "computer_open_url",
        effect: "read",
        scope: "https://example.com",
        threadId: "thread-c-muse",
        args: { url: "https://example.com" },
        target: null,
      },
    },
    {
      id: "r-done",
      status: "consumed",
      createdAt: earlier,
      action: {
        botId: muse.id,
        toolRef: "send_email",
        effect: "write",
        scope: "mail",
        threadId: "thread-c-muse",
        args: {},
        target: null,
      },
    },
  ],
};

const attention: BotAttention[] = [
  {
    agentId: muse.id,
    name: muse.name,
    questions: 0,
    approvals: 1,
    handoffs: 0,
    unread: 0,
    paused: false,
    notify: "all",
  },
  {
    agentId: scout.id,
    name: scout.name,
    questions: 0,
    approvals: 0,
    handoffs: 0,
    unread: 1,
    paused: false,
    notify: "all",
  },
];

const activity: BotActivity = {
  inProgress: [
    {
      id: "a-live",
      kind: "routine",
      title: "Morning briefing",
      detail: "Reading the overnight news",
      status: "running",
      at: now,
      channelId: "c-muse",
      needsYou: false,
      stoppable: false,
      cancellable: false,
    },
  ],
  scheduled: [],
  completed: [
    {
      id: "a-done",
      kind: "handoff",
      title: "Draft the launch post",
      detail: null,
      status: "succeeded",
      at: earlier,
      channelId: null,
      needsYou: false,
      stoppable: false,
      cancellable: false,
    },
  ],
};

const settings: ProactiveSetting[] = [
  {
    id: "p-muse",
    agentId: muse.id,
    channelId: "c-muse",
    focus: "",
    enabled: true,
    intervalMinutes: 240,
    nextRunAt: now,
    lastRunAt: earlier,
    lastStatus: "succeeded",
    lastError: null,
  },
];

const suggestions: ProactiveSuggestion[] = [
  {
    id: "s-muse",
    agentId: muse.id,
    title: "Book a table for Friday dinner",
    detail: "Jamie asked about Friday.\nThe thread is in your inbox.",
    sourceApp: "Gmail",
    sourceLink: "https://mail.example.com/thread/1",
    createdAt: now,
  },
  {
    id: "s-scout",
    agentId: scout.id,
    title: "Compare pricing pages",
    detail: "A competitor changed theirs.",
    sourceApp: null,
    sourceLink: null,
    createdAt: now,
  },
];

const routines: RoutineRecord[] = [
  {
    id: "rt-1",
    agentId: muse.id,
    schedule: "Every weekday at 9:00",
    timezone: "Europe/London",
    instruction: "Send me the headlines",
    channel: { id: "c-muse", name: "Muse", gone: false },
    enabled: true,
    nextRunAt: now,
    lastRun: null,
  },
];

const responsibilities: ResponsibilityRecord[] = [
  {
    id: "g-1",
    agentId: muse.id,
    channelId: "c-muse",
    threadId: "thread-c-muse",
    title: "Keep my inbox at zero",
    instruction: "Triage new mail each morning",
    successCriteria: "Nothing unread by noon",
    status: "active",
    progress: "Down to 4 unread",
    lastResult: null,
    subscriptions: [],
    updatedAt: now,
  },
  {
    id: "g-scout",
    agentId: scout.id,
    channelId: "c-scout",
    threadId: "thread-c-scout",
    title: "Watch the competition",
    instruction: "",
    successCriteria: "",
    status: "active",
    progress: "",
    lastResult: null,
    subscriptions: [],
    updatedAt: now,
  },
];

const memories: MemoryRecord[] = [
  {
    id: "m-1",
    content: "Prefers morning meetings",
    provenance: "You told Muse",
    sourceId: null,
    enabled: true,
    reviewState: "confirmed",
    formedBy: "person",
    formedByAgentId: null,
    sourceApp: null,
    sourceLink: null,
    observedAt: null,
    updatedAt: earlier,
  },
];

const plugins: PluginsPage = {
  catalogue: [
    {
      key: "notion",
      title: "Notion",
      vendor: "Notion",
      summary: "Pages and databases",
      docsUrl: "",
      auth: "user-oauth",
      perInstance: false,
    },
    {
      key: "google-drive",
      title: "Google Drive",
      vendor: "Google",
      summary: "Files",
      docsUrl: "",
      auth: "user-oauth",
      perInstance: false,
    },
  ],
  servers: [
    { id: "notion" },
    { id: "google-drive" },
  ] as unknown as PluginsPage["servers"],
  skills: [],
  botsMayCallBack: false,
  redirectUri: null,
  composioConfigured: false,
  authorizesPerAction: false,
};

type Call = { method: string; path: string; body: unknown };

function serve(options: { role?: "admin" | "user"; userId?: string } = {}) {
  const calls: Call[] = [];
  const routes: Record<string, unknown> = {
    "/api/me": {
      user: {
        id: options.userId ?? "u-1",
        email: "alex@example.com",
        name: "Alex Rivera",
        role: options.role ?? "admin",
        onboarding: null,
      },
    },
    "/api/agents": { agents: [scout, muse] },
    "/api/channels": { channels, nextCursor: null },
    "/api/approvals": inbox,
    "/api/bots/attention": { bots: attention },
    [`/api/bots/${muse.id}/activity`]: { activity },
    [`/api/bots/${scout.id}/activity`]: {
      activity: { inProgress: [], scheduled: [], completed: [] },
    },
    "/api/proactive/settings": { settings },
    "/api/proactive/suggestions": { suggestions },
    "/api/routines": {
      routines,
      sweep: { lastSweptAt: now, working: true },
    },
    "/api/responsibilities": { responsibilities },
    "/api/memory": { memories },
    "/api/plugins": plugins,
    "/api/plugins/connections": {
      connections: [{ serverId: "notion", holder: "person" }],
      redirectUri: null,
    },
    "/api/identity/links": { links: [] },
    "/api/identity/providers": { providers: { slack: false, github: false } },
    "/api/capabilities": {},
    "/api/settings/preferences": { preferences: {} },
  };
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = typeof input === "string" ? input : input.toString();
      const method = init?.method ?? "GET";
      calls.push({
        method,
        path,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      if (method !== "GET") return Response.json({ ok: true });
      const detail = path.match(/^\/api\/channels\/([^/?]+)$/);
      if (detail) {
        const found = channels.find((row) => row.id === detail[1]);
        return found
          ? Response.json({ channel: found })
          : Response.json({ error: "Not found" }, { status: 404 });
      }
      if (path in routes) return Response.json(routes[path]);
      return Response.json({ error: "Not here" }, { status: 404 });
    },
    { preconnect: originalFetch.preconnect },
  );
  // A socket that never opens: the roster is then exactly what the API returned.
  globalThis.WebSocket = class {
    close() {}
  } as unknown as typeof WebSocket;
  return calls;
}

/** The page under the frame. OpenBot's own pages are stood in for by their path. */
function Page() {
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  return <p data-testid="page">OpenBot page {pathname}</p>;
}

function renderAt(path: string) {
  const root = createRootRoute({ component: Outlet });
  const app = createRoute({
    getParentRoute: () => root,
    id: "app",
    component: () => (
      <OpenMuseFrame>
        <Outlet />
      </OpenMuseFrame>
    ),
  });
  const skinScreen = createRoute({
    getParentRoute: () => app,
    path: "/s/$screen",
    component: function SkinScreen() {
      // The same lookup `/s/$screen` makes for the active skin.
      const { screen: key } = skinScreen.useParams();
      const Screen = openmuse.screens?.[key];
      return Screen ? <Screen /> : <Page />;
    },
  });
  const channelRoute = createRoute({
    getParentRoute: () => app,
    path: "/channel/$channelId",
    component: Page,
  });
  const anything = createRoute({
    getParentRoute: () => app,
    path: "$",
    component: Page,
  });
  const home = createRoute({
    getParentRoute: () => app,
    path: "/",
    component: Page,
  });
  const router = createRouter({
    routeTree: root.addChildren([
      app.addChildren([home, skinScreen, channelRoute, anything]),
    ]),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

/*
 * Testing Library's `screen` binds to the document that existed when it was imported, which is
 * before `beforeAll` registers happy-dom; this binds to the document of the moment instead.
 */
const page = () => within(document.body);

const hrefOf = (name: string | RegExp) =>
  page().getByRole("link", { name }).getAttribute("href");

async function openMenu() {
  fireEvent.click(
    await page().findByRole("button", { name: "Open conversations and menu" }),
  );
  return page().findByRole("dialog");
}

describe("OpenMuse is a registered skin with its own frame", () => {
  test("the registry hands OpenBot the frame and the three skin screens", () => {
    expect(SKINS.openmuse.Frame).toBe(OpenMuseFrame);
    // Apps is OpenBot's own Connections page, so the skin adds three screens, not four.
    expect(Object.keys(SKINS.openmuse.screens ?? {}).sort()).toEqual([
      "activity",
      "goals",
      "ideas",
    ]);
  });
});

describe("the frame", () => {
  test("centres OpenBot's default Bot, with what it is waiting on", async () => {
    serve();
    renderAt("/connections");
    const centre = await page().findByRole("button", {
      name: /^Muse, Ready to review · 1 approval\. Switch Bot$/,
    });
    expect(centre.textContent).toContain("Muse");
    expect(page().getByTestId("openmuse-status").textContent).toBe(
      "Ready to review · 1 approval",
    );
    // The bell carries the one pending approval.
    expect(
      page().getByRole("button", { name: "Needs you, 1 waiting" }),
    ).toBeTruthy();
  });

  test("a one-to-one conversation puts its own Bot at the centre", async () => {
    serve();
    renderAt("/channel/c-scout");
    await page().findByRole("button", { name: /^Scout, .*Switch Bot$/ });
    // Scout has a turn running in its channel; the line says so.
    await waitFor(() =>
      expect(page().getByTestId("openmuse-status").textContent).toBe(
        "Working on Competitor notes…",
      ),
    );
    expect(page().getByTestId("page").textContent).toBe(
      "OpenBot page /channel/c-scout",
    );
  });

  test("the five tabs lead to OpenBot's chat and the skin's own screens", async () => {
    serve();
    renderAt("/s/goals");
    const nav = await page().findByRole("navigation", { name: PRODUCT });
    const tabs = within(nav);
    // Chat is the centre Bot's main chat: its one-to-one conversation.
    await waitFor(() =>
      expect(
        tabs.getByRole("link", { name: "Chat" }).getAttribute("href"),
      ).toBe("/channel/c-muse"),
    );
    expect(
      tabs.getByRole("link", { name: "Activity" }).getAttribute("href"),
    ).toBe("/s/activity");
    expect(tabs.getByRole("link", { name: "Ideas" }).getAttribute("href")).toBe(
      "/s/ideas",
    );
    expect(
      tabs.getByRole("link", { name: "Goals" }).getAttribute("aria-current"),
    ).toBe("page");
    expect(tabs.getByRole("link", { name: "Apps" }).getAttribute("href")).toBe(
      "/connections",
    );
  });

  test.each([
    ["/s/activity", "Activity"],
    ["/s/ideas", "Ideas"],
    ["/s/goals", "Goals"],
    ["/connections", "Apps"],
    ["/channel/c-muse", "Chat"],
    ["/routines", null],
    ["/settings/approvals", null],
    ["/bots/scout/setup", null],
    ["/capabilities/memory", null],
  ])("on %s the current tab is %s", async (path, current) => {
    serve();
    renderAt(path);
    const nav = await page().findByRole("navigation", { name: PRODUCT });
    await within(nav).findByRole("link", { name: "Chat" });
    const marked = within(nav)
      .getAllByRole("link")
      .filter((link) => link.getAttribute("aria-current") === "page")
      .map((link) => link.getAttribute("aria-label"));
    expect(marked).toEqual(current ? [current] : []);
  });

  test.each([
    ["/s/goals", "column"],
    ["/connections", "column"],
    ["/channel/c-muse", "column"],
    // The Bot's computer open beside the conversation needs OpenBot's own width.
    ["/channel/c-muse?watch=true", "page"],
    ["/channel/c-muse?settings=true", "page"],
    ["/bots/scout/setup", "page"],
    ["/routines", "page"],
  ])("%s is drawn at the %s width", async (path, width) => {
    serve();
    renderAt(path);
    await page().findByRole("navigation", { name: PRODUCT });
    expect(
      document
        .querySelector(".openmuse-stage")
        ?.getAttribute("data-openmuse-width"),
    ).toBe(width);
  });

  test("the chosen Bot is remembered per person, not per machine", async () => {
    serve({ userId: "u-1" });
    renderAt("/s/activity");
    fireEvent.click(await page().findByRole("button", { name: /Switch Bot$/ }));
    fireEvent.click(
      within(await page().findByRole("dialog")).getByRole("button", {
        name: /Scout/,
      }),
    );
    await page().findByRole("button", { name: /^Scout, / });
    expect(window.localStorage.getItem(chosenBotKey("u-1"))).toBe(scout.id);
    cleanup();
    // The next person on this browser starts from OpenBot's default Bot.
    forgetChosenBots();
    serve({ userId: "u-2" });
    renderAt("/s/activity");
    await page().findByRole("button", { name: /^Muse, / });
    expect(window.localStorage.getItem(chosenBotKey("u-2"))).toBeNull();
  });

  test("Chat opens a new conversation with a Bot that has none yet", async () => {
    serve();
    chooseBot("u-1", scout.id);
    const roster = channels.filter((row) => row.id !== "c-scout");
    globalThis.fetch = (() => {
      const real = globalThis.fetch;
      return Object.assign(
        (input: RequestInfo | URL, init?: RequestInit) =>
          String(input) === "/api/channels"
            ? Promise.resolve(
                Response.json({ channels: roster, nextCursor: null }),
              )
            : real(input, init),
        { preconnect: originalFetch.preconnect },
      );
    })();
    renderAt("/s/ideas");
    const nav = await page().findByRole("navigation", { name: PRODUCT });
    await page().findByRole("button", { name: /^Scout, / });
    await waitFor(() =>
      expect(
        within(nav).getByRole("link", { name: "Chat" }).getAttribute("href"),
      ).toBe("/channel/new?agent=scout"),
    );
  });
});

describe("the frame wears the deployment's brand, not OpenMuse's", () => {
  /** Everything a person can read or hear: the text, and every name, label and alt text. */
  function readable() {
    const attributes = [...document.body.querySelectorAll("*")].flatMap(
      (element) =>
        ["aria-label", "alt", "title", "placeholder"]
          .map((name) => element.getAttribute(name))
          .filter((value): value is string => Boolean(value)),
    );
    return [document.body.textContent ?? "", ...attributes].join("\n");
  }

  function capybaras() {
    return [...document.body.querySelectorAll("img")].filter((image) =>
      /capybara|mascot/i.test(
        `${image.getAttribute("src")} ${image.getAttribute("alt")}`,
      ),
    );
  }

  test.each([
    "/",
    "/channel/c-muse",
    "/s/activity",
    "/s/ideas",
    "/s/goals",
    "/connections",
  ])(
    "%s shows the deployment's name, never OpenMuse, and no capybara",
    async (path) => {
      serve();
      renderAt(path);
      // The tab bar is named for the deployment, and so is the menu.
      await page().findByRole("navigation", { name: PRODUCT });
      const menu = within(await openMenu());
      expect(menu.getByRole("heading", { name: PRODUCT })).toBeTruthy();
      await menu.findByText("Planning the week");
      expect(readable()).toContain(PRODUCT);
      expect(readable()).not.toMatch(/openmuse/i);
      expect(capybaras()).toEqual([]);
    },
  );

  test("the centre Bot is drawn with its own OpenBot avatar", async () => {
    serve();
    renderAt("/connections");
    const centre = await page().findByRole("button", { name: /Switch Bot$/ });
    // AbstractAvatar names the drawing after the Bot, as on its OpenBot page.
    expect(within(centre).getByRole("img", { name: "Muse" })).toBeTruthy();
    expect(capybaras()).toEqual([]);
  });

  test("with no Bot yet, the deployment's name and mark stand at the centre", async () => {
    serve();
    const real = globalThis.fetch;
    globalThis.fetch = Object.assign(
      (input: RequestInfo | URL, init?: RequestInit) =>
        String(input) === "/api/agents"
          ? Promise.resolve(Response.json({ agents: [] }))
          : real(input, init),
      { preconnect: originalFetch.preconnect },
    );
    renderAt("/s/activity");
    const centre = await page().findByRole("button", { name: "Choose a Bot" });
    await waitFor(() => expect(centre.textContent).toContain(PRODUCT));
    expect(readable()).not.toMatch(/openmuse/i);
    expect(capybaras()).toEqual([]);
  });
});

describe("every OpenBot surface stays reachable", () => {
  // A row's name is its title and then its one line of detail, so each is matched from its start.
  const surfaces: [RegExp, string][] = [
    [/^Main chat/, "/channel/c-muse"],
    [/^New chat$/, "/channel/new?agent=picked-harness"],
    [/^New group$/, "/channel/new"],
    [/^Home$/, "/"],
    // OpenBot's own destinations, from the shared navigation list its sidebar draws.
    [/^Bots$/, "/bots"],
    [/^Capabilities$/, "/capabilities"],
    [/^Connections$/, "/connections"],
    [/^Admin$/, "/admin"],
    [/^Settings$/, "/settings"],
  ];

  test("the menu reaches every surface, every conversation and every group", async () => {
    serve({ role: "admin" });
    renderAt("/s/activity");
    const menu = within(await openMenu());
    await menu.findByText("Planning the week");
    for (const [name, href] of surfaces) {
      expect([
        String(name),
        menu.getByRole("link", { name }).getAttribute("href"),
      ]).toEqual([String(name), href]);
    }
    expect(
      menu
        .getByRole("link", { name: /Planning the week/ })
        .getAttribute("href"),
    ).toBe("/channel/c-muse");
    expect(
      menu.getByRole("link", { name: /Competitor notes/ }).getAttribute("href"),
    ).toBe("/channel/c-scout");
    expect(
      menu.getByRole("link", { name: /Launch plan/ }).getAttribute("href"),
    ).toBe("/group/g-team");
  });

  test.each(["admin", "user"] as const)(
    "the menu draws OpenBot's whole navigation list for a %s",
    async (role) => {
      serve({ role });
      renderAt("/s/goals");
      const menu = within(await openMenu());
      await menu.findByRole("link", { name: /^Settings$/ });
      for (const item of navigationFor(role)) {
        expect(
          menu
            .getByRole("link", { name: new RegExp(`^${item.label}$`) })
            .getAttribute("href"),
        ).toBe(item.to);
      }
    },
  );

  test("Admin is offered only to administrators", async () => {
    serve({ role: "user" });
    renderAt("/s/activity");
    const menu = within(await openMenu());
    await menu.findByRole("link", { name: /^Settings$/ });
    expect(menu.queryByRole("link", { name: /^Admin$/ })).toBeNull();
  });

  test.each([
    "/",
    "/channel/c-muse",
    "/s/activity",
    "/s/ideas",
    "/s/goals",
    "/connections",
    "/bots/scout/setup",
  ])("Settings is one tap behind the menu on %s", async (path) => {
    serve();
    const router = renderAt(path);
    const menu = within(await openMenu());
    const settings = await menu.findByRole("link", { name: /^Settings$/ });
    expect(settings.getAttribute("href")).toBe("/settings");
    fireEvent.click(settings);
    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/settings"),
    );
  });

  test("the Bot switcher reaches each Bot's page, the roster and a new Bot", async () => {
    serve();
    renderAt("/connections");
    fireEvent.click(await page().findByRole("button", { name: /Switch Bot$/ }));
    const sheet = within(await page().findByRole("dialog"));
    expect(hrefOf(/^Muse's page/)).toBe("/bots/picked-harness");
    expect(
      sheet.getByRole("link", { name: /^All Bots/ }).getAttribute("href"),
    ).toBe("/bots");
    expect(
      sheet.getByRole("link", { name: /^New Bot/ }).getAttribute("href"),
    ).toBe("/bots?new=true");
    // A Bot that is waiting on the person says so; one with only unread messages does not.
    expect(sheet.getByText("Needs you · 1 approval")).toBeTruthy();
    expect(sheet.getByText("1 unread")).toBeTruthy();
    expect(sheet.queryByText(/Needs you · 1 unread/)).toBeNull();
    // Choosing Scout moves it to the centre.
    fireEvent.click(sheet.getByRole("button", { name: /Scout/ }));
    await page().findByRole("button", { name: /^Scout, / });
  });
});

describe("each tab is OpenBot's own sections for the centre Bot", () => {
  test("Activity shows what the Bot waits on you for, and its work", async () => {
    serve();
    renderAt("/s/activity");
    // OpenBot's Needs you section, with OpenBot's own approval and its details always shown.
    expect(await page().findByText("Muse wants to open url")).toBeTruthy();
    expect(page().getByText(/"url": "https:\/\/example.com"/)).toBeTruthy();
    // OpenBot's activity sections for the Bot.
    expect(await page().findByText("Morning briefing")).toBeTruthy();
    expect(page().getByText("Draft the launch post")).toBeTruthy();
    expect(page().getByRole("heading", { name: "In progress" })).toBeTruthy();
    expect(page().getByRole("heading", { name: "Completed" })).toBeTruthy();
  });

  test("Ideas shows only the centre Bot's suggestions and starts one through OpenBot", async () => {
    const calls = serve();
    renderAt("/s/ideas");
    expect(
      await page().findByText("Book a table for Friday dinner"),
    ).toBeTruthy();
    expect(page().queryByText("Compare pricing pages")).toBeNull();
    // OpenBot's own background-research section for the Bot sits under the suggestions.
    expect(
      page().getByRole("heading", { name: "Background research" }),
    ).toBeTruthy();
    fireEvent.click(page().getByRole("button", { name: "Start as task" }));
    await waitFor(() =>
      expect(
        calls.some(
          (call) =>
            call.method === "POST" &&
            call.path === "/api/proactive/suggestions/s-muse/start",
        ),
      ).toBe(true),
    );
  });

  test("Goals shows the centre Bot's routines and responsibilities", async () => {
    serve();
    renderAt("/s/goals");
    expect(await page().findByText("Send me the headlines")).toBeTruthy();
    expect(await page().findByText("Keep my inbox at zero")).toBeTruthy();
    expect(page().queryByText("Watch the competition")).toBeNull();
  });

  test("a routine is paused from Goals through OpenBot's own switch", async () => {
    const calls = serve();
    renderAt("/s/goals");
    fireEvent.click(
      await page().findByRole("switch", {
        name: "Enable the routine scheduled Every weekday at 9:00",
      }),
    );
    await waitFor(() =>
      expect(calls).toContainEqual({
        method: "PUT",
        path: "/api/routines/rt-1/enabled",
        body: { enabled: false },
      }),
    );
  });

  test("the bell lists what is waiting and decides through OpenBot's approvals", async () => {
    const calls = serve();
    renderAt("/s/goals");
    fireEvent.click(
      await page().findByRole("button", { name: "Needs you, 1 waiting" }),
    );
    const sheet = within(await page().findByRole("dialog"));
    expect(await sheet.findByText("Muse wants to open url")).toBeTruthy();
    // What it will send is always on screen, as in OpenBot.
    expect(sheet.getByText(/"url": "https:\/\/example.com"/)).toBeTruthy();
    expect(sheet.queryByText(/send email/)).toBeNull();
    fireEvent.click(sheet.getByRole("button", { name: "Allow once" }));
    await waitFor(() =>
      expect(calls).toContainEqual({
        method: "POST",
        path: "/api/approvals/r-pending/decision",
        body: { decision: "allow_once" },
      }),
    );
  });
});

describe("the rules the frame runs on", () => {
  test("the centre follows the conversation, then the choice, then OpenBot's default", () => {
    const agents = [scout, muse];
    expect(centreBot(agents, null, undefined)?.id).toBe(muse.id);
    expect(centreBot(agents, scout.id, undefined)?.id).toBe(scout.id);
    expect(centreBot(agents, muse.id, scout.id)?.id).toBe(scout.id);
    expect(centreBot(agents, "deleted-bot", undefined)?.id).toBe(muse.id);
    expect(centreBot([], null, undefined)).toBeUndefined();
  });

  test("a group is never a Bot's main chat", () => {
    expect(mainChannel(muse.id, channels)?.id).toBe("c-muse");
    expect(mainChannel("nobody", channels)).toBeUndefined();
    expect(
      mainChannel(
        muse.id,
        channels.filter((row) => row.id !== "c-muse"),
      ),
    ).toBeUndefined();
  });

  test("only a tab's own screen lights that tab", () => {
    expect(tabFor("/")).toBe("chat");
    expect(tabFor("/channel/new")).toBe("chat");
    expect(tabFor("/group/g-team")).toBe("chat");
    expect(tabFor("/s/activity")).toBe("activity");
    expect(tabFor("/s/ideas")).toBe("ideas");
    expect(tabFor("/s/goals")).toBe("goals");
    expect(tabFor("/connections")).toBe("apps");
    expect(tabFor("/connections/notion")).toBe("apps");
    expect(tabFor("/routines")).toBeNull();
    expect(tabFor("/settings/approvals")).toBeNull();
    expect(tabFor("/bots/scout/setup")).toBeNull();
    expect(tabFor("/capabilities/skills")).toBeNull();
    expect(tabFor("/s/apps")).toBeNull();
  });

  test("something waiting on the person outranks work in progress", () => {
    const busy = [
      channel({ id: "x", agentIds: ["b"], busy: true, summary: "Report" }),
    ];
    const base = {
      agentId: "b",
      name: "B",
      questions: 0,
      approvals: 0,
      handoffs: 0,
      unread: 0,
      paused: false,
      notify: "all" as const,
    };
    expect(
      statusLine({ attention: undefined, channels: busy, agentId: "b" }),
    ).toBe("Working on Report…");
    expect(
      statusLine({
        attention: { ...base, questions: 2 },
        channels: busy,
        agentId: "b",
      }),
    ).toBe("Needs your input · 2 questions");
    expect(
      statusLine({
        attention: { ...base, approvals: 1 },
        channels: busy,
        agentId: "b",
      }),
    ).toBe("Ready to review · 1 approval");
    expect(
      statusLine({
        attention: { ...base, paused: true },
        channels: [],
        agentId: "b",
      }),
    ).toBe("Paused");
    expect(statusLine({ attention: base, channels: [], agentId: "b" })).toBe(
      "Ready when you are",
    );
  });
});
