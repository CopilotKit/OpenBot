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
  type ConnectPrompt,
  connectAppRefusal,
  SHOW_APP_ACCESS_TOOL,
} from "@openbot/shared/connect-prompt";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { AppAccessCard } from "@/components/channels/app-access-card";
import { ServerToolLine } from "@/components/channels/chat-transcript";
import type { AppAccess } from "@/lib/app-access/queries";
import { carryOnMessage } from "@/lib/copilot/carry-on";
import { ConversationProvider } from "@/lib/copilot/conversation";
import { queryClient } from "@/query-client";
import { ME_PATH, meResponse } from "./accounts-api";
import { DEPLOYMENT_PATH } from "./admin-settings-api";
import { appAccess } from "./app-access-fixture";
import {
  APP_ACCESS_REQUESTS_PATH,
  APP_SETUP_PATH,
  appAccessApprovalResponse,
  appAccessRequest,
  appAccessRequestResponse,
  appSetupResponse,
  botAppPath,
  botAppResponse,
} from "./bot-grants-api";
import { botPath } from "./bots-api";
import { connectionPage, MY_CONNECTIONS_PATH } from "./connections-api";
import { settleReactWork } from "./settle-react-work";

/**
 * A BOT THAT HOLDS AN APP AND NEEDS MORE OF IT THAN IT WAS GIVEN.
 *
 * Reported in dogfooding (OpenBot Cloud 1.2.0-rc.4): an admin asked his Bot to recolour customer
 * calls in Google Calendar. The Bot held only Calendar's read actions, read the events, and then
 * told him an administrator could grant it edit access. He is the admin. He had to find Settings,
 * the app's page, Grant tools, and tick raw tool names.
 *
 * Now the Bot puts up the app's card with a `tools` prompt: the actions it needs, and what they are
 * for. The card reads the app for exactly those actions, says what the Bot can't do yet, and its one
 * press gives exactly those (an admin, or the Bot's owner), or asks an admin for them (anybody
 * else). Once given, the conversation carries on by itself.
 *
 * Drawn as it is in a conversation: the real card, the app's one query client its writes refresh,
 * and the API answered at its own addresses in its own shapes.
 */

beforeAll(() =>
  GlobalRegistrator.register({ url: "http://127.0.0.1:3010/channel/one" }),
);
// The app's one client is a module shared by every file in the run: emptied around each case.
beforeEach(() => queryClient.clear());
const originalFetch = global.fetch;
let originalOpen: typeof window.open;
beforeEach(() => {
  originalOpen = window.open;
});
afterEach(() => {
  cleanup();
  queryClient.clear();
  global.fetch = originalFetch;
  window.open = originalOpen;
});
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const BOT = "calendar";
const CALENDAR = "composio-googlecalendar";
const PATCH_EVENT = `${CALENDAR}/GOOGLECALENDAR_PATCH_EVENT`;
const SIGNED_IN = "2026-11-20T09:00:00.000Z";

/** Google Calendar on the Bot, connected by the person looking. Each case says the state. */
const calendar = (overrides: Partial<AppAccess> = {}): AppAccess =>
  appAccess({
    key: CALENDAR,
    displayName: "Google Calendar",
    connect: "consent",
    connectedAt: SIGNED_IN,
    granted: true,
    ...overrides,
  });

/** Holds the read actions only: ready for the app, not given the action that edits an event. */
const holdsReadOnly = calendar({ state: "ready" });
const lacksPatch = calendar({
  state: "not_granted",
  requestKind: "grant",
});

type Sent = { method: string; url: string; body: unknown };

/**
 * The server for one person. `whole` is the app read with no actions named; `forActions` with them,
 * which a press that gives them turns to ready, and a request turns to requested. Every request is
 * recorded with its body.
 */
