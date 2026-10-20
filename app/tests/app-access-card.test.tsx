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
import { cleanup, render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { AppAccessCard } from "@/components/channels/app-access-card";
import { ServerToolLine } from "@/components/channels/chat-transcript";
import type { AppAccess } from "@/lib/app-access/queries";
import { REFUSAL_MARKER } from "@/lib/plugins/tool-result";
import {
  type ConnectPrompt,
  connectAppRefusal,
  SHOW_APP_ACCESS_TOOL,
} from "@openbot/shared/connect-prompt";
import { appAccess } from "./app-access-fixture";
import { settleReactWork } from "./settle-react-work";

/**
 * The card a conversation draws when a Bot could not use an app, for every way that happens: the
 * person has not connected, a Shared app has no team account, the vendor lost the account, and the
 * `show_app_access` tool a Bot calls for an app it holds nothing for (switched off, not granted).
 *
 * The card never draws what the refusal said: it asks the server what the app is for this person
 * on the Bot that refused, and draws that. The one exception is an account the vendor lost, which
 * the server cannot know about — drawn as Reconnect over a live `ready`, until a connection newer
 * than the refusal says it has been put back.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

/** Answers the live read with `live`, and records which Bot and app it was asked about. */
function serving(live: AppAccess | null) {
  const asked: string[] = [];
  global.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    asked.push(url);
    if (url.includes("/apps/"))
      return live
        ? Response.json({ app: live })
        : Response.json({ error: "nope" }, { status: 500 });
    if (url.includes("/api/plugins/connections"))
      return Response.json({ connections: [], redirectUri: null });
    return Response.json({});
  }) as unknown as typeof fetch;
  return asked;
}

