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
        page("/channel/$channelId", () => <p>A conversation</p>),
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

  test("with none, says how one arrives and offers New conversation", async () => {
    serve([]);
    const { view } = renderApp("/conversations");
    await view.findByText("No conversations yet");
    // The page's own, and the empty state's.
    expect(newConversationLinks(view.container)).toEqual([
      "/channel/new",
      "/channel/new",
    ]);
    // Nothing to search yet.
    expect(
      view.queryByRole("textbox", { name: "Search conversations" }),
    ).toBeNull();
  });

  test("a failure says so and offers Try again", async () => {
    serve(500);
    const { view } = renderApp("/conversations");
    const alert = await view.findByRole("alert");
    expect(alert.textContent).toContain("Couldn't load your conversations.");
    expect(view.getByRole("button", { name: "Try again" })).toBeTruthy();
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
        { type: "route", path: "/", tab: "home", signedIn: false },
        { type: "route", path: "/bots", tab: "bots", signedIn: false },
        {
          type: "route",
          path: "/conversations",
          tab: "conversations",
          signedIn: false,
        },
        { type: "route", path: "/", tab: "home", signedIn: false },
      ]),
    );
    // Opening the page already open adds no history entry.
    expect(router.history.length).toBe(4);
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
        { type: "route", path: "/", tab: "home", signedIn: false },
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
    await waitFor(() => expect(heard.length).toBe(4));
    expect(readies(heard)).toHaveLength(1);
    expect(heard[0]).toEqual({ type: "ready" });
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
        { type: "route", path: "/sign", tab: null, signedIn: false },
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
