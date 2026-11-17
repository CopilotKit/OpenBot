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
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import {
  cleanup,
  fireEvent,
  render,
  waitFor,
  within,
} from "@testing-library/react";
import { PlacesSidebar } from "@/components/places/places-sidebar";
import { SidebarProvider } from "@/components/ui/sidebar";
import { agentKeys } from "@/lib/agents/queries";
import { authKeys } from "@/lib/auth/queries";
import { botLifecycleKeys } from "@/lib/bot-lifecycle/queries";
import { channelKeys } from "@/lib/channels/queries";
import { deploymentKeys } from "@/lib/deployment/queries";
import {
  PLACE_IDS,
  PLACE_ORDER_STORAGE_KEY,
  PLACES,
  parseStoredOrder,
} from "@/lib/places/places";
import { getPlace, setPlace, setPlaceOrder } from "@/lib/places/store";
import { userPreferencesQueryOptions } from "@/lib/settings/message-list";
import { settleReactWork } from "./settle-react-work";

/*
 * The strip's places are reordered from a context menu on each button, and the order is kept in
 * this browser.
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
  GlobalRegistrator.register({
    url: "http://localhost/",
    width: 1280,
    height: 840,
    settings: { navigation: { disableChildFrameNavigation: true } },
  });
  globalThis.WebSocket = OfflineWebSocket as unknown as typeof WebSocket;
});
beforeEach(() => {
  globalThis.fetch = Object.assign(
    async () => Response.json({ error: "not served" }, { status: 404 }),
    { preconnect: originalFetch.preconnect },
  );
  setPlaceOrder([...PLACE_IDS]);
  setPlace("conversations");
  sessionStorage.clear();
  localStorage.clear();
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

function renderSidebar() {
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
    role: "admin",
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
  const rootRoute = createRootRoute({
    component: () => (
      <SidebarProvider>
        <PlacesSidebar />
        <Outlet />
      </SidebarProvider>
    ),
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      createRoute({
        getParentRoute: () => rootRoute,
        path: "/",
        component: () => null,
      }),
    ]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return view;
}

/** The strip's place buttons, in document order. */
async function placeButtons(view: ReturnType<typeof renderSidebar>) {
  const strip = await view.findByRole("toolbar");
  return within(strip)
    .getAllByRole("button")
    .filter((button) => button.hasAttribute("aria-pressed"));
}

async function placeNames(view: ReturnType<typeof renderSidebar>) {
  return (await placeButtons(view)).map((button) =>
    button.getAttribute("aria-label"),
  );
}

test("Move down on the first place puts it second and remembers it", async () => {
  const view = renderSidebar();
  const before = await placeNames(view);
  const [first] = await placeButtons(view);

  fireEvent.contextMenu(first);
  fireEvent.click(await view.findByRole("menuitem", { name: "Move down" }));

  const after = [before[1], before[0], ...before.slice(2)];
  await waitFor(async () => expect(await placeNames(view)).toEqual(after));
  const stored = JSON.parse(
    localStorage.getItem(PLACE_ORDER_STORAGE_KEY) ?? "[]",
  );
  const ids = after.map((name) =>
    PLACE_IDS.find((id) => PLACES[id].label === name),
  );
  expect(stored.slice(0, 2)).toEqual(ids.slice(0, 2));
});

test("a fresh render keeps the order", async () => {
  const view = renderSidebar();
  const before = await placeNames(view);
  const [first] = await placeButtons(view);
  fireEvent.contextMenu(first);
  fireEvent.click(await view.findByRole("menuitem", { name: "Move down" }));
  const after = [before[1], before[0], ...before.slice(2)];
  await waitFor(async () => expect(await placeNames(view)).toEqual(after));

  view.unmount();
  const ids = after.flatMap((name) =>
    PLACE_IDS.filter((id) => PLACES[id].label === name),
  );
  expect(
    parseStoredOrder(localStorage.getItem(PLACE_ORDER_STORAGE_KEY)),
  ).toEqual(ids);
  const again = renderSidebar();
  expect(await placeNames(again)).toEqual(after);
});

test("Move up is disabled on the first place", async () => {
  const view = renderSidebar();
  const [first] = await placeButtons(view);
  fireEvent.contextMenu(first);
  const up = await view.findByRole("menuitem", { name: "Move up" });
  const down = await view.findByRole("menuitem", { name: "Move down" });
  expect(
    up.getAttribute("aria-disabled") === "true" ||
      up.hasAttribute("data-disabled"),
  ).toBe(true);
  expect(down.getAttribute("aria-disabled")).not.toBe("true");
  expect(down.hasAttribute("data-disabled")).toBe(false);
});

test("a press without movement still chooses the place", async () => {
  const view = renderSidebar();
  const bots = (await placeButtons(view)).find(
    (button) => button.getAttribute("aria-label") === "Bots",
  ) as HTMLElement;

  fireEvent.pointerDown(bots);
  fireEvent.pointerUp(bots);
  fireEvent.click(bots);

  expect(getPlace()).toBe("bots");
  expect(bots.getAttribute("aria-pressed")).toBe("true");
});

/** A mouse event carrying coordinates and a click count, checked on arrival so no test passes on defaults. */
function press(
  type: "pointerdown" | "click",
  target: HTMLElement,
  init: { clientX: number; clientY: number; detail: number },
) {
  const event = new MouseEvent(type, { bubbles: true, ...init });
  expect([event.clientX, event.clientY, event.detail]).toEqual([
    init.clientX,
    init.clientY,
    init.detail,
  ]);
  fireEvent(target, event);
}

async function botsButton() {
  const view = renderSidebar();
  const bots = (await placeButtons(view)).find(
    (button) => button.getAttribute("aria-label") === "Bots",
  ) as HTMLElement;
  return bots;
}

test("a drag of 4px or more does not choose the place", async () => {
  const bots = await botsButton();

  press("pointerdown", bots, { clientX: 10, clientY: 10, detail: 0 });
  press("click", bots, { clientX: 10, clientY: 20, detail: 1 });

  expect(getPlace()).toBe("conversations");
  expect(bots.getAttribute("aria-pressed")).toBe("false");
});

test("a mouse click that moved under 4px still chooses the place", async () => {
  const bots = await botsButton();

  press("pointerdown", bots, { clientX: 10, clientY: 10, detail: 0 });
  press("click", bots, { clientX: 12, clientY: 11, detail: 1 });

  expect(getPlace()).toBe("bots");
});

test("a keyboard press always chooses the place", async () => {
  const bots = await botsButton();

  press("pointerdown", bots, { clientX: 10, clientY: 10, detail: 0 });
  press("click", bots, { clientX: 0, clientY: 0, detail: 0 });

  expect(getPlace()).toBe("bots");
});

test("a keyboard press after a drag released over the button still chooses the place", async () => {
  const bots = await botsButton();

  press("pointerdown", bots, { clientX: 10, clientY: 10, detail: 0 });
  press("click", bots, { clientX: 10, clientY: 20, detail: 1 });
  expect(getPlace()).toBe("conversations");
  press("click", bots, { clientX: 0, clientY: 0, detail: 0 });

  expect(getPlace()).toBe("bots");
});