function serving(
  role: "admin" | "member",
  answers: { whole: AppAccess; forActions: AppAccess },
) {
  const sent: Sent[] = [];
  const live = { ...answers };
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body: unknown = init?.body
      ? JSON.parse(String(init.body))
      : undefined;
    sent.push({ method, url, body });
    const [path, query] = url.split("?");
    const named = (body as { actions?: string[] } | undefined)?.actions ?? [];
    if (path === DEPLOYMENT_PATH) return Response.json({ edition: "team" });
    if (path === ME_PATH)
      return meResponse({ user: { id: "usr_me", role, name: "Me" } });
    if (path === botPath(BOT))
      return Response.json({ bot: { id: BOT, name: "Calendar Bot" } });
    if (path === APP_SETUP_PATH) return appSetupResponse();
    if (method === "GET" && path === botAppPath(BOT, CALENDAR))
      return botAppResponse(
        new URLSearchParams(query ?? "").get("actions")
          ? live.forActions
          : live.whole,
      );
    if (path === `${botAppPath(BOT, CALENDAR)}/approve`) {
      live.forActions = calendar({ state: "ready" });
      return appAccessApprovalResponse({
        request: appAccessRequest({
          appKey: CALENDAR,
          appTitle: "Google Calendar",
          status: "approved",
          agentId: BOT,
          actions: named,
        }),
        granted: named,
      });
    }
    if (path === `${botAppPath(BOT, CALENDAR)}/give`) {
      live.forActions = calendar({ state: "ready" });
      return Response.json({ given: named });
    }
    if (method === "POST" && path === APP_ACCESS_REQUESTS_PATH) {
      const filed = appAccessRequest({
        id: "req_patch",
        appKey: CALENDAR,
        appTitle: "Google Calendar",
        agentId: BOT,
        botName: "Calendar Bot",
        actions: named,
      });
      live.forActions = {
        ...live.forActions,
        request: { id: filed.id, kind: "grant", createdAt: filed.createdAt },
      };
      return appAccessRequestResponse(filed);
    }
    if (path.startsWith(MY_CONNECTIONS_PATH)) return connectionPage([]);
    return Response.json({});
  }) as unknown as typeof fetch;
  return { sent, live };
}

const toolsPrompt = (
  overrides: Partial<ConnectPrompt> = {},
): ConnectPrompt => ({
  serverId: CALENDAR,
  title: "Google Calendar",
  message: "Calendar Bot wasn't given the actions it needs.",
  agentId: BOT,
  reason: "tools",
  actions: [PATCH_EVENT],
  need: "To change an event's colour.",
  blocked: true,
  ...overrides,
});

