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
import { ThemeProvider } from "@/components/theme-provider";
import { AppSidebar } from "@/components/app-sidebar/app-sidebar";
import { SidebarProvider, useSidebar } from "@/components/ui/sidebar";
import { agentKeys } from "@/lib/agents/queries";
import { authKeys } from "@/lib/auth/queries";
import { botLifecycleKeys } from "@/lib/bot-lifecycle/queries";
import { channelKeys } from "@/lib/channels/queries";
import { formatHotkey, getHotkey, HOTKEYS } from "@/lib/hotkeys/hotkeys";
import { userPreferencesQueryOptions } from "@/lib/settings/message-list";
import { settingsKeys } from "@/lib/settings/queries";
import { Route as SettingsRoute } from "@/routes/_authed/settings/index";
import { settleReactWork } from "./settle-react-work";

/*
 * ⌘K, or Ctrl+K off a Mac, finds a conversation from anywhere: it opens the sidebar if it was
 * collapsed, or the sheet on a narrow window where the sidebar is one, and puts the cursor in its
 * search box. It is a modified key, so it works while somebody is typing in a field, too.
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

/** The window's size, which is what decides whether the sidebar is a sheet (under 768px). */
function setViewport(width: number, height: number) {
  (
    window as unknown as {
      happyDOM: { setViewport(size: { width: number; height: number }): void };
    }
  ).happyDOM.setViewport({ width, height });
}

const originalFetch = globalThis.fetch;
const originalWebSocket = globalThis.WebSocket;
const clients: QueryClient[] = [];

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  globalThis.WebSocket = OfflineWebSocket as unknown as typeof WebSocket;
});
beforeEach(() => {
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
  setViewport(1024, 768);
});
afterAll(async () => {
  await settleReactWork();
  globalThis.WebSocket = originalWebSocket;
  GlobalRegistrator.unregister();
});

function signedIn() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  clients.push(queryClient);
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
    narration: null,
    skin: "openbot",
  });
  queryClient.setQueryData(agentKeys.list(false), []);
  queryClient.setQueryDefaults(botLifecycleKeys.attention, {
    staleTime: Number.POSITIVE_INFINITY,
    refetchInterval: false,
  });
  queryClient.setQueryData(botLifecycleKeys.attention, []);
  queryClient.setQueryData(channelKeys.list(), {
    pages: [{ channels: [], nextCursor: null }],
    pageParams: [""],
  });
  queryClient.setQueryData(settingsKeys.instructions(), "");
  return queryClient;
}

function SidebarState() {
  const { isMobile, open, openMobile } = useSidebar();
  return <output>{(isMobile ? openMobile : open) ? "open" : "closed"}</output>;
}

/** The sidebar, collapsed, beside a field somebody could be typing in. */
async function renderCollapsed() {
  const queryClient = signedIn();
  const router = createRouter({
    routeTree: createRootRoute({
      component: () => (
        <SidebarProvider defaultOpen={false}>
          <AppSidebar />
          <SidebarState />
          <textarea aria-label="Message" />
        </SidebarProvider>
      ),
    }),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  await view.findByText("closed");
  return {
    view,
    state: () => view.container.querySelector("output")?.textContent,
  };
}

const combo = getHotkey("search").combo;

/** ⌘K on a Mac, Ctrl+K everywhere else, as the keycaps Settings draws say. */
function pressSearch(target: EventTarget = document.body) {
  const mod = formatHotkey(combo)[0] === "⌘" ? "metaKey" : "ctrlKey";
  act(() => {
    target.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "k",
        code: "KeyK",
        [mod]: true,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
}

function searchBox() {
  return document.querySelector<HTMLInputElement>(
    'input[aria-label="Search conversations"]',
  );
}

/**
 * What has focus, by its label. A string because a failed `toBe` between two elements prints both
 * of them whole, which takes bun seconds on every retry inside `waitFor`.
 */
function focused() {
  return document.activeElement?.getAttribute("aria-label") ?? null;
}

test("⌘K opens a collapsed sidebar and puts the cursor in its search box", async () => {
  const { state } = await renderCollapsed();

  pressSearch();

  expect(state()).toBe("open");
  await waitFor(() => expect(focused()).toBe("Search conversations"));
});

test("⌘K works while somebody is typing in another field", async () => {
  const { view, state } = await renderCollapsed();
  const message = view.getByRole("textbox", { name: "Message" });
  message.focus();

  pressSearch(message);

  expect(state()).toBe("open");
  await waitFor(() => expect(focused()).toBe("Search conversations"));
});

test("on a narrow window, ⌘K opens the sidebar's sheet and focuses its search box", async () => {
  setViewport(500, 800);
  const { state } = await renderCollapsed();
  expect(searchBox()).toBeNull();

  pressSearch();

  expect(state()).toBe("open");
  await waitFor(() => expect(focused()).toBe("Search conversations"));
});

test("Settings lists the search shortcut with its keys, from the same list the listener reads", async () => {
  const queryClient = signedIn();
  const router = createRouter({
    routeTree: createRootRoute({ component: SettingsRoute.options.component }),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <RouterProvider router={router} />
      </ThemeProvider>
    </QueryClientProvider>,
  );

  const search = HOTKEYS.find((hotkey) => hotkey.id === "search");
  if (!search) throw new Error("No search shortcut");
  const title = await view.findByText(search.label);
  const row = title.closest('[data-slot="item"]');
  expect(row?.textContent).toContain(search.description);
  expect(
    [...(row?.querySelectorAll("kbd") ?? [])].map((key) => key.textContent),
  ).toEqual(formatHotkey(combo));
});
