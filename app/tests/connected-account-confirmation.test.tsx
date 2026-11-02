import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
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
import { cleanup, render } from "@testing-library/react";
import {
  brokeredDisconnectNote,
  brokeredKeyMissing,
  disconnectSiblingsNotice,
} from "@/lib/plugins/provider-vocabulary";
import type { PluginServer, PluginsPage } from "@/lib/plugins/queries";
import {
  Route as ConnectedAccountRoute,
  landedActionFrom,
} from "@/routes/_authed/_app/connections.$key";

/**
 * The page a person reads before deciding to grant or end access to a mailbox, on each broker.
 *
 * Three things are pinned, and the first two are RENDERED markup because a sentence computed and
 * never drawn is not shipped: the sibling list names what a Disconnect would also end and draws
 * NOTHING when there is none; an Arcade deployment's page never says Composio, in text or in
 * attributes; and a person's own page names no broker on either deployment, because the broker is
 * an internal a person cannot act on (see the openbot-copy skill). Where a vendor name is shown,
 * on the admin pages, it comes from the provider vocabulary. The fourth is the landing parameter
 * the verifier's redirect carries.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(async () => {
  // Let React's scheduler drain before the DOM globals it reads go away.
  await new Promise((resolve) => setTimeout(resolve, 50));
  await GlobalRegistrator.unregister();
});

const APP = "gmail";

function captureRouteState(route: object): Record<string, unknown> {
  return { ...route, options: { ...(route as { options: object }).options } };
}
function restoreRouteState(
  route: object,
  snapshot: Record<string, unknown>,
): void {
  for (const key of Object.keys(route)) {
    if (!(key in snapshot)) {
      delete (route as Record<string, unknown>)[key];
    }
  }
  Object.assign(route, snapshot);
}
const pristine = captureRouteState(ConnectedAccountRoute);
let snapshot: Record<string, unknown>;
beforeEach(() => {
  snapshot = captureRouteState(pristine);
});
afterEach(() => {
  restoreRouteState(ConnectedAccountRoute, snapshot);
});

type Provider = "composio" | "arcade";

function server(provider: Provider): PluginServer {
  return {
    authScheme: "OAUTH2",
    id: APP,
    title: "Gmail",
    vendor: "Google",
    url: provider === "arcade" ? "arcade://gmail" : "https://example.invalid",
    summary: "Mail.",
    docsUrl: "",
    provenance: provider,
    hasCredential: false,
    toolsRefreshedAt: null,
    lastError: null,
    addedBy: null,
    dynamicClient: false,
    accountMode: null,
    sharedVendorConnected: false,
    ownerGrants: "any",
    ownerGrantsChosen: null,
    tools: [],
    withdrawn: [],
  };
}

type Setup = {
  provider: Provider;
  connected: boolean;
  configured?: boolean;
  siblings?: { siblings: string[]; unanswered: number };
  /** Whether the siblings read answers 500. */
  siblingsFail?: boolean;
  /**
   * Whether the deployment's broker authorizes per action, the capability the grant list is gated
   * on. Defaults to what the named provider's broker declares today, so a case that says nothing
   * about it gets the deployment it has always meant; set it against the name to build the
   * deployment where the two DISAGREE.
   */
  authorizesPerAction?: boolean;
};

const siblingReads: string[] = [];

function install(setup: Setup) {
  siblingReads.length = 0;
  const page: PluginsPage = {
    catalogue: [],
    servers: [server(setup.provider)],
    skills: [],
    botsMayCallBack: true,
    redirectUri: null,
    composioConfigured: setup.configured ?? true,
    authorizesPerAction:
      setup.authorizesPerAction ?? setup.provider === "arcade",
    provider: setup.provider,
  };
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      headers: { "content-type": "application/json" },
      status,
    });
  global.fetch = (async (input: RequestInfo | URL) => {
    const path = String(input).split("?")[0] ?? "";
    if (path === "/api/plugins") return json(page);
    if (path.startsWith("/api/plugins/connections")) {
      return json({
        connections: setup.connected
          ? [
              {
                serverId: APP,
                scope: "",
                connectedAt: "2026-09-10T00:00:00.000Z",
                verified: true,
                verifiedAt: null,
                checkable: false,
              },
            ]
          : [],
        redirectUri: null,
      });
    }
    if (path.endsWith("/connection/siblings")) {
      siblingReads.push(path);
      if (setup.siblingsFail) return json({ error: "no" }, 500);
      return json(setup.siblings ?? { siblings: [], unanswered: 0 });
    }
    if (path.endsWith("/connection/confirm"))
      return json({ connected: setup.connected });
    return json({ error: "unexpected" }, 404);
  }) as typeof fetch;
}

