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
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { consentCopy } from "@/lib/plugins/enablement-notes";
import type { GrantState } from "@/lib/plugins/grants";
import type { PluginServer, PluginsPage } from "@/lib/plugins/queries";
import { Route as ConnectedAccountRoute } from "@/routes/_authed/_app/connections.$key";

/**
 * THE GRANT LIST on an app's own page, drawn by `GrantState`, grouped by permission, with the consent
 * copy rendered before any redirect.
 *
 * Every assertion is on RENDERED markup: a sentence computed and never drawn is not shipped.
 */
/**
 * (harness below is shared in shape with connected-account-confirmation.test.tsx)
 *
 * Three things are pinned, and the first two are RENDERED markup because a sentence computed and
 * never drawn is not shipped: the sibling list names what a Disconnect would also end and draws
 * NOTHING when there is none; an Arcade deployment's page never says Composio, in text or in
 * attributes; and a Composio deployment's three vendor sentences are character-for-character what
 * they were. The fourth is the landing parameter the verifier's redirect carries.
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

function server(
  provider: Provider,
  accountMode: "shared" | null = null,
): PluginServer {
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
    accountMode,
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
  grants?: GrantState[];
  /** Whether the grants read answers 500. */
  accountMode?: "shared" | null;
  role?: "admin" | "user";
};

const authorizeCalls: string[] = [];

const siblingReads: string[] = [];

