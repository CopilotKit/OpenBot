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
  QueryClient,
  QueryClientProvider,
  useQuery,
} from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AppSidebar } from "@/components/app-sidebar/app-sidebar";
import { NewOrganizationDialog } from "@/components/organizations/new-organization-dialog";
import { OrganizationBoundary } from "@/components/organizations/organization-boundary";
import { SidebarProvider } from "@/components/ui/sidebar";
import { Toaster } from "@/components/ui/toast";
import { agentKeys, agentListQueryOptions } from "@/lib/agents/queries";
import { getGetBotResponseMock } from "@/lib/api/generated/bots/bots.msw";
import { signedInUser } from "@/lib/auth/queries";
import { channelKeys } from "@/lib/channels/queries";
import { deploymentKeys } from "@/lib/deployment/queries";
import {
  currentOrganizationId,
  organizationId,
  setCurrentOrganization,
} from "@/lib/organizations/current";
import { organizationKeys } from "@/lib/organizations/queries";
import { organizationScopedHash, queryClient } from "@/query-client";
import { settleReactWork } from "./settle-react-work";

/**
 * A person can belong to several organizations, and the app works in one of them at a time.
 *
 * The server here keeps two, Acme and Acme Research, each with a Bot and a conversation of its own,
 * and answers as OpenBot does: the person's organizations at /api/v2/people/me/organizations with
 * the one their session works in marked active, and an organization's Bots and conversations under
 * the address that names it.
 * The app is the real sidebar and its account menu, on the app's one query client.
 */

class OfflineWebSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readyState = 0;
  onclose = null;
  onerror = null;
  onmessage = null;
  onopen = null;
  close() {}
  send() {}
}

const ACME = { id: "org_acme", slug: "acme", name: "Acme" };
const RESEARCH = {
  id: "org_research",
  slug: "acme-research",
  name: "Acme Research",
};
const BOTS: Record<string, string> = {
  [ACME.id]: "Acme Sales Bot",
  [RESEARCH.id]: "Research Librarian",
};
const CONVERSATIONS: Record<string, string> = {
  [ACME.id]: "Acme launch plan",
  [RESEARCH.id]: "Research reading list",
};

/** The server: what it keeps, and how it answers. Reset before each test. */
let server: {
  edition: "team" | "personal";
  /** The person's organizations, the one they joined first at the top. */
  organizations: { id: string; slug: string; name: string }[];
  /** The one their session works in. */
  active: string;
  canCreate: boolean;
  /** How the list of organizations is answered: as it is, or not at all. */
  list: "served" | "not-found" | "signed-out";
  /** Held until released, when a test needs to look at the app before the list answers. */
  listGate: Promise<void>;
  /** What a create is refused with, when it is. */
  createRefusal: { status: number; code: string; detail: string } | null;
};
let requests: string[] = [];
/** Where the app asks what this deployment offers (the API's getDeployment). */
const DEPLOYMENT = "/api/v2/organizations/default/deployment";

function problem(status: number, code: string, detail: string): Response {
  return new Response(JSON.stringify({ status, code, detail, title: code }), {
    status,
    headers: { "content-type": "application/problem+json" },
  });
}

function conversation(organization: string) {
  return {
    id: `${organization}-conversation`,
    name: "Personal Assistant",
    botIds: ["assistant"],
    threadId: `${organization}-conversation`,
    active: true,
    lastMessageAt: "2026-11-08T14:00:00Z",
    summary: CONVERSATIONS[organization],
    lastMessage: null,
    lastMessageBotId: null,
    work: [],
    createdAt: "2026-11-08T13:00:00Z",
    pinned: false,
    lastReadAt: "2026-11-08T14:00:00Z",
  };
}