/** The card, in a conversation whose `ask` is recorded, with the app's one query client. */
function inConversation(children: ReactNode) {
  const asked: string[] = [];
  const root = createRootRoute({ component: Outlet });
  const page = createRoute({
    getParentRoute: () => root,
    path: "/",
    component: () => (
      <ConversationProvider ask={(text) => asked.push(text)}>
        {children}
      </ConversationProvider>
    ),
  });
  const appPage = createRoute({
    getParentRoute: () => root,
    path: "/connections/$key",
    component: () => null,
  });
  const router = createRouter({
    routeTree: root.addChildren([page, appPage]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
  return Object.assign(view, { asked });
}

/** A browser whose every tab is recorded: a press that needs no sign-in opens none. */
function recordingTabs() {
  const opened: unknown[] = [];
  window.open = ((...args: unknown[]) => {
    opened.push(args);
    return null;
  }) as typeof window.open;
  return opened;
}

const card = (view: ReturnType<typeof inConversation>) =>
  waitFor(() => {
    const found = view.container.querySelector("[data-app-access]");
    if (!found?.getAttribute("data-state")) throw new Error("not drawn yet");
    return found as HTMLElement;
  });

const writes = (sent: Sent[]) => sent.filter((each) => each.method !== "GET");

let calls = 0;
const place = () => {
  calls += 1;
  return { toolCallId: `call_tools_${calls}_${Date.now()}`, latest: true };
};

/*
 * THE REGRESSION. The server answers `ready` for the app as a whole, because the Bot holds its read
 * actions, and `not_granted` for the action it needs. A card that reads the app without the actions
 * draws "ready" and offers nothing, which is the dead end the admin was left in.
 */
test("an admin is offered the action the Bot needs, though the Bot already holds the app", async () => {
  serving("admin", { whole: holdsReadOnly, forActions: lacksPatch });
  const view = inConversation(
    <AppAccessCard place={place()} prompt={toolsPrompt()} />,
  );
  const button = await view.findByRole(
    "button",
    { name: "Give Google Calendar to Calendar Bot" },
    { timeout: 3_000 },
  );
  expect(button.textContent).toBe("Give it to Calendar Bot");
});

test("an admin: says what the Bot can't do yet, gives exactly that action in one press, and the conversation carries on", async () => {
  const opened = recordingTabs();
  const { sent } = serving("admin", {
    whole: holdsReadOnly,
    forActions: lacksPatch,
  });
  const view = inConversation(
    <AppAccessCard place={place()} prompt={toolsPrompt()} />,
  );
  const drawn = await card(view);
  expect(drawn.getAttribute("data-state")).toBe("not_granted");
  // The Bot's own words, trimmed of "To" and the full stop, and never telling an admin to ask one.
  await waitFor(() =>
    expect(drawn.textContent).toContain(
      "Calendar Bot can't change an event's colour yet.",
    ),
  );
  expect(drawn.textContent).not.toMatch(/admin/i);
  // Read for exactly the action it needs.
  expect(
    sent.some(
      (each) =>
        each.method === "GET" &&
        each.url ===
          `${botAppPath(BOT, CALENDAR)}?actions=${encodeURIComponent(PATCH_EVENT)}`,
    ),
  ).toBe(true);

  fireEvent.click(
    await view.findByRole("button", {
      name: "Give Google Calendar to Calendar Bot",
    }),
  );
  await waitFor(() =>
    expect(view.asked).toEqual([carryOnMessage("Google Calendar")]),
  );
  expect(view.asked).toEqual([
    "Google Calendar is ready now. Please carry on.",
  ]);
  expect(writes(sent)).toEqual([
    {
      method: "POST",
      url: `${botAppPath(BOT, CALENDAR)}/approve`,
      body: { actions: [PATCH_EVENT] },
    },
  ]);
  expect((await card(view)).textContent).toContain(
    "Google Calendar is ready now.",
  );
  // Already connected: nothing to sign in to, so no tab was opened only to be closed.
  expect(opened).toEqual([]);
});

test("a member: is told only an admin can give it, asks for exactly that action, then sees Requested", async () => {
  const { sent } = serving("member", {
    whole: holdsReadOnly,
    forActions: lacksPatch,
  });
  const view = inConversation(
    <AppAccessCard place={place()} prompt={toolsPrompt()} />,
  );
  const drawn = await card(view);
  await waitFor(() =>
    expect(drawn.textContent).toContain(
      "Calendar Bot can't change an event's colour yet. Only an admin can give it that.",
    ),
  );
  fireEvent.click(
    await view.findByRole("button", {
      name: "Request access to Google Calendar",
    }),
  );
  await view.findByText("Requested");
  expect(
    view.getByRole("button", {
      name: "Withdraw request for Google Calendar",
    }),
  ).toBeTruthy();
  expect(writes(sent)).toEqual([
    {
      method: "POST",
      url: APP_ACCESS_REQUESTS_PATH,
      body: { botId: BOT, appId: CALENDAR, actions: [PATCH_EVENT] },
    },
  ]);
});

test("the Bot's owner gives exactly that action with Allow, and the conversation carries on", async () => {
  const { sent } = serving("member", {
    whole: holdsReadOnly,
    forActions: calendar({ state: "owner_grantable" }),
  });
  const view = inConversation(
    <AppAccessCard place={place()} prompt={toolsPrompt()} />,
  );
  const drawn = await card(view);
  await waitFor(() =>
    expect(drawn.textContent).toContain(
      "Calendar Bot can't change an event's colour yet.",
    ),
  );
  expect(drawn.textContent).not.toMatch(/admin/i);
  fireEvent.click(
    await view.findByRole("button", {
      name: "Let Calendar Bot use Google Calendar",
    }),
  );
  await waitFor(() =>
    expect(view.asked).toEqual([carryOnMessage("Google Calendar")]),
  );
  expect(writes(sent)).toEqual([
    {
      method: "POST",
      url: `${botAppPath(BOT, CALENDAR)}/give`,
      body: { actions: [PATCH_EVENT] },
    },
  ]);
});

test("with no words for what it needs, the card names the app instead", async () => {
  serving("member", { whole: holdsReadOnly, forActions: lacksPatch });
  const view = inConversation(
    <AppAccessCard place={place()} prompt={toolsPrompt({ need: undefined })} />,
  );
  const drawn = await card(view);
  await waitFor(() =>
    expect(drawn.textContent).toContain(
      "Calendar Bot needs more of Google Calendar for this. Only an admin can give it that.",
    ),
  );
});

test("an app turned off since the Bot asked: the card's own sentence and button for that", async () => {
  serving("admin", {
    whole: holdsReadOnly,
    forActions: calendar({
      state: "disabled",
      unavailable: "absent",
      granted: false,
      requestKind: "enable",
    }),
  });
  const view = inConversation(
    <AppAccessCard place={place()} prompt={toolsPrompt()} />,
  );
  const drawn = await card(view);
  await waitFor(() =>
    expect(drawn.textContent).toContain("Google Calendar isn't turned on yet."),
  );
  expect(
    await view.findByRole("button", {
      name: "Turn on Google Calendar and give it to Calendar Bot",
    }),
  ).toBeTruthy();
});

test("the transcript draws show_app_access's tools answer as the card, read for its actions", async () => {
  const { sent } = serving("admin", {
    whole: holdsReadOnly,
    forActions: lacksPatch,
  });
  const view = inConversation(
    <ServerToolLine
      name={SHOW_APP_ACCESS_TOOL}
      result={connectAppRefusal(toolsPrompt())}
    />,
  );
  expect((await card(view)).getAttribute("data-state")).toBe("not_granted");
  expect(
    await view.findByRole("button", {
      name: "Give Google Calendar to Calendar Bot",
    }),
  ).toBeTruthy();
  expect(
    sent.some((each) =>
      each.url.startsWith(`${botAppPath(BOT, CALENDAR)}?actions=`),
    ),
  ).toBe(true);
});