function install(setup: Setup) {
  siblingReads.length = 0;
  const page: PluginsPage = {
    catalogue: [],
    servers: [server(setup.provider, setup.accountMode ?? null)],
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
  authorizeCalls.length = 0;
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input).split("?")[0] ?? "";
    if (path.endsWith("/grants")) return json({ actions: setup.grants ?? [] });
    if (path.endsWith("/authorize")) {
      authorizeCalls.push(String(init?.body));
      return json({ authorizationUrl: "https://vendor.invalid/consent" });
    }
    if (path === "/api/me")
      return json({
        user: { id: "u", role: setup.role ?? "user", email: "u@x.io" },
      });
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

const GMAIL: GrantState[] = [
  {
    action: "Gmail.ListEmails",
    state: "authorized",
    scopes: ["gmail.readonly"],
    authorization: "held",
  },
  {
    action: "Gmail.ListThreads",
    state: "authorized",
    scopes: ["gmail.readonly"],
    authorization: "held",
  },
  { action: "Gmail.SendEmail", state: "needs-consent", scopes: ["gmail.send"] },
  {
    action: "Gmail.Setup",
    state: "needs-operator",
    missing: ["GOOGLE_CLIENT_SECRET"],
  },
  { action: "Gmail.Flaky", state: "unknown", reason: "Try again in a moment." },
];

function row(view: ReturnType<typeof render>, action: string): HTMLElement {
  const found = view.container.querySelector<HTMLElement>(
    `[data-action="${action}"]`,
  );
  if (!found) throw new Error(`no row for ${action}`);
  return found;
}

// ---- 0: reachable without typing anything ----

test("with no search term, Authorize for an unauthorized action is already on screen", async () => {
  install({ provider: "arcade", connected: true, grants: GMAIL });
  const view = renderScreen();
  // Nothing is typed: this is the first visit, and the affordance must be here anyway.
  await waitFor(() => row(view, "Gmail.SendEmail"));
  expect(
    [...row(view, "Gmail.SendEmail").querySelectorAll("button")].map(
      (b) => b.textContent,
    ),
  ).toEqual(["Authorize"]);
  expect(view.getByLabelText("Search actions")).toHaveProperty("value", "");
});

// ---- 1: each action renders by its GrantState ----

test("Authorize appears for needs-consent and for nothing else", async () => {
  install({ provider: "arcade", connected: true, grants: GMAIL });
  const view = renderScreen();
  await waitFor(() => row(view, "Gmail.SendEmail"));
  const buttons = (action: string) =>
    [...row(view, action).querySelectorAll("button")].map((b) => b.textContent);
  expect(buttons("Gmail.SendEmail")).toEqual(["Authorize"]);
  expect(buttons("Gmail.ListEmails")).toEqual([]);
  expect(buttons("Gmail.Setup")).toEqual([]);
  expect(buttons("Gmail.Flaky")).not.toContain("Authorize");
});

test("needs-operator names the missing secret, says an admin has to set it, and offers no Authorize", async () => {
  install({
    provider: "arcade",
    connected: true,
    grants: [
      {
        action: "Gmail.Setup",
        state: "needs-operator",
        missing: ["GOOGLE_CLIENT_SECRET"],
      },
    ],
  });
  const view = renderScreen();
  await waitFor(() => row(view, "Gmail.Setup"));
  const text = row(view, "Gmail.Setup").textContent ?? "";
  expect(text).toContain("GOOGLE_CLIENT_SECRET");
  expect(text).toContain("An admin has to set it");
  expect(row(view, "Gmail.Setup").querySelector("button")).toBeNull();
  expect(view.queryByText("Authorize")).toBeNull();
});

test("unknown offers Retry and never a speculative Authorize", async () => {
  install({
    provider: "arcade",
    connected: true,
    grants: [
      {
        action: "Gmail.Flaky",
        state: "unknown",
        reason: "Try again in a moment.",
      },
      {
        action: "Gmail.ListEmails",
        state: "authorized",
        scopes: ["gmail.readonly"],
        authorization: "held",
      },
    ],
  });
  const view = renderScreen();
  await waitFor(() => row(view, "Gmail.Flaky"));
  const labels = [...row(view, "Gmail.Flaky").querySelectorAll("button")].map(
    (b) => b.textContent,
  );
  expect(labels).toEqual(["Retry"]);
  expect(view.queryByText("Authorize")).toBeNull();
});

test("the route's synthetic toolkit-named unknown reads as could not read and never as an action", async () => {
  install({
    provider: "arcade",
    connected: true,
    grants: [
      {
        action: "Gmail",
        state: "unknown",
        reason:
          "Couldn't read what this account allows right now. Try again in a moment.",
      },
    ],
  });
  const view = renderScreen();
  const notice = await view.findByRole("status");
  expect(notice.textContent?.toLowerCase()).toContain("couldn't read");
  expect(view.container.querySelector("[data-action]")).toBeNull();
  expect(view.container.querySelector('[data-action="Gmail"]')).toBeNull();
  expect(
    [...view.container.querySelectorAll("button")].map((b) => b.textContent),
  ).toContain("Retry");
});

// ---- 2: grouped by permission ----

test("actions are grouped by the permission they require", async () => {
  install({ provider: "arcade", connected: true, grants: GMAIL });
  const view = renderScreen();
  await waitFor(() => row(view, "Gmail.SendEmail"));
  const group = (scope: string) =>
    view.container.querySelector<HTMLElement>(`[data-grant-group="${scope}"]`);
  const readonly = group("gmail.readonly");
  expect(
    readonly?.querySelector('[data-action="Gmail.ListEmails"]'),
  ).not.toBeNull();
  expect(
    readonly?.querySelector('[data-action="Gmail.ListThreads"]'),
  ).not.toBeNull();
  expect(readonly?.querySelector('[data-action="Gmail.SendEmail"]')).toBeNull();
  expect(
    group("gmail.send")?.querySelector('[data-action="Gmail.SendEmail"]'),
  ).not.toBeNull();
});

test("an all-or-nothing app renders as ONE group containing everything", async () => {
  install({
    provider: "arcade",
    connected: true,
    grants: [
      {
        action: "Github.A",
        state: "authorized",
        scopes: [],
        authorization: "held",
      },
      { action: "Github.B", state: "needs-consent", scopes: [] },
      {
        action: "Github.C",
        state: "authorized",
        scopes: [],
        authorization: "held",
      },
    ],
  });
  const view = renderScreen();
  await waitFor(() => row(view, "Github.B"));
  const groups = view.container.querySelectorAll("[data-grant-group]");
  expect(groups.length).toBe(1);
  expect(groups[0]?.querySelectorAll("[data-action]").length).toBe(3);
  expect(groups[0]?.getAttribute("data-grant-group")).toBe("whole-app");
});

// ---- 3: ordering ----

test("authorized actions are listed first, and the unauthorized ones follow with nothing typed", async () => {
  install({
    provider: "arcade",
    connected: true,
    grants: [
      { action: "Github.B", state: "needs-consent", scopes: [] },
      {
        action: "Github.C",
        state: "authorized",
        scopes: [],
        authorization: "held",
      },
      {
        action: "Github.A",
        state: "authorized",
        scopes: [],
        authorization: "held",
      },
      { action: "Github.D", state: "unknown", reason: "Try again." },
    ],
  });
  const view = renderScreen();
  await waitFor(() => row(view, "Github.B"));
  expect(
    [...view.container.querySelectorAll("[data-action]")].map((element) =>
      element.getAttribute("data-action"),
    ),
  ).toEqual(["Github.A", "Github.C", "Github.B", "Github.D"]);
  expect(view.container.textContent).not.toContain(
    "more actions not yet authorized",
  );
});

test("past the first ten unauthorized actions the rest wait behind the search", async () => {
  const many: GrantState[] = [
    {
      action: "Gmail.ListEmails",
      state: "authorized",
      scopes: ["gmail.readonly"],
      authorization: "held",
    },
    ...Array.from({ length: 12 }, (_, index): GrantState => {
      const name = String.fromCharCode(97 + index);
      return {
        action: `Gmail.Send${name}`,
        state: "needs-consent",
        scopes: ["gmail.send"],
      };
    }),
  ];
  install({ provider: "arcade", connected: true, grants: many });
  const view = renderScreen();
  await view.findByText(/more actions not yet authorized/);
  expect(row(view, "Gmail.ListEmails")).toBeTruthy();
  expect(row(view, "Gmail.Senda")).toBeTruthy();
  expect(row(view, "Gmail.Sendj")).toBeTruthy();
  expect(
    view.container.querySelector('[data-action="Gmail.Sendk"]'),
  ).toBeNull();
  expect(
    view.container.querySelector('[data-action="Gmail.Sendl"]'),
  ).toBeNull();
  expect(view.container.textContent).toContain(
    "2 more actions not yet authorized",
  );
  // The search still narrows to exactly what matches, and reaches the tail.
  await userEvent.type(view.getByLabelText("Search actions"), "sendk");
  await waitFor(() => row(view, "Gmail.Sendk"));
  expect(
    view.container.querySelector('[data-action="Gmail.ListEmails"]'),
  ).toBeNull();
  expect(
    view.container.querySelector('[data-action="Gmail.Senda"]'),
  ).toBeNull();
});

test("with mixed unauthorized states past ten, the ten drawn are in state order: every consentable action first", async () => {
  // Names sort the OTHER way round to the state ranking (unknown < operator < consent by name), so
  // any reordering of the single RANK table changes which ten are drawn.
  const mixed: GrantState[] = [
    ...Array.from(
      { length: 4 },
      (_, index): GrantState => ({
        action: `Gmail.A${index}`,
        state: "unknown",
        reason: "Try again.",
      }),
    ),
    ...Array.from(
      { length: 3 },
      (_, index): GrantState => ({
        action: `Gmail.B${index}`,
        state: "needs-operator",
        missing: ["GOOGLE_CLIENT_SECRET"],
      }),
    ),
    ...Array.from(
      { length: 6 },
      (_, index): GrantState => ({
        action: `Gmail.C${index}`,
        state: "needs-consent",
        scopes: ["gmail.send"],
      }),
    ),
  ];
  install({ provider: "arcade", connected: true, grants: mixed });
  const view = renderScreen();
  await view.findByText(/more actions not yet authorized/);
  const drawn = [...view.container.querySelectorAll("[data-action]")]
    .map((element) => element.getAttribute("data-action"))
    .sort();
  expect(drawn).toEqual([
    "Gmail.A0",
    "Gmail.B0",
    "Gmail.B1",
    "Gmail.B2",
    "Gmail.C0",
    "Gmail.C1",
    "Gmail.C2",
    "Gmail.C3",
    "Gmail.C4",
    "Gmail.C5",
  ]);
  expect(view.container.textContent).toContain(
    "3 more actions not yet authorized",
  );
});

// ---- 4: Shared ----

test("a Shared app shows state to a member but Authorize only to an administrator", async () => {
  install({
    provider: "arcade",
    connected: false,
    accountMode: "shared",
    role: "user",
    grants: GMAIL,
  });
  const member = renderScreen();
  await waitFor(() => row(member, "Gmail.SendEmail"));
  expect(row(member, "Gmail.ListEmails").textContent).toContain("Authorized");
  expect(member.queryByText("Authorize")).toBeNull();
  cleanup();

  install({
    provider: "arcade",
    connected: false,
    accountMode: "shared",
    role: "admin",
    grants: GMAIL,
  });
  const admin = renderScreen();
  await waitFor(() => row(admin, "Gmail.SendEmail"));
  await waitFor(() => expect(admin.queryByText("Authorize")).not.toBeNull());
});

/*
 * THE SHARED APP'S LANDING, which is where a deployment-held consent now comes back to.
 *
 * The verifier used to send this holder to `/admin/plugins/:key`, a route with no `validateSearch`
 * for `action`, no notice and no grant list — so the one flow whose Authorize is admin-only
 * finished a consent at the vendor and landed on a screen that named nothing. Asserted on RENDERED
 * markup for that reason: the destination mattering is exactly the claim.
 */
test("a Shared app landing from a consent names the action and marks its row", async () => {
  install({
    provider: "arcade",
    connected: false,
    accountMode: "shared",
    role: "admin",
    grants: GMAIL,
  });
  const view = renderScreen("?action=Gmail.ListEmails");

  const notice = await view.findByRole("status");
  expect(notice.textContent).toBe("You just authorized Gmail.ListEmails.");
  expect(notice.getAttribute("data-landed-action")).toBe("Gmail.ListEmails");

  // And the row itself is the marked one, with no search typed to find it by.
  await waitFor(() => row(view, "Gmail.ListEmails"));
  expect(row(view, "Gmail.ListEmails").hasAttribute("data-landed")).toBe(true);
  expect(row(view, "Gmail.SendEmail").hasAttribute("data-landed")).toBe(false);
  // The Shared branch is the one drawing this, not the personal-account branch.
  expect(view.container.textContent).toContain("Team account");
});

test("a Shared app reached without an action says nothing about authorizing", async () => {
  install({
    provider: "arcade",
    connected: false,
    accountMode: "shared",
    role: "admin",
    grants: GMAIL,
  });
  const view = renderScreen();
  await waitFor(() => row(view, "Gmail.ListEmails"));
  expect(view.queryByRole("status")).toBeNull();
  expect(view.container.textContent).not.toContain("just authorized");
});

// ---- Part B: the consent copy is RENDERED before the redirect ----

test("pressing Authorize renders consentCopy's sentence and redirects nowhere yet", async () => {
  install({ provider: "arcade", connected: true, grants: GMAIL });
  const view = renderScreen();
  await waitFor(() => row(view, "Gmail.SendEmail"));
  fireEvent.click(view.getByText("Authorize"));
  const expected = consentCopy("Gmail.SendEmail", [
    { name: "Gmail.ListEmails", scopes: ["gmail.readonly"] },
    { name: "Gmail.ListThreads", scopes: ["gmail.readonly"] },
    { name: "Gmail.SendEmail", scopes: ["gmail.send"] },
  ]).sentence;
  const panel = await view.findByRole("group", {
    name: /Before you authorize/,
  });
  expect(panel.textContent).toContain(expected);
  expect(panel.textContent).toContain(
    "Approving Gmail.SendEmail asks the provider for the permission gmail.send.",
  );
  // Nothing was minted by merely looking at the copy.
  expect(authorizeCalls).toEqual([]);
  fireEvent.click(view.getByText("Continue to consent"));
  await waitFor(() =>
    expect(authorizeCalls).toEqual([
      JSON.stringify({ action: "Gmail.SendEmail" }),
    ]),
  );
});

test("on screen, the N an approval approves leaves out every action that needs no authorization", async () => {
  // An all-unscoped app where two actions wait on the approval, one is held, and three need none.
  const grants: GrantState[] = [
    { action: "Tk.A", state: "needs-consent", scopes: [] },
    { action: "Tk.B", state: "needs-consent", scopes: [] },
    { action: "Tk.C", state: "authorized", scopes: [], authorization: "held" },
    ...["Tk.X", "Tk.Y", "Tk.Z"].map(
      (action): GrantState => ({
        action,
        state: "authorized",
        scopes: [],
        authorization: "not-required",
      }),
    ),
  ];
  const covered = grants.filter(
    (grant) =>
      grant.state === "needs-consent" ||
      (grant.state === "authorized" && grant.authorization === "held"),
  ).length;
  // The fixture only discriminates if counting everything would give a different number.
  expect(covered).not.toBe(grants.length);
  install({ provider: "arcade", connected: true, grants });
  const view = renderScreen();
  await waitFor(() => row(view, "Tk.A"));
  fireEvent.click(row(view, "Tk.A").querySelector("button") as HTMLElement);
  const panel = await view.findByRole("group", {
    name: /Before you authorize/,
  });
  expect(panel.textContent).toContain(
    `approving this approves all ${covered}.`,
  );
  expect(row(view, "Tk.X").textContent).toContain("Needs no authorization.");
  const together = view.container.querySelector(
    '[data-grant-group="whole-app"]',
  );
  expect(together?.querySelectorAll("[data-action]").length).toBe(covered);
});

test("the consent copy never promises that only the named action becomes usable", async () => {
  install({
    provider: "arcade",
    connected: true,
    grants: [
      {
        action: "Github.CountStargazers",
        state: "needs-consent",
        scopes: ["repo"],
      },
      {
        action: "Github.CreateIssue",
        state: "needs-consent",
        scopes: ["repo"],
      },
    ],
  });
  const view = renderScreen();
  await userEvent.type(await view.findByLabelText("Search actions"), "Github.");
  await waitFor(() => row(view, "Github.CountStargazers"));
  fireEvent.click(
    row(view, "Github.CountStargazers").querySelector("button") as HTMLElement,
  );
  const panel = await view.findByRole("group", {
    name: /Before you authorize/,
  });
  expect(panel.textContent).toContain(
    "It also enables this other action requiring it: Github.CreateIssue.",
  );
  expect(panel.textContent?.toLowerCase()).not.toMatch(
    /only (this|that|the named)|just this/,
  );
});

// ---- 12.1's rule, on the new markup ----

test("on Arcade the grant list says nothing of Composio, in text or attributes", async () => {
  install({
    provider: "arcade",
    connected: true,
    grants: GMAIL,
    siblings: { siblings: ["googledocs"], unanswered: 0 },
  });
  const view = renderScreen("?action=Gmail.ListEmails");
  await waitFor(() => row(view, "Gmail.SendEmail"));
  fireEvent.click(view.getByText("Authorize"));
  await view.findByRole("group", { name: /Before you authorize/ });
  expect(everythingRendered(view)).not.toMatch(/composio/i);
});

test("a Composio deployment draws no grant list and never reads the grants", async () => {
  install({ provider: "composio", connected: true, grants: GMAIL });
  const view = renderScreen();
  await view.findByText("Disconnect");
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(view.container.querySelector("[data-action]")).toBeNull();
  expect(view.queryByLabelText("Search actions")).toBeNull();
});

/*
 * ---- the gate is the CAPABILITY, not the name ----
 *
 * The case where the two DISAGREE, which is the whole reason the screen stopped comparing names: a
 * deployment whose provider is named arcade but whose broker declares no per-action authorization
 * flow. `/servers/:id/authorize` refuses such a deployment with 503, so a list drawn here would be
 * a screenful of buttons that cannot work. The name says draw it; the capability says do not; the
 * capability is what the route behind the buttons reads.
 */
test("a broker named arcade that authorizes no action draws no grant list", async () => {
  install({
    provider: "arcade",
    authorizesPerAction: false,
    connected: true,
    grants: GMAIL,
  });
  const view = renderScreen();
  await view.findByText("Disconnect");
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(view.container.querySelector("[data-action]")).toBeNull();
  expect(view.queryByLabelText("Search actions")).toBeNull();
});

/* And the mirror: the capability alone is enough, with no name read anywhere on the way. */
test("a broker that authorizes per action draws the grant list", async () => {
  install({
    provider: "arcade",
    authorizesPerAction: true,
    connected: true,
    grants: GMAIL,
  });
  const view = renderScreen();
  await waitFor(() => row(view, "Gmail.SendEmail"));
  expect(view.getByLabelText("Search actions")).toBeTruthy();
});
