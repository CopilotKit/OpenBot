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
import { appAccess } from "./app-access-fixture";
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
 * it. A cached `/api/capabilities` answer never goes stale, and a team one drew the card as the team
 * edition: an admin's "Turn on and give it", never Connect.
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
 * Gmail as `GET /api/plugins/for/:agentId/apps/:app` answers it on OpenBot Personal before anybody
 * turned it on: no row, so no recorded scheme, and switched off because it is absent.
 */
const notTurnedOn = (overrides: Partial<AppAccess> = {}): AppAccess =>
  appAccess({
    state: "disabled",
    unavailable: "absent",
    authScheme: null,
    accountMode: null,
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
    if (url === "/api/capabilities")
      return Response.json({ edition: "personal" });
    if (url === "/api/me")
      return Response.json({
        user: { id: "usr_me", role: "admin", name: "Me" },
      });
    if (url === "/api/agents/assistant")
      return Response.json({
        agent: { id: "assistant", name: "Personal Assistant" },
      });
    if (url === "/api/plugins/for/assistant/apps/composio-gmail")
      return Response.json({ app: live });
    if (url === "/api/plugins/for/assistant/apps/composio-gmail/approve") {
      live = turnedOn;
      return Response.json({
        request: {
          id: "req_1",
          kind: "enable",
          appKey: "composio-gmail",
          status: "approved",
        },
        enabled: true,
        granted: ["composio-gmail/GMAIL_FETCH_EMAILS"],
      });
    }
    if (
      url === "/api/plugins/servers/composio-gmail/connect?returnTo=settings"
    ) {
      await signIn;
      return Response.json({ authorizationUrl: CONSENT });
    }
    if (url.startsWith("/api/plugins/connections"))
      return Response.json({ connections: [], redirectUri: null });
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
    "Turn on",
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
      "POST /api/plugins/for/assistant/apps/composio-gmail/approve",
      "POST /api/plugins/servers/composio-gmail/connect?returnTo=settings",
    ]);
    // And it says what it is doing while the person signs in.
    await view.findByText("Finish in the tab that opened.");
    expect(
      view.getByRole("button", { name: "Waiting for Gmail…" }),
    ).toBeTruthy();
  },
);