async function answer(
  input: Parameters<typeof fetch>[0],
  init?: RequestInit,
): Promise<Response> {
  const url = new URL(String(input), "http://openbot.invalid");
  const method = (init?.method ?? "GET").toUpperCase();
  const path = url.pathname;
  requests.push(`${method} ${path}`);

  if (path === DEPLOYMENT)
    return Response.json({
      generativeUi: true,
      selfHostBanner: false,
      localEvaluation: server.edition === "personal",
      edition: server.edition,
    });

  if (path === "/api/v2/people/me/organizations") {
    if (server.list === "not-found") return new Response(null, { status: 404 });
    if (server.list === "signed-out")
      return problem(401, "UNAUTHENTICATED", "Sign in to continue.");
    if (method === "GET") {
      await server.listGate;
      return Response.json({
        organizations: server.organizations.map((one) => ({
          ...one,
          role: "admin",
          active: one.id === server.active,
        })),
        canCreate: server.canCreate,
        nextCursor: null,
      });
    }
    if (server.createRefusal) {
      const { status, code, detail } = server.createRefusal;
      return problem(status, code, detail);
    }
    const { name } = JSON.parse(String(init?.body)) as { name: string };
    const made = { id: "org_new", slug: "new", name };
    server.organizations.push(made);
    BOTS[made.id] = "";
    return Response.json(
      { organization: { ...made, role: "owner", active: false } },
      { status: 201 },
    );
  }

  if (path === "/api/auth/organization/set-active" && method === "POST") {
    const wanted = (
      JSON.parse(String(init?.body)) as { organizationId: string }
    ).organizationId;
    if (!server.organizations.some((one) => one.id === wanted))
      return Response.json(
        { code: "FORBIDDEN", message: "Not a member." },
        { status: 403 },
      );
    server.active = wanted;
    return Response.json({ id: wanted });
  }

  const addressed = /^\/api\/v2\/organizations\/([^/]+)\/(.+)$/.exec(path);
  if (addressed) {
    const [, organization, rest] = addressed;
    // An organization the person is not in is one that does not exist.
    if (!server.organizations.some((one) => one.id === organization))
      return problem(
        404,
        "ORGANIZATION_NOT_FOUND",
        "Couldn't find that organization.",
      );
    if (rest === "people/me")
      return Response.json({
        person: {
          id: "dana",
          email: "dana@example.com",
          name: "Dana Fresh",
          needsName: false,
          image: null,
          role: "admin",
          onboarding: null,
        },
        openbotVersion: null,
      });
    // Conversations are addressed by organization, as Bots are.
    if (rest === "conversations")
      return Response.json({
        conversations: CONVERSATIONS[organization as string]
          ? [conversation(organization as string)]
          : [],
        nextCursor: null,
      });
    if (rest === `conversations/${organization}-conversation`)
      return Response.json({
        conversation: conversation(organization as string),
      });
    if (rest === "bots") {
      const name = BOTS[organization as string];
      return Response.json({
        bots: name
          ? [
              {
                ...getGetBotResponseMock().bot,
                id: `${organization}-bot`,
                name,
              },
            ]
          : [],
        nextCursor: null,
      });
    }
  }

  return Response.json({ error: "not served" }, { status: 404 });
}

const originalFetch = globalThis.fetch;
const originalWebSocket = globalThis.WebSocket;

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://openbot.invalid/" });
  globalThis.WebSocket = OfflineWebSocket as unknown as typeof WebSocket;
});
beforeEach(() => {
  server = {
    edition: "team",
    organizations: [ACME, RESEARCH],
    active: ACME.id,
    canCreate: false,
    list: "served",
    listGate: Promise.resolve(),
    createRefusal: null,
  };
  requests = [];
  // A browser that has just opened OpenBot: nothing read, no organization known.
  setCurrentOrganization(undefined);
  queryClient.clear();
  globalThis.fetch = Object.assign(answer, {
    preconnect: originalFetch.preconnect,
  });
});
afterEach(() => {
  cleanup();
  queryClient.clear();
  globalThis.fetch = originalFetch;
});
afterAll(async () => {
  await settleReactWork();
  globalThis.WebSocket = originalWebSocket;
  GlobalRegistrator.unregister();
  setCurrentOrganization("default");
});

/**
 * The requests the app addressed to an organization, in order. What the deployment itself offers is
 * not one of them: it is asked before anybody has signed in, of the organization every install has.
 */
