import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
  useParams,
} from "@tanstack/react-router";
import { cleanup, render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { AppSidebar } from "@/components/app-sidebar/app-sidebar";
import {
  InvitationPage,
  InvitationsPage,
} from "@/components/organizations/invitations-page";
import { OrganizationBoundary } from "@/components/organizations/organization-boundary";
import { OrganizationSettingsPage } from "@/components/organizations/organization-settings-page";
import { settingsSidebarItems } from "@/components/settings/settings-sidebar";
import { SidebarProvider } from "@/components/ui/sidebar";
import { Toaster } from "@/components/ui/toast";
import { signedInUser } from "@/lib/auth/queries";
import {
  currentOrganizationId,
  setCurrentOrganization,
} from "@/lib/organizations/current";
import { organizationsOnly } from "@/lib/organizations/guard";
import {
  type OrganizationMemberSummary,
  organizationMembersQueryOptions,
  type ReceivedInvitation,
  receivedInvitationQueryOptions,
  type SentInvitation,
} from "@/lib/organizations/queries";
import {
  invitationLink,
  memberControl,
  receivedInvitationLine,
  roleName,
  sentInvitationLine,
} from "@/lib/organizations/words";
import { queryClient } from "@/query-client";
import { settleReactWork } from "./settle-react-work";

/**
 * People join an organization by invitation, and an organization has settings: its name, its
 * members and the invitations it sent.
 *
 * The server here answers as the API describes (api/openapi/organizations.yaml). Dana has an
 * organization of her own and is in Acme, where she works. The app is the real sidebar with its
 * account menu and the real screens, on the app's one query client.
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

type Listed = {
  id: string;
  slug: string;
  name: string;
  role: "owner" | "admin" | "member";
  personal: boolean;
};

const OWN: Listed = {
  id: "org_dana",
  slug: "dana",
  name: "Dana's organization",
  role: "owner",
  personal: true,
};
const ACME = { id: "org_acme", slug: "acme", name: "Acme" };
const RESEARCH = {
  id: "org_research",
  slug: "acme-research",
  name: "Acme Research",
};
const DAY = 86_400_000;
const inDays = (days: number) =>
  new Date(Date.now() + days * DAY).toISOString();
const SENDER = { name: "Lee Park", email: "lee.park@example.com" };

const member = (
  id: string,
  name: string | null,
  role: OrganizationMemberSummary["role"],
): OrganizationMemberSummary => ({
  id,
  email: `${id}@example.com`,
  name,
  image: null,
  role,
  joinedAt: "2026-11-01T09:00:00.000Z",
  // As the server answers it: the owner stays.
  removable: role !== "owner",
  // Said for the person asking when the list is read: see `asListed`.
  assignableRoles: [],
});

const ROLES = ["owner", "admin", "member"] as const;

/**
 * A member as the list says them to somebody with `asker`'s role: the roles that person may give
 * them, their current one left out. An owner gives any role, and an owner's own role changes only
 * while another owner exists. An admin moves people between admin and member. A member gives none.
 */
function asListed(
  one: OrganizationMemberSummary,
  asker: Listed["role"],
  all: OrganizationMemberSummary[],
): OrganizationMemberSummary {
  const others = ROLES.filter((role) => role !== one.role);
  const owners = all.filter((each) => each.role === "owner").length;
  const assignableRoles =
    asker === "member"
      ? []
      : one.role === "owner"
        ? asker === "owner" && owners > 1
          ? others
          : []
        : asker === "owner"
          ? others
          : others.filter((role) => role !== "owner");
  return { ...one, assignableRoles };
}

const sent = (
  id: string,
  email: string,
  status: SentInvitation["status"],
  days: number,
): SentInvitation => ({
  id,
  email,
  role: "member",
  status,
  invitedBy: { name: "Dana Fresh", email: "dana@example.com" },
  createdAt: inDays(days - 7),
  expiresAt: inDays(days),
});

const received = (
  id: string,
  status: ReceivedInvitation["status"],
  days = 6,
): ReceivedInvitation => ({
  id,
  organization: RESEARCH,
  role: "member",
  status,
  invitedBy: SENDER,
  createdAt: inDays(days - 7),
  expiresAt: inDays(days),
});

/** The server: what it keeps, and how it answers. Reset before each test. */
let server: {
  edition: "team" | "personal";
  /** Dana's organizations, the one she joined first at the top. */
  organizations: Listed[];
  /** The one her session works in. */
  active: string;
  /** Acme's members, in the order they joined. */
  members: OrganizationMemberSummary[];
  /** The invitations Acme sent that nobody accepted. */
  sent: SentInvitation[];
  /** Every invitation sent to Dana's address, answered or not. */
  received: ReceivedInvitation[];
  /** How a new invitation reaches the person. */
  delivery: "emailed" | "link";
  /** What the next write is refused with, when it is. */
  refusal: { status: number; detail: string } | null;
};
/** Every request, in order, and each write's body and whether it carried an Idempotency-Key. */
let requests: string[] = [];
let writes: { request: string; body: unknown; keyed: boolean }[] = [];
const DEPLOYMENT = "/api/v2/organizations/default/deployment";

function problem(status: number, code: string, detail: string): Response {
  return new Response(JSON.stringify({ status, code, detail, title: code }), {
    status,
    headers: { "content-type": "application/problem+json" },
  });
}

const page = <T,>(key: string, items: T[], url: URL) => {
  // Two to a page, so a list longer than that is only whole when every page is read.
  const from = Number(url.searchParams.get("cursor") ?? 0);
  const next = from + 2 < items.length ? String(from + 2) : null;
  return Response.json({
    [key]: items.slice(from, from + 2),
    nextCursor: next,
  });
};

async function answer(
  input: Parameters<typeof fetch>[0],
  init?: RequestInit,
): Promise<Response> {
  const url = new URL(String(input), "http://openbot.invalid");
  const method = (init?.method ?? "GET").toUpperCase();
  const path = url.pathname;
  requests.push(`${method} ${path}`);
  const body = init?.body ? (JSON.parse(String(init.body)) as unknown) : null;
  if (method !== "GET") {
    writes.push({
      request: `${method} ${path}`,
      body,
      keyed: !!new Headers(init?.headers).get("idempotency-key"),
    });
  }
  const refused = () => {
    const refusal = server.refusal;
    server.refusal = null;
    return refusal ? problem(refusal.status, "CONFLICT", refusal.detail) : null;
  };
  const listed = (one: Listed) => ({
    ...one,
    active: one.id === server.active,
  });

  if (path === DEPLOYMENT)
    return Response.json({
      generativeUi: true,
      selfHostBanner: false,
      localEvaluation: server.edition === "personal",
      edition: server.edition,
    });

  if (path === "/api/v2/people/me/organizations" && method === "GET")
    return Response.json({
      organizations: server.organizations.map(listed),
      canCreate: true,
      nextCursor: null,
    });

  if (path === "/api/auth/organization/set-active" && method === "POST") {
    const wanted = (body as { organizationId: string }).organizationId;
    if (!server.organizations.some((one) => one.id === wanted))
      return Response.json({ message: "Not a member." }, { status: 403 });
    server.active = wanted;
    return Response.json({ id: wanted });
  }

  if (path === "/api/v2/people/me/invitations" && method === "GET")
    return page(
      "invitations",
      server.received.filter(
        (one) => one.status === "pending" || one.status === "expired",
      ),
      url,
    );

  const mine =
    /^\/api\/v2\/people\/me\/invitations\/([^/]+)(?:\/(accept|decline))?$/.exec(
      path,
    );
  if (mine) {
    const [, id, verb] = mine;
    const invitation = server.received.find((one) => one.id === id);
    if (!invitation)
      return problem(
        404,
        "INVITATION_NOT_FOUND",
        "Couldn't find that invitation. Check that you're signed in with the address it was sent to.",
      );
    if (!verb) return Response.json({ invitation });
    if (invitation.status !== "pending")
      return problem(
        409,
        "CONFLICT",
        "This invitation has expired. Ask whoever invited you to send a new one.",
      );
    if (verb === "decline") {
      invitation.status = "declined";
      return new Response(null, { status: 204 });
    }
    invitation.status = "accepted";
    const joined: Listed = {
      ...invitation.organization,
      role: invitation.role,
      personal: false,
    };
    server.organizations.push(joined);
    return Response.json({ organization: listed(joined) });
  }

  const addressed = /^\/api\/v2\/organizations\/([^/]+)\/(.+)$/.exec(path);
  if (addressed) {
    const [, organization, rest] = addressed;
    const here = server.organizations.find((one) => one.id === organization);
    // An organization the person is not in is one that does not exist.
    if (!here)
      return problem(
        404,
        "ORGANIZATION_NOT_FOUND",
        "Couldn't find that organization.",
      );
    const manages = here.role !== "member";
    const adminOnly = () =>
      problem(403, "FORBIDDEN", "Only an admin can do that.");
    if (rest === "people/me")
      return Response.json({
        person: {
          id: "dana",
          email: "dana@example.com",
          name: "Dana Fresh",
          needsName: false,
          image: null,
          role: here.role,
          onboarding: null,
        },
        openbotVersion: null,
      });
    if (rest === "conversations")
      return Response.json({ conversations: [], nextCursor: null });
    if (rest === "bots") return Response.json({ bots: [], nextCursor: null });
    if (rest === "profile" && method === "PATCH") {
      if (!manages) return adminOnly();
      const no = refused();
      if (no) return no;
      here.name = (body as { name: string }).name;
      return Response.json({ organization: listed(here) });
    }
    if (rest === "members" && method === "GET")
      return page(
        "members",
        server.members.map((one) => asListed(one, here.role, server.members)),
        url,
      );
    const removed = /^members\/([^/]+)$/.exec(rest as string);
    if (removed && method === "PATCH") {
      const no = refused();
      if (no) return no;
      if (!manages) return adminOnly();
      const { role } = body as { role: OrganizationMemberSummary["role"] };
      const changed = server.members.find((one) => one.id === removed[1]);
      if (!changed)
        return problem(404, "PERSON_NOT_FOUND", "Couldn't find that person.");
      changed.role = role;
      if (changed.id === "dana") here.role = role;
      return Response.json({
        member: asListed(changed, here.role, server.members),
      });
    }
    if (removed && method === "DELETE") {
      const no = refused();
      if (no) return no;
      const who = removed[1] === "me" ? "dana" : removed[1];
      if (who !== "dana" && !manages) return adminOnly();
      server.members = server.members.filter((one) => one.id !== who);
      if (who === "dana")
        server.organizations = server.organizations.filter(
          (one) => one.id !== organization,
        );
      return new Response(null, { status: 204 });
    }
    if (rest === "invitations") {
      if (!manages) return adminOnly();
      if (method === "GET") return page("invitations", server.sent, url);
      const no = refused();
      if (no) return no;
      const { email, role } = body as { email: string; role: "member" };
      const made = server.sent.some((one) => one.id === "inv_new")
        ? `inv_new_${server.sent.length}`
        : "inv_new";
      const invitation = { ...sent(made, email, "pending", 7), role };
      server.sent.unshift(invitation);
      return Response.json(
        { invitation, delivery: server.delivery },
        { status: 201 },
      );
    }
    const canceled = /^invitations\/([^/]+)$/.exec(rest as string);
    if (canceled && method === "DELETE") {
      if (!manages) return adminOnly();
      server.sent = server.sent.filter((one) => one.id !== canceled[1]);
      return new Response(null, { status: 204 });
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
    organizations: [{ ...OWN }, { ...ACME, role: "owner", personal: false }],
    active: ACME.id,
    members: [
      member("dana", "Dana Fresh", "owner"),
      member("lee", "Lee Park", "admin"),
      member("sam", null, "member"),
    ],
    sent: [
      sent("inv_wait", "ana@example.com", "pending", 6),
      sent("inv_old", "bo@example.com", "expired", -3),
      sent("inv_no", "cy@example.com", "declined", 2),
    ],
    received: [],
    delivery: "link",
    refusal: null,
  };
  requests = [];
  writes = [];
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

/** Dana is a plain member of Acme, which Lee owns. */
function asMember() {
  server.organizations = [
    { ...OWN },
    { ...ACME, role: "member", personal: false },
  ];
  server.members = [
    member("lee", "Lee Park", "owner"),
    member("dana", "Dana Fresh", "member"),
  ];
}

function LinkedInvitation() {
  const { invitationId } = useParams({ strict: false }) as {
    invitationId: string;
  };
  return <InvitationPage invitationId={invitationId} />;
}

/** The app as a signed-in person opens it at `start`: the gate, then the sidebar beside the page. */
async function open(start: string) {
  await signedInUser(queryClient);
  const rootRoute = createRootRoute({
    component: () => (
      <OrganizationBoundary>
        <SidebarProvider>
          <AppSidebar />
          <main>
            <Outlet />
          </main>
          <Toaster />
        </SidebarProvider>
      </OrganizationBoundary>
    ),
  });
  const at = (path: string, component: () => ReactNode) =>
    createRoute({ getParentRoute: () => rootRoute, path, component });
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: [start] }),
    routeTree: rootRoute.addChildren([
      at("/", () => <p>Home</p>),
      at("/settings/organization", OrganizationSettingsPage),
      at("/invitations", InvitationsPage),
      at("/invitations/$invitationId", LinkedInvitation),
    ]),
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
  const person = userEvent.setup({ document });
  return {
    view,
    router,
    person,
    async openAccountMenu() {
      await person.click(
        await view.findByRole("button", { name: /Dana Fresh/ }),
      );
      return view.findByRole("menu");
    },
  };
}

const sentWrites = () => writes.map((write) => write.request);

describe("the words and the controls", () => {
  test("a role, an invitation's line and its link read as the screens say them", () => {
    expect(["owner", "admin", "member"].map(roleName)).toEqual([
      "Owner",
      "Admin",
      "Member",
    ]);
    expect(sentInvitationLine(sent("a", "ana@example.com", "pending", 6))).toBe(
      "Member · Pending · Expires in 6 days",
    );
    expect(
      sentInvitationLine(sent("a", "ana@example.com", "expired", -3)),
    ).toBe("Member · Expired");
    expect(
      sentInvitationLine(sent("a", "ana@example.com", "declined", 2)),
    ).toBe("Member · Declined");
    expect(invitationLink("inv_1", "https://openbot.example")).toBe(
      "https://openbot.example/invitations/inv_1",
    );
    expect(receivedInvitationLine(received("a", "pending"))).toBe(
      "Lee Park invited you to join as a member. Expires in 6 days.",
    );
    expect(
      receivedInvitationLine({ ...received("a", "pending"), role: "admin" }),
    ).toStartWith("Lee Park invited you to join as an admin.");
    expect(receivedInvitationLine(received("a", "expired", -1))).toBe(
      "This invitation has expired. Ask Lee Park to send a new one.",
    );
    expect(receivedInvitationLine(received("a", "accepted"))).toBe(
      "You're a member of Acme Research.",
    );
  });

  test("a member's row offers leaving on your own, removing to an owner or admin, and nothing where the membership cannot end", () => {
    // `removable` is the server's verdict: false for the owner, and for somebody OpenBot's
    // settings keep as an admin.
    const row = (
      id: string,
      role: OrganizationMemberSummary["role"],
      removable = role !== "owner",
    ) => ({ id, role, removable });
    // An admin the settings keep is offered no Leave, and nobody is offered to remove them.
    expect(
      memberControl(row("dana", "admin", false), { id: "dana", role: "admin" }),
    ).toBeNull();
    expect(
      memberControl(row("lee", "admin", false), { id: "dana", role: "admin" }),
    ).toBeNull();
    for (const role of ["owner", "admin"]) {
      const viewer = { id: "dana", role };
      expect(memberControl(row("sam", "member"), viewer)).toBe("remove");
      expect(memberControl(row("lee", "admin"), viewer)).toBe("remove");
      expect(memberControl(row("ona", "owner"), viewer)).toBeNull();
    }
    const plain = { id: "dana", role: "member" };
    expect(memberControl(row("sam", "member"), plain)).toBeNull();
    expect(memberControl(row("dana", "member"), plain)).toBe("leave");
    expect(
      memberControl(row("dana", "admin"), { ...plain, role: "admin" }),
    ).toBe("leave");
    // The owner stays, their own row included.
    expect(
      memberControl(row("dana", "owner"), { id: "dana", role: "owner" }),
    ).toBeNull();
  });
});

describe("reading", () => {
  test("every page of an organization's members is read, in the order they joined", async () => {
    setCurrentOrganization(ACME.id);
    const members = await queryClient.fetchQuery(
      organizationMembersQueryOptions(ACME.id),
    );
    expect(members.map((one) => one.id)).toEqual(["dana", "lee", "sam"]);
    expect(
      requests.filter((request) => request.endsWith("/members")),
    ).toHaveLength(2);
  });

  test("an invitation the server does not find for this person is an answer, not a failure", async () => {
    setCurrentOrganization(ACME.id);
    expect(
      await queryClient.fetchQuery(receivedInvitationQueryOptions("inv_gone")),
    ).toBeNull();
    server.received = [received("inv_1", "canceled")];
    expect(
      await queryClient.fetchQuery(receivedInvitationQueryOptions("inv_1")),
    ).toMatchObject({ id: "inv_1", status: "canceled" });
  });
});

describe("the account menu", () => {
  test("offers the organization's settings, marks nothing as waiting when nothing is, and counts the invitations that are", async () => {
    const app = await open("/");
    let menu = await app.openAccountMenu();
    expect(
      within(menu)
        .getAllByRole("menuitemradio")
        .map((choice) => choice.textContent),
    ).toEqual(["Dana's organization", "Acme"]);
    expect(within(menu).queryByRole("menuitem", { name: /Invitations/ })).toBe(
      null,
    );
    await app.person.click(
      within(menu).getByRole("menuitem", { name: "Organization settings" }),
    );
    await waitFor(() =>
      expect(app.router.state.location.pathname).toBe("/settings/organization"),
    );

    // Two arrive, and one of them has already run out of time: one is waiting.
    server.received = [
      received("inv_1", "pending"),
      received("inv_2", "expired", -1),
    ];
    await queryClient.invalidateQueries();
    menu = await app.openAccountMenu();
    const entry = await within(menu).findByRole("menuitem", {
      name: /Invitations/,
    });
    expect(
      entry.querySelector("[data-slot=invitations-waiting]")?.textContent,
    ).toBe("1, 1 waiting");
    await app.person.click(entry);
    await waitFor(() =>
      expect(app.router.state.location.pathname).toBe("/invitations"),
    );
  });

  test("the personal edition has no organization settings and no invitations, in the menu or in Settings", async () => {
    server.edition = "personal";
    // One person and the one organization every install has, which the app asks for no list of.
    server.organizations = [{ ...OWN, id: "default" }];
    server.active = "default";
    server.received = [received("inv_1", "pending")];
    const app = await open("/");
    const menu = await app.openAccountMenu();
    expect(menu.textContent).not.toContain("Organization settings");
    expect(menu.textContent).not.toContain("Invitations");
    expect(requests).not.toContain("GET /api/v2/people/me/invitations");
    expect(
      settingsSidebarItems("personal").map((item) => item.title),
    ).not.toContain("Organization");
    expect(settingsSidebarItems("team").map((item) => item.title)).toContain(
      "Organization",
    );
    // And its pages send the person home.
    let thrown: unknown;
    try {
      await organizationsOnly({ context: { queryClient } });
    } catch (error) {
      thrown = error;
    }
    expect((thrown as { options?: { to?: string } }).options?.to).toBe("/");
  });
});

describe("organization settings, for its owner", () => {
  test("renames it from the Name row, and a refusal stays in the dialog in the server's sentence", async () => {
    const app = await open("/settings/organization");
    const page = within(await app.view.findByRole("main"));
    await app.person.click(await page.findByRole("button", { name: /Name/ }));
    const dialog = await app.view.findByRole("dialog", {
      name: "Rename organization",
    });
    const field = within(dialog).getByLabelText("Name");
    expect(field).toHaveProperty("value", "Acme");

    server.refusal = { status: 409, detail: "That name can't be used here." };
    await app.person.clear(field);
    await app.person.type(field, "Acme Labs");
    await app.person.click(
      within(dialog).getByRole("button", { name: "Save" }),
    );
    expect((await within(dialog).findByRole("alert")).textContent).toBe(
      "That name can't be used here.",
    );
    expect(field).toHaveProperty("value", "Acme Labs");

    await app.person.click(
      within(dialog).getByRole("button", { name: "Save" }),
    );
    await waitFor(() =>
      expect(
        app.view.queryByRole("dialog", { name: "Rename organization" }),
      ).toBeNull(),
    );
    // The row and the account row both say the new name, read back from the server.
    await waitFor(() =>
      expect(page.getByRole("button", { name: /Name/ }).textContent).toContain(
        "Acme Labs",
      ),
    );
    expect(writes.at(-1)).toEqual({
      request: `PATCH /api/v2/organizations/${ACME.id}/profile`,
      body: { name: "Acme Labs" },
      keyed: true,
    });
  });

  test("lists every member with their role, and removes one after asking", async () => {
    const app = await open("/settings/organization");
    const page = within(await app.view.findByRole("main"));
    await page.findByText("sam@example.com");
    expect(page.getByText("dana@example.com · Owner")).toBeTruthy();
    expect(page.getByText("lee@example.com · Admin")).toBeTruthy();
    // The owner stays: nothing on her own row, Remove on the others.
    expect(page.queryByRole("button", { name: "Leave organization" })).toBe(
      null,
    );
    expect(page.queryByRole("button", { name: "Remove Dana Fresh" })).toBe(
      null,
    );
    expect(page.getByRole("button", { name: "Remove Lee Park" })).toBeTruthy();

    await app.person.click(
      page.getByRole("button", { name: "Remove sam@example.com" }),
    );
    const dialog = await app.view.findByRole("dialog", {
      name: "Remove sam@example.com from Acme?",
    });
    // Asked first: nothing is sent until the answer.
    expect(sentWrites()).toEqual([]);
    await app.person.click(
      within(dialog).getByRole("button", { name: "Remove" }),
    );
    await waitFor(() => expect(page.queryByText("sam@example.com")).toBeNull());
    expect(writes.at(-1)).toMatchObject({
      request: `DELETE /api/v2/organizations/${ACME.id}/members/sam`,
      keyed: true,
    });
  });

  test("offers a Role menu where the server says a role can be given, and changing a member to an admin applies at once", async () => {
    const app = await open("/settings/organization");
    const page = within(await app.view.findByRole("main"));
    await page.findByText("sam@example.com");
    // Dana is the only owner, so her own role stays: no menu on her row.
    expect(
      page.queryByRole("button", { name: "Change role for Dana Fresh" }),
    ).toBeNull();
    expect(
      page.getByRole("button", { name: "Change role for Lee Park" }),
    ).toBeTruthy();

    const role = page.getByRole("button", {
      name: "Change role for sam@example.com",
    });
    const row = role.closest("[data-slot=item]") as HTMLElement;
    expect(within(row).getByText("Member")).toBeTruthy();
    await app.person.click(role);
    const menu = await app.view.findByRole("menu");
    // The roles she may give Sam, by name, without the one he has.
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((choice) => choice.textContent),
    ).toEqual(["Owner", "Admin"]);
    await app.person.click(
      within(menu).getByRole("menuitem", { name: "Admin" }),
    );

    // The row says the new role, read back from the server.
    await waitFor(() => expect(within(row).getByText("Admin")).toBeTruthy());
    expect(writes).toEqual([
      {
        request: `PATCH /api/v2/organizations/${ACME.id}/members/sam`,
        body: { role: "admin" },
        keyed: true,
      },
    ]);
  });

  test("asks before making somebody an owner, saying what an owner can do", async () => {
    const app = await open("/settings/organization");
    const page = within(await app.view.findByRole("main"));
    await app.person.click(
      await page.findByRole("button", { name: "Change role for Lee Park" }),
    );
    await app.person.click(
      within(await app.view.findByRole("menu")).getByRole("menuitem", {
        name: "Owner",
      }),
    );
    const dialog = await app.view.findByRole("dialog", {
      name: "Make Lee Park an owner of Acme?",
    });
    expect(dialog.textContent).toContain(
      "An owner can rename the organization, invite and remove people, and change who owns it.",
    );
    // Asked first: nothing is sent until the answer.
    expect(sentWrites()).toEqual([]);
    await app.person.click(
      within(dialog).getByRole("button", { name: "Make owner" }),
    );
    await page.findByText("lee@example.com · Owner");
    expect(writes).toEqual([
      {
        request: `PATCH /api/v2/organizations/${ACME.id}/members/lee`,
        body: { role: "owner" },
        keyed: true,
      },
    ]);
    // With a second owner, Dana's own role can change, and stepping down is asked about too.
    await app.person.click(
      await page.findByRole("button", { name: "Change role for Dana Fresh" }),
    );
    await app.person.click(
      within(await app.view.findByRole("menu")).getByRole("menuitem", {
        name: "Admin",
      }),
    );
    await app.view.findByRole("dialog", {
      name: "Step down as an owner of Acme?",
    });
    expect(writes).toHaveLength(1);
  });

  test("a role change the server refuses is said in the server's sentence, and the role stays", async () => {
    const app = await open("/settings/organization");
    const page = within(await app.view.findByRole("main"));
    server.refusal = {
      status: 409,
      detail: "Their role just changed. Reload the page and try again.",
    };
    await app.person.click(
      await page.findByRole("button", {
        name: "Change role for sam@example.com",
      }),
    );
    await app.person.click(
      within(await app.view.findByRole("menu")).getByRole("menuitem", {
        name: "Admin",
      }),
    );
    expect((await page.findByRole("alert")).textContent).toBe(
      "Their role just changed. Reload the page and try again.",
    );
    expect(server.members.find((one) => one.id === "sam")?.role).toBe("member");
  });

  test("lists the invitations it sent with their status, copies a waiting one's link and cancels one", async () => {
    const app = await open("/settings/organization");
    const page = within(await app.view.findByRole("main"));
    await page.findByText("ana@example.com");
    expect(page.getByText("Member · Pending · Expires in 6 days")).toBeTruthy();
    expect(page.getByText("Member · Expired")).toBeTruthy();
    expect(page.getByText("Member · Declined")).toBeTruthy();
    // Only one still waiting has a link worth passing on. Every one can be taken back.
    expect(
      page.getAllByRole("button", { name: /^Copy link for/ }),
    ).toHaveLength(1);
    expect(
      page.getAllByRole("button", { name: /^Cancel invitation for/ }),
    ).toHaveLength(3);

    await app.person.click(
      page.getByRole("button", { name: "Copy link for ana@example.com" }),
    );
    await waitFor(async () =>
      expect(await navigator.clipboard.readText()).toBe(
        "http://openbot.invalid/invitations/inv_wait",
      ),
    );

    await app.person.click(
      page.getByRole("button", {
        name: "Cancel invitation for bo@example.com",
      }),
    );
    await waitFor(() => expect(page.queryByText("bo@example.com")).toBeNull());
    expect(writes.at(-1)).toMatchObject({
      request: `DELETE /api/v2/organizations/${ACME.id}/invitations/inv_old`,
      keyed: true,
    });
  });

  test("invites an address and says what happened: a link to pass on, or an email sent", async () => {
    const app = await open("/settings/organization");
    const page = within(await app.view.findByRole("main"));
    const invite = async (email: string) => {
      await app.person.click(
        await page.findByRole("button", { name: "Invite" }),
      );
      const dialog = await app.view.findByRole("dialog", {
        name: "Invite to Acme",
      });
      await app.person.type(within(dialog).getByLabelText("Email"), email);
      await app.person.click(
        within(dialog).getByRole("button", { name: "Invite" }),
      );
      return dialog;
    };

    // Already invited: the server's sentence, with the address still typed.
    server.refusal = {
      status: 409,
      detail:
        "They already have an invitation waiting. Cancel it to send a new one.",
    };
    const form = await invite("ana@example.com");
    expect((await within(form).findByRole("alert")).textContent).toBe(
      "They already have an invitation waiting. Cancel it to send a new one.",
    );
    expect(within(form).getByLabelText("Email")).toHaveProperty(
      "value",
      "ana@example.com",
    );
    await app.person.click(
      within(form).getByRole("button", { name: "Cancel" }),
    );

    // OpenBot could not email it: the inviter copies the link.
    await invite("sam.ortiz@example.com");
    const ready = await app.view.findByRole("dialog", {
      name: "Invitation ready",
    });
    expect(within(ready).getByRole("status").textContent).toBe(
      "Copy the link and send it to sam.ortiz@example.com.",
    );
    expect(writes.at(-1)).toEqual({
      request: `POST /api/v2/organizations/${ACME.id}/invitations`,
      body: { email: "sam.ortiz@example.com", role: "member" },
      keyed: true,
    });
    await app.person.click(
      within(ready).getByRole("button", { name: "Copy link" }),
    );
    await waitFor(async () =>
      expect(await navigator.clipboard.readText()).toBe(
        "http://openbot.invalid/invitations/inv_new",
      ),
    );
    await app.person.click(within(ready).getByRole("button", { name: "Done" }));
    // It is in the list now, waiting.
    await page.findByText("sam.ortiz@example.com");

    // OpenBot emailed it: nothing to copy.
    server.delivery = "emailed";
    await invite("kit@example.com");
    const emailed = await app.view.findByRole("dialog", {
      name: "Invitation sent",
    });
    expect(within(emailed).getByRole("status").textContent).toBe(
      "We emailed kit@example.com an invitation.",
    );
    expect(within(emailed).queryByRole("button", { name: "Copy link" })).toBe(
      null,
    );
  });
});