function renderScreen(search = "") {
  const rootRoute = createRootRoute({ component: Outlet });
  const authedRoute = createRoute({
    id: "/_authed",
    getParentRoute: () => rootRoute,
    component: Outlet,
  });
  const appRoute = createRoute({
    id: "/_app",
    getParentRoute: () => authedRoute,
    component: Outlet,
  });
  const indexRoute = createRoute({
    path: "/connections/",
    getParentRoute: () => appRoute,
    component: () => null,
  });
  const wired = (
    ConnectedAccountRoute as unknown as {
      update: (options: unknown) => typeof ConnectedAccountRoute;
    }
  ).update({
    id: "/connections/$key",
    path: "/connections/$key",
    getParentRoute: () => appRoute,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      authedRoute.addChildren([appRoute.addChildren([indexRoute, wired])]),
    ]),
    history: createMemoryHistory({
      initialEntries: [`/connections/${APP}${search}`],
    }),
  });
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

/** Every string the page puts in front of anyone: its text AND its markup, attributes included. */
function everythingRendered(view: ReturnType<typeof render>): string {
  return `${view.container.textContent ?? ""}\n${view.container.innerHTML}`;
}

const PAGE = "Bots use this as you, and see only what you can see.";
const CONNECTED =
  "Signed in with Gmail. Bots you allow use your Gmail as you. Disconnecting removes their access everywhere.";
const DISCONNECTED =
  "No Bot can use this as you. Connecting takes you to Gmail to approve access.";

// ---- 1 and 2: the sibling list, rendered ----

test("a connected app with siblings NAMES each of them in the confirmation", async () => {
  install({
    provider: "arcade",
    connected: true,
    siblings: { siblings: ["googlecalendar", "googledocs"], unanswered: 0 },
  });
  const view = renderScreen();
  await view.findByText(/googlecalendar/);
  const text = view.container.textContent ?? "";
  expect(text).toContain("googlecalendar");
  expect(text).toContain("googledocs");
  expect(text).toContain(
    "Disconnecting also ends your access to googlecalendar and googledocs, which share this connection.",
  );
  expect(text).not.toContain("gmail,");
});

test("with no siblings NO sibling copy appears at all, not an empty block", async () => {
  install({
    provider: "arcade",
    connected: true,
    siblings: { siblings: [], unanswered: 0 },
  });
  const view = renderScreen();
  await view.findByText("Disconnect");
  // The read has happened, and answered empty.
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(siblingReads.length).toBeGreaterThan(0);
  const text = view.container.textContent ?? "";
  expect(text).not.toContain("also ends");
  expect(text).not.toContain("couldn't be checked");
  expect(text).not.toContain("share this connection");
  // No second description under the row's own: the notice slot is not drawn.
  const descriptions = view.container.querySelectorAll(
    '[data-slot="item-description"]',
  );
  expect(descriptions.length).toBe(1);
});

test("a Composio deployment always answers empty, so it draws no sibling copy either", async () => {
  install({ provider: "composio", connected: true });
  const view = renderScreen();
  await view.findByText("Disconnect");
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(view.container.textContent).not.toContain("also ends");
});

test("apps that could not be asked about are a count and never names", () => {
  expect(disconnectSiblingsNotice({ siblings: [], unanswered: 0 })).toBeNull();
  expect(disconnectSiblingsNotice({ siblings: ["slack"], unanswered: 2 })).toBe(
    "Disconnecting also ends your access to slack, which shares this connection. 2 other apps couldn't be checked and may be affected too.",
  );
  expect(disconnectSiblingsNotice({ siblings: [], unanswered: 1 })).toBe(
    "1 app on this connection couldn't be checked, so disconnecting may end it too.",
  );
});

test("the sibling list is not drawn once there is no account for a Disconnect to end", async () => {
  install({
    provider: "arcade",
    connected: false,
    siblings: { siblings: ["googledocs"], unanswered: 0 },
  });
  const view = renderScreen();
  /*
   * WAITED ON AS A RENDER SIGNAL AND NOT AS THE SUBJECT: this case is about the sibling list and
   * the read behind it. It used to wait on "Connect", which this deployment no longer draws —
   * Arcade authorizes per action, so the row withholds a whole-app Connect that could only reach
   * the adapter's refusal. The row's disconnected state is what is being waited for either way.
   */
  await view.findByText("Approved per action");
  expect(view.container.textContent).not.toContain("googledocs");
  expect(siblingReads.length).toBe(0);
});

// ---- 3: Arcade never says Composio ----