const addressedRequests = () =>
  requests.filter(
    (request) =>
      request.includes("/api/v2/organizations/") &&
      request !== `GET ${DEPLOYMENT}`,
  );

/** The home screen, as far as this test needs it: the Bots of the organization the app works in. */
function Home() {
  const bots = useQuery(agentListQueryOptions());
  return (
    <main>
      <h1>Home</h1>
      <ul aria-label="Bots">
        {bots.data?.map((bot) => (
          <li key={bot.id}>{bot.name}</li>
        ))}
      </ul>
    </main>
  );
}

/** The app as a signed-in person opens it: the gate first, then the sidebar beside the page. */
async function open(start = "/") {
  const user = await signedInUser(queryClient);
  const rootRoute = createRootRoute({
    component: () => (
      <OrganizationBoundary>
        <SidebarProvider>
          <AppSidebar />
          <NewOrganizationDialog />
          <Outlet />
          <Toaster />
        </SidebarProvider>
      </OrganizationBoundary>
    ),
  });
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: [start] }),
    routeTree: rootRoute.addChildren([
      createRoute({
        getParentRoute: () => rootRoute,
        path: "/",
        component: Home,
      }),
      createRoute({
        getParentRoute: () => rootRoute,
        path: "/channel/$channelId",
        component: () => <main>An open conversation</main>,
      }),
    ]),
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
  const person = userEvent.setup({ document });
  return {
    signedIn: user,
    view,
    router,
    person,
    /** The account row at the foot of the sidebar, which opens the account menu. */
    account: () => view.findByRole("button", { name: /Dana Fresh/ }),
    async openAccountMenu() {
      await person.click(
        await view.findByRole("button", { name: /Dana Fresh/ }),
      );
      return view.findByRole("menu");
    },
  };
}

const menuWords = (menu: HTMLElement) =>
  [...menu.querySelectorAll("[role^=menuitem]")].map((item) =>
    item.textContent?.trim(),
  );

/** Everything the app holds in its cache, as text, to look for a row that should not be there. */
const everythingCached = () =>
  JSON.stringify(
    queryClient
      .getQueryCache()
      .getAll()
      .map((query) => query.state.data),
  );

test("the list of the person's organizations decides where every request goes, and nothing is asked of one before it answers", async () => {
  // Working in the second one they joined, so neither `default` nor the first is the answer.
  server.active = RESEARCH.id;
  let release = () => {};
  server.listGate = new Promise((resolve) => {
    release = resolve;
  });

  const gate = signedInUser(queryClient);
  await waitFor(() =>
    expect(requests).toContain("GET /api/v2/people/me/organizations"),
  );
  // The list has not answered: no organization is known, and nothing has been asked of one.
  expect(currentOrganizationId()).toBeUndefined();
  expect(() => organizationId()).toThrow();
  expect(addressedRequests()).toEqual([]);

  release();
  expect(await gate).toMatchObject({ id: "dana" });
  expect(currentOrganizationId()).toBe(RESEARCH.id);
  await queryClient.fetchQuery(agentListQueryOptions());
  expect(addressedRequests()).toEqual([
    `GET /api/v2/organizations/${RESEARCH.id}/people/me`,
    `GET /api/v2/organizations/${RESEARCH.id}/bots`,
  ]);
});

/** The one organization every OpenBot had before a person could be in several. */
const ONLY = { id: "default", slug: "default", name: "Acme" };

test("an OpenBot with one organization and no list of them is addressed as default, as before", async () => {
  server.list = "not-found";
  server.organizations = [ONLY];
  server.active = ONLY.id;
  expect(await signedInUser(queryClient)).toMatchObject({ id: "dana" });
  expect(addressedRequests()).toEqual([
    "GET /api/v2/organizations/default/people/me",
  ]);
});

test("nobody signed in is asked for nothing in any organization", async () => {
  server.list = "signed-out";
  expect(await signedInUser(queryClient)).toBeNull();
  expect(currentOrganizationId()).toBeUndefined();
  expect(addressedRequests()).toEqual([]);
});

