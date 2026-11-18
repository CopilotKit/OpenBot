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
} from "@tanstack/react-router";
import {
  cleanup,
  fireEvent,
  render,
  waitFor,
  within,
} from "@testing-library/react";
import type { BotAttention } from "@/lib/bot-lifecycle/queries";
import { navigationFor } from "@/lib/navigation";
import { SKINS } from "@/skins/registry";
import { ME_PATH, meBody, PREFERENCES_PATH } from "./accounts-api";
import { DEPLOYMENT_PATH } from "./admin-settings-api";
import { answerBotAttention, answerBotsList, attentionOf } from "./bots-api";
import { CONVERSATIONS_PATH, conversationPage } from "./conversations-api";
import { settleReactWork } from "./settle-react-work";

/*
 * Kite Bot's frame replaces OpenBot's sidebar with one that lists Bots first. These render the skin
 * as `_authed/_app` does (its Frame around the page, its Sky on home) against a fake of OpenBot's
 * API that answers in the shapes the real endpoints return.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const originalFetch = global.fetch;
const originalSocket = globalThis.WebSocket;
afterEach(() => {
  global.fetch = originalFetch;
  globalThis.WebSocket = originalSocket;
});

/** The frame keeps OpenBot's live socket open; here it never connects. */
class QuietSocket {
  onopen: unknown = null;
  onclose: unknown = null;
  onmessage: unknown = null;
  onerror: unknown = null;
  close() {}
  send() {}
}

const now = "2026-11-17T10:00:00.000Z";

function bot(id: string, name: string, title: string) {
  return {
    id,
    name,
    title,
    roleDescription: "",
    avatarSeed: id,
    hidden: false,
    pinned: false,
  };
}

const BOTS = [
  bot("b-ledger", "Ledger", "Finance"),
  bot("b-ivy", "Ivy", "Inbox"),
  bot("b-scout", "Scout", "Research"),
  bot("b-quill", "Quill", "Writer"),
];

function channel(
  id: string,
  agentIds: string[],
  summary: string,
  more: Record<string, unknown> = {},
) {
  return {
    id,
    name: "",
    agentIds,
    threadId: `t-${id}`,
    active: true,
    lastMessageAt: now,
    summary,
    lastMessage: summary,
    lastMessageAgentId: null,
    createdAt: now,
    pinned: false,
    lastReadAt: now,
    ...more,
  };
}

const CHANNELS = [
  channel("c-close", ["b-ledger"], "October close"),
  channel("c-invoices", ["b-ledger"], "Supplier invoices", {
    lastMessageAt: "2026-11-16T10:00:00.000Z",
  }),
  channel("c-triage", ["b-ivy"], "Morning triage", { pinned: true }),
  channel("c-scan", ["b-scout"], "Competitor scan", { busy: true }),
  channel("g-launch", ["b-quill", "b-scout"], "Launch post draft"),
];

function api({
  attention = [
    attentionOf("b-ivy", "Ivy", { approvals: 2, waitingIn: "c-triage" }),
  ],
}: {
  attention?: BotAttention[];
} = {}) {
  const bodies: Record<string, unknown> = {
    [ME_PATH]: meBody({
      user: {
        id: "u-1",
        name: "Maya Chen",
        email: "maya@example.com",
        role: "admin",
        onboarding: null,
      },
    }),
    [DEPLOYMENT_PATH]: { transcription: true },
    [PREFERENCES_PATH]: {
      messageListEmphasis: "thread",
      selfHostBannerDismissed: true,
    },
    [CONVERSATIONS_PATH]: conversationPage(CHANNELS),
  };
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input).split("?")[0] ?? "";
    const bots = answerBotsList(input, init, { visible: BOTS });
    if (bots) return bots;
    const waiting = answerBotAttention(input, init, { bots: attention });
    if (waiting) return waiting;
    if (path in bodies) return Response.json(bodies[path]);
    return Response.json({ error: "not served" }, { status: 404 });
  }) as typeof fetch;
  globalThis.WebSocket = QuietSocket as unknown as typeof WebSocket;
}

/** Kite Bot around a page, as `_authed/_app` draws a skin's Frame, starting at `path`. */
function renderApp(path: string) {
  const { Frame, home: Home } = SKINS.kitebot;
  if (!Frame || !Home) throw new Error("Kite Bot has no frame");
  const rootRoute = createRootRoute({
    component: () => (
      <Frame>
        <Outlet />
      </Frame>
    ),
  });
  const page = (routePath: string, body: () => React.ReactNode) =>
    createRoute({
      path: routePath,
      getParentRoute: () => rootRoute,
      component: body,
    });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      page("/", () => (
        <>
          <h1>Start a conversation</h1>
          <Home />
        </>
      )),
      page("/channel/$channelId", () => <p>A conversation</p>),
      page("/group/$channelId", () => <p>A group</p>),
      page("/channel/new", () => <p>New</p>),
      page("/bots", () => <p>Bots</p>),
      page("/bots/$agentId", () => <p>A Bot</p>),
    ]),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

function section(view: ReturnType<typeof render>, name: string) {
  return view.findByRole("region", { name });
}

