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
import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { queryClient } from "@/query-client";
import { opendots } from "@/skins/opendots";
import { dotCharacter } from "@/skins/opendots/dot-avatar";
import type { AgentProfileStore } from "../../server/src/agents/profile-store";
import type { AgentProfile } from "../../server/src/agents/profile-types";
import { createAgentRoutes } from "../../server/src/agents/routes";
import { settleReactWork } from "./settle-react-work";

/**
 * The OpenDots frame, drawn around a page the way `_authed/_app` draws it, against OpenBot's own
 * agent routes and the payloads OpenBot's endpoints send.
 *
 * What it holds the frame to: every OpenBot surface the default sidebar reaches is reachable from
 * it, Settings above all (it is where a skin is switched back); its Dots are OpenBot's Bots as the
 * agents route lists them; a Dot opens a chat with its Bot; and its computer toggle drives the
 * conversation's own computer pane rather than opening a second one.
 */

class OfflineWebSocket extends EventTarget implements WebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;
  binaryType: BinaryType = "blob";
  bufferedAmount = 0;
  extensions = "";
  protocol = "";
  readyState = 0;
  onclose: WebSocket["onclose"] = null;
  onerror: WebSocket["onerror"] = null;
  onmessage: WebSocket["onmessage"] = null;
  onopen: WebSocket["onopen"] = null;
  readonly url: string;
  constructor(url: string | URL) {
    super();
    this.url = String(url);
  }
  close() {}
  send() {}
}

type Actor = { id: string; email: string; role: "admin" | "user" };

const person: Actor = { id: "dana", email: "dana@example.test", role: "user" };
const admin: Actor = { id: "ola", email: "ola@example.test", role: "admin" };

function profile(
  id: string,
  name: string,
  overrides: Partial<AgentProfile> = {},
): AgentProfile {
  return {
    id,
    name,
    title: "Coworker",
    roleDescription: `${name} helps.`,
    avatarSeed: id,
    ownerUserId: person.id,
    visibility: "private",
    systemOwned: false,
    hidden: false,
    pinned: false,
    deletedAt: null,
    endpoint: null,
    hasAuth: false,
    hasCallbackToken: false,
    ...overrides,
  };
}

function channel(
  id: string,
  agentIds: string[],
  overrides: Record<string, unknown> = {},
) {
  return {
    id,
    name: id,
    agentIds,
    threadId: id,
    active: true,
    lastMessageAt: "2026-10-20T10:00:00.000Z",
    summary: null,
    lastMessage: null,
    lastMessageAgentId: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    pinned: false,
    lastReadAt: null,
    ...overrides,
  };
}

/** What each request asked for, so a test can say a write reached the server. */
const requests: Array<{ method: string; path: string }> = [];
let actor: Actor = person;
let bots: AgentProfile[] = [];
let channels: ReturnType<typeof channel>[] = [];
let agentsFail = false;
const paused = new Set<string>();

let originalFetch: typeof fetch;
let originalWebSocket: typeof WebSocket;

function agentRoutes() {
  const store = {
    list: async () => (agentsFail ? Promise.reject(new Error("down")) : bots),
    get: async (_actor: unknown, id: string) =>
      bots.find((bot) => bot.id === id) ?? null,
  } as unknown as AgentProfileStore;
  return createAgentRoutes(store, async (context, next) => {
    context.set("actor", actor);
    await next();
  });
}

/** OpenBot's endpoints, answering in the envelopes the browser reads them in. */
async function serve(path: string, init?: RequestInit): Promise<Response> {
  const method = init?.method ?? "GET";
  requests.push({ method, path });
  const url = new URL(path, "http://openbot.test");
  if (
    url.pathname === "/api/agents" ||
    url.pathname.startsWith("/api/agents/")
  ) {
    return agentRoutes().request(
      new Request(
        `http://openbot.test${url.pathname.slice("/api/agents".length)}${url.search}`,
        init,
      ),
    );
  }
  if (url.pathname === "/api/me") {
    return Response.json({
      user: { ...actor, name: "Dana Reyes", onboarding: null },
    });
  }
  if (url.pathname === "/api/channels") {
    return Response.json({ channels, nextCursor: null });
  }
  const one = url.pathname.match(/^\/api\/channels\/([^/]+)$/);
  if (one) {
    const found = channels.find((item) => item.id === one[1]);
    return found
      ? Response.json({ channel: found })
      : Response.json({ error: "Not found" }, { status: 404 });
  }
  if (url.pathname === "/api/routines") {
    return Response.json({
      routines: [],
      sweep: { lastSweptAt: null, working: true },
    });
  }
  if (url.pathname === "/api/memory") {
    return Response.json({ memories: [] });
  }
  if (url.pathname === "/api/bots/attention") {
    return Response.json({ bots: [] });
  }
  const lifecycle = url.pathname.match(
    /^\/api\/bots\/([^/]+)\/(lifecycle|pause|resume)$/,
  );
  if (lifecycle) {
    const id = decodeURIComponent(lifecycle[1]);
    if (lifecycle[2] === "pause") paused.add(id);
    if (lifecycle[2] === "resume") paused.delete(id);
    return Response.json({
      lifecycle: {
        agentId: id,
        paused: paused.has(id),
        pausedAt: null,
        notify: "all",
      },
    });
  }
  return Response.json({ error: "Not part of this test" }, { status: 404 });
}

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://127.0.0.1:3112" });
  originalFetch = globalThis.fetch;
  originalWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = OfflineWebSocket;
  globalThis.fetch = Object.assign(
    (input: RequestInfo | URL, init?: RequestInit) =>
      serve(String(input), init),
    { preconnect: originalFetch.preconnect },
  );
});

