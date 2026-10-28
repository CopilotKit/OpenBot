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
import { PageShell } from "@/components/layout/page-shell";
import { appConfig } from "@/lib/generated/application-config";
import { navigationFor } from "@/lib/navigation";
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
        <PageShell
          backButton={{ label: "Home", linkProps: { to: "/" } }}
          description="Your Bots and the ones shared with you."
          title="Bots"
        >
          <p>The roster</p>
        </PageShell>
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
      "/s/tasks",
      "/bots",
      "/capabilities",
      "/connections",
      "/admin",
      "/settings",
    ])
      expect(links).toContain(place);
  });

  /*
   * Found in review: the menu kept its own list of destinations beside OpenBot's sidebar. It draws
   * OpenBot's one navigation list now, so a destination added there reaches this menu too.
   */
  test("the menu's destinations are exactly OpenBot's navigation list, for admins and for everyone else", async () => {
    for (const role of ["admin", "user"] as const) {
      api(role);
      const view = renderApp("/");
      const menu = await openMenu(view);
      const manage = within(menu).getByRole("button", { name: /Manage/ });
      const group = document.getElementById(
        manage.getAttribute("aria-controls") ?? "",
      );
      const drawn = [...(group?.querySelectorAll("a") ?? [])].map((link) =>
        link.textContent?.replace(/\d+$/, "").trim(),
      );
      const settings = within(menu).getByRole("link", { name: "Settings" });
      expect([...drawn, settings.textContent?.trim()]).toEqual(
        navigationFor(role).map((item) => item.label),
      );
      view.unmount();
    }
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

  /*
   * Found in review: the frame wrote an attribute onto the page's own heading, an element React
   * owns, and a page with its own back link showed two ways back. The chrome now reads the page's
   * `page-title` and its back link, writes nothing to either, and its one back disc goes where the
   * page's own link goes.
   */
  test("a page opened over the app names itself from its own title, writes nothing to it, and has one way back that goes where the page's does", async () => {
    api("user");
    const view = renderApp("/bots");
    const back = await view.findByRole("button", { name: "Back to Home" });
    expect(view.queryByRole("navigation", { name: "Main" })).toBeNull();
    expect(view.queryByRole("button", { name: "Menu" })).toBeNull();
    await waitFor(() =>
      expect(document.querySelector("header p[aria-hidden]")?.textContent).toBe(
        "Bots",
      ),
    );
    const title = document.querySelector('[data-slot="page-title"]');
    expect(title?.getAttributeNames().sort()).toEqual(["class", "data-slot"]);
    /*
     * The skin hides the page's own bar by its place beside the page-header hook
     * (`div:has(+ div > div > [data-slot="page-header"])`, which this DOM cannot evaluate): the
     * div just before the one holding the header's column. It is the bar with the page's back link.
     */
    const header = document.querySelector('[data-slot="page-header"]');
    const bar = header?.parentElement?.parentElement?.previousElementSibling;
    expect(bar?.tagName).toBe("DIV");
    expect(bar?.querySelector("a")?.textContent).toContain("Home");
    fireEvent.click(back);
    await view.findByRole("heading", { name: "Start a conversation" });
  });

  test("Chat and Tasks are phone-shaped, other pages keep OpenBot's width, and an open computer gets OpenBot's pane", async () => {
    api("user");
    const column = () =>
      document
        .querySelector("[data-openduet-column]")
        ?.getAttribute("data-openduet-column");
    for (const [path, expected] of [
      ["/", "phone"],
      ["/s/tasks", "phone"],
      ["/bots", "page"],
      ["/channel/c-1?watch=true", "pane"],
    ] as const) {
      const view = renderApp(path);
      await waitFor(() => expect(column()).toBe(expected));
      view.unmount();
    }
  });

  test("the Tasks tab counts what waits on the person", async () => {
    api("user");
    const view = renderApp("/");
    expect(
      await view.findByRole("link", { name: "Tasks, 2 waiting" }),
    ).toBeTruthy();
  });
});

/*
 * Found in review: Tasks re-implemented OpenBot's approvals, suggestions and routines, and the copies
 * had drifted. It now draws OpenBot's own lists, so these drive those lists through Tasks.
 */
