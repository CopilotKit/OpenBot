import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { CopilotKitProvider } from "@copilotkit/react-core/v2";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  type InfiniteData,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import {
  type AnyRoute,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
  within,
} from "@testing-library/react";
import { ConversationPresenceProvider } from "@/components/channels/conversation-presence";
import { ComputerPaneTitle } from "@/components/computer/computer-panel";
import { ComputerView } from "@/components/computer/computer-view";
import { SidebarProvider } from "@/components/ui/sidebar";
import { type AgentProfile, agentKeys } from "@/lib/agents/queries";
import type { ApprovalInboxData } from "@/lib/approvals";
import { authKeys } from "@/lib/auth/queries";
import {
  type AgentChannel,
  type ChannelPage,
  channelKeys,
} from "@/lib/channels/queries";
import { reportComputerActivity } from "@/lib/copilot/computer-activity";
import { Route as ChannelRoute } from "@/routes/_authed/_app/channel/$channelId";
import { settleReactWork } from "./settle-react-work";

/**
 * The pane beside a conversation that shows its Bot's computer: a header naming whose computer it
 * is, with the Bot's orb, Take control and a dot while the conversation needs the person; the
 * screen; and under it the steps. It is 440px wide beside the conversation, opens itself only when
 * it has room there, and otherwise lights the header's computer button.
 */

let width = 1280;
class Observer implements ResizeObserver {
  constructor(private readonly callback: ResizeObserverCallback) {}
  observe(target: Element) {
    this.callback(
      [
        {
          target,
          contentRect: new DOMRect(0, 0, width, 800),
          borderBoxSize: [],
          contentBoxSize: [],
          devicePixelContentBoxSize: [],
        },
      ],
      this,
    );
  }
  unobserve() {}
  disconnect() {}
}

class OfflineWebSocket extends EventTarget {
  readyState = 0;
  onclose = null;
  onerror = null;
  onmessage = null;
  onopen = null;
  close() {}
  send() {}
}

const originalFetch = globalThis.fetch;
const originalObserver = globalThis.ResizeObserver;
const originalWebSocket = globalThis.WebSocket;
beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  globalThis.ResizeObserver = Observer;
  globalThis.WebSocket = OfflineWebSocket as unknown as typeof WebSocket;
});
afterEach(() => {
  cleanup();
  width = 1280;
  globalThis.fetch = originalFetch;
});
afterAll(async () => {
  await settleReactWork();
  globalThis.ResizeObserver = originalObserver;
  globalThis.WebSocket = originalWebSocket;
  GlobalRegistrator.unregister();
});

const THREAD = "t-1";

function inboxWith(threads: string[]): ApprovalInboxData {
  return {
    enabled: true,
    requests: threads.map((threadId, index) => ({
      id: `r-${index}`,
      status: "pending",
      createdAt: "2026-10-28T00:00:00.000Z",
      action: {
        botId: "ana",
        toolRef: "computer/click",
        effect: "write",
        scope: "external",
        threadId,
        toolCallId: `call-${index}`,
        args: {},
        target: {},
      },
    })),
    rules: [],
    teamRules: [],
    questions: [],
  };
}

function emptyList(): InfiniteData<ChannelPage> {
  return { pages: [{ channels: [], nextCursor: null }], pageParams: [""] };
}

describe("the pane's title", () => {
  function renderTitle(
    name: string | undefined,
    inbox: ApprovalInboxData = inboxWith([]),
  ) {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    client.setQueryData(channelKeys.list(), emptyList());
    client.setQueryData(["approvals"], inbox);
    return render(
      <QueryClientProvider client={client}>
        <ConversationPresenceProvider channelId="c-1" threadId={THREAD}>
          <h2>
            <ComputerPaneTitle agentId="ana" name={name} />
          </h2>
        </ConversationPresenceProvider>
      </QueryClientProvider>,
    );
  }

  test("names whose computer it is, beside that Bot's orb", () => {
    const view = renderTitle("Ana");
    const heading = view.getByRole("heading");
    expect(heading.textContent).toBe("Ana's computer");
    const orb = heading.querySelector("[data-palette]");
    expect(orb).not.toBeNull();
    // The conversation's orb: at rest while nothing is happening.
    expect(orb?.getAttribute("data-state")).toBe("idle");
  });

  test("is the Computer until the Bot's name arrives", () => {
    expect(renderTitle(undefined).getByRole("heading").textContent).toBe(
      "Computer",
    );
  });

  test("carries a dot while an approval waits in this conversation, and only this one", () => {
    const waiting = renderTitle("Ana", inboxWith([THREAD]));
    const dot = waiting.getByRole("img", { name: "Needs you" });
    expect(dot.className).toContain("bg-status-needs");
    cleanup();

    const elsewhere = renderTitle("Ana", inboxWith(["another-thread"]));
    expect(elsewhere.queryByRole("img", { name: "Needs you" })).toBeNull();
  });
});

