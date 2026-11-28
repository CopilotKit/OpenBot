import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
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
} from "@tanstack/react-router";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ReactNode, useEffect, useState } from "react";
import { NativeSignedOut } from "@/components/auth/native-signed-out";
import { ShellAccountMenu } from "@/components/layout/native-shell-account";
import { ShellBackButton } from "@/components/layout/native-shell-back";
import { ShellBots } from "@/components/layout/native-shell-panels";
import { PageShell } from "@/components/layout/page-shell";
import { SidebarToggleBar } from "@/components/layout/sidebar-toggle";
import {
  NOTIFY_PROMPT_KEY,
  NotifyPrompt,
} from "@/components/notifications/notify-prompt";
import { useDesktopOpenRequests } from "@/lib/desktop/open-requests";
import {
  forgetReadyForTests,
  useNativeShellRouteReports,
} from "@/lib/native-shell/route-reports";
import { forgetNativeShellForTests } from "@/lib/native-shell/shell";
import {
  forgetTabStacksForTests,
  useTabNavigation,
} from "@/lib/native-shell/use-tab-navigation";
import {
  notificationPermission,
  refreshNotificationPermission,
} from "@/lib/notifications/permission";
import { webPushSupport } from "@/lib/web-push/browser";
import { queryClient } from "@/query-client";
import { Route as AppRoute } from "@/routes/_authed/_app";
import { Route as ConversationsRoute } from "@/routes/_authed/_app/conversations";
import { signsInNatively } from "@/routes/sign";
import { ME_PATH, meBody } from "./accounts-api";
import { DEPLOYMENT_PATH } from "./admin-settings-api";
import {
  CONVERSATIONS_PATH,
  conversationPage,
  TASKS_PATH,
} from "./conversations-api";
import { settleReactWork } from "./settle-react-work";

/*
 * The web app inside the phone app's native shell (lib/native-shell): the page alone, with no
 * sidebar; the Conversations page the shell's Conversations tab opens; the quiet sign-in page; and
 * what the shell is told. And outside the shell, the app as it was.
 */

beforeAll(() => GlobalRegistrator.register({ url: "http://127.0.0.1:3010/" }));
afterAll(async () => {
  cleanup();
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const originalFetch = global.fetch;
const originalSocket = globalThis.WebSocket;
afterEach(() => {
  cleanup();
  global.fetch = originalFetch;
  globalThis.WebSocket = originalSocket;
  inShell(false);
});

/** Puts the page in the shell (as its injected object says) or takes it out. */
function inShell(on: boolean) {
  const page = window as {
    __OPENBOT_NATIVE_SHELL__?: unknown;
    webkit?: unknown;
  };
  if (on)
    page.__OPENBOT_NATIVE_SHELL__ = {
      platform: "ios",
      version: "0.1",
      bridge: 1,
    };
  else delete page.__OPENBOT_NATIVE_SHELL__;
  delete page.webkit;
  forgetNativeShellForTests();
  forgetReadyForTests();
  forgetTabStacksForTests();
}

/** What the shell is told, as its iOS handler receives it. */
function listen(): unknown[] {
  const heard: unknown[] = [];
  (window as { webkit?: unknown }).webkit = {
    messageHandlers: {
      openbotShell: { postMessage: (message: unknown) => heard.push(message) },
    },
  };
  return heard;
}

let sockets = 0;
class QuietSocket {
  onopen: unknown = null;
  onclose: unknown = null;
  onmessage: unknown = null;
  onerror: unknown = null;
  constructor() {
    sockets += 1;
  }
  close() {}
  send() {}
}

const now = "2026-11-27T10:00:00.000Z";
function channel(
  id: string,
  summary: string,
  { pinned = false, unread = false } = {},
) {
  return {
    id,
    name: "Research Bot",
    agentIds: ["b-1"],
    threadId: `t-${id}`,
    active: true,
    lastMessageAt: now,
    summary,
    opening: null,
    lastMessage: summary,
    lastMessageAgentId: "b-1",
    createdAt: now,
    pinned,
    lastReadAt: unread ? "2026-11-27T09:00:00.000Z" : now,
    canRename: true,
    task: false,
    work: [],
  };
}

/** The API, answering the conversation list with `list` (a status for a failure, or never). */
function serve(list: ReturnType<typeof channel>[] | number | "never") {
  global.fetch = (async (input: RequestInfo | URL) => {
    const path = new URL(String(input), "http://127.0.0.1:3010").pathname;
    if (path === CONVERSATIONS_PATH) {
      if (list === "never") return new Promise<Response>(() => {});
      if (typeof list === "number")
        return Response.json(
          { detail: "Couldn't load your conversations." },
          { status: list },
        );
      return Response.json(conversationPage(list));
    }
    if (path === ME_PATH)
      return Response.json(
        meBody({
          user: { id: "sam", name: "Sam Rivera", email: "sam@example.com" },
        }),
      );
    if (path === DEPLOYMENT_PATH)
      return Response.json({ edition: "team", localEvaluation: false });
    if (path === TASKS_PATH)
      return Response.json({ tasks: [], nextCursor: null });
    return Response.json({ detail: "not served" }, { status: 404 });
  }) as typeof fetch;
  sockets = 0;
  globalThis.WebSocket = QuietSocket as unknown as typeof WebSocket;
}

function Reports({ children }: { children: ReactNode }) {
  useNativeShellRouteReports();
  useDesktopOpenRequests();
  useTabNavigation();
  return children;
}

/** The app's `_authed/_app` frame around a few pages, as the real route tree nests them. */
function renderApp(path: string) {
  const AppFrame = AppRoute.options.component as () => ReactNode;
  const Conversations = ConversationsRoute.options.component as () => ReactNode;
  const rootRoute = createRootRoute({
    component: () => (
      <Reports>
        <Outlet />
      </Reports>
    ),
  });
  const appRoute = createRoute({
    id: "_app",
    getParentRoute: () => rootRoute,
    component: AppFrame,
  });
  const page = (routePath: string, body: () => ReactNode) =>
    createRoute({
      path: routePath,
      getParentRoute: () => appRoute,
      component: body,
    });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      appRoute.addChildren([
        page("/", () => (
          <>
            <SidebarToggleBar />
            {/* Beside the bar, not in it: another file stands a stub in for the bar (mock.module). */}
            <ShellAccountMenu />
            <h1>Home</h1>
          </>
        )),
        page("/bots", () => (
          <PageShell title="Bots">
            <p>The roster</p>
          </PageShell>
        )),
        page("/conversations", Conversations),
        page("/channel/$channelId", () => (
          <>
            <ShellBackButton />
            <p>A conversation</p>
          </>
        )),
        page("/channel/new", () => <p>New conversation</p>),
      ]),
    ]),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
  return { view, router };
}