describe("Tasks is OpenBot's own lists under OpenDuet's headings", () => {
  test("Active shows OpenBot's waiting list, responsibilities and routines, and every region has its own name", async () => {
    api("user");
    const view = renderApp("/s/tasks");
    fireEvent.click(await view.findByRole("tab", { name: "Active" }));
    const needs = await view.findByRole("region", { name: "Needs input" });
    expect(within(needs).getByText("Needs input")).toBeTruthy();
    expect(await within(needs).findByText(/Inbox Bot wants to/)).toBeTruthy();
    expect(within(needs).queryByText(/drive\/share/)).toBeNull();
    expect(
      within(needs).getByText(/Which kiln should I book the repair for\?/),
    ).toBeTruthy();
    // OpenBot's list always shows what the action would send.
    expect(within(needs).getByText(/Thursday at 10 works\./)).toBeTruthy();
    expect(
      await view.findByText("Keep the support inbox at zero"),
    ).toBeTruthy();
    const routines = view.getByRole("region", { name: "Routines" });
    expect(
      await within(routines).findByText("Post the standup notes"),
    ).toBeTruthy();
    const names = view
      .getAllByRole("region")
      .map((region) => region.getAttribute("aria-label"));
    expect(new Set(names).size).toBe(names.length);
  });

  test("an approval is decided in OpenBot's own row", async () => {
    const sent = api("user");
    const view = renderApp("/s/tasks");
    fireEvent.click(await view.findByRole("tab", { name: "Active" }));
    const needs = await view.findByRole("region", { name: "Needs input" });
    fireEvent.click(
      await within(needs).findByRole("button", { name: "Allow once" }),
    );
    await waitFor(() =>
      expect(sent).toContainEqual({
        method: "POST",
        path: "/api/approvals/r-waiting/decision",
        body: { decision: "allow_once" },
      }),
    );
  });

  test("a Bot's question is answered in OpenBot's own row", async () => {
    const sent = api("user");
    const view = renderApp("/s/tasks");
    fireEvent.click(await view.findByRole("tab", { name: "Active" }));
    const needs = await view.findByRole("region", { name: "Needs input" });
    await userEvent
      .setup({ document })
      .type(await within(needs).findByLabelText("Your answer"), "Kiln 2");
    const send = within(needs).getByRole("button", { name: "Send answer" });
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

  test("Up next starts or dismisses a suggestion with OpenBot's own suggestion list", async () => {
    const sent = api("user");
    const view = renderApp("/s/tasks");
    fireEvent.click(await view.findByRole("tab", { name: "Up next" }));
    expect(
      await view.findByText("Confirm Friday ship date for the 120 mugs"),
    ).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "Start as task" }));
    await waitFor(() =>
      expect(sent).toContainEqual({
        method: "POST",
        path: "/api/proactive/suggestions/s-1/start",
        body: null,
      }),
    );
    fireEvent.click(await view.findByRole("button", { name: "Dismiss" }));
    await waitFor(() =>
      expect(sent).toContainEqual({
        method: "POST",
        path: "/api/proactive/suggestions/s-1/dismiss",
        body: null,
      }),
    );
  });
});

/*
 * A skin takes OpenDuet's look and the deployment's identity: the name a person reads is the one in
 * brand.yaml, and the orb is OpenBot's own, never OpenDuet's name or its robot face.
 */
describe("the frame carries the deployment's brand, not OpenDuet's", () => {
  /** Every word a person can read or hear: the text, and the names and titles on controls. */
  function readable(): string {
    const named = [...document.querySelectorAll("[aria-label], [title], [alt]")]
      .flatMap((node) => [
        node.getAttribute("aria-label"),
        node.getAttribute("title"),
        node.getAttribute("alt"),
      ])
      .filter(Boolean);
    return `${document.body.textContent ?? ""}\n${named.join("\n")}`;
  }

  test("the menu and the orb name the deployment's product, and nothing says OpenDuet", async () => {
    api("admin");
    const view = renderApp("/");
    const orb = await view.findByRole("button", {
      name: `Talk to ${appConfig.brand.productName}`,
    });
    await openMenu(view);
    const menu = view.getByRole("dialog");
    expect(within(menu).getByText(appConfig.brand.productName)).toBeTruthy();
    expect(readable()).not.toContain("OpenDuet");
    // OpenBot's own orb, as sign-in and onboarding draw it, and no drawing of OpenDuet's.
    expect(orb.querySelector(".agent-orb")).not.toBeNull();
    expect(orb.querySelector("canvas")).toBeNull();
  });

  test("Tasks names nothing as OpenDuet either", async () => {
    api("user");
    const view = renderApp("/s/tasks");
    fireEvent.click(await view.findByRole("tab", { name: "Active" }));
    await view.findByRole("region", { name: "Needs input" });
    fireEvent.click(view.getByRole("tab", { name: "Up next" }));
    await view.findByRole("button", { name: "Start as task" });
    expect(readable()).not.toContain("OpenDuet");
  });
});