beforeEach(() => {
  requests.length = 0;
  actor = person;
  agentsFail = false;
  paused.clear();
  bots = [
    profile("ada", "Ada"),
    profile("brook", "Brook", { pinned: true }),
    profile("cass", "Cass", { ownerUserId: "someone", visibility: "public" }),
  ];
  channels = [
    channel("trip", ["brook"], { summary: "Planning the Lisbon trip" }),
    channel("standup", ["ada", "brook"], { summary: "Monday standup" }),
  ];
});

afterEach(() => {
  cleanup();
  // The app's one client, as the mutations invalidate it; each test starts from an empty cache.
  queryClient.clear();
});

afterAll(async () => {
  await settleReactWork();
  globalThis.fetch = originalFetch;
  globalThis.WebSocket = originalWebSocket;
  GlobalRegistrator.unregister();
});

/**
 * The frame around a stand-in page, at `path`, in a router whose every address is a page. The
 * frame is the registered skin's own, exactly what `_authed/_app` renders.
 */
function draw(path: string) {
  const Frame = opendots.Frame;
  if (!Frame) throw new Error("OpenDots has no frame");
  const root = createRootRoute({
    component: () => (
      <Frame>
        <Outlet />
      </Frame>
    ),
  });
  const page = createRoute({
    getParentRoute: () => root,
    path: "$",
    component: () => <p>OpenBot page</p>,
  });
  const index = createRoute({
    getParentRoute: () => root,
    path: "/",
    component: () => <p>OpenBot home</p>,
  });
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: [path] }),
    routeTree: root.addChildren([index, page]),
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  const user = userEvent.setup({ document: view.baseElement.ownerDocument });
  return { view, router, user };
}

/** Every address the frame links to, as the browser would follow it. */
function hrefs(container: HTMLElement) {
  return new Set(
    [...container.querySelectorAll("a[href]")].map(
      (anchor) => anchor.getAttribute("href") ?? "",
    ),
  );
}