const ANA: AgentProfile = {
  id: "ana",
  name: "Ana",
  title: "Research",
  roleDescription: "Looks things up.",
  avatarSeed: "ana",
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
const CHANNEL: AgentChannel = {
  id: "c-1",
  // A conversation is named for what it is about; its computer is named for its Bot.
  name: "Q3 budget",
  agentIds: ["ana"],
  threadId: THREAD,
  active: true,
  lastMessageAt: null,
};

const NativeResponse = globalThis.Response;
const control = {
  holder: "bot",
  since: "2026-10-28T00:00:00.000Z",
  requested: false,
  transitioning: false,
  resumeSnapshotRequired: false,
  recoveryRequired: false,
};
function sse(events: unknown[]) {
  return new NativeResponse(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}
async function served(input: Parameters<typeof fetch>[0]) {
  const url = new URL(
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url,
    "http://localhost",
  );
  if (url.pathname === "/api/agents")
    return NativeResponse.json({ agents: [ANA] });
  if (url.pathname === "/api/plugins/for/ana")
    return NativeResponse.json({ skills: [], tools: [] });
  if (url.pathname.endsWith("/info"))
    return NativeResponse.json({
      version: "fixture",
      agents: { ana: { description: "Fixture", capabilities: {} } },
      mode: "sse",
      telemetryDisabled: true,
    });
  if (url.pathname.endsWith("/connect"))
    return sse([
      { type: "RUN_STARTED", threadId: THREAD, runId: "join" },
      { type: "MESSAGES_SNAPSHOT", messages: [] },
      { type: "RUN_FINISHED", threadId: THREAD, runId: "join" },
    ]);
  if (url.pathname.endsWith(`/threads/${THREAD}/messages`))
    return NativeResponse.json({ messages: [] });
  if (url.pathname === "/api/voice/sessions")
    return NativeResponse.json({ sessions: [], nextCursor: null });
  if (url.pathname === "/api/approvals")
    return NativeResponse.json(inboxWith([]));
  if (url.pathname.endsWith("/control")) return NativeResponse.json(control);
  return NativeResponse.json({ error: "not served" }, { status: 404 });
}

/** The conversation route as the app registers it, with its channel and Bot already loaded. */
function renderConversation(path: string) {
  globalThis.fetch = Object.assign(served, {
    preconnect: originalFetch.preconnect,
  });
  const root = createRootRoute({
    component: () => (
      <SidebarProvider>
        <Outlet />
      </SidebarProvider>
    ),
  });
  const authed = createRoute({
    id: "_authed",
    getParentRoute: () => root,
    component: Outlet,
  });
  const app = createRoute({
    id: "_app",
    getParentRoute: () => authed,
    component: Outlet,
  });
  const channel = createRoute({
    path: "channel/$channelId",
    getParentRoute: () => app,
    component: (ChannelRoute as AnyRoute).options.component,
    validateSearch: (ChannelRoute as AnyRoute).options.validateSearch,
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData(authKeys.currentUser(), {
    id: "maya",
    email: "maya@example.com",
    role: "user",
    onboarding: null,
  });
  client.setQueryData(agentKeys.list(false), [ANA]);
  client.setQueryData(channelKeys.detail("c-1"), CHANNEL);
  client.setQueryData(channelKeys.list(), emptyList());
  client.setQueryData(["approvals"], inboxWith([]));
  const router = createRouter({
    routeTree: root.addChildren([
      authed.addChildren([app.addChildren([channel])]),
    ]),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  const view = render(
    <QueryClientProvider client={client}>
      <CopilotKitProvider runtimeUrl="http://localhost/api/copilotkit">
        <RouterProvider router={router as never} />
      </CopilotKitProvider>
    </QueryClientProvider>,
  );
  return { view, router };
}

describe("the Bot's computer beside a conversation", () => {
  test("is 440px wide, with whose computer it is and Take control in its header", async () => {
    const { view } = renderConversation("/channel/c-1?watch=true");
    const pane = await waitFor(() => {
      const found = view.container.querySelector<HTMLElement>(
        '[data-slot="detail-pane"]',
      );
      if (!found) throw new Error("No pane yet");
      return found;
    });
    expect(pane.style.width).toBe("440px");
    const header = pane.querySelector<HTMLElement>(
      '[data-slot="detail-pane-header"]',
    );
    const title = header?.querySelector('[data-slot="detail-pane-title"]');
    await waitFor(() => expect(title?.textContent).toBe("Ana's computer"));
    const take = await within(header as HTMLElement).findByRole("button", {
      name: "Take control",
    });
    expect(take.closest('[data-slot="detail-pane-title"]')).toBeNull();
    // Take control is in the header alone, not again under the screen.
    expect(
      within(pane).getAllByRole("button", { name: "Take control" }),
    ).toHaveLength(1);
    // The screen's badge is the Bot's name, not the conversation's.
    await waitFor(() =>
      expect(within(pane).getByText("The Bot has control.")).toBeTruthy(),
    );
    expect(within(pane).queryByText("Q3 budget")).toBeNull();
    expect(
      within(pane).getByRole("heading", { name: "Activity" }),
    ).toBeTruthy();
  });

  test("opens itself beside the conversation when the Bot starts using it", async () => {
    const { view, router } = renderConversation("/channel/c-1");
    await view.findByRole("button", { name: "Open Computer" });
    act(() => {
      reportComputerActivity("ana");
    });
    await waitFor(() =>
      expect(router.state.location.search).toMatchObject({ watch: true }),
    );
  });

  test("does not cover a narrow conversation: it lights the computer button instead", async () => {
    width = 700;
    const { view, router } = renderConversation("/channel/c-1");
    const button = await view.findByRole("button", { name: "Open Computer" });
    act(() => {
      reportComputerActivity("ana");
    });
    await waitFor(() =>
      expect(within(button).getByRole("img", { name: "In use" })).toBeTruthy(),
    );
    expect(router.state.location.search).not.toMatchObject({ watch: true });
    expect(view.queryByRole("dialog")).toBeNull();

    // Opened by hand, it is a sheet, and the light goes out.
    fireEvent.click(button);
    expect(
      await view.findByRole("dialog", { name: "Ana's computer" }),
    ).toBeTruthy();
    await waitFor(() =>
      expect(view.queryByRole("img", { name: "In use" })).toBeNull(),
    );
  });
});

describe("the screen in the pane", () => {
  // Without an observer the preview counts as on screen, so it polls for its frame.
  let originalIntersectionObserver: typeof IntersectionObserver | undefined;
  let originalDecode: typeof HTMLImageElement.prototype.decode;
  beforeAll(() => {
    originalIntersectionObserver = globalThis.IntersectionObserver;
    originalDecode = HTMLImageElement.prototype.decode;
    Reflect.deleteProperty(globalThis, "IntersectionObserver");
    HTMLImageElement.prototype.decode = () => Promise.resolve();
  });
  afterAll(() => {
    if (originalIntersectionObserver)
      globalThis.IntersectionObserver = originalIntersectionObserver;
    HTMLImageElement.prototype.decode = originalDecode;
  });

  function screenServer(state: Record<string, unknown>) {
    globalThis.fetch = Object.assign(
      async (input: Parameters<typeof fetch>[0]) => {
        const path = String(input);
        if (path.endsWith("/control"))
          return NativeResponse.json({ ...control, ...state });
        if (path.endsWith("/screenshot"))
          return NativeResponse.json({
            base64: "AAAA",
            width: 320,
            height: 200,
            capturedAt: new Date(0).toISOString(),
            url: "https://accounts.example.com/login",
          });
        return NativeResponse.json({ error: "not served" }, { status: 404 });
      },
      { preconnect: originalFetch.preconnect },
    );
  }
  function renderScreen(wheelInHeader = false) {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    return render(
      <QueryClientProvider client={client}>
        <ComputerView
          active
          computerId="ana"
          intervalMs={10}
          name="Ana"
          wheelInHeader={wheelInHeader}
        />
      </QueryClientProvider>,
    );
  }

  test("asks for a secret for the page, and says it goes only there, never naming a site it can't vouch for", async () => {
    screenServer({ secretWanted: "the code sent to your phone" });
    const view = renderScreen();
    expect(
      await view.findByText("The page needs the code sent to your phone"),
    ).toBeTruthy();
    expect(
      view.getByText("It goes straight to the page. Ana never sees it."),
    ).toBeTruthy();
    const field = view.getByLabelText(
      /The page needs the code sent to your phone/,
    );
    expect(field.getAttribute("type")).toBe("password");
    expect(view.getByRole("button", { name: "Send to the page" })).toBeTruthy();
  });

  test("with Take control in the header, under the screen it only says who has control", async () => {
    screenServer({});
    const view = renderScreen(true);
    expect(await view.findByText("The Bot has control.")).toBeTruthy();
    expect(view.queryByRole("button", { name: "Take control" })).toBeNull();
  });
});