describe("the frame", () => {
  test("in the shell: no sidebar, no toggle and no empty band, and the one socket still opens", async () => {
    inShell(true);
    serve([]);
    const { view } = renderApp("/");
    await view.findByRole("heading", { name: "Home" });
    expect(view.container.querySelector('[data-slot="sidebar"]')).toBeNull();
    expect(
      view.container.querySelector('[data-slot="sidebar-wrapper"]'),
    ).toBeNull();
    expect(view.queryByRole("button", { name: /sidebar/i })).toBeNull();
    // The band that held the toggle is gone, not left empty.
    expect(view.container.querySelector(".h-12")).toBeNull();
    await waitFor(() => expect(sockets).toBeGreaterThan(0));
  });

  test("a skin's frame with no sidebar, outside the shell, keeps the 48px band", () => {
    inShell(false);
    // No sidebar provider, as in OpenDuet's and OpenDots' frames.
    const view = render(
      <SidebarToggleBar>
        <span>At the end</span>
      </SidebarToggleBar>,
    );
    const band = view.container.querySelector(".h-12");
    expect(band).not.toBeNull();
    expect(band?.textContent).toContain("At the end");
  });

  test("in the shell, a configuration screen keeps no bar above its title", async () => {
    inShell(true);
    serve([]);
    const { view } = renderApp("/bots");
    await view.findByRole("heading", { name: "Bots" });
    expect(view.container.querySelector(".h-14")).toBeNull();
  });

  test("in the shell, the sidebar's account menu sits at the top right, named Account", async () => {
    inShell(true);
    serve([]);
    const { view } = renderApp("/");
    await view.findByRole("heading", { name: "Home" });
    const account = view.getByRole("button", { name: "Account" });
    await userEvent
      .setup({ document: view.container.ownerDocument })
      .click(account);
    const settings = await within(document.body).findByRole("menuitem", {
      name: "Settings",
    });
    expect(settings.getAttribute("href")).toBe("/settings");
    expect(
      within(document.body).getByRole("menuitem", { name: "Sign out" }),
    ).toBeTruthy();
    // The web view doesn't take a download yet, so nothing in the menu offers one.
    expect(
      within(document.body).queryByRole("menuitem", {
        name: "Get troubleshooting logs",
      }),
    ).toBeNull();
  });

  test("in the shell, the account button and its menu's rows are a thumb's size", async () => {
    inShell(true);
    serve([]);
    const { view } = renderApp("/");
    await view.findByRole("heading", { name: "Home" });
    const account = view.getByRole("button", { name: "Account" });
    // 44px square, the whole tap target iOS asks for, round a 36px avatar.
    expect(account.className).toContain("size-11");
    expect(account.querySelector(".size-9")).not.toBeNull();
    await userEvent
      .setup({ document: view.container.ownerDocument })
      .click(account);
    const settings = await within(document.body).findByRole("menuitem", {
      name: "Settings",
    });
    expect(settings.className).toContain("py-3");
  });

  test("in a browser, the sidebar is there as before", async () => {
    inShell(false);
    serve([]);
    const { view } = renderApp("/");
    await view.findByRole("heading", { name: "Home" });
    expect(
      view.container.querySelector('[data-slot="sidebar-wrapper"]'),
    ).not.toBeNull();
    expect(
      view.container.querySelector('[data-slot="sidebar"]'),
    ).not.toBeNull();
    // The account is the sidebar's, named for the person: none is added at the top of the page.
    expect(view.queryByRole("button", { name: "Account" })).toBeNull();
  });
});