describe("OpenDots frame", () => {
  test("DOTS lists the Bots OpenBot's agent list returns, each with a stable plush", async () => {
    const { view } = draw("/");
    const dots = await view.findByRole("navigation", { name: "Your Bots" });
    await waitFor(() =>
      expect(within(dots).getAllByTestId("opendots-dot")).toHaveLength(3),
    );
    // Pinned first, then the person's own, then shared with them: the Bots roster's own order.
    expect(
      within(dots)
        .getAllByTestId("opendots-dot")
        .map((row) => row.textContent),
    ).toEqual(["Brook", "Ada", "Cass"]);
    for (const bot of bots) {
      const row = within(dots).getByText(bot.name).closest("a");
      expect(row?.querySelector("img")?.getAttribute("src")).toBe(
        `/skins/opendots/${dotCharacter(bot.id)}.png`,
      );
    }
    // The same Bot always wears the same plush.
    expect(dotCharacter("ada")).toBe(dotCharacter("ada"));
    expect(requests.some((request) => request.path === "/api/agents")).toBe(
      true,
    );
  });

  test("a Dot reopens its latest chat, starts one when there is none, and its settings open the Bot", async () => {
    const { view, router, user } = draw("/");
    const dots = await view.findByRole("navigation", { name: "Your Bots" });
    await within(dots).findByText("Ada");
    await waitFor(() =>
      expect(
        within(dots).getByText("Brook").closest("a")?.getAttribute("href"),
      ).toBe("/channel/trip"),
    );
    // Ada is only in a group, so choosing her starts a conversation with her alone.
    expect(
      within(dots).getByText("Ada").closest("a")?.getAttribute("href"),
    ).toBe("/channel/new?agent=ada");

    await user.click(within(dots).getByText("Ada"));
    await waitFor(() =>
      expect(router.state.location.href).toBe("/channel/new?agent=ada"),
    );
    await waitFor(() =>
      expect(view.getByTestId("opendots-crumb").textContent).toBe("Ada"),
    );

    await user.click(view.getByLabelText("Open Cass's settings"));
    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/bots/cass"),
    );
  });

  test("every OpenBot surface is reachable from the frame", async () => {
    const { view } = draw("/");
    await view.findByText("Planning the Lisbon trip");
    await view.findByText("Cass");
    const links = hrefs(view.container);
    for (const href of [
      "/", // home
      "/channel/new", // new chat
      "/channel/trip", // a conversation with one Bot
      "/group/standup", // a group conversation
      "/bots", // Bots, where approvals, responsibilities and Team Bots now live
      "/bots?new=true", // creating a Bot
      "/bots/ada", // each Bot's own pages
      "/bots/brook",
      "/bots/cass",
      "/s/activity", // routines
      "/s/memories", // memory
      "/capabilities/skills", // skills
      "/connections",
      "/settings", // the skin picker, approvals and reachability
    ]) {
      expect(links).toContain(href);
    }
    // Admin is offered only to the people the server lets in.
    expect(links).not.toContain("/admin");
    expect(view.getByRole("button", { name: "Sign out" })).toBeTruthy();
  });

  test("an administrator also reaches Admin", async () => {
    actor = admin;
    const { view } = draw("/");
    await waitFor(() => expect(hrefs(view.container)).toContain("/admin"));
  });

  test.each([
    "/",
    "/channel/trip",
    "/group/standup",
    "/bots/ada/setup",
    "/s/activity",
    "/connections",
  ])(
    "Settings is reachable on %s, even when nothing else loads",
    async (path) => {
      agentsFail = true;
      channels = [];
      const { view } = draw(path);
      await view.findByText(/OpenBot (page|home)/);
      const settings = view
        .getAllByRole("link")
        .filter((link) => link.getAttribute("href") === "/settings");
      // In the rail and in the sidebar, so collapsing the sidebar never hides it.
      expect(settings.length).toBe(2);
      expect(
        view.getByRole("link", { name: "Open settings" }).getAttribute("href"),
      ).toBe("/settings");
    },
  );

  test("on a conversation, the computer toggle opens the conversation's own computer pane", async () => {
    const { view, router, user } = draw("/channel/trip");
    const toggle = await view.findByRole("button", { name: "Show computer" });
    await user.click(toggle);
    await waitFor(() =>
      expect(router.state.location.search).toMatchObject({ watch: true }),
    );
    // No second screen: the frame's own pane stays shut where the page has one.
    expect(view.queryByTestId("opendots-computer-pane")).toBeNull();
    await user.click(
      await view.findByRole("button", { name: "Hide computer" }),
    );
    await waitFor(() =>
      expect(
        (router.state.location.search as { watch?: boolean }).watch,
      ).toBeUndefined(),
    );
  });

  test("elsewhere, the computer toggle opens OpenBot's computer for the Bot on screen", async () => {
    const { view, user } = draw("/bots/cass");
    await waitFor(() =>
      expect(view.getByTestId("opendots-crumb").textContent).toBe("Cass"),
    );
    await user.click(view.getByRole("button", { name: "Show computer" }));
    const pane = await view.findByTestId("opendots-computer-pane");
    expect(within(pane).getByText("Cass’s computer")).toBeTruthy();
    // OpenBot's own panel, not a copy of it.
    expect(
      within(pane).getByRole("region", { name: "Computer sidebar" }),
    ).toBeTruthy();
    await user.click(
      within(pane).getByRole("button", { name: "Close computer" }),
    );
    expect(view.queryByTestId("opendots-computer-pane")).toBeNull();
  });

  test("the Bot on screen can be paused and resumed from the top bar", async () => {
    const { view, user } = draw("/channel/new?agent=ada");
    await user.click(await view.findByRole("button", { name: "Pause Ada" }));
    expect(
      await view.findByRole("button", { name: "Resume Ada" }),
    ).toBeTruthy();
    expect(requests).toContainEqual({
      method: "POST",
      path: "/api/bots/ada/pause",
    });
    // A page about no one Bot offers no pause, since there would be nothing to say it applies to.
    cleanup();
    const elsewhere = draw("/connections");
    await elsewhere.view.findByText("OpenBot page");
    expect(
      elsewhere.view.queryByRole("button", { name: /^Pause / }),
    ).toBeNull();
  });
});

describe("OpenDots screens", () => {
  test("Scheduled & activity is OpenBot's routines list under OpenDots' heading", async () => {
    const Screen = opendots.screens?.activity;
    if (!Screen) throw new Error("OpenDots has no activity screen");
    const view = render(
      <QueryClientProvider client={queryClient}>
        <Screen />
      </QueryClientProvider>,
    );
    expect(
      view.getByRole("heading", { name: "A little follow-through." }),
    ).toBeTruthy();
    expect(await view.findByText("No routines yet")).toBeTruthy();
  });

  test("Memories is OpenBot's memory list under OpenDots' heading, with Remember a fact", async () => {
    const Screen = opendots.screens?.memories;
    if (!Screen) throw new Error("OpenDots has no memories screen");
    const view = render(
      <QueryClientProvider client={queryClient}>
        <Screen />
      </QueryClientProvider>,
    );
    expect(view.getByRole("heading", { name: "Memories" })).toBeTruthy();
    expect(await view.findByText("No memories yet")).toBeTruthy();
    expect(view.getByRole("button", { name: /Remember a fact/ })).toBeTruthy();
  });
});
