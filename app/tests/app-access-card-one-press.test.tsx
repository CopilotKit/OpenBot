import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { ConnectPrompt } from "@openbot/shared/connect-prompt";
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
import { AppAccessCard } from "@/components/channels/app-access-card";
import type { AppAccess } from "@/lib/app-access/queries";
import { queryClient } from "@/query-client";
import { ME_PATH, meResponse } from "./accounts-api";
import { DEPLOYMENT_PATH } from "./admin-settings-api";
import { appAccess } from "./app-access-fixture";
import {
  appAccessApprovalResponse,
  appAccessRequest,
  botAppPath,
  botAppResponse,
} from "./bot-grants-api";
import { botPath } from "./bots-api";
import {
  connectionPage,
  MY_CONNECTIONS_PATH,
  myConnectionPath,
  startResponse,
} from "./connections-api";
import { settleReactWork } from "./settle-react-work";

/**
 * ONE PRESS ON THE CHAT CARD, IN THE DESKTOP, FOR AN APP NOBODY HAS TURNED ON.
 *
 * OpenBot Personal on a fresh install: a Bot asked for Gmail, which nobody had turned on, and drew
 * this card. The press turned Gmail on and stopped there. The card swapped to "You haven't connected
 * your Gmail account yet." with a second Connect, and only that second press opened the sign-in.
 *
 * Drawn here as it is in a conversation: the real card, the real query client its writes refresh,
 * the route answers in the shapes the server gives them (`app-access-routes.integration.test.ts`),
 * and the window shim the Desktop injects (`desktop/src-tauri/src/outside-links.js`), which hands
 * the sign-in to the person's own browser.
 */

const SHIM = readFileSync(
  join(import.meta.dir, "../../desktop/src-tauri/src/outside-links.js"),
  "utf8",
);

type DesktopPage = Window & {
  __openbotNavigate?: (to: string) => void;
  __openbotOutsideLinks?: boolean;
};

const CONSENT = "https://backend.composio.dev/api/v3/s/abc123";

let originalOpen: typeof window.open;
beforeAll(() => {
  GlobalRegistrator.register({ url: "http://127.0.0.1:3010/channel/one" });
  originalOpen = window.open;
});
/*
 * EMPTIED BEFORE EACH CASE, NOT ONLY AFTER. The app's one query client is a module, and `bun test`
 * runs every file in one process, so it reaches this file holding whatever an earlier file left on
 * it. A cached `deployment` answer never goes stale, and a team one drew the card as the team
 * edition: an admin's "Connect and give it", never the personal edition's Connect.
 */
beforeEach(() => queryClient.clear());
const originalFetch = global.fetch;
afterEach(() => {
  cleanup();
  queryClient.clear();
  global.fetch = originalFetch;
  window.open = originalOpen;
  const page = window as DesktopPage;
  page.__openbotOutsideLinks = false;
  page.__openbotNavigate = undefined;
});
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

/** The Desktop window: its shim installed, and every address it hands the browser recorded. */
function inTheDesktop() {
  const browser: string[] = [];
  const page = window as DesktopPage;
  page.__openbotOutsideLinks = false;
  page.__openbotNavigate = (to) => browser.push(to);
  // biome-ignore lint/security/noGlobalEval: the desktop window evaluates this shim in the page's global scope; the test must run it the same way.
  globalThis.eval(SHIM);
  return browser;
}

/**
 * Gmail as the API answers it on the Bot (getBotApp) on OpenBot Personal before anybody
 * turned it on: no row, so no recorded scheme, and switched off because it is absent.
 */
const notTurnedOn = (overrides: Partial<AppAccess> = {}): AppAccess =>
  appAccess({
    state: "disabled",
    unavailable: "absent",
    granted: false,
    requestKind: "enable",
    ...overrides,
  });

/** And after the press turned it on and gave it to the Bot: only this person's sign-in is missing. */
const turnedOn = appAccess({ state: "not_connected" });

/**
 * The server, for one person on OpenBot Personal. Records each write the card sends, and holds the
 * connect route's answer until `signIn` settles, the way a vendor's slow answer does.
 */