/** Where each "New conversation" on the page goes. */
function newConversationLinks(container: HTMLElement): (string | null)[] {
  return [...container.querySelectorAll("a")]
    .filter(
      (link) =>
        (link.getAttribute("aria-label") ?? link.textContent?.trim()) ===
        "New conversation",
    )
    .map((link) => link.getAttribute("href"));
}

describe("the Conversations page", () => {
  // Drawn in the shell, so the sidebar's own list of the same conversations is not on screen too.
  beforeEach(() => inShell(true));

  test("pinned first, unread marked", async () => {
    serve([
      channel("c-1", "Quarterly forecast"),
      channel("c-2", "Competitor pricing notes", {
        pinned: true,
        unread: true,
      }),
      channel("c-3", "Trip to Lisbon"),
    ]);
    const { view } = renderApp("/conversations");
    await view.findByText("Trip to Lisbon");
    const titles = [
      ...view.container.querySelectorAll('a[href^="/channel/c-"]'),
    ].map((row) => row.textContent ?? "");
    expect(
      titles.map((text) => text.match(/Competitor|Quarterly|Lisbon/)?.[0]),
    ).toEqual(["Competitor", "Quarterly", "Lisbon"]);
    expect(
      view.container.querySelectorAll('[data-slot="unread-dot"]'),
    ).toHaveLength(1);
    expect(
      view.getByRole("textbox", { name: "Search conversations" }),
    ).toBeTruthy();
    expect(newConversationLinks(view.container)).toEqual(["/channel/new"]);
  });

  test("while it loads, nothing: no empty state, no error", async () => {
    serve("never");
    const { view } = renderApp("/conversations");
    await view.findByRole("heading", { name: "Conversations" });
    expect(view.queryByText("No conversations yet")).toBeNull();
    expect(view.queryByRole("alert")).toBeNull();
  });

  test("with none, says how one arrives; New conversation is in the title's row", async () => {
    serve([]);
    const { view } = renderApp("/conversations");
    await view.findByText("No conversations yet");
    // The panel's own, as on Desktop.
    expect(newConversationLinks(view.container)).toEqual(["/channel/new"]);
  });

  test("a failure says so and offers Try again", async () => {
    serve(500);
    const { view } = renderApp("/conversations");
    const alert = await view.findByRole("alert");
    expect(alert.textContent).toContain("Couldn't load your conversations.");
    expect(view.getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  test("it is the sidebar's Conversations panel, with the account in its title's row", async () => {
    serve([channel("c-1", "Quarterly forecast")]);
    const { view } = renderApp("/conversations");
    await view.findByText("Quarterly forecast");
    const panel = view.container.querySelector('[data-slot="section-panel"]');
    expect(panel).not.toBeNull();
    const header = panel?.querySelector('[data-slot="section-panel-header"]');
    expect(header?.textContent).toContain("Conversations");
    expect(
      within(header as HTMLElement).getByRole("button", { name: "Account" }),
    ).toBeTruthy();
  });
});

describe("what the shell is told", () => {
  test("ready once, then each page's path, tab and sign-in, and openbot:open moves the page", async () => {
    inShell(true);
    const heard = listen();
    serve([]);
    const { view, router } = renderApp("/");
    await view.findByRole("heading", { name: "Home" });
    for (const path of ["/bots", "/conversations", "/", "/"]) {
      const event = new CustomEvent("openbot:open", {
        detail: { path },
        cancelable: true,
      });
      act(() => {
        window.dispatchEvent(event);
      });
      expect(event.defaultPrevented).toBe(true);
      await waitFor(() => expect(router.state.location.pathname).toBe(path));
    }
    await waitFor(() =>
      expect(heard).toEqual([
        { type: "ready" },
        {
          type: "route",
          path: "/",
          tab: "home",
          signedIn: false,
          canGoBack: false,
          depth: 1,
          scrollRestored: true,
        },
        {
          type: "route",
          path: "/bots",
          tab: "bots",
          signedIn: false,
          canGoBack: false,
          depth: 1,
          scrollRestored: true,
        },
        {
          type: "route",
          path: "/conversations",
          tab: "conversations",
          signedIn: false,
          canGoBack: false,
          depth: 1,
          scrollRestored: true,
        },
        {
          type: "route",
          path: "/",
          tab: "home",
          signedIn: false,
          canGoBack: false,
          depth: 1,
          scrollRestored: true,
        },
      ]),
    );
    // In the shell the tabs' stacks are the history: the web view's own stays one entry long.
    expect(router.history.length).toBe(1);
  });

  test("outside the shell, nothing", async () => {
    inShell(false);
    const heard = listen();
    serve([]);
    const { view } = renderApp("/");
    await view.findByRole("heading", { name: "Home" });
    expect(heard).toEqual([]);
  });
});

describe("the tabs' stacks in the shell", () => {
  /** The shell tapping a tab: `openbot:open` with the tab's root. */
  function tap(path: string) {
    act(() => {
      window.dispatchEvent(
        new CustomEvent("openbot:open", { detail: { path }, cancelable: true }),
      );
    });
  }
  const routes = (heard: unknown[]) =>
    heard.filter((m) => (m as { type: string }).type === "route") as {
      path: string;
      tab: string | null;
      canGoBack: boolean;
    }[];

  test("Back in a conversation goes back to where it was opened, and the page keeps its tab", async () => {
    inShell(true);
    const heard = listen();
    serve([channel("c-1", "Quarterly forecast")]);
    const { view, router } = renderApp("/bots");
    await view.findByText("The roster");
    await act(() =>
      router.navigate({
        to: "/channel/$channelId",
        params: { channelId: "c-1" },
      }),
    );
    await view.findByText("A conversation");
    // Opened from Bots: in Bots' stack, with somewhere to go back to.
    await waitFor(() =>
      expect(routes(heard).at(-1)).toMatchObject({
        path: "/channel/c-1",
        tab: "bots",
        canGoBack: true,
      }),
    );
    fireEvent.click(view.getByRole("button", { name: "Back" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/bots"));
    await waitFor(() =>
      expect(routes(heard).at(-1)).toMatchObject({
        path: "/bots",
        tab: "bots",
        canGoBack: false,
        depth: 1,
        scrollRestored: true,
      }),
    );
    // In the shell the stacks are the history: the web view's own stays one entry long.
    expect(router.history.length).toBe(1);
  });

  test("opened cold, a conversation's Back goes to the Chats list", async () => {
    inShell(true);
    serve([]);
    const { view, router } = renderApp("/channel/c-9");
    await view.findByText("A conversation");
    fireEvent.click(view.getByRole("button", { name: "Back" }));
    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/conversations"),
    );
  });

  test("switching away and back shows the tab where it was; tapping the current tab pops it to its root", async () => {
    inShell(true);
    serve([]);
    const { view, router } = renderApp("/conversations");
    await view.findByText("No conversations yet");
    await act(() =>
      router.navigate({
        to: "/channel/$channelId",
        params: { channelId: "c-2" },
      }),
    );
    await view.findByText("A conversation");
    tap("/bots");
    await view.findByText("The roster");
    tap("/conversations");
    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/channel/c-2"),
    );
    tap("/conversations");
    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/conversations"),
    );
  });

  test("openbot:back pops the current tab, and does nothing at its root", async () => {
    inShell(true);
    serve([]);
    const { view, router } = renderApp("/");
    await view.findByRole("heading", { name: "Home" });
    await act(() =>
      router.navigate({
        to: "/channel/$channelId",
        params: { channelId: "c-3" },
      }),
    );
    await view.findByText("A conversation");
    act(() => {
      window.dispatchEvent(new CustomEvent("openbot:back"));
    });
    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
    act(() => {
      window.dispatchEvent(new CustomEvent("openbot:back"));
    });
    await settleReactWork();
    expect(router.state.location.pathname).toBe("/");
  });

  test("outside the shell, navigation is the browser's history as before, and no Back is drawn", async () => {
    inShell(false);
    serve([]);
    const { view, router } = renderApp("/");
    await view.findByRole("heading", { name: "Home" });
    await act(() =>
      router.navigate({
        to: "/channel/$channelId",
        params: { channelId: "c-4" },
      }),
    );
    await view.findByText("A conversation");
    expect(router.history.length).toBe(2);
    expect(view.queryByRole("button", { name: "Back" })).toBeNull();
    act(() => {
      window.dispatchEvent(new CustomEvent("openbot:back"));
    });
    await settleReactWork();
    expect(router.state.location.pathname).toBe("/channel/c-4");
  });
});

describe("the app's swipe back", () => {
  type Heard = {
    type: string;
    direction?: string;
    depth?: number;
    path?: string;
    at: number;
    showing: string;
  };
  /**
   * What the app hears, with when and what the page was showing at that moment. On iOS through its
   * handler, which answers `will-navigate` with `openbot:navigate-ok` when `answer` is set; on Android
   * through its object, which never answers.
   */
  function hear(platform: "ios" | "android", answer = false): Heard[] {
    const heard: Heard[] = [];
    const page = window as unknown as Record<string, unknown>;
    page.__OPENBOT_NATIVE_SHELL__ = { platform, version: "0.1", bridge: 1 };
    forgetNativeShellForTests();
    const take = (message: Record<string, unknown>) => {
      heard.push({
        ...(message as { type: string }),
        at: performance.now(),
        showing: document.body.textContent ?? "",
      });
      if (answer && message.type === "will-navigate")
        window.dispatchEvent(new CustomEvent("openbot:navigate-ok"));
    };
    if (platform === "ios")
      page.webkit = {
        messageHandlers: { openbotShell: { postMessage: take } },
      };
    else
      page.OpenBotShellAndroid = {
        postMessage: (json: string) => take(JSON.parse(json)),
      };
    return heard;
  }
  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).OpenBotShellAndroid;
  });
  const of = (heard: Heard[], type: string) =>
    heard.filter((message) => message.type === type);
  const toConversation = (channelId: string, replace = false) =>
    ({ to: "/channel/$channelId", params: { channelId }, replace }) as const;

  test("depth: 1 at a root, deeper as pages open, back down on Back, kept by a replace, a tab's own", async () => {
    inShell(true);
    const heard = hear("ios", true);
    serve([]);
    const { view, router } = renderApp("/conversations");
    await view.findByText("No conversations yet");
    await act(() => router.navigate(toConversation("c-1")));
    await view.findByText("A conversation");
    await act(() => router.navigate(toConversation("c-2", true)));
    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/channel/c-2"),
    );
    act(() => {
      window.dispatchEvent(
        new CustomEvent("openbot:open", {
          detail: { path: "/bots" },
          cancelable: true,
        }),
      );
    });
    await view.findByText("The roster");
    await waitFor(() =>
      expect(
        of(heard, "route").map(({ path, depth }) => [path, depth]),
      ).toEqual([
        ["/conversations", 1],
        ["/channel/c-1", 2],
        ["/channel/c-2", 2],
        ["/bots", 1],
      ]),
    );
  });

  test("a cold deep link starts at depth 2", async () => {
    inShell(true);
    const heard = hear("ios");
    serve([]);
    const { view } = renderApp("/channel/c-9");
    await view.findByText("A conversation");
    await waitFor(() =>
      expect(of(heard, "route")[0]).toMatchObject({
        path: "/channel/c-9",
        depth: 2,
        canGoBack: true,
      }),
    );
  });

  test("will-navigate comes before the page changes, with its direction and where it leads", async () => {
    inShell(true);
    const heard = hear("ios", true);
    serve([]);
    const { view, router } = renderApp("/conversations");
    await view.findByText("No conversations yet");
    await act(() => router.navigate(toConversation("c-1")));
    await view.findByText("A conversation");
    fireEvent.click(view.getByRole("button", { name: "Back" }));
    await view.findByText("No conversations yet");
    const announced = of(heard, "will-navigate");
    expect(
      announced.map(({ direction, depth }) => ({ direction, depth })),
    ).toEqual([
      { direction: "push", depth: 2 },
      { direction: "back", depth: 1 },
    ]);
    // Each while the page it leaves is still on screen.
    expect(announced[0]?.showing).toContain("No conversations yet");
    expect(announced[1]?.showing).toContain("A conversation");
  });

  test("on iOS with no answer the page goes ahead after 120 ms; with an answer, at once", async () => {
    inShell(true);
    const silent = hear("ios");
    serve([]);
    const first = renderApp("/conversations");
    await first.view.findByText("No conversations yet");
    const asked = performance.now();
    await act(() => first.router.navigate(toConversation("c-1")));
    await first.view.findByText("A conversation");
    const waited = performance.now() - asked;
    expect(of(silent, "will-navigate")).toHaveLength(1);
    expect(waited).toBeGreaterThanOrEqual(110);
    expect(waited).toBeLessThan(1000);
    cleanup();

    inShell(true);
    const answering = hear("ios", true);
    serve([]);
    const second = renderApp("/conversations");
    await second.view.findByText("No conversations yet");
    const askedAgain = performance.now();
    await act(() => second.router.navigate(toConversation("c-1")));
    await second.view.findByText("A conversation");
    expect(of(answering, "will-navigate")).toHaveLength(1);
    expect(performance.now() - askedAgain).toBeLessThan(110);
  });

  test("on Android it is said and never waited for", async () => {
    inShell(true);
    const heard = hear("android");
    serve([]);
    const { view, router } = renderApp("/conversations");
    await view.findByText("No conversations yet");
    const asked = performance.now();
    await act(() => router.navigate(toConversation("c-1")));
    await view.findByText("A conversation");
    expect(performance.now() - asked).toBeLessThan(110);
    expect(of(heard, "will-navigate")).toHaveLength(1);
  });

  test("in a browser nothing is said or waited for", async () => {
    inShell(false);
    const heard = listen();
    serve([]);
    const { view, router } = renderApp("/conversations");
    await waitFor(() =>
      expect(view.getAllByText("No conversations yet").length).toBeGreaterThan(
        0,
      ),
    );
    await act(() => router.navigate(toConversation("c-1")));
    await view.findByText("A conversation");
    expect(heard).toEqual([]);
  });

  test("Back the app asks for is not announced back to it", async () => {
    inShell(true);
    const heard = hear("ios", true);
    serve([]);
    const { view, router } = renderApp("/conversations");
    await view.findByText("No conversations yet");
    await act(() => router.navigate(toConversation("c-1")));
    await view.findByText("A conversation");
    act(() => {
      window.dispatchEvent(new CustomEvent("openbot:back"));
    });
    await view.findByText("No conversations yet");
    expect(
      of(heard, "will-navigate").map(({ direction }) => direction),
    ).toEqual(["push"]);
    await waitFor(() =>
      expect(of(heard, "route").at(-1)).toMatchObject({
        path: "/conversations",
        depth: 1,
        scrollRestored: true,
      }),
    );
  });
});