test("every cached answer is kept under the organization it was asked in", async () => {
  setCurrentOrganization(ACME.id);
  const inAcme = organizationScopedHash(agentKeys.list());
  const conversationsInAcme = organizationScopedHash(channelKeys.list());
  setCurrentOrganization(RESEARCH.id);
  // The same key in another organization is another entry, for Bots and for conversations alike.
  expect(inAcme).toContain(ACME.id);
  expect(organizationScopedHash(agentKeys.list())).toContain(RESEARCH.id);
  expect(organizationScopedHash(agentKeys.list())).not.toBe(inAcme);
  expect(organizationScopedHash(channelKeys.list())).not.toBe(
    conversationsInAcme,
  );
  // What is the same in every organization is one entry in all of them.
  for (const key of [organizationKeys.mine(), deploymentKeys.capabilities()]) {
    const inResearch = organizationScopedHash(key);
    setCurrentOrganization(ACME.id);
    expect(organizationScopedHash(key)).toBe(inResearch);
    setCurrentOrganization(RESEARCH.id);
  }

  // The app's own client keys what it holds the same way.
  queryClient.setQueryData(agentKeys.list(), []);
  expect(
    queryClient.getQueryCache().find({ queryKey: agentKeys.list() })?.queryHash,
  ).toContain(RESEARCH.id);

  // A cache that only keys by organization and drops nothing: Acme's Bots are not Research's.
  const cache = new QueryClient({
    defaultOptions: { queries: { queryKeyHashFn: organizationScopedHash } },
  });
  setCurrentOrganization(ACME.id);
  cache.setQueryData(agentKeys.list(), [{ name: BOTS[ACME.id] }]);
  setCurrentOrganization(RESEARCH.id);
  expect(cache.getQueryData(agentKeys.list())).toBeUndefined();
  setCurrentOrganization(ACME.id);
  expect(cache.getQueryData<unknown>(agentKeys.list())).toEqual([
    { name: BOTS[ACME.id] },
  ]);
  cache.clear();
});

test("switching shows the other organization everywhere: its Bots and conversations, none of the one left, after Back and a reload too", async () => {
  const app = await open("/channel/org_acme-conversation");
  // In Acme, with one of its conversations open.
  await app.view.findByText(CONVERSATIONS[ACME.id] as string);
  expect((await app.account()).textContent).toContain("Acme");
  await app.view.findByText("An open conversation");

  const menu = await app.openAccountMenu();
  const choices = within(menu).getAllByRole("menuitemradio");
  expect(choices.map((choice) => choice.textContent)).toEqual([
    "Acme",
    "Acme Research",
  ]);
  // The one being worked in is the one marked.
  expect(choices.map((choice) => choice.getAttribute("aria-checked"))).toEqual([
    "true",
    "false",
  ]);
  requests = [];
  await app.person.click(choices[1] as HTMLElement);

  // The conversation closes and the person lands on home, in Acme Research.
  await waitFor(() => expect(app.router.state.location.pathname).toBe("/"));
  await app.view.findByText(BOTS[RESEARCH.id] as string);
  await app.view.findByText(CONVERSATIONS[RESEARCH.id] as string);
  await waitFor(async () =>
    expect((await app.account()).textContent).toContain("Acme Research"),
  );
  expect(server.active).toBe(RESEARCH.id);
  const gone = () => {
    for (const left of [BOTS[ACME.id], CONVERSATIONS[ACME.id]]) {
      expect(document.body.textContent).not.toContain(left);
      expect(everythingCached()).not.toContain(left);
    }
  };
  gone();
  // Asked again under the new organization's address.
  expect(addressedRequests()).toContain(
    `GET /api/v2/organizations/${RESEARCH.id}/bots`,
  );
  requests = [];

  // Back, to the conversation that was open in Acme: nothing of Acme comes with it.
  app.router.history.back();
  await waitFor(() =>
    expect(app.router.state.location.pathname).toBe(
      "/channel/org_acme-conversation",
    ),
  );
  await app.view.findByText(CONVERSATIONS[RESEARCH.id] as string);
  gone();
  // Once the app has changed over, nothing more is asked of the organization it left.
  expect(
    addressedRequests().filter((request) => request.includes(ACME.id)),
  ).toEqual([]);

  // A reload: the browser starts from nothing, and the server still says Acme Research.
  cleanup();
  queryClient.clear();
  setCurrentOrganization(undefined);
  const reloaded = await open();
  await reloaded.view.findByText(BOTS[RESEARCH.id] as string);
  await reloaded.view.findByText(CONVERSATIONS[RESEARCH.id] as string);
  expect((await reloaded.account()).textContent).toContain("Acme Research");
  gone();
});