function mount(children: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const root = createRootRoute({ component: Outlet });
  const page = createRoute({
    getParentRoute: () => root,
    path: "/",
    component: () => <>{children}</>,
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
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

const prompt = (overrides: Partial<ConnectPrompt> = {}): ConnectPrompt => ({
  serverId: "composio-gmail",
  title: "Gmail",
  message:
    "You have not connected your Gmail account. Connect it and ask again.",
  agentId: "expenses",
  ...overrides,
});

const card = (view: ReturnType<typeof mount>) =>
  waitFor(() => {
    const found = view.container.querySelector("[data-app-access]");
    if (!found?.getAttribute("data-state")) throw new Error("not drawn yet");
    return found as HTMLElement;
  });

test("asks about the app on the Bot that refused, not on another", async () => {
  const asked = serving(appAccess({ state: "not_connected" }));
  mount(<AppAccessCard prompt={prompt()} />);
  await waitFor(() =>
    expect(asked).toContain("/api/plugins/for/expenses/apps/composio-gmail"),
  );
});

test("not connected: names the app and offers Connect", async () => {
  serving(appAccess({ state: "not_connected" }));
  const view = mount(<AppAccessCard prompt={prompt()} />);
  const drawn = await card(view);
  expect(drawn.textContent).toContain("Gmail");
  expect(drawn.textContent).toContain(
    "You haven't connected your Gmail account yet.",
  );
  expect(view.getByRole("button", { name: "Connect" })).toBeTruthy();
});

test("connected since the refusal: says so and offers nothing stale", async () => {
  serving(appAccess({ state: "ready" }));
  const view = mount(<AppAccessCard prompt={prompt()} />);
  const drawn = await card(view);
  expect(drawn.textContent).toContain(
    "Gmail is ready now. Ask again and the Bot can use it.",
  );
  expect(view.queryByRole("button")).toBeNull();
});

test("a Shared app with no team account: Request access, not a sentence", async () => {
  serving(
    appAccess({
      state: "shared_not_connected",
      account: "shared",
      accountMode: "shared",
      requestKind: "connect_shared",
    }),
  );
  const view = mount(
    <AppAccessCard
      prompt={prompt({
        reason: "shared",
        message:
          "Gmail is shared across this deployment and no account is connected to it yet. Ask an administrator to connect it.",
      })}
    />,
  );
  const drawn = await card(view);
  expect(drawn.textContent).toContain(
    "Your organisation's Gmail account isn't connected yet.",
  );
  expect(view.getByRole("button", { name: "Request access" })).toBeTruthy();
});

test("an account the vendor lost: Reconnect, though the server still reads ready", async () => {
  serving(
    appAccess({ state: "ready", connectedAt: "2026-10-01T00:00:00.000Z" }),
  );
  const view = mount(
    <AppAccessCard
      prompt={prompt({ reason: "reconnect", at: "2026-10-20T12:00:00.000Z" })}
    />,
  );
  const drawn = await card(view);
  expect(drawn.getAttribute("data-state")).toBe("reconnect");
  expect(drawn.textContent).toContain(
    "Your Gmail connection needs reconnecting.",
  );
  expect(
    (await view.findByText("Reconnect")).closest("a")?.getAttribute("href"),
  ).toBe("/settings/connected-accounts/composio-gmail");
});

test("an account lost and then connected again: the newer connection wins", async () => {
  serving(
    appAccess({ state: "ready", connectedAt: "2026-10-20T12:05:00.000Z" }),
  );
  const view = mount(
    <AppAccessCard
      prompt={prompt({ reason: "reconnect", at: "2026-10-20T12:00:00.000Z" })}
    />,
  );
  const drawn = await card(view);
  expect(drawn.getAttribute("data-state")).toBe("ready");
  expect(view.queryByText("Reconnect")).toBeNull();
});

test("a team account the vendor lost: says an administrator has to reconnect it, with nothing to press", async () => {
  serving(appAccess({ state: "ready", account: "shared" }));
  const view = mount(<AppAccessCard prompt={prompt({ reason: "shared" })} />);
  const drawn = await card(view);
  expect(drawn.textContent).toContain(
    "Your organisation's Gmail account needs reconnecting. Only an administrator can reconnect it.",
  );
  expect(view.queryByRole("button")).toBeNull();
});

test.each([
  ["disabled", "enable", /Turned off by an administrator/],
  ["not_granted", "grant", /This Bot hasn't been given Gmail/],
] as const)(
  "the Bot asked about an app that is %s: Request access",
  async (state, kind, sentence) => {
    serving(appAccess({ state, requestKind: kind, granted: false }));
    const view = mount(
      <AppAccessCard prompt={prompt({ reason: "access", message: "" })} />,
    );
    const drawn = await card(view);
    expect(drawn.textContent).toMatch(sentence);
    expect(view.getByRole("button", { name: "Request access" })).toBeTruthy();
  },
);

test("asked about an app that is ready, it says so without claiming it was just connected", async () => {
  serving(appAccess());
  const view = mount(<AppAccessCard prompt={prompt({ reason: "access" })} />);
  const drawn = await card(view);
  expect(drawn.textContent).toContain("Ready to use.");
});

/*
 * The fallback to the Bot the surface declared is not asserted here: `bot-route-default-agent`'s
 * fixture replaces `useActiveBot` with a no-op for the whole process, so a declaration made in this
 * file is a no-op whenever bun has loaded that one first.
 */
test("with no Bot to ask about at all, it is the Connect card it always was", async () => {
  const asked = serving(null);
  const view = mount(<AppAccessCard prompt={prompt({ agentId: undefined })} />);
  expect(await view.findByText("Connect Gmail")).toBeTruthy();
  expect(asked.some((url) => url.includes("/apps/"))).toBe(false);
});

test("a live read that fails falls back to the Connect card for a connect refusal", async () => {
  serving(null);
  const view = mount(<AppAccessCard prompt={prompt()} />);
  expect(await view.findByText("Connect Gmail")).toBeTruthy();
});

/*
 * THROUGH THE TRANSCRIPT'S OWN LINE. The card is drawn from a server tool's answer — a refusal, or
 * the `show_app_access` result — by `ServerToolLine`, and only those two are read for a marker.
 * That it is drawn rather than folded into "Used N tools" is `tool-activity.test.tsx`'s.
 */
test("the transcript draws a refusal's card", async () => {
  serving(appAccess({ state: "not_connected" }));
  const view = mount(
    <ServerToolLine
      name="mcp__composio-gmail__GMAIL_FETCH_EMAILS"
      result={`${REFUSAL_MARKER} ${connectAppRefusal(prompt())}`}
    />,
  );
  const drawn = await card(view);
  expect(drawn.getAttribute("data-state")).toBe("not_connected");
});

test("the transcript draws show_app_access's card from its ordinary answer", async () => {
  serving(
    appAccess({ state: "disabled", requestKind: "enable", granted: false }),
  );
  const view = mount(
    <ServerToolLine
      name={SHOW_APP_ACCESS_TOOL}
      result={connectAppRefusal(
        prompt({
          reason: "access",
          message: "Gmail is switched off on this deployment.",
        }),
      )}
    />,
  );
  const drawn = await card(view);
  expect(drawn.getAttribute("data-state")).toBe("disabled");
});

test("an ordinary tool's answer is never read for a card, whatever it starts with", async () => {
  serving(appAccess({ state: "not_connected" }));
  const view = mount(
    <ServerToolLine name="run_command" result={connectAppRefusal(prompt())} />,
  );
  await settleReactWork();
  expect(view.container.querySelector("[data-app-access]")).toBeNull();
});