describe("the sidebar lists Bots first", () => {
  test("every Bot is a row led by its kite, in a steady order", async () => {
    api();
    const view = renderApp("/");
    const bots = await section(view, "Bots");
    await within(bots).findByText("Scout");
    const names = within(bots)
      .getAllByRole("img")
      .map((kite) => kite.getAttribute("aria-label"));
    expect(names).toEqual(["Ivy", "Ledger", "Quill", "Scout"]);
    expect(bots.querySelectorAll("[data-kite]")).toHaveLength(4);
  });

  test("Needs you lifts a waiting Bot above the rest, says how much waits, and goes to where it waits", async () => {
    api();
    const view = renderApp("/");
    const needs = await section(view, "Needs you");
    const row = await within(needs).findByRole("link", { name: /Ivy/ });
    expect(row.getAttribute("href")).toBe("/channel/c-triage");
    expect(within(row).getByText("2")).toBeTruthy();
    expect(row.querySelector('[data-kite="waiting"]')).toBeTruthy();
    // Waiting, it looks out with its taller eyes: two blocks of two by four.
    expect(row.querySelectorAll(".bot-kite-eye")).toHaveLength(16);
  });

  test("no Needs you section while nothing waits on the person", async () => {
    api({ attention: [] });
    const view = renderApp("/");
    await within(await section(view, "Bots")).findByText("Scout");
    expect(view.queryByRole("region", { name: "Needs you" })).toBeNull();
  });

  test("a Bot working in a conversation shows it on its kite", async () => {
    api();
    const view = renderApp("/");
    const bots = await section(view, "Bots");
    const scout = await within(bots).findByRole("img", { name: "Scout" });
    await waitFor(() =>
      expect(scout.getAttribute("data-kite")).toBe("working"),
    );
  });

  test("the Bot you are with keeps its eyes open; any other wakes only while you point at it", async () => {
    api();
    const view = renderApp("/channel/c-close");
    const bots = await section(view, "Bots");
    const eyesOf = (name: string) =>
      within(bots).getByRole("img", { name }).querySelectorAll(".bot-kite-eye")
        .length;
    await within(bots).findByRole("link", { name: /^October close/ });
    expect(eyesOf("Ledger")).toBe(12);
    expect(eyesOf("Quill")).toBe(0);
    const quill = within(bots).getByRole("link", { name: /^Quill/ });
    fireEvent.pointerEnter(quill);
    await waitFor(() => expect(eyesOf("Quill")).toBe(12));
    fireEvent.pointerLeave(quill);
    await waitFor(() => expect(eyesOf("Quill")).toBe(0));
  });

  test("the Bot on screen opens out with its conversations, newest first; the others stay closed", async () => {
    api();
    const view = renderApp("/channel/c-close");
    const bots = await section(view, "Bots");
    const close = await within(bots).findByRole("link", {
      name: /^October close/,
    });
    expect(close.getAttribute("href")).toBe("/channel/c-close");
    const ledgerRows = within(bots)
      .getAllByRole("link")
      .map((link) => link.textContent?.trim());
    const at = (title: string) =>
      ledgerRows.findIndex((row) => row?.startsWith(title));
    expect(at("October close")).toBeGreaterThan(-1);
    expect(at("Supplier invoices")).toBeGreaterThan(at("October close"));
    expect(within(bots).queryByText("Competitor scan")).toBeNull();
  });

  test("choosing a Bot opens its newest conversation, or starts one when it has none", async () => {
    api();
    const view = renderApp("/");
    const bots = await section(view, "Bots");
    const ledger = await within(bots).findByRole("link", { name: /^Ledger/ });
    expect(ledger.getAttribute("href")).toBe("/channel/c-close");
    const quill = within(bots).getByRole("link", { name: /^Quill/ });
    expect(quill.getAttribute("href")).toBe("/channel/new?agent=b-quill");
    expect(
      within(bots)
        .getByRole("link", { name: "New conversation with Ledger" })
        .getAttribute("href"),
    ).toBe("/channel/new?agent=b-ledger");
  });

  test("pinned conversations and conversations with several Bots have sections of their own", async () => {
    api();
    const view = renderApp("/");
    const pinned = await section(view, "Pinned");
    expect(
      (
        await within(pinned).findByRole("link", { name: /Morning triage/ })
      ).getAttribute("href"),
    ).toBe("/channel/c-triage");
    const groups = await section(view, "Groups");
    const launch = await within(groups).findByRole("link", {
      name: /Launch post draft/,
    });
    expect(launch.getAttribute("href")).toBe("/group/g-launch");
    expect(launch.querySelectorAll("[data-kite]")).toHaveLength(2);
  });

  test("its foot reaches every one of OpenBot's own destinations", async () => {
    api();
    const view = renderApp("/");
    await within(await section(view, "Bots")).findByText("Scout");
    const primary = navigationFor("admin").filter(
      (item) => item.section === "primary",
    );
    await waitFor(() => {
      for (const item of primary)
        expect(
          view.getAllByRole("link", { name: new RegExp(`^${item.label}`) }),
        ).not.toHaveLength(0);
    });
  });
});

describe("the Sky, on home", () => {
  test("every Bot's kite, what needs you first, then what is working", async () => {
    api();
    const view = renderApp("/");
    const sky = await view.findByRole("region", { name: "Your Bots" });
    await within(sky).findByText("Quill");
    await waitFor(() => {
      const order = within(sky)
        .getAllByRole("img")
        .map((kite) => kite.getAttribute("aria-label"));
      expect(order.slice(0, 2)).toEqual(["Ivy", "Scout"]);
    });
    expect(within(sky).getByText("Waiting on you · 2")).toBeTruthy();
    expect(within(sky).getByText("Working")).toBeTruthy();
  });

  test("a tile opens its Bot's newest conversation, or starts one", async () => {
    api();
    const view = renderApp("/");
    const sky = await view.findByRole("region", { name: "Your Bots" });
    const ledger = await within(sky).findByRole("link", { name: /Ledger/ });
    expect(ledger.getAttribute("href")).toBe("/channel/c-close");
    expect(
      within(sky).getByRole("link", { name: /Quill/ }).getAttribute("href"),
    ).toBe("/channel/new?agent=b-quill");
  });
});
