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
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import {
  AppAccessAction,
  appAccessSentence,
} from "@/components/plugins/app-access-action";
import type { AppAccess, AppAccessState } from "@/lib/app-access/queries";
import { appAccess } from "./app-access-fixture";
import { settleReactWork } from "./settle-react-work";

/**
 * The one piece the Bot page and the chat card both draw an app's state with.
 *
 * Each of the six states must say whose move it is and offer exactly that move — and nothing for a
 * state that needs none. The two moves that write are asserted against the request they send: the
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
) {
  const sent: Sent[] = [];
  const opened: string[] = [];
  window.open = (() => {
    const tab = {
      opener: {} as unknown,
      location: { replace: (next: string) => opened.push(next) },
      close: () => {},
    };
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
    if (answer && method !== "GET")
      return Response.json(answer.body, { status: answer.status });
    if (url.endsWith("/connect?returnTo=settings"))
      return Response.json({ authorizationUrl: "https://gmail.test/consent" });
    return Response.json({ request: { id: "req_1" }, created: true });
  }) as unknown as typeof fetch;

  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const root = createRootRoute({ component: Outlet });
  const page = createRoute({
    getParentRoute: () => root,
    path: "/",
    component: () => (
      <div>
        <p>{appAccessSentence(access.state, access.displayName)}</p>
        <AppAccessAction access={access} agentId="expenses" />
      </div>
    ),
  });
  const settings = createRoute({
    getParentRoute: () => root,
    path: "/settings/connected-accounts/$key",
    component: () => null,
  });
  const router = createRouter({
    routeTree: root.addChildren([page, settings]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  const view = render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
  return { view, sent, opened };
}

const COPY: Record<AppAccessState, RegExp> = {
  ready: /^Ready to use\.$/,
  not_connected: /You haven't connected your Gmail account yet\./,
  reconnect: /Your Gmail connection needs reconnecting\./,
  shared_not_connected:
    /Your organisation's Gmail account isn't connected yet\. Only an administrator can connect it\./,
  disabled: /Turned off by an administrator\. Only they can turn Gmail on\./,
  not_granted:
    /This Bot hasn't been given Gmail\. Only an administrator can give it\./,
};

test.each(Object.entries(COPY))(
  "says whose move it is: %s",
  (state, sentence) => {
    expect(appAccessSentence(state as AppAccessState, "Gmail")).toMatch(
      sentence,
    );
  },
);

test("ready offers nothing to press", async () => {
  const { view } = mounted(appAccess());
  await view.findByText("Ready to use.");
  expect(view.queryByRole("button")).toBeNull();
  expect(view.queryByRole("link")).toBeNull();
});

test("not connected offers Connect, which starts the person's own consent in a new tab", async () => {
  const { view, sent, opened } = mounted(appAccess({ state: "not_connected" }));
  fireEvent.click(await view.findByRole("button", { name: "Connect" }));
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
  expect(link?.getAttribute("href")).toBe(
    "/settings/connected-accounts/composio-gmail",
  );
});

test("a Composio app to reconnect goes to Settings, because the connect route refuses a row that stands", async () => {
  const { view } = mounted(appAccess({ state: "reconnect" }));
  const link = (await view.findByText("Reconnect")).closest("a");
  expect(link?.getAttribute("href")).toBe(
    "/settings/connected-accounts/composio-gmail",
  );
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
  fireEvent.click(await view.findByRole("button", { name: "Reconnect" }));
  await waitFor(() => expect(opened).toHaveLength(1));
});

test.each([
  ["disabled", "enable"],
  ["not_granted", "grant"],
  ["shared_not_connected", "connect_shared"],
] as const)(
  "%s offers Request access, naming the Bot and the app and never the kind",
  async (state, kind) => {
    const { view, sent } = mounted(appAccess({ state, requestKind: kind }));
    fireEvent.click(
      await view.findByRole("button", { name: "Request access" }),
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
  expect(view.queryByRole("button", { name: "Request access" })).toBeNull();
  fireEvent.click(view.getByRole("button", { name: "Withdraw" }));
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
  fireEvent.click(await view.findByRole("button", { name: "Request access" }));
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