for (const connected of [true, false]) {
  for (const configured of [true, false]) {
    test(`on an Arcade deployment NO rendered string says Composio (connected=${connected}, configured=${configured})`, async () => {
      install({
        provider: "arcade",
        connected,
        configured,
        siblings: { siblings: ["googledocs"], unanswered: 1 },
      });
      const view = renderScreen("?action=Gmail.ListEmails");
      await view.findByText("You just authorized Gmail.ListEmails.");
      if (connected && configured) await view.findByText(/googledocs/);
      const rendered = everythingRendered(view);
      expect(rendered).not.toMatch(/composio/i);
      if (!configured) expect(rendered).toContain("ARCADE_API_KEY");
    });
  }
}

test("where a screen does name the broker, the vocabulary names the active one", () => {
  expect(brokeredDisconnectNote("arcade")).toBe(
    "Disconnecting also ends the account at Arcade.",
  );
  expect(brokeredDisconnectNote("composio")).toBe(
    "Disconnecting also ends the account at Composio.",
  );
  expect(brokeredKeyMissing("arcade")).toBe(
    "Set ARCADE_API_KEY on this deployment. Until then, this account can't be connected or disconnected here. The app stays turned on, and its tool grants still stand.",
  );
  expect(brokeredKeyMissing("composio")).toBe(
    "Set COMPOSIO_API_KEY on this deployment. Until then, this account can't be connected or disconnected here. The app stays turned on, and its tool grants still stand.",
  );
});

// ---- 4: a person's own page names no broker ----

for (const provider of ["composio", "arcade"] as const) {
  test(`a connected page on ${provider} says what Bots do, and names no broker`, async () => {
    install({ provider, connected: true });
    const view = renderScreen();
    await view.findByText("Disconnect");
    const rendered = everythingRendered(view);
    expect(rendered).toContain(PAGE);
    expect(rendered).not.toMatch(/composio|arcade/i);
  });
}

test("a connected Composio page renders its sentences verbatim", async () => {
  install({ provider: "composio", connected: true });
  const view = renderScreen();
  await view.findByText(/Disconnecting removes their access/);
  const text = view.container.textContent ?? "";
  expect(text).toContain(PAGE);
  expect(text).toContain(CONNECTED);
});

test("a disconnected Composio page renders its sentences verbatim", async () => {
  install({ provider: "composio", connected: false });
  const view = renderScreen();
  await view.findByText(/Connecting takes you to/);
  const text = view.container.textContent ?? "";
  expect(text).toContain(PAGE);
  expect(text).toContain(DISCONNECTED);
});

test("a disconnected Arcade page points at the action list, not at a Connect it does not draw", async () => {
  install({ provider: "arcade", connected: false });
  const view = renderScreen();
  await view.findByText("Approved per action");
  expect(view.container.textContent).toContain(
    "No Bot can use this as you. Authorize the actions you want below.",
  );
});

// ---- 5: the landing parameter ----

test("a redirect carrying an action marks that action", async () => {
  install({ provider: "arcade", connected: true });
  const view = renderScreen("?action=Gmail.ListEmails");
  const marked = await view.findByRole("status");
  expect(marked.textContent).toBe("You just authorized Gmail.ListEmails.");
  expect(marked.getAttribute("data-landed-action")).toBe("Gmail.ListEmails");
});

test("a landing without an action behaves as it did", async () => {
  install({ provider: "arcade", connected: true });
  const view = renderScreen();
  await view.findByText("Disconnect");
  expect(view.queryByRole("status")).toBeNull();
  expect(view.container.textContent).not.toContain("just authorized");
});

test("validateSearch omits the key when absent and reads the action as text", () => {
  const validate = (
    ConnectedAccountRoute as unknown as {
      options: { validateSearch: (s: Record<string, unknown>) => object };
    }
  ).options.validateSearch;
  expect(validate({})).toEqual({});
  expect("action" in validate({})).toBe(false);
  expect(validate({ action: "Gmail.ListEmails" })).toEqual({
    action: "Gmail.ListEmails",
  });
  /*
   * The router JSON-parses search values, so an action name made of digits arrives as a number and
   * a JSON-shaped one as an object. Both are still what the verifier put in the URL: the key is
   * read as text (`searchText`) rather than dropped for having parsed into something else.
   */
  expect(validate({ action: 5 })).toEqual({ action: "5" });
  expect(validate({ action: { a: 1 } })).toEqual({ action: '{"a":1}' });
});

test("an empty or absurdly long action is not drawn", () => {
  expect(landedActionFrom(undefined)).toBeNull();
  expect(landedActionFrom("   ")).toBeNull();
  expect(landedActionFrom("x".repeat(201))).toBeNull();
  expect(landedActionFrom(" Gmail.ListEmails ")).toBe("Gmail.ListEmails");
});
