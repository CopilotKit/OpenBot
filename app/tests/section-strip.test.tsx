import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AppSidebar } from "@/components/app-sidebar/app-sidebar";
import { SidebarShell } from "@/components/layout/sidebar-shell";
import { agentKeys } from "@/lib/agents/queries";
import { authKeys } from "@/lib/auth/queries";
import { botLifecycleKeys } from "@/lib/bot-lifecycle/queries";
import { channelKeys } from "@/lib/channels/queries";
import { deploymentKeys } from "@/lib/deployment/queries";
import {
  CONVERSATIONS,
  SectionProvider,
  sectionHasPanel,
  useOpenSection,
} from "@/lib/sections";
import { userPreferencesQueryOptions } from "@/lib/settings/message-list";
import { SIDEBAR_STORAGE_KEY } from "@/lib/sidebar";
import { settleReactWork } from "./settle-react-work";

/*
 * Each icon on the strip is a section, and the open section follows the page. Only Conversations
 * has a panel: a page whose section has none folds the panel away, and the Conversations icon (or
 * ⌘B) brings it back without leaving the page. None of that touches the person's own choice to keep
 * the panel open or closed.
 */

class OfflineWebSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readyState = 0;
  onclose = null;
  onerror = null;
  onmessage = null;
  onopen = null;
  close() {}
  send() {}
}

const originalFetch = globalThis.fetch;
const originalWebSocket = globalThis.WebSocket;
const clients: QueryClient[] = [];

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/", width: 1280 });
  globalThis.WebSocket = OfflineWebSocket as unknown as typeof WebSocket;
});
beforeEach(() => {
  window.localStorage.clear();
  globalThis.fetch = Object.assign(
    async () => Response.json({ error: "not served" }, { status: 404 }),
    { preconnect: originalFetch.preconnect },
  );
});
afterEach(() => {
  cleanup();
  for (const client of clients) client.clear();
  clients.length = 0;
  globalThis.fetch = originalFetch;
});
afterAll(async () => {
  await settleReactWork();
  globalThis.WebSocket = originalWebSocket;
  GlobalRegistrator.unregister();
});

/** The app's frame as `routes/_authed/_app.tsx` draws it, without the page. */
function Frame() {
  const { section, show } = useOpenSection();
  return (
    <SidebarShell
      panel={{
        available: sectionHasPanel(section),
        reveal: () => show(CONVERSATIONS),
      }}
    >
      <AppSidebar />
    </SidebarShell>
  );
}