describe("organization settings, for a member", () => {
  test("shows the name and the members, and nothing a member cannot use", async () => {
    asMember();
    const app = await open("/settings/organization");
    const page = within(await app.view.findByRole("main"));
    await page.findByText("lee@example.com · Owner");
    // The name is read, not opened; nobody is removed; no invitations are asked for or drawn.
    expect(page.queryByRole("button", { name: /Name/ })).toBeNull();
    expect(page.getByText("Acme")).toBeTruthy();
    expect(page.queryByRole("button", { name: /^Remove/ })).toBeNull();
    expect(page.queryByRole("button", { name: /^Change role/ })).toBeNull();
    expect(page.queryByText("Invitations")).toBeNull();
    expect(page.queryByRole("button", { name: "Invite" })).toBeNull();
    expect(requests).not.toContain(
      `GET /api/v2/organizations/${ACME.id}/invitations`,
    );
  });

  test("leaves after being asked, and is then working in another of their organizations, from home", async () => {
    asMember();
    const app = await open("/settings/organization");
    const page = within(await app.view.findByRole("main"));
    await app.person.click(
      await page.findByRole("button", { name: "Leave organization" }),
    );
    const dialog = await app.view.findByRole("dialog", { name: "Leave Acme?" });
    expect(sentWrites()).toEqual([]);
    requests = [];
    await app.person.click(
      within(dialog).getByRole("button", { name: "Leave" }),
    );

    await waitFor(() => expect(currentOrganizationId()).toBe(OWN.id));
    expect(app.router.state.location.pathname).toBe("/");
    expect(sentWrites()).toEqual([
      `DELETE /api/v2/organizations/${ACME.id}/members/me`,
      "POST /api/auth/organization/set-active",
    ]);
    expect(server.active).toBe(OWN.id);
    // Nothing more was asked of the organization left once she had gone.
    const left = requests.indexOf(
      `DELETE /api/v2/organizations/${ACME.id}/members/me`,
    );
    expect(
      requests.slice(left + 1).filter((request) => request.includes(ACME.id)),
    ).toEqual([]);
    const menu = await app.openAccountMenu();
    await waitFor(() =>
      expect(
        within(menu)
          .getAllByRole("menuitemradio")
          .map((choice) => choice.textContent),
      ).toEqual(["Dana's organization"]),
    );
  });
});