test("a switch made in another window is followed as soon as the person comes back to this one, from home", async () => {
  const app = await open("/channel/org_acme-conversation");
  await app.view.findByText(CONVERSATIONS[ACME.id] as string);
  await app.view.findByText("An open conversation");
  expect((await app.account()).textContent).toContain("Acme");

  // Another window of the same browser switches. The session is one for both, so from now on
  // every address the session decides answers from Acme Research, this window's included.
  server.active = RESEARCH.id;
  // The person comes back to this window, moments after it read the list.
  window.dispatchEvent(new Event("visibilitychange"));

  // It follows: home, in Acme Research, with nothing of Acme left on the screen or held.
  await waitFor(() => expect(app.router.state.location.pathname).toBe("/"));
  await app.view.findByText(BOTS[RESEARCH.id] as string);
  await app.view.findByText(CONVERSATIONS[RESEARCH.id] as string);
  await waitFor(async () =>
    expect((await app.account()).textContent).toContain("Acme Research"),
  );
  for (const left of [BOTS[ACME.id], CONVERSATIONS[ACME.id]]) {
    expect(document.body.textContent).not.toContain(left);
    expect(everythingCached()).not.toContain(left);
  }
  // The conversation that was open is closed, not drawn again in an organization it is not in.
  expect(document.body.textContent).not.toContain("An open conversation");
  expect(addressedRequests()).toContain(
    `GET /api/v2/organizations/${RESEARCH.id}/bots`,
  );
});

test("a switch the server refuses leaves the person where they were, told so", async () => {
  const app = await open("/channel/org_acme-conversation");
  const menu = await app.openAccountMenu();
  // Removed from Acme Research since the menu was drawn.
  server.organizations = [ACME];
  await app.person.click(
    within(menu).getByRole("menuitemradio", { name: "Acme Research" }),
  );
  await waitFor(() =>
    expect(
      [...document.querySelectorAll("[data-slot=toast]")].map(
        (toast) => toast.textContent,
      ),
    ).toEqual(["Couldn't switch organizations. Try again."]),
  );
  expect(app.router.state.location.pathname).toBe(
    "/channel/org_acme-conversation",
  );
  expect(currentOrganizationId()).toBe(ACME.id);
  await app.view.findByText(CONVERSATIONS[ACME.id] as string);
});

test("somebody who may create one makes an organization from the menu and is switched to it", async () => {
  server.canCreate = true;
  const app = await open();
  await app.view.findByText(BOTS[ACME.id] as string);
  const menu = await app.openAccountMenu();
  await app.person.click(
    within(menu).getByRole("menuitem", { name: "New organization" }),
  );
  const dialog = await app.view.findByRole("dialog", {
    name: "New organization",
  });
  // Nothing to create until it has a name.
  const create = within(dialog).getByRole("button", { name: "Create" });
  expect(create.hasAttribute("disabled")).toBe(true);
  await app.person.type(within(dialog).getByLabelText("Name"), "Acme Labs");
  requests = [];
  await app.person.click(create);

  await waitFor(() => expect(server.active).toBe("org_new"));
  expect(requests.filter((request) => request.startsWith("POST"))).toEqual([
    "POST /api/v2/people/me/organizations",
    "POST /api/auth/organization/set-active",
  ]);
  // In the new one, which starts empty: the dialog is gone and nothing of Acme is left.
  await waitFor(async () =>
    expect((await app.account()).textContent).toContain("Acme Labs"),
  );
  expect(
    app.view.queryByRole("dialog", { name: "New organization" }),
  ).toBeNull();
  await waitFor(() => {
    expect(document.body.textContent).not.toContain(BOTS[ACME.id]);
    expect(document.body.textContent).not.toContain(CONVERSATIONS[ACME.id]);
  });
  expect(currentOrganizationId()).toBe("org_new");
});

