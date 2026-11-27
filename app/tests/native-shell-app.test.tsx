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
import { act, cleanup, render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { NativeSignedOut } from "@/components/auth/native-signed-out";
import { PageShell } from "@/components/layout/page-shell";
import { SidebarToggleBar } from "@/components/layout/sidebar-toggle";
import { useDesktopOpenRequests } from "@/lib/desktop/open-requests";
import {
  forgetReadyForTests,
  useNativeShellRouteReports,
} from "@/lib/native-shell/route-reports";
import { forgetNativeShellForTests } from "@/lib/native-shell/shell";
import { notificationPermission } from "@/lib/notifications/permission";
import { webPushSupport } from "@/lib/web-push/browser";
import { Route as AppRoute } from "@/routes/_authed/_app";
import { Route as ConversationsRoute } from "@/routes/_authed/_app/conversations";
import { signsInNatively } from "@/routes/sign";
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

  test("in the shell, a configuration screen keeps no bar above its title", async () => {
    inShell(true);
    serve([]);
    const { view } = renderApp("/bots");
    await view.findByRole("heading", { name: "Bots" });
    expect(view.container.querySelector(".h-14")).toBeNull();
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
  });
});

/** Where each "New conversation" on the page goes. */
function newConversationLinks(container: HTMLElement): (string | null)[] {
  return [...container.querySelectorAll("a")]
    .filter((link) => link.textContent?.trim() === "New conversation")
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

describe("what makes no sense in the shell", () => {
  test("no Home Screen push and no notifications of the page's own", () => {
    inShell(true);
    expect(webPushSupport()).toBe("unsupported");
    expect(notificationPermission()).toBe("unsupported");
  });
});