function serving(before: AppAccess, signIn: Promise<void>) {
  const writes: string[] = [];
  let live = before;
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (method !== "GET") writes.push(`${method} ${url}`);
    if (url === DEPLOYMENT_PATH) return Response.json({ edition: "personal" });
    if (url === ME_PATH)
      return meResponse({
        user: { id: "usr_me", role: "admin", name: "Me" },
      });
    if (url === botPath("assistant"))
      return Response.json({
        bot: { id: "assistant", name: "Personal Assistant" },
      });
    if (url === botAppPath("assistant", "composio-gmail"))
      return botAppResponse(live);
    if (url === `${botAppPath("assistant", "composio-gmail")}/approve`) {
      live = turnedOn;
      return appAccessApprovalResponse({
        request: appAccessRequest({
          kind: "enable",
          status: "approved",
          agentId: "assistant",
        }),
        enabled: true,
        granted: ["composio-gmail/GMAIL_FETCH_EMAILS"],
      });
    }
    if (url === myConnectionPath("composio-gmail", "connect")) {
      await signIn;
      return startResponse({ authorizationUrl: CONSENT });
    }
    if (url.startsWith(MY_CONNECTIONS_PATH)) return connectionPage([]);
    return Response.json({});
  }) as unknown as typeof fetch;
  return writes;
}