test("a create the server refuses says so in the dialog, in the server's own sentence", async () => {
  server.canCreate = true;
  const refusal = "This OpenBot can't add another organization yet.";
  server.createRefusal = {
    status: 503,
    code: "SERVICE_UNAVAILABLE",
    detail: refusal,
  };
  const app = await open();
  const menu = await app.openAccountMenu();
  await app.person.click(
    within(menu).getByRole("menuitem", { name: "New organization" }),
  );
  const dialog = await app.view.findByRole("dialog", {
    name: "New organization",
  });
  await app.person.type(within(dialog).getByLabelText("Name"), "Acme Labs");
  await app.person.click(
    within(dialog).getByRole("button", { name: "Create" }),
  );

  expect((await within(dialog).findByRole("alert")).textContent).toBe(refusal);
  // Still open with the name typed, still in Acme, and no switch was asked for.
  expect(within(dialog).getByLabelText("Name")).toHaveProperty(
    "value",
    "Acme Labs",
  );
  expect(server.active).toBe(ACME.id);
  expect(requests).not.toContain("POST /api/auth/organization/set-active");
});

/** The account row and its menu, as markup, without the ids the menu makes up each time it opens. */
async function accountMenuMarkup(app: Awaited<ReturnType<typeof open>>) {
  const row = (await app.account()).innerHTML;
  const menu = await app.openAccountMenu();
  const markup = menu.innerHTML.replace(/ (id|aria-[a-z]+)="[^"]*"/g, "");
  return { row, menu: markup, words: menuWords(menu) };
}

test("on an OpenBot that lists no organizations the account menu is exactly as it was, and with one listed it shows that one and its settings", async () => {
  // Before there were organizations to list: a server with no list of them.
  server.list = "not-found";
  server.organizations = [ONLY];
  server.active = ONLY.id;
  const unlisted = await open();
  const before = await accountMenuMarkup(unlisted);
  // Teams are the one organization's own, so they are there with or without others to switch to.
  expect(before.words).toEqual(["Teams", "Admin", "Settings", "Sign out"]);
  expect(before.row).not.toContain("Acme");
  expect(unlisted.view.queryByText("Organizations")).toBeNull();
  expect(unlisted.view.queryByRole("menuitemradio")).toBeNull();
  cleanup();
  queryClient.clear();
  setCurrentOrganization(undefined);

  // The same person on a server that lists their one organization and lets them create none.
  server.list = "served";
  const app = await open();
  const now = await accountMenuMarkup(app);
  expect(requests).toContain("GET /api/v2/people/me/organizations");
  expect(now.words).toEqual([
    "Acme",
    "Organization settings",
    "Admin",
    "Settings",
    "Sign out",
  ]);
  expect(now.row).toContain("Acme");
  expect(app.view.queryByText("New organization")).toBeNull();
});

test("the personal edition asks for no organizations and shows none", async () => {
  server.edition = "personal";
  server.organizations = [ONLY];
  server.active = ONLY.id;
  // Even if a list were answered, with the right to create.
  server.canCreate = true;
  const app = await open();
  expect(app.signedIn).toMatchObject({ id: "dana" });
  expect(currentOrganizationId()).toBe("default");
  await app.account();
  const menu = await app.openAccountMenu();
  expect(menuWords(menu)).not.toContain("New organization");
  expect(within(menu).queryByRole("menuitemradio")).toBeNull();
  expect(app.view.queryByText("Organizations")).toBeNull();
  expect((await app.account()).textContent).not.toContain("Acme");
  expect(requests).not.toContain("GET /api/v2/people/me/organizations");
});