function renderApp(path: string) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  clients.push(queryClient);
  queryClient.setQueryData(deploymentKeys.capabilities(), {
    generativeUi: true,
    selfHostBanner: false,
    localEvaluation: false,
    edition: "team",
  });
  queryClient.setQueryData(authKeys.currentUser(), {
    id: "maya",
    name: "Maya Chen",
    email: "maya@example.com",
    role: "user",
    onboarding: null,
  });
  queryClient.setQueryData(userPreferencesQueryOptions("maya").queryKey, {
    messageListEmphasis: "thread",
    selfHostBannerDismissed: true,
    dismissedNotices: [],
    narration: null,
    skin: "openbot",
    proactive: "on",
  });
  queryClient.setQueryData(agentKeys.list(false), []);
  queryClient.setQueryDefaults(botLifecycleKeys.attention, {
    staleTime: Number.POSITIVE_INFINITY,
    refetchInterval: false,
  });
  queryClient.setQueryData(botLifecycleKeys.attention, {
    bots: [],
    lastPingId: null,
  });
  queryClient.setQueryData(channelKeys.list(), {
    pages: [{ channels: [], nextCursor: null }],
    pageParams: [""],
  });
  const router = createRouter({
    routeTree: createRootRoute({
      component: () => (
        <SectionProvider>
          <Frame />
        </SectionProvider>
      ),
      notFoundComponent: () => null,
    }),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { view, router, user: userEvent.setup({ document }) };
}

/** The app's sidebar, whose state says whether the panel is showing beside the strip. */
function sidebarState(view: ReturnType<typeof render>) {
  return view.container
    .querySelector('[data-slot="sidebar"][data-state]')
    ?.getAttribute("data-state");
}

test("on a page whose section has no panel, that section is current and the panel is folded away", async () => {
  const { view } = renderApp("/routines");
  const routines = await view.findByRole("link", { name: "Routines" });
  expect(routines.getAttribute("aria-current")).toBe("page");
  expect(sidebarState(view)).toBe("collapsed");
});

test("Conversations brings its panel back without leaving the page", async () => {
  const { view, router, user } = renderApp("/routines");
  await user.click(await view.findByRole("button", { name: "Conversations" }));
  expect(sidebarState(view)).toBe("expanded");
  expect(router.state.location.pathname).toBe("/routines");
  expect(
    view
      .getByRole("button", { name: "Conversations" })
      .getAttribute("aria-pressed"),
  ).toBe("true");
});

test("⌘B on a page with no panel opens Conversations' panel", async () => {
  const { view, user } = renderApp("/routines");
  await view.findByRole("link", { name: "Routines" });
  await user.keyboard("{Meta>}b{/Meta}");
  expect(sidebarState(view)).toBe("expanded");
  expect(
    view
      .getByRole("button", { name: "Conversations" })
      .getAttribute("aria-pressed"),
  ).toBe("true");
});

test("a page no section owns keeps the section that was open", async () => {
  const { view, router } = renderApp("/routines");
  await view.findByRole("link", { name: "Routines" });
  await act(() => router.navigate({ to: "/teams" }));
  const routines = view.getByRole("link", { name: "Routines" });
  expect(routines.hasAttribute("data-active")).toBe(true);
  // Shown open, but Teams is the page: a screen reader is not told Routines is.
  expect(routines.getAttribute("aria-current")).toBeNull();
  await act(() => router.navigate({ to: "/routines" }));
  expect(
    view.getByRole("link", { name: "Routines" }).getAttribute("aria-current"),
  ).toBe("page");
});

/*
 * Found in review: the section kept for such a page was the last one a page belonged to, so a panel
 * opened from the strip was taken back. On a Bot's page, Conversations opened, then Teams from the
 * account menu: the Bots panel came back.
 */
test("a page no section owns keeps a panel opened from the strip", async () => {
  const { view, router, user } = renderApp("/bots");
  await view.findByRole("heading", { level: 2, name: "Bots" });
  await user.click(view.getByRole("button", { name: "Conversations" }));
  await view.findByRole("heading", { level: 2, name: "Conversations" });
  await act(() => router.navigate({ to: "/teams" }));
  expect(
    view
      .getByRole("button", { name: "Conversations" })
      .getAttribute("aria-pressed"),
  ).toBe("true");
  expect(
    view.getByRole("heading", { level: 2, name: "Conversations" }),
  ).toBeTruthy();
});

/*
 * Found in review: switching panels unmounted the one left, so going back lost what was typed in its
 * search and where it was scrolled, and the Bots panel took its top three again on every visit.
 */
test("going to the Bots panel and back finds the Conversations panel as it was left", async () => {
  const { view, user } = renderApp("/");
  const search = await view.findByRole("textbox", {
    name: "Search conversations",
  });
  await user.type(search, "Lisbon");
  await user.click(view.getByRole("button", { name: "Bots" }));
  await view.findByRole("heading", { level: 2, name: "Bots" });
  expect(
    view.queryByRole("heading", { level: 2, name: "Conversations" }),
  ).toBeNull();
  await user.click(view.getByRole("button", { name: "Conversations" }));
  await view.findByRole("heading", { level: 2, name: "Conversations" });
  expect(view.queryByRole("heading", { level: 2, name: "Bots" })).toBeNull();
  expect(
    (
      view.getByRole("textbox", {
        name: "Search conversations",
      }) as HTMLInputElement
    ).value,
  ).toBe("Lisbon");
});

test("a panel the person closed stays closed, in storage too, after a page with no panel", async () => {
  window.localStorage.setItem(SIDEBAR_STORAGE_KEY, "collapsed");
  const { view, router } = renderApp("/");
  await view.findByRole("button", { name: "Conversations" });
  expect(sidebarState(view)).toBe("collapsed");
  await act(() => router.navigate({ to: "/bots" }));
  await act(() => router.navigate({ to: "/" }));
  await waitFor(() => expect(sidebarState(view)).toBe("collapsed"));
  expect(window.localStorage.getItem(SIDEBAR_STORAGE_KEY)).toBe("collapsed");
});

test("clicking the open Conversations icon hides its panel, and clicking it again shows it", async () => {
  const { view, user } = renderApp("/");
  const conversations = await view.findByRole("button", {
    name: "Conversations",
  });
  expect(sidebarState(view)).toBe("expanded");
  await user.click(conversations);
  expect(sidebarState(view)).toBe("collapsed");
  await user.click(conversations);
  expect(sidebarState(view)).toBe("expanded");
});

/*
 * Found in dogfooding: on Routines, the Routines icon could not be chosen. Bots on the strip opened
 * Conversations' panel instead (opening the panel on a page with none asked for Conversations, and
 * that came last), and once Bots was open, Routines' own icon did nothing: its link went to the page
 * already open, so the page never took the strip back. Bots stayed lit beside Routines.
 */
test("on Routines, Bots and then Routines lights Routines and folds the panel away", async () => {
  const { view, router, user } = renderApp("/routines");
  await user.click(await view.findByRole("button", { name: "Bots" }));
  await view.findByRole("heading", { level: 2, name: "Bots" });
  expect(
    view.getByRole("button", { name: "Bots" }).getAttribute("aria-pressed"),
  ).toBe("true");
  expect(sidebarState(view)).toBe("expanded");
  await user.click(view.getByRole("link", { name: "Routines" }));
  expect(router.state.location.pathname).toBe("/routines");
  const routines = view.getByRole("link", { name: "Routines" });
  expect(routines.hasAttribute("data-active")).toBe(true);
  expect(routines.getAttribute("aria-current")).toBe("page");
  expect(
    view.getByRole("button", { name: "Bots" }).getAttribute("aria-pressed"),
  ).toBe("false");
  expect(sidebarState(view)).toBe("collapsed");
  // And back again: Bots lights and shows its panel once more.
  await user.click(view.getByRole("button", { name: "Bots" }));
  expect(
    view.getByRole("button", { name: "Bots" }).getAttribute("aria-pressed"),
  ).toBe("true");
  expect(sidebarState(view)).toBe("expanded");
});

test("on Routines, with Bots opened by way of Conversations, Routines lights Routines again", async () => {
  const { view, user } = renderApp("/routines");
  await user.click(await view.findByRole("button", { name: "Conversations" }));
  await user.click(view.getByRole("button", { name: "Bots" }));
  await view.findByRole("heading", { level: 2, name: "Bots" });
  await user.click(view.getByRole("link", { name: "Routines" }));
  expect(
    view.getByRole("link", { name: "Routines" }).hasAttribute("data-active"),
  ).toBe(true);
  expect(
    view.getByRole("button", { name: "Bots" }).getAttribute("aria-pressed"),
  ).toBe("false");
  expect(sidebarState(view)).toBe("collapsed");
});

test("Bots on the strip shows the Bots panel and stays on the page", async () => {
  const { view, router, user } = renderApp("/");
  await user.click(await view.findByRole("button", { name: "Bots" }));
  await view.findByRole("heading", { level: 2, name: "Bots" });
  expect(router.state.location.pathname).toBe("/");
  expect(
    view.getByRole("button", { name: "Bots" }).getAttribute("aria-pressed"),
  ).toBe("true");
  // Pressed again with its panel showing, it folds the panel away, as Conversations does.
  await user.click(view.getByRole("button", { name: "Bots" }));
  expect(sidebarState(view)).toBe("collapsed");
});
