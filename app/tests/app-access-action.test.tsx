import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
  useRouterState,
} from "@tanstack/react-router";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import { useState } from "react";
import {
  AppAccessAction,
  appAccessSentence,
} from "@/components/plugins/app-access-action";
import { AppSource } from "@/lib/api/generated/model/appSource";
import { BotAppConnect } from "@/lib/api/generated/model/botAppConnect";
import type { AppAccess } from "@/lib/app-access/queries";
import { ME_PATH, meResponse } from "./accounts-api";
import {
  APPS_SETTING_PATH,
  appsSettingResponse,
  DEPLOYMENT_PATH,
} from "./admin-settings-api";
import { appAccess } from "./app-access-fixture";
import { APPS_PATH } from "./apps-api";
import {
  APP_ACCESS_REQUESTS_PATH,
  APP_SETUP_PATH,
  appAccessApprovalResponse,
  appAccessRequest,
  appAccessRequestPath,
  appAccessRequestResponse,
  appSetupResponse,
  botAppPath,
  botAppResponse,
} from "./bot-grants-api";
import { botPath } from "./bots-api";
import {
  connectionsCall,
  myConnectionPath,
  startResponse,
} from "./connections-api";
import { settleReactWork } from "./settle-react-work";

/**
 * The one piece the Bot page and the chat card both draw an app's state with.
 *
 * Each of the eight states must say whose move it is and offer exactly that move — and nothing for a
 * state that needs none, or a move that is somebody else's: an administrator's, or on somebody else's
 * Team Bot its owner's. The two moves that write are asserted against the request they send: the
 * browser names a Bot and an app and never a kind, which is the server's to decide.
 */

let originalOpen: typeof window.open;
beforeAll(() => {
  GlobalRegistrator.register();
  originalOpen = window.open;
});
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
  window.open = originalOpen;
});

type Sent = { method: string; url: string; body: unknown };

