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
import userEvent from "@testing-library/user-event";
import { SKINS } from "@/skins/registry";
import { settleReactWork } from "./settle-react-work";

/*
 * OpenDuet's frame replaces OpenBot's sidebar, so everything the sidebar reached has to be reachable
 * from it, and Settings above all, because the skin picker is there. And its Tasks screen draws only
 * OpenBot's own data, decided with OpenBot's own mutations. These render the skin exactly as
 * `_authed/_app` does (the registered skin's Frame around the page, its screen at `/s/tasks`)
 * against a fake of OpenBot's API that answers in the shapes the real endpoints return.
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

type Sent = { method: string; path: string; body: unknown };

const now = "2026-10-27T10:00:00.000Z";

function channel(id: string, agentIds: string[], summary: string) {
  return {
    id,
    name: agentIds.length > 1 ? "Ops group" : "Inbox Bot",
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
  };
}

function api(role: "admin" | "user") {
  const sent: Sent[] = [];
  const bodies: Record<string, unknown> = {
    "/api/me": {
      user: {
        id: "u-1",
        name: "Maya Chen",
        email: "maya@example.com",
        role,
        onboarding: null,
      },
    },
    "/api/capabilities": { transcription: true },
    "/api/settings/preferences": {
      preferences: {
        messageListEmphasis: "thread",
        selfHostBannerDismissed: true,
      },
    },
    "/api/channels": {
      channels: [
        channel("c-1", ["b-1"], "Renewal for the studio policy"),
        channel("g-1", ["b-1", "b-2"], "Kiln repair plan"),
      ],
      nextCursor: null,
    },
    "/api/bots/attention": { bots: [] },
    "/api/agents": {
      agents: [
        { id: "b-1", name: "Inbox Bot" },
        { id: "b-2", name: "Ops Bot" },
      ],
    },
    "/api/approvals": {
      enabled: true,
      rules: [],
      teamRules: [],
      requests: [
        {
          id: "r-waiting",
          status: "pending",
          createdAt: now,
          action: {
            botId: "b-1",
            toolRef: "mcp/gmail/send_email",
            effect: "write",
            scope: "priya@example.com",
            threadId: "t-c-1",
            args: { to: "priya@example.com", body: "Thursday at 10 works." },
            target: null,
            policy: {
              behaviour: "ask",
              source: "rule",
              reason: "Sending mail asks first.",
            },
          },
        },
        {
          id: "r-decided",
          status: "allowed",
          createdAt: now,
          action: {
            botId: "b-1",
            toolRef: "mcp/drive/share",
            effect: "write",
            scope: "Quarterly plan",
            threadId: "t-c-1",
            args: {},
            target: null,
          },
        },
      ],
      questions: [
        {
          id: "q-1",
          botId: "b-2",
          threadId: "t-g-1",
          question: "Which kiln should I book the repair for?",
          createdAt: now,
        },
      ],
    },
    "/api/responsibilities": {
      responsibilities: [
        {
          id: "resp-on",
          agentId: "b-1",
          channelId: "c-1",
          threadId: "t-c-1",
          title: "Keep the support inbox at zero",
          instruction: "Answer what you can, hand me the rest.",
          successCriteria: "",
          status: "active",
          progress: "Answered 4 of 6 this morning",
          lastResult: null,
          subscriptions: [],
          updatedAt: now,
        },
        {
          id: "resp-paused",
          agentId: "b-1",
          channelId: "c-1",
          threadId: "t-c-1",
          title: "Chase overdue invoices",
          instruction: "",
          successCriteria: "",
          status: "paused",
          progress: "",
          lastResult: null,
          subscriptions: [],
          updatedAt: now,
        },
      ],
    },
    "/api/routines": {
      routines: [
        {
          id: "rt-on",
          agentId: "b-2",
          schedule: "Every weekday at 9:00",
          timezone: "UTC",
          instruction: "Post the standup notes",
          channel: { id: "g-1", name: "Ops group", gone: false },
          enabled: true,
          nextRunAt: "2026-10-28T09:00:00.000Z",
          lastRun: null,
        },
        {
          id: "rt-off",
          agentId: "b-2",
          schedule: "Every Monday at 8:00",
          timezone: "UTC",
          instruction: "Summarise last week's orders",
          channel: { id: "g-1", name: "Ops group", gone: false },
          enabled: false,
          nextRunAt: "2026-11-02T08:00:00.000Z",
          lastRun: null,
        },
      ],
      sweep: { lastSweptAt: now, working: true },
    },
    "/api/proactive/suggestions": {
      suggestions: [
        {
          id: "s-1",
          agentId: "b-1",
          title: "Confirm Friday ship date for the 120 mugs",
          detail: "Ana needs it confirmed by end of day.",
          sourceApp: "Gmail",
          sourceLink: null,
          createdAt: now,
        },
      ],
    },
  };
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input).split("?")[0] ?? "";
    const method = init?.method ?? "GET";
    if (method !== "GET") {
      sent.push({
        method,
        path,
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      return Response.json({ ok: true });
    }
    if (path in bodies) return Response.json(bodies[path]);
    return Response.json({ error: "not served" }, { status: 404 });
  }) as typeof fetch;
  globalThis.WebSocket = QuietSocket as unknown as typeof WebSocket;
  return sent;
}

/** OpenDuet around a page, as `_authed/_app` draws a skin's Frame, starting at `path`. */
function renderApp(path: string) {
  const skin = SKINS.openduet;
  const { Frame, screens } = skin;
  if (!Frame || !screens) throw new Error("OpenDuet has no frame");
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
  const screenRoute = createRoute({
    path: "/s/$screen",
    getParentRoute: () => rootRoute,
    component: function SkinScreen() {
      const { screen } = screenRoute.useParams();
      const Screen = screens[screen];
      return Screen ? <Screen /> : null;
    },
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      page("/", () => <h1>Start a conversation</h1>),
      page("/bots", () => (
        <div>
          <header>
            <h1>Bots</h1>
          </header>
          <p>Your Bots and the ones shared with you.</p>
        </div>
      )),
      page("/channel/$channelId", () => <p>A conversation</p>),
      screenRoute,
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

/** Every address a link on screen goes to, the menu's included (it is portaled to the body). */
function hrefs(): string[] {
  return [...document.querySelectorAll("a[href]")].map(
    (anchor) => anchor.getAttribute("href") ?? "",
  );
}

async function openMenu(view: ReturnType<typeof render>) {
  fireEvent.click(await view.findByRole("button", { name: "Menu" }));
  const menu = await view.findByRole("navigation", { name: "Menu" });
  // Wait for the conversations, then open Manage.
  await within(menu).findByText("Renewal for the studio policy");
  fireEvent.click(within(menu).getByRole("button", { name: /Manage/ }));
  return menu;
}

describe("the frame reaches every OpenBot surface", () => {
  test("Chat, each conversation, and every page OpenBot's sidebar reached are one menu away", async () => {
    api("admin");
    const view = renderApp("/");
    await openMenu(view);
    const links = hrefs();
    for (const place of [
      "/",
      "/channel/c-1",
      "/group/g-1",
      "/channel/new",
      "/bots",
      "/connections",
      "/capabilities/skills",
      "/capabilities/memory",
      "/routines",
      "/s/tasks#responsibilities",
      "/settings/approvals",
      "/settings/notifications",
      "/admin",
      "/settings",
      "/s/tasks",
    ])
      expect(links).toContain(place);
  });

  test("Settings, which holds the skin picker, is on every tab without opening anything; Admin only for administrators", async () => {
    api("user");
    const view = renderApp("/");
    const settings = await view.findByRole("link", { name: "Your settings" });
    expect(settings.getAttribute("href")).toBe("/settings");
    await openMenu(view);
    const links = hrefs();
    expect(links.filter((href) => href === "/settings").length).toBe(2);
    expect(links).not.toContain("/admin");
  });

  test("a page opened over the app has a way back, no tab bar, and its own name in the pill", async () => {
    api("user");
    const view = renderApp("/bots");
    await view.findByRole("button", { name: "Back" });
    expect(view.queryByRole("navigation", { name: "Main" })).toBeNull();
    expect(view.queryByRole("button", { name: "Menu" })).toBeNull();
    const heading = await view.findByRole("heading", { name: "Bots" });
    await waitFor(() =>
      expect(heading.hasAttribute("data-openduet-titled")).toBe(true),
    );
    expect(
      document.querySelector("header [aria-hidden] ")?.textContent,
    ).toContain("Bots");
  });

  test("the Tasks tab counts what waits on the person", async () => {
    api("user");
    const view = renderApp("/");
    expect(
      await view.findByRole("link", { name: "Tasks, 2 waiting" }),
    ).toBeTruthy();
  });
});

describe("Tasks draws OpenBot's data", () => {
  test("Active lists what waits on the person and what their Bots carry, and nothing that is not under way", async () => {
    api("user");
    const view = renderApp("/s/tasks");
    fireEvent.click(await view.findByRole("tab", { name: "Active" }));
    const needs = await view.findByRole("region", { name: "Needs input" });
    expect(within(needs).getByText("Needs input")).toBeTruthy();
    expect(within(needs).getByText("Send email")).toBeTruthy();
    expect(within(needs).queryByText("Share")).toBeNull();
    expect(
      within(needs).getByText("Which kiln should I book the repair for?"),
    ).toBeTruthy();
    const carried = view.getByRole("region", { name: "Responsibilities" });
    expect(
      within(carried).getByText("Keep the support inbox at zero"),
    ).toBeTruthy();
    expect(within(carried).queryByText("Chase overdue invoices")).toBeNull();
    expect(
      within(carried)
        .getByText("Keep the support inbox at zero")
        .closest("a")
        ?.getAttribute("href"),
    ).toBe("/bots/b-1/responsibilities");
    const routines = view.getByRole("region", { name: "Routines" });
    expect(within(routines).getByText("Post the standup notes")).toBeTruthy();
    expect(
      within(routines).queryByText("Summarise last week's orders"),
    ).toBeNull();
  });

  test("an approval is decided on its card with OpenBot's own decision", async () => {
    const sent = api("user");
    const view = renderApp("/s/tasks");
    fireEvent.click(await view.findByRole("tab", { name: "Active" }));
    const card = await view.findByRole("region", {
      name: "Waiting for your approval",
    });
    fireEvent.click(within(card).getByRole("button", { name: "Allow once" }));
    await waitFor(() =>
      expect(sent).toContainEqual({
        method: "POST",
        path: "/api/approvals/r-waiting/decision",
        body: { decision: "allow_once" },
      }),
    );
  });

  test("a Bot's question is answered on its card, and the run picks up with the answer", async () => {
    const sent = api("user");
    const view = renderApp("/s/tasks");
    fireEvent.click(await view.findByRole("tab", { name: "Active" }));
    const card = await view.findByRole("region", { name: "Ops Bot asks" });
    await userEvent
      .setup({ document })
      .type(within(card).getByLabelText("Your answer"), "Kiln 2");
    const send = within(card).getByRole("button", { name: "Send answer" });
    await waitFor(() => expect(send.hasAttribute("disabled")).toBe(false));
    fireEvent.click(send);
    await waitFor(() =>
      expect(sent).toContainEqual({
        method: "POST",
        path: "/api/approvals/questions/q-1/respond",
        body: { response: "Kiln 2" },
      }),
    );
  });

  test("Up next starts or hides a suggestion with OpenBot's own suggestion actions", async () => {
    const sent = api("user");
    const view = renderApp("/s/tasks");
    fireEvent.click(await view.findByRole("tab", { name: "Up next" }));
    const start = await view.findByRole("button", {
      name: "Start Confirm Friday ship date for the 120 mugs",
    });
    fireEvent.click(start);
    await waitFor(() =>
      expect(sent).toContainEqual({
        method: "POST",
        path: "/api/proactive/suggestions/s-1/start",
        body: null,
      }),
    );
    fireEvent.click(
      view.getByRole("button", {
        name: "Hide Confirm Friday ship date for the 120 mugs",
      }),
    );
    await waitFor(() =>
      expect(sent).toContainEqual({
        method: "POST",
        path: "/api/proactive/suggestions/s-1/dismiss",
        body: null,
      }),
    );
  });

  test("the menu's Responsibilities opens Tasks on Active at that section", async () => {
    api("user");
    window.localStorage.setItem("openduet.tasks-view", "up_next");
    const view = renderApp("/s/tasks#responsibilities");
    expect(
      (await view.findByRole("tab", { name: "Active" })).getAttribute(
        "aria-selected",
      ),
    ).toBe("true");
    expect(
      await view.findByRole("region", { name: "Responsibilities" }),
    ).toBeTruthy();
  });
});