describe("a Back while a list's scroll is being put back", () => {
  /** Frames the page asks for, run only when the test says: the scroll's restore is held meanwhile. */
  let frames: FrameRequestCallback[] = [];
  let realFrame: typeof window.requestAnimationFrame;
  beforeEach(() => {
    frames = [];
    realFrame = window.requestAnimationFrame;
    window.requestAnimationFrame = ((callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    }) as typeof window.requestAnimationFrame;
  });
  afterEach(() => {
    window.requestAnimationFrame = realFrame;
  });
  const runFrames = () =>
    act(() => {
      const now = frames;
      frames = [];
      for (const frame of now) frame(performance.now());
    });
  const routesOf = (heard: unknown[]) =>
    heard
      .filter((m) => (m as { type: string }).type === "route")
      .map((m) => (m as { path: string; depth: number }).path);
  const back = () =>
    act(() => {
      window.dispatchEvent(new CustomEvent("openbot:back"));
    });

  /** The Chats list scrolled down, then a conversation opened from it, then Back: the hold. */
  async function holding() {
    inShell(true);
    const heard = listen();
    serve(
      Array.from({ length: 30 }, (_, index) =>
        channel(`c-${index}`, `Conversation ${index}`),
      ),
    );
    const { view, router } = renderApp("/conversations");
    await view.findByText("Conversation 29");
    const list = view.container.querySelector(
      '[data-slot="section-panel"] [data-slot="sidebar-content"]',
    ) as HTMLElement;
    list.scrollTop = 400;
    await act(() =>
      router.navigate({
        to: "/channel/$channelId",
        params: { channelId: "c-3" },
      }),
    );
    await view.findByText("A conversation");
    await back();
    await view.findByText("Conversation 29");
    await settleReactWork();
    return { heard, view, router };
  }

  test("a second Back at the root does nothing, and the held route goes out once", async () => {
    const { heard, router } = await holding();
    // Held: the list has not been put back yet, so the root's route has not been said.
    expect(routesOf(heard).at(-1)).toBe("/channel/c-3");
    // Android's Back still read canGoBack true and asks again.
    await back();
    await settleReactWork();
    expect(router.state.location.pathname).toBe("/conversations");
    await runFrames();
    await waitFor(() =>
      expect(routesOf(heard)).toEqual([
        "/conversations",
        "/channel/c-3",
        "/conversations",
      ]),
    );
    await runFrames();
    await settleReactWork();
    expect(
      routesOf(heard).filter((path) => path === "/conversations"),
    ).toHaveLength(2);
  });

  test("a tab tap during the hold is not lost: the tapped tab is shown and reported", async () => {
    const { heard, view, router } = await holding();
    act(() => {
      window.dispatchEvent(
        new CustomEvent("openbot:open", {
          detail: { path: "/bots" },
          cancelable: true,
        }),
      );
    });
    await view.findByText("The roster");
    await runFrames();
    await waitFor(() => expect(routesOf(heard).at(-1)).toBe("/bots"));
    expect(router.state.location.pathname).toBe("/bots");
  });
});

