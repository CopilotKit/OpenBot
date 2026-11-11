import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  type BrowserApiState,
  browserApiPaths,
} from "@openbot/shared/openbot-browser";
import type { RecorderActivity } from "@openbot/shared/recorder-api";
import {
  environmentManager,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AppSidebar } from "@/components/app-sidebar/app-sidebar";
import { SidebarProvider } from "@/components/ui/sidebar";
import { agentKeys } from "@/lib/agents/queries";
import { authKeys } from "@/lib/auth/queries";
import { botLifecycleKeys } from "@/lib/bot-lifecycle/queries";
import { channelKeys } from "@/lib/channels/queries";
import { deploymentKeys } from "@/lib/deployment/queries";
import { userPreferencesQueryOptions } from "@/lib/settings/message-list";
import { settleReactWork } from "./settle-react-work";

/**
 * The main menu says when a recording is live. Teaching a Bot a task is how a skill is recorded, so while any of the
 * person's Recorders records (the server's `activity`: the OpenBot browser's, or one in their everyday browser), the
 * Skills entry carries a red dot named for the recording, and a tooltip saying the same. Nothing extra otherwise.
 *
 * Drawn through the real sidebar, against the server's Browser state route as shared/openbot-browser.ts types it.
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
let wasServer = true;

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  globalThis.WebSocket = OfflineWebSocket as unknown as typeof WebSocket;
  wasServer = environmentManager.isServer();
  // The query library decided "server" when it was imported, before the DOM existed, and so never polls. The
  // sidebar's polling of the Browser state is what this file is about.
  environmentManager.setIsServer(() => false);
});

const PERSON_BROWSER = `person-${"cd34".repeat(8)}`;
let state: BrowserApiState;

function idleState(available = true): BrowserApiState {
  return { available, computerId: PERSON_BROWSER, open: false, tabs: [] };
}

/** A Recorder at `phase`, recording "Submit the receipt" for the last 83 seconds, as the server's `activity` has it. */
function receipt(phase: RecorderActivity["phase"]): RecorderActivity {
  return {
    phase,
    recordingId: "rec-1",
    title: "Submit the receipt",
    startedAt: Date.now() - 83_000,
    actions: 4,
  };
}

beforeEach(() => {
  state = idleState();
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL) =>
      new URL(String(input), "http://localhost/").pathname ===
      browserApiPaths.state
        ? Response.json(state)
        : Response.json({ error: "not served" }, { status: 404 }),
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
  environmentManager.setIsServer(() => wasServer);
  globalThis.WebSocket = originalWebSocket;
  GlobalRegistrator.unregister();
});

function renderSidebar() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  clients.push(queryClient);
  queryClient.setQueryDefaults(deploymentKeys.capabilities(), {
    staleTime: Number.POSITIVE_INFINITY,
  });
  queryClient.setQueryData(deploymentKeys.capabilities(), {
    generativeUi: true,
    selfHostBanner: false,
    localEvaluation: false,
    edition: "team",
  });
  queryClient.setQueryDefaults(authKeys.currentUser(), {
    staleTime: Number.POSITIVE_INFINITY,
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
        <SidebarProvider>
          <AppSidebar />
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
  return { view, queryClient };
}

/** The sidebar's footer, where the main menu's entries are. */
async function footerOf(view: ReturnType<typeof render>) {
  return waitFor(() => {
    const element = view.container.querySelector<HTMLElement>(
      '[data-sidebar="footer"]',
    );
    if (!element) throw new Error("No sidebar footer");
    return element;
  });
}

/** The names of the red dots in the footer. */
const dots = (footer: HTMLElement) =>
  within(footer)
    .queryAllByRole("img")
    .map((dot) => dot.getAttribute("aria-label"));

test("a recording puts a red dot named for it on Skills, ticking while it records, and Stop takes it away", async () => {
  state = { ...idleState(), activity: receipt("recording") };
  const { view } = renderSidebar();
  const footer = await footerOf(view);
  const dot = await within(footer).findByRole("img", {
    name: /^Recording: Submit the receipt, 1:2\d$/,
  });
  expect(dot.querySelector(".bg-destructive")).not.toBeNull();
  // On Skills, and on Skills alone: the entry carries the recording's name with its own, for a screen reader.
  const skills = within(footer).getByRole("link", {
    name: /^Skills Recording: Submit the receipt, 1:2\d$/,
  });
  expect(skills.getAttribute("href")).toBe("/skills");
  expect(skills.contains(dot)).toBe(true);
  expect(dots(footer)).toHaveLength(1);

  // Hovered, the tooltip says what the dot's name says, even with the sidebar open.
  const user = userEvent.setup({ document });
  await user.hover(skills);
  await waitFor(() =>
    expect(
      [...document.querySelectorAll("[data-slot=tooltip-content]")].map(
        (tooltip) => tooltip.textContent,
      ),
    ).toEqual([
      expect.stringMatching(/^Recording: Submit the receipt, 1:2\d$/),
    ]),
  );
  await user.unhover(skills);

  // Stopping, then stopped: gone at the next ask, which is every second while something records.
  state = { ...idleState(), activity: receipt("stopping") };
  expect(
    await within(footer).findByRole(
      "img",
      { name: "Recording: Submit the receipt, stopping" },
      { timeout: 2000 },
    ),
  ).toBeTruthy();
  state = idleState();
  await waitFor(() => expect(dots(footer)).toEqual([]), { timeout: 2000 });
  expect(within(footer).getByRole("link", { name: "Skills" })).toBeTruthy();
});

test("while a recording starts the dot shows, and is not yet live", async () => {
  state = { ...idleState(), activity: receipt("starting") };
  const { view } = renderSidebar();
  const footer = await footerOf(view);
  const dot = await within(footer).findByRole("img", {
    name: "Recording: Submit the receipt, starting",
  });
  expect(dot.querySelector(".bg-destructive")).toBeNull();
});

test("nothing recording, or OpenBot unable to run a browser, puts nothing extra on Skills", async () => {
  const { view, queryClient } = renderSidebar();
  const footer = await footerOf(view);
  await waitFor(() =>
    expect(queryClient.getQueryState(["browser", "state"])?.status).toBe(
      "success",
    ),
  );
  expect(dots(footer)).toEqual([]);
  expect(within(footer).getByRole("link", { name: "Skills" })).toBeTruthy();
  expect(document.querySelector("[data-slot=tooltip-content]")).toBeNull();
  cleanup();

  // A server that says it cannot run a browser for this person, whatever its activity says, lights nothing.
  state = { ...idleState(false), activity: receipt("recording") };
  const unavailable = renderSidebar();
  const footer2 = await footerOf(unavailable.view);
  await waitFor(() =>
    expect(
      unavailable.queryClient.getQueryState(["browser", "state"])?.status,
    ).toBe("success"),
  );
  expect(dots(footer2)).toEqual([]);
});