function mounted(
  access: AppAccess,
  answer?: { status: number; body: unknown },
  options: {
    admin?: boolean;
    personal?: boolean;
    /** Holds the connect route's answer until it settles, so a test can refetch first. */
    connectGate?: Promise<void>;
    /** Holds the apps list's answer, which an app's page waits for before it draws. */
    appsGate?: Promise<void>;
    /** The service this OpenBot's directory comes from, as app-setup says. Composio's unless named. */
    directory?: "composio" | "arcade";
    /** What the server says the app is now, when the press reads it again after turning it on. */
    readAgain?: () => AppAccess;
    /** Holds that read's answer until it settles: the seconds between the turn-on and the rest. */
    readAgainGate?: Promise<void>;
    /**
     * Apps open, and whether the Bot is the person's own. Locked down unless given: every test here
     * that pins Request access pins it locked down.
     */
    open?: { owner: boolean };
  } = {},
) {
  const sent: Sent[] = [];
  const opened: string[] = [];
  // The tab the last Connect claimed, so a test can close it the way a person would.
  const tabs: { closed: boolean }[] = [];
  window.open = (() => {
    const tab = {
      opener: {} as unknown,
      closed: false,
      location: { replace: (next: string) => opened.push(next) },
      close: () => {},
    };
    tabs.push(tab);
    return tab as unknown as Window;
  }) as typeof window.open;
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    sent.push({
      method,
      url,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    if (url === APPS_SETTING_PATH) return appsSettingResponse(!options.open);
    if (method === "GET" && url.startsWith(APPS_PATH)) {
      await options.appsGate;
      return Response.json({ apps: [], nextCursor: null });
    }
    if (options.open && url === botPath("expenses"))
      return Response.json({
        bot: { id: "expenses", name: "Expenses", mine: options.open.owner },
      });
    if (options.admin && url === ME_PATH)
      return meResponse({ user: { id: "usr_admin", role: "admin" } });
    if (options.personal && url === DEPLOYMENT_PATH)
      return Response.json({ edition: "personal" });
    if (options.admin && url === botPath("expenses"))
      return Response.json({ bot: { id: "expenses", name: "Expenses" } });
    if (url === APP_SETUP_PATH)
      return appSetupResponse(options.directory ?? "composio");
    if (
      options.readAgain &&
      method === "GET" &&
      url === botAppPath("expenses", access.key)
    ) {
      await options.readAgainGate;
      return botAppResponse(options.readAgain());
    }
    if (answer && method !== "GET")
      return Response.json(answer.body, { status: answer.status });
    if (connectionsCall(url, { method })?.operation === "connect") {
      await options.connectGate;
      return startResponse({ authorizationUrl: "https://gmail.test/consent" });
    }
    // Each write answers as the API does: the approval, the actions given, or the request filed.
    if (url.endsWith("/approve"))
      return appAccessApprovalResponse({
        request: appAccessRequest({ status: "approved" }),
      });
    if (url.endsWith("/give")) return Response.json({ given: [] });
    return appAccessRequestResponse(appAccessRequest());
  }) as unknown as typeof fetch;

  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  // Stands in for the refetch after a write: the server's next answer, handed to the same row.
  let swap: (next: AppAccess) => void = () => {};
  function Row() {
    const [current, setCurrent] = useState(access);
    swap = setCurrent;
    return (
      <div>
        <p>{appAccessSentence(current)}</p>
        <AppAccessAction access={current} agentId="expenses" />
      </div>
    );
  }
  const root = createRootRoute({ component: Outlet });
  const page = createRoute({
    getParentRoute: () => root,
    path: "/",
    component: Row,
  });
  const settings = createRoute({
    getParentRoute: () => root,
    path: "/connections/$key",
    // Where a press that ends at a key form lands, read back by the test as the address it reached.
    component: function AppPage() {
      const at = useRouterState({ select: (state) => state.location.href });
      return <p data-testid="app-page">{at}</p>;
    },
  });
  const directory = createRoute({
    getParentRoute: () => root,
    path: "/connections/browse/$provider",
    component: () => null,
  });
  const admin = createRoute({
    getParentRoute: () => root,
    path: "/admin/plugins/$key",
    component: () => null,
  });
  const router = createRouter({
    routeTree: root.addChildren([page, settings, directory, admin]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  const view = render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
  return {
    view,
    sent,
    opened,
    tabs,
    swap: (next: AppAccess) => act(() => swap(next)),
  };
}

const COPY: [string, Partial<AppAccess>, RegExp][] = [
  ["ready", {}, /^Ready to use\.$/],
  [
    "ready, on the owner's account",
    { accountHolder: "owner" },
    /^Ready to use\. This Bot uses its owner's Gmail account\.$/,
  ],
  [
    "ready, asking first",
    { asksFirst: true },
    /^Ready to use with your own Gmail account\. You'll be asked to allow it the first time\.$/,
  ],
  [
    "not_connected",
    { state: "not_connected" },
    /You haven't connected your Gmail account yet\./,
  ],
  [
    "reconnect",
    { state: "reconnect" },
    /^Your Gmail connection needs reconnecting\.$/,
  ],
  [
    "reconnect, on the owner's account",
    { state: "reconnect", accountHolder: "owner" },
    /^This Bot uses its owner's Gmail account, which needs reconnecting\. Only the Bot's owner can reconnect it\.$/,
  ],
  [
    "shared_not_connected",
    { state: "shared_not_connected" },
    /Your organisation's Gmail account isn't connected yet\. Only an admin can connect it\./,
  ],
  [
    "shared_not_approved",
    { state: "shared_not_approved" },
    /^This Bot reaches more people than an admin approved for your organisation's Gmail account\. Only an admin can approve it\.$/,
  ],
  [
    "disabled, never switched on",
    { state: "disabled", unavailable: "absent" },
    /^Gmail isn't turned on yet\. Only an admin can turn it on\.$/,
  ],
  [
    "disabled, with no reason given",
    { state: "disabled", unavailable: null },
    /^Gmail isn't turned on yet\./,
  ],
  [
    "disabled, with no directory set up",
    { state: "disabled", unavailable: "directory_unavailable" },
    /^Gmail isn't set up yet\. An admin has to turn it on\.$/,
  ],
  ...(
    ["scheme_unreadable", "oauth_client_missing", "token_missing"] as const
  ).map((unavailable): [string, Partial<AppAccess>, RegExp] => [
    `disabled, ${unavailable}`,
    { state: "disabled", unavailable },
    /^Gmail isn't fully set up yet\. Only an admin can finish setting it up\.$/,
  ]),
  // Open to Bot owners by default: its owner can give it, not only an admin.
  [
    "not_granted, open to owners",
    { state: "not_granted", ownerGrants: "any" },
    /^This Bot hasn't been given Gmail\. Its owner can give it, or an admin\.$/,
  ],
  [
    "not_granted, kept to admins",
    { state: "not_granted", ownerGrants: "admin" },
    /^This Bot hasn't been given Gmail\. Only an admin can give it\.$/,
  ],
];

test.each(COPY)("says whose move it is: %s", (_, overrides, sentence) => {
  expect(appAccessSentence(appAccess(overrides))).toMatch(sentence);
});

/*
 * APPS OPEN: what a member is told, as the Bot's owner and as anybody else. The steps open apps hand
 * to a member name nobody; what an admin keeps either way (a set-up left unfinished, the shared
 * account, an app kept to admins) reads as it does locked down.
 */
const OPEN_COPY: [string, Partial<AppAccess>, boolean, RegExp][] = [
  [
    "not added, the owner",
    { state: "disabled", unavailable: "absent" },
    true,
    /^Gmail isn't connected yet\.$/,
  ],
  [
    "not added, anybody else",
    { state: "disabled", unavailable: "absent" },
    false,
    /^Gmail isn't connected yet\. Connect it, and this Bot's owner can give it to the Bot\.$/,
  ],
  [
    "not given, the owner",
    { state: "not_granted", ownerGrants: "any" },
    true,
    /^This Bot hasn't been given Gmail yet\.$/,
  ],
  [
    "not given, anybody else",
    { state: "not_granted", ownerGrants: "any" },
    false,
    /^This Bot hasn't been given Gmail\. Its owner can give it\.$/,
  ],
  [
    "kept to admins",
    { state: "not_granted", ownerGrants: "admin" },
    true,
    /^This Bot hasn't been given Gmail\. Only an admin can give it\.$/,
  ],
  [
    "set-up unfinished",
    { state: "disabled", unavailable: "oauth_client_missing" },
    true,
    /^Gmail isn't fully set up yet\. Only an admin can finish setting it up\.$/,
  ],
  [
    "shared account not connected",
    { state: "shared_not_connected", account: "shared" },
    false,
    /Only an admin can connect it\.$/,
  ],
];

test.each(OPEN_COPY)(
  "apps open, says whose move it is: %s",
  (_, overrides, owner, sentence) => {
    expect(
      appAccessSentence(appAccess(overrides), undefined, "team", false, [], {
        owner,
      }),
    ).toMatch(sentence);
  },
);

test("apps open: the Bot's owner is offered Connect and give it, which turns it on and gives it in one press", async () => {
  const { view, sent } = mounted(
    appAccess({ state: "disabled", unavailable: "absent", connect: "key" }),
    undefined,
    { open: { owner: true } },
  );
  fireEvent.click(
    await view.findByRole("button", {
      name: "Connect Gmail and give it to Expenses",
    }),
  );
  await waitFor(() =>
    expect(sent.find((call) => call.method === "POST")?.url).toBe(
      `${botAppPath("expenses", "composio-gmail")}/approve`,
    ),
  );
  expect(view.queryByRole("button", { name: /Request access/ })).toBeNull();
});

test("apps open: on somebody else's Bot, Connect adds a catalogue app and goes on to the person's own key", async () => {
  const fireflies = appAccess({
    key: "fireflies",
    displayName: "Fireflies",
    source: "catalogue",
    connect: "key",
    state: "disabled",
    unavailable: "absent",
    requestKind: "enable",
  });
  const { view, sent } = mounted(fireflies, undefined, {
    open: { owner: false },
    // Added, not given to this Bot, and the person hasn't typed their key yet.
    readAgain: () =>
      appAccess({
        ...fireflies,
        state: "not_granted",
        unavailable: null,
        granted: false,
      }),
  });
  fireEvent.click(
    await view.findByRole("button", { name: "Connect Fireflies" }),
  );
  await waitFor(() =>
    expect(view.getByTestId("app-page").textContent).toBe(
      "/connections/fireflies?connect=true",
    ),
  );
  const posts = sent.filter((call) => call.method === "POST");
  expect(posts.map((call) => [call.url, call.body])).toEqual([
    [APPS_PATH, { from: "directory", directoryEntryId: "catalogue:fireflies" }],
  ]);
});

test("no sentence about a switched-off app says an admin turned it off", () => {
  for (const [, overrides] of COPY.filter(([, o]) => o.state === "disabled"))
    expect(appAccessSentence(appAccess(overrides))).not.toMatch(/Turned off/);
});

test("ready offers nothing to press", async () => {
  const { view } = mounted(appAccess());
  await view.findByText("Ready to use.");
  expect(view.queryByRole("button")).toBeNull();
  expect(view.queryByRole("link")).toBeNull();
});

test("not connected offers Connect, which starts the person's own consent in a new tab", async () => {
  const { view, sent, opened } = mounted(appAccess({ state: "not_connected" }));
  fireEvent.click(await view.findByRole("button", { name: "Connect Gmail" }));
  await waitFor(() => expect(opened).toEqual(["https://gmail.test/consent"]));
  expect(sent.map((call) => `${call.method} ${call.url}`)).toContain(
    `POST ${myConnectionPath("composio-gmail", "connect")}`,
  );
  await view.findByText("Finish in the tab that opened.");
});

test("an app connected with a typed key goes to its page in Settings, with the key form open", async () => {
  const { view } = mounted(
    appAccess({ state: "not_connected", connect: "key" }),
  );
  fireEvent.click(await view.findByRole("button", { name: "Connect Gmail" }));
  expect((await view.findByTestId("app-page")).textContent).toBe(
    "/connections/composio-gmail?connect=true",
  );
});

/*
 * FOUND AFTER KEY APPS WERE MADE ONE PRESS: Reconnect on an app that signs in through the directory
 * opened its page as it was, where a second press began the sign-in. Every app that signs in now
 * starts its sign-in from the press, and the button says so until the sign-in opens.
 */
test.each([
  ["Composio's directory", "composio-gmail", "Gmail", "consent", "composio"],
  ["Arcade's directory", "arcade-Gmail", "Gmail", "consent", "arcade"],
  ["OpenBot's own sign-in", "notion", "Notion", "oauth", "composio"],
  [
    "an app's own sign-in server",
    "fireflies-mcp",
    "Fireflies",
    "oauth",
    "composio",
  ],
  [
    "an MCP server that signs people in",
    "mcp-linear",
    "Linear",
    "oauth",
    "composio",
  ],
] as const)(
  "Reconnect on a sign-in app through %s starts its sign-in in one press",
  async (_, key, name, connect, directory) => {
    let release: () => void = () => {};
    const connectGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { view, sent, opened } = mounted(
      appAccess({ key, displayName: name, state: "reconnect", connect }),
      undefined,
      { connectGate, directory },
    );
    fireEvent.click(
      await view.findByRole("button", { name: `Reconnect ${name}` }),
    );
    // Asked for the sign-in from the press, and saying so where it was pressed until it opens.
    await waitFor(() =>
      expect(
        sent.some(
          (call) =>
            call.method === "POST" &&
            call.url === myConnectionPath(key, "connect"),
        ),
      ).toBe(true),
    );
    const working = await view.findByText("Opening sign-in…");
    expect(working.closest("button")?.hasAttribute("disabled")).toBe(true);
    expect(view.getByText(/connection needs reconnecting/)).toBeTruthy();
    release();
    await waitFor(() => expect(opened).toEqual(["https://gmail.test/consent"]));
    // The screen stays: the sign-in is in the tab that opened.
    expect(view.queryByTestId("app-page")).toBeNull();
    expect(
      await view.findByText("Finish in the tab that opened."),
    ).toBeTruthy();
  },
);

/*
 * FOUND IN DOGFOODING: Reconnect on Fireflies, whose key the app didn't take, opened its page as it
 * was, where nothing reconnected it. Every app that takes a key now reconnects in the key form.
 */
test.each([
  ["composio-fireflies", "Fireflies"],
  ["composio-_1password", "1Password"],
  ["composio-pipedrive", "Pipedrive"],
])(
  "Reconnect on %s, a key the app didn't take, opens its key form",
  async (key, name) => {
    const { view, opened } = mounted(
      appAccess({
        key,
        displayName: name,
        state: "reconnect",
        connect: "key",
      }),
    );
    fireEvent.click(
      await view.findByRole("button", { name: `Reconnect ${name}` }),
    );
    expect((await view.findByTestId("app-page")).textContent).toBe(
      `/connections/${key}?connect=true`,
    );
    expect(opened).toEqual([]);
  },
);

test("Reconnect stays on the screen it was pressed on, saying so, until the app's page can draw", async () => {
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { view } = mounted(
    appAccess({
      key: "composio-fireflies",
      displayName: "Fireflies",
      state: "reconnect",
      connect: "key",
    }),
    undefined,
    { appsGate: held },
  );
  fireEvent.click(
    await view.findByRole("button", { name: "Reconnect Fireflies" }),
  );
  // The page's reads are still out: the row is where it was, and its button says it is working.
  const working = await view.findByText("Connecting…");
  expect(working.closest("button")?.hasAttribute("disabled")).toBe(true);
  expect(view.queryByTestId("app-page")).toBeNull();
  expect(view.getByText(/connection needs reconnecting/)).toBeTruthy();
  release();
  expect((await view.findByTestId("app-page")).textContent).toBe(
    "/connections/composio-fireflies?connect=true",
  );
});

test("this deployment's own OAuth app reconnects in place, with a fresh consent", async () => {
  const { view, opened } = mounted(
    appAccess({
      key: "notion",
      displayName: "Notion",
      source: "catalogue",
      connect: "oauth",
      state: "reconnect",
    }),
  );
  fireEvent.click(
    await view.findByRole("button", { name: "Reconnect Notion" }),
  );
  await waitFor(() => expect(opened).toHaveLength(1));
});

/** Whether this tab has the focus, as `document.hasFocus` answers it, for the length of `run`. */
async function withFocus(focused: boolean, run: () => Promise<void>) {
  const real = document.hasFocus;
  document.hasFocus = () => focused;
  try {
    await run();
  } finally {
    document.hasFocus = real;
  }
}

test("closing the sign-in tab ends the wait, rather than waiting for it forever", async () => {
  await withFocus(true, async () => {
    const { view, tabs } = mounted(appAccess({ state: "not_connected" }));
    fireEvent.click(await view.findByRole("button", { name: "Connect Gmail" }));
    await view.findByText("Waiting for Gmail…");
    const [tab] = tabs;
    if (!tab) throw new Error("no tab was claimed");
    tab.closed = true;
    await waitFor(
      () =>
        expect(
          view.getByRole("button", { name: "Connect Gmail" }),
        ).toBeTruthy(),
      { timeout: 3_000 },
    );
    expect(view.queryByText("Waiting for Gmail…")).toBeNull();
    expect(view.queryByText("Finish in the tab that opened.")).toBeNull();
  });
});

test("a sign-in tab that only reads closed keeps the wait until this tab has the focus back", async () => {
  await withFocus(false, async () => {
    const { view, tabs } = mounted(appAccess({ state: "not_connected" }));
    fireEvent.click(await view.findByRole("button", { name: "Connect Gmail" }));
    await view.findByText("Waiting for Gmail…");
    const [tab] = tabs;
    if (!tab) throw new Error("no tab was claimed");
    // A vendor's opener policy severs the handle while the person is still on its consent screen.
    tab.closed = true;
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(view.getByText("Waiting for Gmail…")).toBeTruthy();
    // They come back to this tab: there is an answer to show now.
    window.dispatchEvent(new Event("focus"));
    await waitFor(() =>
      expect(view.queryByText("Waiting for Gmail…")).toBeNull(),
    );
  });
});

test("a Reconnect on the owner's account offers nothing: only the owner can reconnect it", async () => {
  const { view } = mounted(
    appAccess({ state: "reconnect", accountHolder: "owner" }),
  );
  await view.findByText(/Only the Bot's owner can reconnect it/);
  expect(view.queryByRole("button")).toBeNull();
  expect(view.queryByRole("link")).toBeNull();
});

test("a Shared app waiting on an admin's approval offers nothing: the refused call already asked", async () => {
  const { view } = mounted(
    appAccess({
      state: "shared_not_approved",
      account: "shared",
    }),
  );
  await view.findByText(/Only an admin can approve it/);
  expect(view.queryByRole("button")).toBeNull();
});

test.each([
  [{ accountHolder: "owner" }, /owner's Gmail account/],
  [{ asksFirst: true }, /asked to allow it the first time/],
] as const)(
  "ready on somebody else's Team Bot offers nothing to press",
  async (overrides, sentence) => {
    const { view } = mounted(appAccess(overrides));
    await view.findByText(sentence);
    expect(view.queryByRole("button")).toBeNull();
  },
);

test.each([
  ["disabled", "enable"],
  ["not_granted", "grant"],
  ["shared_not_connected", "connect_shared"],
] as const)(
  "%s offers Request access, naming the Bot and the app and never the kind",
  async (state, kind) => {
    const { view, sent } = mounted(appAccess({ state, requestKind: kind }));
    fireEvent.click(
      await view.findByRole("button", { name: "Request access to Gmail" }),
    );
    await waitFor(() =>
      expect(sent.find((call) => call.method === "POST")).toEqual({
        method: "POST",
        url: APP_ACCESS_REQUESTS_PATH,
        body: { botId: "expenses", appId: "composio-gmail" },
      }),
    );
  },
);

test("a pending request reads Requested, and Withdraw cancels it", async () => {
  const { view, sent } = mounted(
    appAccess({
      state: "disabled",
      requestKind: "enable",
      request: {
        id: "req_9",
        kind: "enable",
        createdAt: "2026-10-20T10:00:00.000Z",
      },
    }),
  );
  await view.findByText("Requested");
  expect(
    view.queryByRole("button", { name: "Request access to Gmail" }),
  ).toBeNull();
  fireEvent.click(
    view.getByRole("button", { name: "Withdraw request for Gmail" }),
  );
  await waitFor(() =>
    expect(
      sent.some(
        (call) =>
          call.method === "DELETE" &&
          call.url === appAccessRequestPath("req_9"),
      ),
    ).toBe(true),
  );
});

test("the server's refusal of a request is drawn beside the button", async () => {
  const { view } = mounted(
    appAccess({ state: "not_granted", requestKind: "grant" }),
    { status: 409, body: { error: "Gmail is ready to use." } },
  );
  fireEvent.click(
    await view.findByRole("button", { name: "Request access to Gmail" }),
  );
  expect((await view.findByRole("alert")).textContent).toBe(
    "Gmail is ready to use.",
  );
});

test("a state with no request to file offers none, rather than a button the server would refuse", async () => {
  const { view } = mounted(
    appAccess({ state: "shared_not_connected", requestKind: null }),
  );
  await view.findByText(/organisation's Gmail account/);
  expect(view.queryByRole("button")).toBeNull();
});

test("the focus follows the press: Request access hands it to Withdraw, and Withdraw back", async () => {
  const asked = appAccess({ state: "not_granted", requestKind: "grant" });
  const { view, sent, swap } = mounted(asked);
  const ask = await view.findByRole("button", {
    name: "Request access to Gmail",
  });
  ask.focus();
  fireEvent.click(ask);
  await waitFor(() =>
    expect(sent.some((call) => call.method === "POST")).toBe(true),
  );
  const pending = {
    ...asked,
    request: {
      id: "req_1",
      kind: "grant" as const,
      createdAt: "2026-10-20T10:00:00.000Z",
    },
  };
  await swap(pending);
  const withdraw = await view.findByRole("button", {
    name: "Withdraw request for Gmail",
  });
  expect(document.activeElement).toBe(withdraw);

  fireEvent.click(withdraw);
  await waitFor(() =>
    expect(sent.some((call) => call.method === "DELETE")).toBe(true),
  );
  await swap(asked);
  expect(document.activeElement).toBe(
    await view.findByRole("button", { name: "Request access to Gmail" }),
  );
});

test.each([
  [
    "disabled",
    "Connect and give it to Expenses",
    "Connect Gmail and give it to Expenses",
  ],
  ["not_granted", "Give it to Expenses", "Give Gmail to Expenses"],
] as const)(
  "an admin looking at %s gets the fix itself, in one press, never a request to themselves",
  async (state, label, spoken) => {
    const { view, sent } = mounted(
      appAccess({
        state,
        unavailable: state === "disabled" ? "absent" : null,
        requestKind: state === "disabled" ? "enable" : "grant",
      }),
      undefined,
      { admin: true },
    );
    const button = await view.findByRole("button", { name: spoken });
    expect(button.textContent).toBe(label);
    expect(
      view.queryByRole("button", { name: "Request access to Gmail" }),
    ).toBeNull();
    fireEvent.click(button);
    await waitFor(() =>
      expect(sent.find((call) => call.method === "POST")).toStrictEqual({
        method: "POST",
        url: `${botAppPath("expenses", "composio-gmail")}/approve`,
        body: undefined,
      }),
    );
  },
);

test.each(["disabled", "not_granted"] as const)(
  "in the personal edition, %s is one Connect: turn it on, then sign in in a new tab",
  async (state) => {
    const { view, sent, opened } = mounted(
      appAccess({
        state,
        unavailable: state === "disabled" ? "absent" : null,
      }),
      undefined,
      { admin: true, personal: true },
    );
    const button = await view.findByRole("button", { name: "Connect Gmail" });
    expect(button.textContent).toBe("Connect");
    fireEvent.click(button);
    await waitFor(() => expect(opened).toEqual(["https://gmail.test/consent"]));
    expect(
      sent.filter((call) => call.method === "POST").map((call) => call.url),
    ).toEqual([
      `${botAppPath("expenses", "composio-gmail")}/approve`,
      myConnectionPath("composio-gmail", "connect"),
    ]);
  },
);

test("in the personal edition, Connect still opens the sign-in when turning the app on swaps the button", async () => {
  let release: () => void = () => {};
  const connectGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { view, sent, opened, swap } = mounted(
    appAccess({ state: "disabled", unavailable: "absent" }),
    undefined,
    { admin: true, personal: true, connectGate },
  );
  fireEvent.click(await view.findByRole("button", { name: "Connect Gmail" }));
  await waitFor(() =>
    expect(
      sent.some(
        (call) => call.url === myConnectionPath("composio-gmail", "connect"),
      ),
    ).toBe(true),
  );
  // The refetch after turning it on: the app is on now, and only this person's sign-in is missing.
  swap(appAccess({ state: "not_connected" }));
  release();
  await waitFor(() => expect(opened).toEqual(["https://gmail.test/consent"]));
  expect(
    (await view.findByRole("button", { name: "Waiting for Gmail…" }))
      .textContent,
  ).toBe("Waiting for Gmail…");
});

test("in the personal edition, an app that isn't set up says what is missing, not who to ask", () => {
  expect(
    appAccessSentence(
      appAccess({ state: "disabled", unavailable: "directory_unavailable" }),
      undefined,
      "personal",
    ),
  ).toBe("Gmail isn't set up yet. Set it up to connect it.");
  expect(
    appAccessSentence(
      appAccess({ state: "disabled", unavailable: "token_missing" }),
      undefined,
      "personal",
    ),
  ).toBe("Gmail isn't fully set up yet. Set it up to finish.");
});

test("in the personal edition, Set it up for an app with no broker key opens the broker's directory", async () => {
  const { view } = mounted(
    appAccess({
      state: "disabled",
      unavailable: "directory_unavailable",
      requestKind: "enable",
    }),
    undefined,
    { admin: true, personal: true },
  );
  const link = await view.findByRole("button", { name: "Set up Gmail" });
  expect(link.getAttribute("href")).toBe("/connections/browse/composio");
});

test("in the personal edition, the card says what is missing rather than who to ask", () => {
  for (const state of ["disabled", "not_granted"] as const) {
    const sentence = appAccessSentence(
      appAccess({ state, unavailable: state === "disabled" ? "absent" : null }),
      undefined,
      "personal",
    );
    expect(sentence).toBe("Gmail isn't connected yet.");
  }
});

test("an admin's press that cannot be carried out says what is missing", async () => {
  const { view } = mounted(
    appAccess({ state: "not_granted", requestKind: "grant" }),
    {
      status: 409,
      body: {
        error: "Couldn't get Gmail ready for this Bot. Try again in a moment.",
      },
    },
    { admin: true },
  );
  fireEvent.click(
    await view.findByRole("button", { name: "Give Gmail to Expenses" }),
  );
  expect((await view.findByRole("alert")).textContent).toBe(
    "Couldn't get Gmail ready for this Bot. Try again in a moment.",
  );
});

/*
 * OpenBot Cloud, an admin in their own organization: a Bot asked for Notion, and the card said
 * "This Bot hasn't been given Notion. Only an admin can give it." to the admin. Pressing Give it
 * answered "Notion has no tools to give yet": the app had listed nothing, and the press stopped
 * before the admin's sign-in, after which the app is asked for its tools again as them. Notion and
 * Gmail from the directory, each run on the person's own account.
 */
const NOTION: Partial<AppAccess> = {
  key: "composio-notion",
  displayName: "Notion",
  source: "directory",
  connect: "consent",
  account: "personal",
  connectedAt: null,
};

test.each([
  [
    "not_granted",
    { state: "not_granted" },
    "This Bot hasn't been given Gmail yet.",
  ],
  [
    "disabled, never switched on",
    { state: "disabled", unavailable: "absent" },
    "Gmail isn't connected yet.",
  ],
  [
    "disabled, with no directory set up",
    { state: "disabled", unavailable: "directory_unavailable" },
    "Gmail isn't set up yet.",
  ],
  [
    "disabled, token_missing",
    { state: "disabled", unavailable: "token_missing" },
    "Gmail isn't fully set up yet.",
  ],
  [
    "shared_not_connected",
    { state: "shared_not_connected", account: "shared" },
    "Your organization's Gmail account isn't connected yet.",
  ],
] as const)(
  "an admin is told what is missing, never to ask an admin: %s",
  (_, overrides, sentence) => {
    expect(
      appAccessSentence(appAccess(overrides), undefined, "team", true),
    ).toBe(sentence);
  },
);

/** Gmail from the directory, run on each person's own account and signed in through its consent. */
const GMAIL: Partial<AppAccess> = {
  key: "composio-gmail",
  displayName: "Gmail",
  source: "directory",
  connect: "consent",
  account: "personal",
  connectedAt: null,
};

test.each([
  ["Notion", NOTION],
  ["Gmail", GMAIL],
] as const)(
  "an admin's one press on %s, which has listed nothing yet, signs them in, then gives it to the Bot once they're connected",
  async (title, app) => {
    const before = appAccess({
      ...app,
      state: "not_granted",
      granted: false,
      requestKind: "grant",
    });
    const key = before.key;
    const { view, sent, opened, swap } = mounted(before, undefined, {
      admin: true,
      // Turned on with nothing given: its tools come with the admin's sign-in.
      readAgain: () => before,
    });
    fireEvent.click(
      await view.findByRole("button", { name: `Give ${title} to Expenses` }),
    );
    await waitFor(() => expect(opened).toEqual(["https://gmail.test/consent"]));
    await view.findByText("Finish in the tab that opened.");
    const approve = `POST ${botAppPath("expenses", key)}/approve`;
    const posts = () =>
      sent
        .filter((call) => call.method === "POST")
        .map((call) => `${call.method} ${call.url}`);
    expect(posts()).toEqual([
      approve,
      `POST ${myConnectionPath(key, "connect")}`,
    ]);

    // The admin finished signing in in the other tab.
    await swap({ ...before, connectedAt: "2026-11-23T23:10:00.000Z" });
    await waitFor(() =>
      expect(posts()).toEqual([
        approve,
        `POST ${myConnectionPath(key, "connect")}`,
        approve,
      ]),
    );
    expect(view.queryByRole("alert")).toBeNull();
  },
);

test("an admin already signed in to Notion gives it in one press, with no sign-in", async () => {
  const { view, sent, opened } = mounted(
    appAccess({
      ...NOTION,
      state: "not_granted",
      granted: false,
      requestKind: "grant",
      connectedAt: "2026-11-20T09:00:00.000Z",
    }),
    undefined,
    {
      admin: true,
      readAgain: () =>
        appAccess({ ...NOTION, connectedAt: "2026-11-20T09:00:00.000Z" }),
    },
  );
  fireEvent.click(
    await view.findByRole("button", { name: "Give Notion to Expenses" }),
  );
  await waitFor(() =>
    expect(
      sent.filter((call) => call.method === "POST").map((call) => call.url),
    ).toEqual([`${botAppPath("expenses", "composio-notion")}/approve`]),
  );
  // Settled: nothing more was asked, and no sign-in was opened.
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(sent.filter((call) => call.method === "POST")).toHaveLength(1);
  expect(opened).toEqual([]);
});

test.each([
  // The shared account's sign-in starts as its page opens: one press.
  [
    { state: "shared_not_connected", requestKind: "connect_shared" },
    "Connect the shared Gmail account",
    "/admin/plugins/composio-gmail?connect=true",
  ],
  [
    { state: "shared_not_connected", requestKind: null },
    "Reconnect the shared Gmail account",
    "/admin/plugins/composio-gmail?connect=true",
  ],
  [
    { state: "disabled", unavailable: "token_missing", requestKind: "enable" },
    "Set up Gmail",
    "/admin/plugins/composio-gmail",
  ],
  [
    {
      state: "disabled",
      unavailable: "directory_unavailable",
      requestKind: "enable",
    },
    "Set up Gmail",
    "/admin/plugins/composio",
  ],
] as const)(
  "an admin gets the page that fixes what one press cannot, in a new tab",
  async (overrides, name, href) => {
    const { view } = mounted(appAccess(overrides), undefined, { admin: true });
    const link = await view.findByRole("button", { name });
    expect(link.getAttribute("href")).toBe(href);
    expect(link.getAttribute("target")).toBe("_blank");
  },
);

test("an admin on an OpenBot whose directory is Arcade's is sent to Arcade's page to set it up", async () => {
  const { view } = mounted(
    appAccess({
      state: "disabled",
      unavailable: "directory_unavailable",
      requestKind: "enable",
    }),
    undefined,
    { admin: true, directory: "arcade" },
  );
  await waitFor(async () =>
    expect(
      (await view.findByRole("button", { name: "Set up Gmail" })).getAttribute(
        "href",
      ),
    ).toBe("/admin/plugins/arcade"),
  );
});

test("an owner is asked about their own app, by the Bot's name where the caller has it", () => {
  const owners = appAccess({ state: "owner_grantable", granted: false });
  expect(appAccessSentence(owners)).toBe("Let this Bot use your Gmail?");
  expect(appAccessSentence(owners, "Research Bot")).toBe(
    "Let Research Bot use your Gmail?",
  );
  expect(
    appAccessSentence({ ...owners, needsConnect: true }, "Research Bot"),
  ).toBe("Let Research Bot use your Gmail? Connect it first.");
  // An app on nobody's own account is not "your" anything.
  expect(
    appAccessSentence(
      { ...owners, displayName: "Routines", account: "deployment" },
      "Research Bot",
    ),
  ).toBe("Let Research Bot use Routines?");
});

test("an owner's Allow gives the app in one press, naming the Bot and the app and nothing else", async () => {
  const { view, sent } = mounted(
    appAccess({ state: "owner_grantable", granted: false }),
  );
  fireEvent.click(await view.findByRole("button", { name: /^Let .* Gmail$/ }));
  await waitFor(() =>
    expect(sent.filter((call) => call.method === "POST")).toStrictEqual([
      {
        method: "POST",
        url: `${botAppPath("expenses", "composio-gmail")}/give`,
        body: undefined,
      },
    ]),
  );
});

test("Connect and allow opens the person's consent first, and gives the app once it is connected", async () => {
  const waiting = appAccess({
    state: "owner_grantable",
    granted: false,
    needsConnect: true,
  });
  const { view, sent, opened, swap } = mounted(waiting);
  fireEvent.click(
    await view.findByRole("button", { name: /after you connect it$/ }),
  );
  await waitFor(() => expect(opened).toEqual(["https://gmail.test/consent"]));
  const gives = () =>
    sent.filter((call) => call.url.endsWith("/apps/composio-gmail/give"));
  expect(gives()).toEqual([]);
  // The server's next answer: connected now, and still not given.
  swap({ ...waiting, needsConnect: false });
  await waitFor(() => expect(gives()).toHaveLength(1));
});

/*
 * ONE PRESS FOR EVERY KIND OF APP. An admin who presses the card's button is taken through every
 * step they would otherwise press through: turned on, given, and then their own sign-in or, where
 * the app takes a key, the key form, which is the one place they type. Every kind the API can
 * describe is run: each source (`AppSource`) with each way of connecting (`BotAppConnect`, and none),
 * read from the generated client, so a kind the API gains later is run here too, and a way of
 * connecting this test has no expectation for fails it until somebody says what one press does.
 */
type Kind = {
  name: string;
  source: AppAccess["source"];
  connect: AppAccess["connect"];
  key: string;
  /** Whether the app lists its tools before anybody signs in. */
  listed: boolean;
};

/** The id an app of this source has: from the directory, Composio's and Arcade's both. */
function keysFor(source: AppAccess["source"]): string[] {
  switch (source) {
    case "directory":
      return ["composio-gmail", "arcade-Gmail"];
    case "catalogue":
      return ["google-drive"];
    case "address":
      return ["mcp-notes"];
    default:
      throw new Error(
        `No app id for a source this test doesn't know: ${source}`,
      );
  }
}

const CONNECTS: AppAccess["connect"][] = [
  ...Object.values(BotAppConnect),
  null,
];
const KINDS: Kind[] = Object.values(AppSource).flatMap((source) =>
  keysFor(source).flatMap((key) =>
    CONNECTS.flatMap((connect) =>
      [true, false].map((listed) => ({
        name: `${key} (${source}, connects by ${connect ?? "nothing"}, ${listed ? "tools listed" : "nothing listed until signed in"})`,
        source,
        connect,
        key,
        listed,
      })),
    ),
  ),
);

/** What one press must do for a kind: the writes it sends, and where it ends. */
function onePress(kind: Kind): {
  posts: string[];
  /** The address a sign-in tab is sent to, or the key form the page goes to. */
  ends: "signed in, then given" | "sign-in" | "key form" | "given";
} {
  const approve = `${botAppPath("expenses", kind.key)}/approve`;
  const connect = myConnectionPath(kind.key, "connect");
  switch (kind.connect) {
    case null:
      return { posts: [approve], ends: "given" };
    case "key":
      return { posts: [approve], ends: "key form" };
    case "oauth":
    case "consent":
      return kind.listed
        ? { posts: [approve, connect], ends: "sign-in" }
        : { posts: [approve, connect, approve], ends: "signed in, then given" };
    default:
      throw new Error(
        `No one-press expectation for an app that connects by ${kind.connect}. Say what one press does for it.`,
      );
  }
}

/*
 * "Nothing listed until signed in" is a kind only where there is a sign-in: an app with a key or
 * with nothing to connect lists what it can do before anybody connects.
 */
test.each(
  KINDS.filter(
    (kind) =>
      kind.listed || kind.connect === "oauth" || kind.connect === "consent",
  ),
)("one press takes an admin through every step: $name", async (kind) => {
  const account = kind.connect === null ? "deployment" : "personal";
  const before = appAccess({
    key: kind.key,
    displayName: "The app",
    source: kind.source,
    connect: kind.connect,
    account,
    accountHolder: account === "personal" ? "you" : null,
    state: "disabled",
    unavailable: "absent",
    granted: false,
    connectedAt: null,
    requestKind: "enable",
  });
  // What the server says once the press has turned it on.
  const afterOn = appAccess({
    ...before,
    state: !kind.listed
      ? "not_granted"
      : kind.connect === null
        ? "ready"
        : "not_connected",
    unavailable: null,
    granted: kind.listed,
    requestKind: kind.listed ? null : "grant",
  });
  const { view, sent, opened, swap } = mounted(before, undefined, {
    admin: true,
    readAgain: () => afterOn,
  });
  const expected = onePress(kind);
  const posts = () =>
    sent.filter((call) => call.method === "POST").map((call) => call.url);

  fireEvent.click(
    await view.findByRole("button", {
      name: "Connect The app and give it to Expenses",
    }),
  );

  if (expected.ends === "key form") {
    const page = await view.findByTestId("app-page");
    expect(page.textContent).toBe(`/connections/${kind.key}?connect=true`);
  }
  if (expected.ends === "sign-in" || expected.ends === "signed in, then given")
    await waitFor(() => expect(opened).toEqual(["https://gmail.test/consent"]));
  if (expected.ends === "signed in, then given") {
    // Only the person's sign-in was theirs to do; the give follows it without another press.
    await swap({
      ...afterOn,
      connectedAt: "2026-11-23T23:10:00.000Z",
    });
  }
  await waitFor(() => expect(posts()).toEqual(expected.posts));
  if (expected.ends === "given" || expected.ends === "key form")
    expect(opened).toEqual([]);
  expect(view.queryByRole("alert")).toBeNull();
});

test("every kind the API describes is run", () => {
  for (const source of Object.values(AppSource))
    for (const connect of CONNECTS)
      expect(
        KINDS.some(
          (kind) => kind.source === source && kind.connect === connect,
        ),
      ).toBe(true);
});

test("an app already connected that only needs giving is given in one press, for every kind that connects", async () => {
  for (const kind of KINDS.filter(
    (each) => each.listed && each.connect !== null,
  )) {
    const connected = "2026-11-20T09:00:00.000Z";
    const { view, sent, opened } = mounted(
      appAccess({
        key: kind.key,
        displayName: "The app",
        source: kind.source,
        connect: kind.connect,
        account: "personal",
        state: "not_granted",
        granted: false,
        connectedAt: connected,
        requestKind: "grant",
      }),
      undefined,
      {
        admin: true,
        readAgain: () =>
          appAccess({
            key: kind.key,
            source: kind.source,
            connect: kind.connect,
            connectedAt: connected,
          }),
      },
    );
    fireEvent.click(
      await view.findByRole("button", { name: "Give The app to Expenses" }),
    );
    await waitFor(() =>
      expect(
        sent.filter((call) => call.method === "POST").map((call) => call.url),
      ).toEqual([`${botAppPath("expenses", kind.key)}/approve`]),
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(sent.filter((call) => call.method === "POST")).toHaveLength(1);
    expect(opened).toEqual([]);
    cleanup();
  }
});

/*
 * FOUND IN DOGFOODING: Connect on an app nobody had turned on went back to rest once the app was
 * on, and only a few seconds later went on to the sign-in. For those seconds the card looked done.
 * From the press until the sign-in opens, or the key form, the button says it is still working.
 */
test.each([
  { who: "the personal edition's one person", edition: "personal" as const },
  { who: "a team edition admin", edition: "team" as const },
])(
  "$who's Connect keeps saying it is working until the sign-in opens, and until the key form for a key app",
  async ({ edition }) => {
    for (const connect of [null, "key"] as const) {
      const before = appAccess({
        key: "composio-fireflies",
        displayName: "Fireflies",
        source: "directory",
        connect,
        account: "personal",
        accountHolder: "you",
        state: "disabled",
        unavailable: "absent",
        granted: false,
        connectedAt: null,
        requestKind: "enable",
      });
      const afterOn = appAccess({
        ...before,
        connect: connect ?? "consent",
        state: "not_connected",
        unavailable: null,
        granted: true,
        requestKind: null,
      });
      let release: () => void = () => {};
      const readAgainGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const { view, sent, opened } = mounted(before, undefined, {
        ...(edition === "personal" ? { personal: true } : { admin: true }),
        readAgain: () => afterOn,
        readAgainGate,
      });
      const resting =
        edition === "personal"
          ? "Connect Fireflies"
          : "Connect Fireflies and give it to Expenses";
      fireEvent.click(await view.findByRole("button", { name: resting }));
      // Turned on; what is left is still being read.
      await waitFor(() =>
        expect(
          sent.some(
            (call) =>
              call.method === "POST" &&
              call.url ===
                `${botAppPath("expenses", "composio-fireflies")}/approve`,
          ),
        ).toBe(true),
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
      const working = connect === "key" ? "Connecting…" : "Opening sign-in…";
      const button = await view.findByText(working);
      expect(button.closest("button")?.hasAttribute("disabled")).toBe(true);
      expect(view.queryByRole("button", { name: resting })).toBeNull();

      release();
      if (connect === "key")
        expect((await view.findByTestId("app-page")).textContent).toBe(
          "/connections/composio-fireflies?connect=true",
        );
      else
        await waitFor(() =>
          expect(opened).toEqual(["https://gmail.test/consent"]),
        );
      cleanup();
    }
  },
);
