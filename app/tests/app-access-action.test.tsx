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
import type { AppAccess } from "@/lib/app-access/queries";
import { appAccess } from "./app-access-fixture";
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
  options: { admin?: boolean } = {},
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
    if (options.admin && url === "/api/me")
      return Response.json({ user: { id: "usr_admin", role: "admin" } });
    if (options.admin && url === "/api/agents/expenses")
      return Response.json({ agent: { id: "expenses", name: "Expenses" } });
    if (answer && method !== "GET")
      return Response.json(answer.body, { status: answer.status });
    if (url.endsWith("/connect?returnTo=settings"))
      return Response.json({ authorizationUrl: "https://gmail.test/consent" });
    return Response.json({ request: { id: "req_1" }, created: true });
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
    component: () => null,
  });
  const admin = createRoute({
    getParentRoute: () => root,
    path: "/admin/plugins/$key",
    component: () => null,
  });
  const router = createRouter({
    routeTree: root.addChildren([page, settings, admin]),
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
    "disabled, with no Composio key",
    { state: "disabled", unavailable: "composio_unconfigured" },
    /^Gmail isn't set up yet\. An admin has to turn it on\.$/,
  ],
  ...(
    ["scheme_unreadable", "oauth_client_missing", "token_missing"] as const
  ).map((unavailable): [string, Partial<AppAccess>, RegExp] => [
    `disabled, ${unavailable}`,
    { state: "disabled", unavailable },
    /^Gmail isn't fully set up yet\. Only an admin can finish setting it up\.$/,
  ]),
  [
    "not_granted",
    { state: "not_granted" },
    /This Bot hasn't been given Gmail\. Only an admin can give it\./,
  ],
];

test.each(COPY)("says whose move it is: %s", (_, overrides, sentence) => {
  expect(appAccessSentence(appAccess(overrides))).toMatch(sentence);
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
    "POST /api/plugins/servers/composio-gmail/connect?returnTo=settings",
  );
  await view.findByText("Finish in the tab that opened.");
});

test("an app connected with a typed key goes to its page in Settings, where the form is", async () => {
  const { view } = mounted(
    appAccess({ state: "not_connected", connect: "key" }),
  );
  // Drawn as a button (`Button` over a `Link`), and an anchor underneath with the address.
  const link = (await view.findByText("Connect")).closest("a");
  expect(link?.getAttribute("href")).toBe("/connections/composio-gmail");
});

test("a Composio app to reconnect goes to Settings, because the connect route refuses a row that stands", async () => {
  const { view } = mounted(appAccess({ state: "reconnect" }));
  const link = (await view.findByText("Reconnect")).closest("a");
  expect(link?.getAttribute("href")).toBe("/connections/composio-gmail");
});

test("this deployment's own OAuth app reconnects in place, with a fresh consent", async () => {
  const { view, opened } = mounted(
    appAccess({
      key: "notion",
      displayName: "Notion",
      provider: "catalogue",
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
      accountMode: "shared",
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
        url: "/api/plugins/access-requests",
        body: { agentId: "expenses", app: "composio-gmail" },
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
          call.url === "/api/plugins/access-requests/req_9",
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
    "Turn on and give it to Expenses",
    "Turn on Gmail and give it to Expenses",
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
        url: "/api/plugins/for/expenses/apps/composio-gmail/approve",
        body: undefined,
      }),
    );
  },
);

test("an admin's press that cannot be carried out says what is missing", async () => {
  const { view } = mounted(
    appAccess({ state: "not_granted", requestKind: "grant" }),
    { status: 409, body: { error: "Gmail has no tools to give yet." } },
    { admin: true },
  );
  fireEvent.click(
    await view.findByRole("button", { name: "Give Gmail to Expenses" }),
  );
  expect((await view.findByRole("alert")).textContent).toBe(
    "Gmail has no tools to give yet.",
  );
});

test.each([
  [
    { state: "shared_not_connected", requestKind: "connect_shared" },
    "Connect the team Gmail account",
    "/admin/plugins/composio-gmail",
  ],
  [
    { state: "disabled", unavailable: "token_missing", requestKind: "enable" },
    "Set up Gmail",
    "/admin/plugins/composio-gmail",
  ],
  [
    {
      state: "disabled",
      unavailable: "composio_unconfigured",
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
        url: "/api/plugins/for/expenses/apps/composio-gmail/give",
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