describe("invitations, for the person invited", () => {
  test("accepting joins without switching, and then offers the switch", async () => {
    server.received = [
      received("inv_1", "pending"),
      received("inv_2", "expired", -1),
    ];
    server.received[1] = {
      ...(server.received[1] as ReceivedInvitation),
      organization: { id: "org_other", slug: "other", name: "Other Co" },
    };
    const app = await open("/invitations");
    const page = within(await app.view.findByRole("main"));
    await page.findByText(
      "Lee Park invited you to join as a member. Expires in 6 days.",
    );
    // The expired one says so and cannot be accepted.
    expect(
      page.getByText(
        "This invitation has expired. Ask Lee Park to send a new one.",
      ),
    ).toBeTruthy();
    expect(page.getAllByRole("button", { name: /^Accept/ })).toHaveLength(1);

    await app.person.click(
      page.getByRole("button", { name: "Accept invitation to Acme Research" }),
    );
    await page.findByText("You're a member of Acme Research.");
    expect(sentWrites()).toEqual([
      "POST /api/v2/people/me/invitations/inv_1/accept",
    ]);
    expect(writes[0]?.keyed).toBe(true);
    // Still where she was working.
    expect(currentOrganizationId()).toBe(ACME.id);
    expect(app.router.state.location.pathname).toBe("/invitations");

    await app.person.click(
      await page.findByRole("button", { name: "Switch to Acme Research" }),
    );
    await waitFor(() => expect(currentOrganizationId()).toBe(RESEARCH.id));
    expect(server.active).toBe(RESEARCH.id);
    expect(app.router.state.location.pathname).toBe("/");
  });

  test("declining takes the invitation away, and with none left the page says so", async () => {
    server.received = [received("inv_1", "pending")];
    const app = await open("/invitations");
    const page = within(await app.view.findByRole("main"));
    await app.person.click(
      await page.findByRole("button", {
        name: "Decline invitation to Acme Research",
      }),
    );
    await page.findByText("No invitations");
    expect(sentWrites()).toEqual([
      "POST /api/v2/people/me/invitations/inv_1/decline",
    ]);
    expect(server.organizations.map((one) => one.id)).not.toContain(
      RESEARCH.id,
    );
  });

  test("an invitation that ran out while the page was open is refused in the server's sentence", async () => {
    server.received = [received("inv_1", "pending")];
    const app = await open("/invitations/inv_1");
    const page = within(await app.view.findByRole("main"));
    const accept = await page.findByRole("button", {
      name: "Accept invitation to Acme Research",
    });
    (server.received[0] as ReceivedInvitation).status = "expired";
    await app.person.click(accept);
    expect((await page.findByRole("alert")).textContent).toBe(
      "This invitation has expired. Ask whoever invited you to send a new one.",
    );
  });

  test.each([
    [
      "pending",
      "Lee Park invited you to join as a member. Expires in 6 days.",
      [
        "Decline invitation to Acme Research",
        "Accept invitation to Acme Research",
      ],
    ],
    [
      "accepted",
      "You're a member of Acme Research.",
      ["Switch to Acme Research"],
    ],
    ["declined", "You declined this invitation.", []],
    [
      "canceled",
      "This invitation was canceled. Ask Lee Park to send a new one.",
      [],
    ],
    [
      "expired",
      "This invitation has expired. Ask Lee Park to send a new one.",
      [],
    ],
  ] as const)(
    "the page a link opens says what happened to a %s invitation, to somebody working elsewhere",
    async (status, sentence, buttons) => {
      server.received = [received("inv_1", status)];
      const app = await open("/invitations/inv_1");
      const main = await app.view.findByRole("main");
      const page = within(main);
      await page.findByText(sentence);
      expect(page.getByText("Acme Research")).toBeTruthy();
      expect(
        [...main.querySelectorAll("[data-slot=item-actions] button")].map(
          (button) => button.getAttribute("aria-label") ?? button.textContent,
        ),
      ).toEqual([...buttons]);
      // Read as her own invitation, not as something of the organization she is working in.
      expect(requests).toContain("GET /api/v2/people/me/invitations/inv_1");
      expect(currentOrganizationId()).toBe(ACME.id);
    },
  );

  test("a link to an invitation that is not hers says what to check", async () => {
    const app = await open("/invitations/inv_someone_elses");
    const page = within(await app.view.findByRole("main"));
    await page.findByText("Invitation not found");
    expect(
      page.getByText(
        "Check that you're signed in with the address it was sent to.",
      ),
    ).toBeTruthy();
    expect(page.queryByRole("alert")).toBeNull();
  });
});