/** The card the `show_app_access` tool draws in a conversation with the Personal Assistant. */
function drawCard() {
  const prompt: ConnectPrompt = {
    serverId: "composio-gmail",
    title: "Gmail",
    message: "Gmail isn't connected yet.",
    agentId: "assistant",
    reason: "access",
    blocked: true,
  };
  const root = createRootRoute({ component: Outlet });
  const page = createRoute({
    getParentRoute: () => root,
    path: "/",
    component: () => <AppAccessCard prompt={prompt} />,
  });
  const settings = createRoute({
    getParentRoute: () => root,
    path: "/connections/$key",
    component: () => null,
  });
  const router = createRouter({
    routeTree: root.addChildren([page, settings]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  // The app's one client: the card's writes refresh it, as they do in the app.
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

test.each([
  [
    "the directory says it signs in",
    notTurnedOn({ connect: "consent" }),
    "Connect",
  ],
  [
    "nothing yet says how it connects",
    notTurnedOn({ connect: null }),
    "Connect",
  ],
])(
  "one press turns Gmail on and opens its sign-in in the person's browser: %s",
  async (_, before, label) => {
    const browser = inTheDesktop();
    let answer: () => void = () => {};
    const writes = serving(
      before,
      new Promise<void>((resolve) => {
        answer = resolve;
      }),
    );
    const view = drawCard();

    const button = await view.findByRole("button", {
      name: `${label} Gmail`,
    });
    fireEvent.click(button);

    // While the sign-in is being asked for, the button says so.
    await view.findByRole("button", { name: "Opening sign-in…" });
    answer();
    await waitFor(() => expect(browser).toEqual([CONSENT]), { timeout: 3_000 });
    expect(writes).toEqual([
      `POST ${botAppPath("assistant", "composio-gmail")}/approve`,
      `POST ${myConnectionPath("composio-gmail", "connect")}`,
    ]);
    // And it says what it is doing while the person signs in.
    await view.findByText("Finish in the tab that opened.");
    expect(
      view.getByRole("button", { name: "Waiting for Gmail…" }),
    ).toBeTruthy();
  },
);

/**
 * ONE PRESS FOR AN APP CONNECTED WITH A KEY, AND FOR ONE THAT NEEDS NOTHING.
 *
 * OpenBot Personal: a Bot asked for Fireflies, which nobody had turned on and which connects with a
 * key somebody types. The card said Turn on; pressed, Fireflies was on and the card swapped to a
 * second Connect, and only that one went to where the key is typed. One Connect now does both: it
 * turns the app on and opens the app's page with the key form, in this tab.
 */
const FIREFLIES = "composio-fireflies";

const fireflies = (overrides: Partial<AppAccess> = {}): AppAccess =>
  appAccess({
    key: FIREFLIES,
    displayName: "Fireflies",
    ...overrides,
  });

/**
 * The server for one Fireflies case: `before` until the press turns it on, `after` once it is on.
 * `edition` and `role` say who is looking. Every write is recorded, and every sign-in asked for.
 */
function servingApp(
  before: AppAccess,
  after: AppAccess,
  who: { edition: "personal" | "team"; role: "admin" | "member" } = {
    edition: "personal",
    role: "admin",
  },
) {
  const writes: string[] = [];
  let live = before;
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (method !== "GET") writes.push(`${method} ${url}`);
    if (url === DEPLOYMENT_PATH) return Response.json({ edition: who.edition });
    if (url === ME_PATH)
      return meResponse({ user: { id: "usr_me", role: who.role, name: "Me" } });
    if (url === botPath("assistant"))
      return Response.json({
        bot: { id: "assistant", name: "Personal Assistant" },
      });
    if (url === botAppPath("assistant", before.key))
      return botAppResponse(live);
    if (url === `${botAppPath("assistant", before.key)}/approve`) {
      live = after;
      return appAccessApprovalResponse({
        request: appAccessRequest({
          kind: "enable",
          status: "approved",
          agentId: "assistant",
        }),
        enabled: true,
        granted: [`${before.key}/FIREFLIES_GET_TRANSCRIPTS`],
      });
    }
    if (url === myConnectionPath(before.key, "connect"))
      return startResponse({ authorizationUrl: CONSENT });
    if (url.startsWith(MY_CONNECTIONS_PATH)) return connectionPage([]);
    return Response.json({});
  }) as unknown as typeof fetch;
  return writes;
}

/** The card about one app, with the app's page beside it, saying where it was opened and how. */
function drawFirefliesCard(serverId = FIREFLIES, title = "Fireflies") {
  const prompt: ConnectPrompt = {
    serverId,
    title,
    message: `${title} isn't connected yet.`,
    agentId: "assistant",
    reason: "access",
    blocked: true,
  };
  const root = createRootRoute({ component: Outlet });
  const page = createRoute({
    getParentRoute: () => root,
    path: "/",
    component: () => <AppAccessCard prompt={prompt} />,
  });
  const appPage = createRoute({
    getParentRoute: () => root,
    path: "/connections/$key",
    validateSearch: (search: Record<string, unknown>) => ({
      connect: search.connect === true || search.connect === "true",
    }),
    component: function AppPage() {
      const { key } = appPage.useParams();
      const { connect } = appPage.useSearch();
      return (
        <p>{`${key}'s page${connect ? ", with the key form open" : ""}`}</p>
      );
    },
  });
  const router = createRouter({
    routeTree: root.addChildren([page, appPage]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

/**
 * A browser's `window.open`, recorded: each tab claimed, whether it was claimed while the click was
 * still being handled (the only time a browser lets a page open one), where it was sent, and
 * whether it was closed.
 */
function aBrowser() {
  const tabs: { duringClick: boolean; to: string[]; closed: boolean }[] = [];
  let clicking = false;
  window.open = (() => {
    const tab = { duringClick: clicking, to: [] as string[], closed: false };
    tabs.push(tab);
    return {
      opener: {},
      get closed() {
        return tab.closed;
      },
      location: { replace: (to: string) => tab.to.push(to) },
      close: () => {
        tab.closed = true;
      },
    } as unknown as Window;
  }) as typeof window.open;
  return {
    tabs,
    /** A click, with the browser's window for opening a tab open for exactly its handlers. */
    click: (element: HTMLElement) => {
      clicking = true;
      try {
        fireEvent.click(element);
      } finally {
        clicking = false;
      }
    },
  };
}

test.each([
  ["nothing yet says how it connects", fireflies({ connect: null })],
  ["the directory says it takes a key", fireflies({ connect: "key" })],
])(
  "one Connect turns Fireflies on and opens its key form, with no second press: %s",
  async (_, notOn) => {
    const browser = aBrowser();
    const writes = servingApp(
      { ...notOn, state: "disabled", unavailable: "absent", granted: false },
      fireflies({ state: "not_connected", connect: "key" }),
    );
    const view = drawFirefliesCard();

    const button = await view.findByRole("button", {
      name: "Connect Fireflies",
    });
    expect(button.textContent).toBe("Connect");
    browser.click(button);

    await view.findByText(`${FIREFLIES}'s page, with the key form open`, {
      exact: true,
    });
    expect(writes).toEqual([
      `POST ${botAppPath("assistant", FIREFLIES)}/approve`,
    ]);
    // A tab claimed in case it signed in goes again, never sent anywhere; a known key claims none.
    await waitFor(() =>
      expect(
        browser.tabs.every((tab) => tab.closed && tab.to.length === 0),
      ).toBe(true),
    );
    if (notOn.connect === "key") expect(browser.tabs).toEqual([]);
  },
);

/**
 * AND FOR AN APP THAT SIGNS IN, WHICH NOTHING SAID UNTIL IT WAS ON. A Slack link pasted into a new
 * conversation on OpenBot Personal: the card offered Turn on, and pressing it drew the same card
 * with Connect. One Connect now turns Slack on and opens its sign-in, in a tab claimed on the click,
 * because a browser opens no tab once the click is over.
 */
const SLACK = "composio-slack";

test("one Connect turns Slack on and opens its sign-in in a tab claimed on the click", async () => {
  const browser = aBrowser();
  const writes = servingApp(
    appAccess({
      key: SLACK,
      displayName: "Slack",
      connect: null,
      state: "disabled",
      unavailable: "absent",
      granted: false,
    }),
    appAccess({
      key: SLACK,
      displayName: "Slack",
      connect: "oauth",
      state: "not_connected",
    }),
  );
  const view = drawFirefliesCard(SLACK, "Slack");
  const button = await view.findByRole("button", { name: "Connect Slack" });
  expect(button.textContent).toBe("Connect");
  browser.click(button);

  await waitFor(() => expect(browser.tabs[0]?.to).toEqual([CONSENT]), {
    timeout: 3_000,
  });
  expect(browser.tabs).toHaveLength(1);
  expect(browser.tabs[0].duringClick).toBe(true);
  expect(writes).toEqual([
    `POST ${botAppPath("assistant", SLACK)}/approve`,
    `POST ${myConnectionPath(SLACK, "connect")}`,
  ]);
  await view.findByText("Finish in the tab that opened.");
});

test("one Connect turns on an app that needs nothing more, and the card says it is ready", async () => {
  const browser = aBrowser();
  const writes = servingApp(
    fireflies({
      connect: null,
      state: "disabled",
      unavailable: "absent",
      granted: false,
    }),
    fireflies({ state: "ready", connect: null }),
  );
  const view = drawFirefliesCard();
  browser.click(await view.findByRole("button", { name: "Connect Fireflies" }));
  await waitFor(() =>
    expect(
      view.queryByRole("button", { name: "Connect Fireflies" }),
    ).toBeNull(),
  );
  expect(writes).toEqual([
    `POST ${botAppPath("assistant", FIREFLIES)}/approve`,
  ]);
  expect(view.queryByText(`${FIREFLIES}'s page`, { exact: false })).toBeNull();
  // The tab claimed in case it signed in goes again, never sent anywhere.
  await waitFor(() =>
    expect(browser.tabs.map((tab) => [tab.closed, tab.to])).toEqual([
      [true, []],
    ]),
  );
});

test("an admin's Connect and give it goes on to the key form for an app that takes a key", async () => {
  const browser = aBrowser();
  const writes = servingApp(
    fireflies({
      connect: null,
      state: "disabled",
      unavailable: "absent",
      granted: false,
      requestKind: "enable",
    }),
    fireflies({ state: "not_connected", connect: "key" }),
    { edition: "team", role: "admin" },
  );
  const view = drawFirefliesCard();
  const button = await view.findByRole("button", {
    name: "Connect Fireflies and give it to Personal Assistant",
  });
  expect(button.textContent).toBe("Connect and give it to Personal Assistant");
  browser.click(button);
  await view.findByText(`${FIREFLIES}'s page, with the key form open`, {
    exact: true,
  });
  expect(writes).toEqual([
    `POST ${botAppPath("assistant", FIREFLIES)}/approve`,
  ]);
});

/**
 * NOTION AND GMAIL, FOR THE ADMIN OF THEIR OWN ORGANIZATION ON OPENBOT CLOUD. A Bot asked for Notion.
 * The card told the admin "Only an admin can give it", and its press answered "Notion has no tools to
 * give yet": the app had listed nothing, and the press stopped before the admin's sign-in, after
 * which it is asked again as them. One press now turns the app on, opens the admin's sign-in, and
 * gives it to the Bot once they're in.
 */
test.each([
  ["Notion", "composio-notion", "NOTION_SEARCH"],
  ["Gmail", "composio-gmail", "GMAIL_FETCH_EMAILS"],
] as const)(
  "an admin's one press on %s turns it on, signs them in, and gives it to the Bot",
  async (title, key, read) => {
    const browser = aBrowser();
    const app = (overrides: Partial<AppAccess>): AppAccess =>
      appAccess({
        key,
        displayName: title,
        source: "directory",
        connect: "consent",
        granted: false,
        requestKind: "grant",
        ...overrides,
      });
    const SIGNED_IN = "2026-11-23T23:10:00.000Z";
    let live = app({
      state: "disabled",
      unavailable: "absent",
      requestKind: "enable",
    });
    const writes: string[] = [];
    global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (method !== "GET") writes.push(`${method} ${url}`);
      if (url === DEPLOYMENT_PATH) return Response.json({ edition: "team" });
      if (url === ME_PATH)
        return meResponse({
          user: { id: "usr_me", role: "admin", name: "Me" },
        });
      if (url === botPath("assistant"))
        return Response.json({
          bot: { id: "assistant", name: "General Assistant" },
        });
      if (url === botAppPath("assistant", key)) return botAppResponse(live);
      if (url === `${botAppPath("assistant", key)}/approve`) {
        // As the server answers: on with nothing given until the admin has signed in, then given.
        const given = live.connectedAt !== null;
        live = given
          ? app({ state: "ready", granted: true, connectedAt: SIGNED_IN })
          : app({ state: "not_granted" });
        return appAccessApprovalResponse({
          request: appAccessRequest({
            kind: given ? "grant" : "enable",
            status: "approved",
            agentId: "assistant",
          }),
          enabled: !given,
          granted: given ? [`${key}/${read}`] : [],
        });
      }
      if (url === myConnectionPath(key, "connect"))
        return startResponse({ authorizationUrl: CONSENT });
      if (url.startsWith(MY_CONNECTIONS_PATH)) return connectionPage([]);
      return Response.json({});
    }) as unknown as typeof fetch;
    const view = drawFirefliesCard(key, title);

    // Said to the admin as what is missing: the button beside it is theirs to press.
    await view.findByText(`${title} isn't connected yet.`);
    expect(view.queryByText(/Only an admin/)).toBeNull();
    browser.click(
      await view.findByRole("button", {
        name: `Connect ${title} and give it to General Assistant`,
      }),
    );
    await waitFor(() => expect(browser.tabs[0]?.to).toHaveLength(1), {
      timeout: 3_000,
    });
    expect(browser.tabs[0].duringClick).toBe(true);
    await view.findByText("Finish in the tab that opened.");
    expect(view.queryByRole("alert")).toBeNull();

    // The admin finished the app's sign-in in the other tab.
    live = app({ state: "not_granted", connectedAt: SIGNED_IN });
    // Drawn outside a conversation, so there is nothing to carry on: the card says it's ready.
    await view.findByText("Ready to use.", {}, { timeout: 6_000 });
    expect(writes).toEqual([
      `POST ${botAppPath("assistant", key)}/approve`,
      `POST ${myConnectionPath(key, "connect")}`,
      `POST ${botAppPath("assistant", key)}/approve`,
    ]);
    expect(view.queryByRole("alert")).toBeNull();
  },
  15_000,
);

test("an admin's Connect and give it goes on to the sign-in for an app that signs in", async () => {
  const browser = aBrowser();
  servingApp(
    fireflies({
      connect: null,
      state: "disabled",
      unavailable: "absent",
      granted: false,
      requestKind: "enable",
    }),
    fireflies({ state: "not_connected", connect: "oauth" }),
    { edition: "team", role: "admin" },
  );
  const view = drawFirefliesCard();
  browser.click(
    await view.findByRole("button", {
      name: "Connect Fireflies and give it to Personal Assistant",
    }),
  );
  await waitFor(() => expect(browser.tabs[0]?.to).toEqual([CONSENT]), {
    timeout: 3_000,
  });
  expect(browser.tabs[0].duringClick).toBe(true);
  await view.findByText("Finish in the tab that opened.");
});