describe("the Bots tab in the shell", () => {
  test("is the sidebar's Bots panel, with New Bot and the account in its title's row", async () => {
    inShell(true);
    serve([]);
    const rootRoute = createRootRoute({
      component: () => (
        <ShellBots creating={false} onClose={() => {}} onCreated={() => {}} />
      ),
    });
    const router = createRouter({
      routeTree: rootRoute,
      history: createMemoryHistory({ initialEntries: ["/bots"] }),
    });
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const view = render(
      <QueryClientProvider client={client}>
        <RouterProvider router={router as never} />
      </QueryClientProvider>,
    );
    const header = await waitFor(() => {
      const found = view.container.querySelector(
        '[data-slot="section-panel-header"]',
      );
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    expect(header.textContent).toContain("Bots");
    expect(
      within(header).getByRole("button", { name: "New Bot" }),
    ).toBeTruthy();
    expect(
      within(header).getByRole("button", { name: "Account" }),
    ).toBeTruthy();
    expect(view.getByRole("textbox", { name: "Search Bots" })).toBeTruthy();
  });
});

describe("the Conversations page outside the shell", () => {
  test("is the page it was: its own title, beside the sidebar's panel", async () => {
    inShell(false);
    serve([channel("c-1", "Quarterly forecast")]);
    const { view } = renderApp("/conversations");
    await waitFor(() =>
      expect(view.getAllByText("Quarterly forecast").length).toBeGreaterThan(0),
    );
    // The page's own h1, as before; the panel's title is the sidebar's h2.
    expect(
      view
        .getAllByRole("heading", { name: "Conversations" })
        .map((heading) => heading.tagName),
    ).toContain("H1");
  });
});

describe("when the shell hears ready", () => {
  /** Something a test settles by hand: a route's data, or a page's own. */
  function later() {
    let settle = () => {};
    const promise = new Promise<void>((resolve) => {
      settle = resolve;
    });
    return { promise, settle };
  }

  /**
   * A small app with the shell's reports at its root: `/` waits on `data` before it draws, showing
   * a skeleton meanwhile, then draws `page`; `/next` draws at once; `/sign` is the shell's quiet page.
   */
  function renderReady(
    path: string,
    { data, page }: { data?: Promise<void>; page?: () => ReactNode } = {},
  ) {
    const rootRoute = createRootRoute({
      component: () => (
        <Reports>
          <Outlet />
        </Reports>
      ),
    });
    const routes = [
      createRoute({
        path: "/",
        getParentRoute: () => rootRoute,
        loader: () => data,
        pendingMs: 0,
        pendingComponent: () => <div data-slot="skeleton" />,
        component: page ?? (() => <h1>Drawn</h1>),
      }),
      createRoute({
        path: "/next",
        getParentRoute: () => rootRoute,
        component: () => <h1>Next</h1>,
      }),
      createRoute({
        path: "/sign",
        getParentRoute: () => rootRoute,
        component: NativeSignedOut,
      }),
    ];
    const router = createRouter({
      routeTree: rootRoute.addChildren(routes),
      history: createMemoryHistory({ initialEntries: [path] }),
    });
    const view = render(<RouterProvider router={router as never} />);
    return { view, router };
  }

  const readies = (heard: unknown[]) =>
    heard.filter((message) => (message as { type: string }).type === "ready");

  test("not while the first page is still loading; once it has drawn, ready, then its route", async () => {
    inShell(true);
    const heard = listen();
    const data = later();
    const { view } = renderReady("/", { data: data.promise });
    await settleReactWork();
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
    // The skeleton is up; nothing a person can read, and no route reported ahead of ready.
    expect(view.queryByText("Drawn")).toBeNull();
    expect(heard).toEqual([]);
    await act(async () => data.settle());
    await view.findByText("Drawn");
    await waitFor(() =>
      expect(heard).toEqual([
        { type: "ready" },
        {
          type: "route",
          path: "/",
          tab: "home",
          signedIn: false,
          canGoBack: false,
          depth: 1,
          scrollRestored: true,
        },
      ]),
    );
  });

  test("a page whose own data is still loading is not drawn until its words are", async () => {
    inShell(true);
    const heard = listen();
    const own = later();
    function Page() {
      const [loaded, setLoaded] = useState(false);
      useEffect(() => {
        void own.promise.then(() => setLoaded(true));
      }, []);
      return loaded ? (
        <p>Three conversations</p>
      ) : (
        <span className="sr-only">Loading</span>
      );
    }
    const { view } = renderReady("/", { page: Page });
    await waitFor(() => expect(view.getByText("Loading")).toBeTruthy());
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
    expect(heard).toEqual([]);
    await act(async () => own.settle());
    await view.findByText("Three conversations");
    await waitFor(() => expect(heard[0]).toEqual({ type: "ready" }));
    expect(heard[1]).toEqual({
      type: "route",
      path: "/",
      tab: "home",
      signedIn: false,
      canGoBack: false,
      depth: 1,
      scrollRestored: true,
    });
  });

  test("once only, however many pages follow", async () => {
    inShell(true);
    const heard = listen();
    const { view, router } = renderReady("/");
    await view.findByText("Drawn");
    await act(() => router.navigate({ to: "/next" as never }));
    await view.findByText("Next");
    await act(() => router.navigate({ to: "/" }));
    await view.findByText("Drawn");
    // Ready, then a route for each page, each change of page announced first.
    await waitFor(() =>
      expect(
        heard.filter((m) => (m as { type: string }).type === "route"),
      ).toHaveLength(3),
    );
    expect(readies(heard)).toHaveLength(1);
    expect(heard[0]).toEqual({ type: "ready" });
    expect(heard.map((m) => (m as { type: string }).type)).toEqual([
      "ready",
      "route",
      "will-navigate",
      "route",
      "will-navigate",
      "route",
    ]);
  });

  test("signed out: the quiet page counts as drawn, and signed-out follows ready", async () => {
    inShell(true);
    const heard = listen();
    const { view } = renderReady("/sign");
    await waitFor(() =>
      expect(
        view.container.querySelector('[data-slot="native-signed-out"]'),
      ).not.toBeNull(),
    );
    await waitFor(() =>
      expect(heard).toEqual([
        { type: "ready" },
        { type: "signed-out" },
        {
          type: "route",
          path: "/sign",
          tab: null,
          signedIn: false,
          canGoBack: false,
          depth: 1,
          scrollRestored: true,
        },
      ]),
    );
  });

  test("a page that never draws still hands the screen over, after the fallback", async () => {
    inShell(true);
    forgetReadyForTests(60);
    const heard = listen();
    renderReady("/", { data: new Promise<void>(() => {}) });
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
    expect(heard).toEqual([]);
    await waitFor(() => expect(heard).toEqual([{ type: "ready" }]));
  });
});

describe("signed out in the shell", () => {
  test("the quiet page tells the shell, and offers no way in of its own", () => {
    inShell(true);
    const heard = listen();
    const view = render(<NativeSignedOut />);
    expect(heard).toEqual([{ type: "signed-out" }]);
    expect(view.queryByRole("button")).toBeNull();
    expect(view.queryByRole("link")).toBeNull();
  });

  test("only ?native-sign-in=web asks for the web sign-in, and only in the shell", () => {
    inShell(true);
    expect(signsInNatively({})).toBe(true);
    expect(signsInNatively({ "native-sign-in": "failed" })).toBe(true);
    expect(signsInNatively({ "native-sign-in": "web" })).toBe(false);
    inShell(false);
    expect(signsInNatively({})).toBe(false);
  });
});

describe("the keyboard in the shell", () => {
  /** A field outside the pages, so it is still there after a move and only the shell can blur it. */
  function focusedField() {
    const field = document.createElement("input");
    field.type = "text";
    document.body.append(field);
    field.focus();
    expect(document.activeElement).toBe(field);
    return field;
  }

  test("moving to another page puts the keyboard away; a change of search alone does not", async () => {
    inShell(true);
    serve([]);
    const { view, router } = renderApp("/");
    await view.findByRole("heading", { name: "Home" });
    const field = focusedField();
    try {
      await act(() =>
        router.navigate({ to: "/", search: { q: "x" } as never }),
      );
      expect(document.activeElement).toBe(field);
      await act(() => router.navigate({ to: "/bots" }));
      await view.findByRole("heading", { name: "Bots" });
      expect(document.activeElement).not.toBe(field);
    } finally {
      field.remove();
    }
  });

  test("opening the Account menu takes the focus off a field", async () => {
    inShell(true);
    serve([]);
    const { view } = renderApp("/");
    await view.findByRole("heading", { name: "Home" });
    const field = focusedField();
    try {
      // A click alone, which moves no focus itself: what moves it is the menu opening.
      fireEvent.click(view.getByRole("button", { name: "Account" }));
      await within(document.body).findByRole("menuitem", { name: "Settings" });
      await waitFor(() => expect(document.activeElement).not.toBe(field));
    } finally {
      field.remove();
    }
  });

  test("a tap on a part of the page that does nothing puts the keyboard away; a tap on a button keeps it", async () => {
    inShell(true);
    serve([]);
    const { view } = renderApp("/");
    const heading = await view.findByRole("heading", { name: "Home" });
    const field = focusedField();
    const tap = (target: Element) => {
      fireEvent.pointerDown(target, { clientX: 20, clientY: 20 });
      fireEvent.pointerUp(target, { clientX: 22, clientY: 21 });
    };
    try {
      tap(view.getByRole("button", { name: "Account" }));
      expect(document.activeElement).toBe(field);
      // A drag that scrolls is cancelled by the browser, not a tap.
      fireEvent.pointerDown(heading, { clientX: 20, clientY: 20 });
      fireEvent.pointerCancel(heading);
      fireEvent.pointerUp(heading, { clientX: 20, clientY: 200 });
      expect(document.activeElement).toBe(field);
      tap(heading);
      expect(document.activeElement).not.toBe(field);
    } finally {
      field.remove();
    }
  });

  test("outside the shell the page leaves the keyboard alone", async () => {
    serve([]);
    const { view } = renderApp("/");
    const heading = await view.findByRole("heading", { name: "Home" });
    const field = focusedField();
    try {
      fireEvent.pointerDown(heading, { clientX: 20, clientY: 20 });
      fireEvent.pointerUp(heading, { clientX: 20, clientY: 20 });
      expect(document.activeElement).toBe(field);
    } finally {
      field.remove();
    }
  });
});

describe("what makes no sense in the shell", () => {
  test("no Home Screen push and no notifications of the page's own", () => {
    inShell(true);
    expect(webPushSupport()).toBe("unsupported");
    expect(notificationPermission()).toBe("unsupported");
  });

  /*
   * A browser with push, as Chrome is: a service worker, the Push API and notifications not yet
   * asked. The conversation's offer shows there, so the shell's half proves something.
   */
  function pushAvailable() {
    const page = window as unknown as Record<string, unknown>;
    page.PushManager = class {};
    page.Notification = { permission: "default" };
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: { getRegistration: async () => undefined },
    });
    return () => {
      delete page.PushManager;
      delete page.Notification;
      delete (navigator as unknown as Record<string, unknown>).serviceWorker;
    };
  }

  test("a conversation offers notifications in a browser with push, and never in the shell", async () => {
    const restore = pushAvailable();
    try {
      localStorage.removeItem(NOTIFY_PROMPT_KEY);
      for (const shell of [false, true]) {
        inShell(shell);
        refreshNotificationPermission();
        const view = render(
          <QueryClientProvider client={queryClient}>
            <NotifyPrompt />
          </QueryClientProvider>,
        );
        if (shell) {
          await settleReactWork();
          expect(view.queryByText("Enable notifications")).toBeNull();
          expect(
            view.container.querySelector("[data-notify-prompt]"),
          ).toBeNull();
        } else {
          expect(await view.findByText("Enable notifications")).toBeTruthy();
        }
        cleanup();
        queryClient.clear();
      }
    } finally {
      restore();
      refreshNotificationPermission();
    }
  });
});
