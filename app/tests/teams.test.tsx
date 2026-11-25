import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
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
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { AdminSidebar } from "@/components/admin/admin-sidebar";
import { AppSidebar } from "@/components/app-sidebar/app-sidebar";
import { SidebarShell } from "@/components/layout/sidebar-shell";
import { OrganizationBoundary } from "@/components/organizations/organization-boundary";
import { NewTeamPage } from "@/components/teams/new-team-page";
import { TeamDetailPage } from "@/components/teams/team-page";
import { TeamsPage } from "@/components/teams/teams-page";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import type {
  OrganizationMember,
  Team,
  TeamMember,
} from "@/lib/api/generated/model";
import {
  getListOrganizationMembersMockHandler,
  getListOrganizationsMockHandler,
} from "@/lib/api/generated/organizations/organizations.msw";
import {
  ListOrganizationMembersQueryParams,
  ListOrganizationMembersResponse,
} from "@/lib/api/generated/organizations/organizations.zod";
import {
  getGetPersonMockHandler,
  getGetPersonResponseMock,
} from "@/lib/api/generated/people/people.msw";
import {
  getCreateTeamMockHandler,
  getDeleteTeamMockHandler,
  getGetTeamMockHandler,
  getGetTeamModelsMockHandler,
  getListTeamMembersMockHandler,
  getListTeamsMockHandler,
  getPutTeamMemberMockHandler,
  getRemoveTeamMemberMockHandler,
  getUpdateTeamMockHandler,
} from "@/lib/api/generated/teams/teams.msw";
import { deploymentKeys } from "@/lib/deployment/queries";
import { managementKeys } from "@/lib/management/queries";
import {
  currentOrganizationId,
  setCurrentOrganization,
} from "@/lib/organizations/current";
import {
  possibleParents,
  teamKeys,
  teamListQueryOptions,
} from "@/lib/teams/queries";
import { queryClient } from "@/query-client";
import { Route as AppTeamsRoute } from "@/routes/_authed/_app/teams";
import { Route as AppTeamRoute } from "@/routes/_authed/_app/teams_.$teamId";
import { Route as AppNewTeamRoute } from "@/routes/_authed/_app/teams_.new";
import { Route as AdminTeamsRoute } from "@/routes/_authed/admin/teams";
import { Route as AdminTeamRoute } from "@/routes/_authed/admin/teams_.$teamId";
import { Route as AdminNewTeamRoute } from "@/routes/_authed/admin/teams_.new";
import { settleReactWork } from "./settle-react-work";

/**
 * Teams inside an organization: the list, a team's page and New team, as a person uses them.
 *
 * The server is the spec's own: the MSW handlers Orval generates beside the client, at the API's
 * addresses (`/api/v2/organizations/{organizationId}/teams...`), answering from two organizations
 * that each keep their own teams. A team of another organization is not found, exactly as one that
 * does not exist. The screens are the real ones, on the app's one query client and a router.
 */

type Person = { id: string; email: string; name: string };
const DANA: Person = {
  id: "dana",
  email: "dana@acme.test",
  name: "Dana Whitfield",
};
const SAM: Person = { id: "sam", email: "sam@acme.test", name: "Sam Ortiz" };
const PRIYA: Person = {
  id: "priya",
  email: "priya@acme.test",
  name: "Priya Nair",
};
const TOM: Person = { id: "tom", email: "tom@acme.test", name: "Tom Becker" };
const INES: Person = {
  id: "ines",
  email: "ines@harbor.test",
  name: "Ines Duarte",
};

const ACME = "org_acme";
const HARBOR = "org_harbor";

type StoredTeam = Omit<
  Team,
  "memberCount" | "role" | "canManage" | "canMove" | "canDelete"
> & {
  members: { id: string; role: "maintainer" | "member" }[];
};
type Organization = {
  people: Person[];
  /** Who administers it: they create and delete teams, and manage every one. */
  admins: string[];
  teams: StoredTeam[];
};

let organizations: Record<string, Organization>;
/** Who is signed in. */
let me: Person;
/** Every write, as the server received it. */
let writes: {
  method: string;
  path: string;
  key: string | null;
  body: unknown;
}[];
/** Every request, method and path. */
let requests: string[];
/** Every read of an organization's members: which organization, and what was searched for. */
let searches: {
  organization: string;
  search: string | undefined;
  limit: number;
}[];

const stored = (
  id: string,
  name: string,
  rest: Partial<StoredTeam> = {},
): StoredTeam => ({
  id,
  name,
  description: null,
  parentTeamId: null,
  source: "openbot",
  createdAt: "2026-11-15T09:12:40.000Z",
  members: [],
  ...rest,
});

/** A team as the API answers it to the signed-in person, with the server's verdicts about them. */
function seen(organization: Organization, team: StoredTeam): Team {
  const { members, ...rest } = team;
  const own = members.find((member) => member.id === me.id);
  const fromDirectory = team.source === "directory";
  const admin = organization.admins.includes(me.id);
  return {
    ...rest,
    memberCount: members.length,
    role: own?.role ?? null,
    canManage: !fromDirectory && (admin || own?.role === "maintainer"),
    // Only an admin of the organization moves a team or deletes one, and never the directory's.
    canMove: admin,
    canDelete: admin && !fromDirectory,
  };
}

function notFound(detail: string): never {
  throw HttpResponse.json(
    { type: "about:blank", title: "Not found", status: 404, detail },
    { status: 404, headers: { "content-type": "application/problem+json" } },
  );
}

/** The organization a request names. One the person is not in is one that does not exist. */
function organizationOf(id: string): Organization {
  const organization = organizations[id];
  if (!organization?.people.some((person) => person.id === me.id))
    notFound("Couldn't find that organization.");
  return organization as Organization;
}

function teamOf(organizationId: string, teamId: string) {
  const organization = organizationOf(organizationId);
  const team = organization.teams.find((one) => one.id === teamId);
  if (!team) notFound("Couldn't find that team.");
  return { organization, team: team as StoredTeam };
}

/**
 * The server's search of an organization's members (listOrganizationMembers with search), as the
 * spec says it: a name, a word of it or an address starting with what was typed first, then any
 * that hold it, ignoring case, each group by name and then address. Over one organization's own
 * people and nobody else's.
 */
function searched(people: readonly Person[], typed: string): Person[] {
  const wanted = typed.toLowerCase();
  const rank = (person: Person) => {
    const name = person.name.toLowerCase();
    const email = person.email.toLowerCase();
    if (
      name.startsWith(wanted) ||
      name.includes(` ${wanted}`) ||
      email.startsWith(wanted)
    )
      return 0;
    return name.includes(wanted) || email.includes(wanted) ? 1 : undefined;
  };
  return people
    .flatMap((person) => {
      const found = rank(person);
      return found === undefined ? [] : [{ person, found }];
    })
    .sort(
      (a, b) =>
        a.found - b.found ||
        a.person.name
          .toLowerCase()
          .localeCompare(b.person.name.toLowerCase()) ||
        a.person.email.localeCompare(b.person.email),
    )
    .map(({ person }) => person);
}

const memberOf = (
  person: Person,
  role: "maintainer" | "member",
): TeamMember => ({
  id: person.id,
  email: person.email,
  name: person.name,
  image: null,
  role,
  isCaller: person.id === me.id,
  joinedAt: "2026-11-15T09:13:02.000Z",
});

const server = setupServer(
  getListTeamsMockHandler(({ params }) => {
    const organization = organizationOf(params.organizationId);
    return {
      teams: organization.teams.map((team) => seen(organization, team)),
      canCreate: organization.admins.includes(me.id),
      nextCursor: null,
    };
  }),
  getCreateTeamMockHandler(async ({ params, request }) => {
    const organization = organizationOf(params.organizationId);
    const body = await request.json();
    const team = stored(`team_${organization.teams.length + 1}`, body.name, {
      description: body.description ?? null,
      parentTeamId: body.parentTeamId ?? null,
    });
    organization.teams.push(team);
    return { team: seen(organization, team) };
  }),
  getGetTeamMockHandler(({ params }) => {
    const { organization, team } = teamOf(params.organizationId, params.teamId);
    return { team: seen(organization, team) };
  }),
  getUpdateTeamMockHandler(async ({ params, request }) => {
    const { organization, team } = teamOf(params.organizationId, params.teamId);
    const body = await request.json();
    if (body.name !== undefined) team.name = body.name;
    if (body.description !== undefined) team.description = body.description;
    if (body.parentTeamId !== undefined) team.parentTeamId = body.parentTeamId;
    return { team: seen(organization, team) };
  }),
  getDeleteTeamMockHandler(({ params }) => {
    const { organization, team } = teamOf(params.organizationId, params.teamId);
    organization.teams = organization.teams.filter((one) => one !== team);
    // Teams under it move up to its own parent.
    for (const other of organization.teams)
      if (other.parentTeamId === team.id)
        other.parentTeamId = team.parentTeamId;
  }),
  getListTeamMembersMockHandler(({ params }) => {
    const { organization, team } = teamOf(params.organizationId, params.teamId);
    return {
      members: team.members.map((member) =>
        memberOf(
          organization.people.find(
            (person) => person.id === member.id,
          ) as Person,
          member.role,
        ),
      ),
      nextCursor: null,
    };
  }),
  getPutTeamMemberMockHandler(async ({ params, request }) => {
    const { organization, team } = teamOf(params.organizationId, params.teamId);
    const person = organization.people.find(
      (one) => one.id === params.memberId,
    );
    if (!person) notFound("Couldn't find that person.");
    const { role } = await request.json();
    const already = team.members.find(
      (member) => member.id === params.memberId,
    );
    if (already) already.role = role;
    else team.members.push({ id: params.memberId, role });
    return { member: memberOf(person as Person, role) };
  }),
  getRemoveTeamMemberMockHandler(({ params }) => {
    const { team } = teamOf(params.organizationId, params.teamId);
    team.members = team.members.filter(
      (member) => member.id !== params.memberId,
    );
  }),
  // No team limits its models here (team-models.test.tsx covers those that do).
  getGetTeamModelsMockHandler(({ params }) => {
    teamOf(params.organizationId, params.teamId);
    return { models: null, updatedBy: null, updatedAt: null };
  }),
  // The person's own organizations, the one the app works in marked, as the sidebar asks for them.
  getListOrganizationsMockHandler(() => ({
    organizations: Object.entries(organizations)
      .filter(([, one]) => one.people.some((person) => person.id === me.id))
      .map(([id, one]) => ({
        id,
        slug: id,
        name: id,
        role: one.admins.includes(me.id)
          ? ("admin" as const)
          : ("member" as const),
        active: id === currentOrganizationId(),
        personal: false,
      })),
    canCreate: false,
    nextCursor: null,
  })),
  getListOrganizationMembersMockHandler(({ params, request }) => {
    const organization = organizationOf(params.organizationId);
    // The request as the spec takes it, and the answer as the spec gives it: a fake that drifts
    // from the generated schema fails here, not in the screen.
    const asked = Object.fromEntries(new URL(request.url).searchParams);
    // A whole number in the address, as the server reads one.
    const query = ListOrganizationMembersQueryParams.parse({
      ...asked,
      ...(asked.limit === undefined ? {} : { limit: Number(asked.limit) }),
    });
    searches.push({
      organization: params.organizationId,
      search: query.search,
      limit: query.limit,
    });
    const found = query.search?.trim()
      ? searched(organization.people, query.search.trim()).slice(0, query.limit)
      : organization.people;
    return ListOrganizationMembersResponse.parse({
      members: found.map(
        (person): OrganizationMember => ({
          id: person.id,
          email: person.email,
          name: person.name,
          image: null,
          role: organization.admins.includes(person.id) ? "admin" : "member",
          joinedAt: "2026-11-01T09:00:00.000Z",
          removable: false,
          assignableRoles: [],
        }),
      ),
      nextCursor: null,
    });
  }),
  getGetPersonMockHandler(({ params }) => {
    const organization = organizationOf(params.organizationId);
    return {
      ...getGetPersonResponseMock(),
      person: {
        ...getGetPersonResponseMock().person,
        id: me.id,
        email: me.email,
        name: me.name,
        role: organization.admins.includes(me.id) ? "admin" : "member",
      },
    };
  }),
  // Nothing else is these screens' business.
  http.all("*", () => new HttpResponse(null, { status: 404 })),
);
server.events.on("request:start", async ({ request }) => {
  const url = new URL(request.url);
  requests.push(`${request.method} ${url.pathname}`);
  if (request.method === "GET") return;
  const text = await request.clone().text();
  writes.push({
    method: request.method,
    path: url.pathname,
    key: request.headers.get("idempotency-key"),
    body: text ? JSON.parse(text) : undefined,
  });
});

/** The sidebar keeps a socket open for its conversations, which are not these screens' business. */
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
const originalWebSocket = globalThis.WebSocket;

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://openbot.invalid/" });
  server.listen({ onUnhandledRequest: "error" });
  // After the server is listening, which puts its own socket in the window's place.
  globalThis.WebSocket = OfflineWebSocket as unknown as typeof WebSocket;
});
beforeEach(() => {
  me = DANA;
  writes = [];
  requests = [];
  searches = [];
  organizations = {
    [ACME]: {
      people: [DANA, SAM, PRIYA, TOM],
      admins: [DANA.id],
      teams: [
        stored("team_sales", "Sales", {
          description: "Everybody who sells.",
          members: [
            { id: DANA.id, role: "maintainer" },
            { id: SAM.id, role: "member" },
          ],
        }),
        stored("team_emea", "Sales EMEA", {
          parentTeamId: "team_sales",
          members: [{ id: SAM.id, role: "maintainer" }],
        }),
        stored("team_finance", "Finance", {
          source: "directory",
          members: [{ id: TOM.id, role: "member" }],
        }),
      ],
    },
    [HARBOR]: {
      people: [INES, DANA],
      admins: [INES.id],
      teams: [
        stored("team_litigation", "Litigation", {
          members: [{ id: INES.id, role: "maintainer" }],
        }),
      ],
    },
  };
  setCurrentOrganization(ACME);
  queryClient.clear();
  queryClient.setQueryData(deploymentKeys.capabilities(), {
    generativeUi: true,
    selfHostBanner: false,
    localEvaluation: false,
    edition: "team",
  });
});
afterEach(() => {
  cleanup();
  queryClient.clear();
  server.resetHandlers();
});
afterAll(async () => {
  server.close();
  await settleReactWork();
  globalThis.WebSocket = originalWebSocket;
  GlobalRegistrator.unregister();
});

function Detail() {
  const { teamId } = useParams({ strict: false }) as { teamId: string };
  return <TeamDetailPage key={teamId} teamId={teamId} />;
}

/**
 * The three team screens at their own addresses, opened at `start`. With `sidebar`, they sit in the
 * app's frame beside its real sidebar, whose menu under the person's name is how Teams is reached.
 */
function open(start = "/teams", { sidebar = false } = {}) {
  const rootRoute = createRootRoute({
    // The app's own boundary: a switch builds every screen again for the new organization.
    component: () => (
      <OrganizationBoundary>
        {sidebar ? (
          <SidebarProvider>
            <AppSidebar />
            <main>
              <Outlet />
            </main>
          </SidebarProvider>
        ) : (
          <Outlet />
        )}
      </OrganizationBoundary>
    ),
  });
  const page = (path: string, component: () => React.ReactNode) =>
    createRoute({ getParentRoute: () => rootRoute, path, component });
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: [start] }),
    routeTree: rootRoute.addChildren([
      page("/", () => null),
      page("/teams", TeamsPage),
      page("/teams/new", NewTeamPage),
      page("/teams/$teamId", Detail),
    ]),
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
  return { view, router, person: userEvent.setup({ document }) };
}

/**
 * The app's own team routes, in both frames, placed as `routeTree.gen.ts` places them: a pathless
 * `_authed`, the app's pathless `_app` with its sidebar, and `admin` with Admin's sidebar and inset
 * panel (`routes/_authed/admin/route.tsx`). The guards in front of them are left out: the test
 * answers what they read.
 */
function openBothFrames(start: string) {
  const rootRoute = createRootRoute({
    component: () => (
      <OrganizationBoundary>
        <Outlet />
      </OrganizationBoundary>
    ),
  });
  const authed = createRoute({
    getParentRoute: () => rootRoute,
    id: "_authed",
  });
  const app = createRoute({
    getParentRoute: () => authed,
    id: "_app",
    component: () => (
      <SidebarProvider>
        <AppSidebar />
        <main>
          <Outlet />
        </main>
      </SidebarProvider>
    ),
  });
  const admin = createRoute({
    getParentRoute: () => authed,
    path: "admin",
    component: () => (
      <SidebarShell className="h-svh overflow-hidden">
        <AdminSidebar />
        <SidebarInset className="min-h-0 min-w-0 overflow-hidden">
          <Outlet />
        </SidebarInset>
      </SidebarShell>
    ),
  });
  const placed = (
    route: unknown,
    parent: () => unknown,
    id: string,
    path: string,
  ) =>
    (route as { update: (options: unknown) => never }).update({
      id,
      path,
      getParentRoute: parent,
    });
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: [start] }),
    routeTree: rootRoute.addChildren([
      authed.addChildren([
        app.addChildren([
          createRoute({
            getParentRoute: () => app,
            path: "/",
            component: () => null,
          }),
          placed(AppTeamsRoute, () => app, "/teams", "/teams"),
          placed(AppNewTeamRoute, () => app, "/teams_/new", "/teams/new"),
          placed(AppTeamRoute, () => app, "/teams_/$teamId", "/teams/$teamId"),
        ]),
        admin.addChildren([
          createRoute({
            getParentRoute: () => admin,
            path: "/",
            component: () => null,
          }),
          placed(AdminTeamsRoute, () => admin, "/teams", "/teams"),
          placed(AdminNewTeamRoute, () => admin, "/teams_/new", "/teams/new"),
          placed(
            AdminTeamRoute,
            () => admin,
            "/teams_/$teamId",
            "/teams/$teamId",
          ),
        ]),
      ]),
    ]),
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
  return { view, router, person: userEvent.setup({ document }) };
}

const KEY = expect.stringMatching(/^[0-9a-f]{32}$/);
const teamsPath = (organization: string) =>
  `/api/v2/organizations/${organization}/teams`;

/** The Add people dialog's type-ahead box. */
function box(dialog: HTMLElement): HTMLInputElement {
  return within(dialog).getByRole("combobox", {
    name: "Name or email",
  }) as HTMLInputElement;
}

/** The people the box lists, by name, as they are offered. */
function offered(dialog: HTMLElement): string[] {
  return within(dialog)
    .queryAllByRole("option")
    .map((option) => option.querySelector("p")?.textContent ?? "");
}

/** Type into the box until `name` is highlighted, then press Enter, and wait for them to be added. */
async function addThroughTheBox(
  dialog: HTMLElement,
  person: ReturnType<typeof userEvent.setup>,
  typed: string,
  name: string,
) {
  await person.type(box(dialog), typed);
  await waitFor(() =>
    expect(highlighted(dialog)?.textContent ?? "").toContain(name),
  );
  await person.keyboard("{Enter}");
  expect(
    await within(
      within(dialog).getByRole("region", { name: /^Added to / }),
    ).findByText(name),
  ).toBeTruthy();
}

/** The option the box points at (aria-activedescendant), if any. */
function highlighted(dialog: HTMLElement): HTMLElement | null {
  const id = box(dialog).getAttribute("aria-activedescendant");
  return id ? dialog.ownerDocument.getElementById(id) : null;
}

/** A row of the page, by the name it is titled with. */
function row(view: ReturnType<typeof render>, title: string): HTMLElement {
  const found = view
    .getAllByText(title)
    .map((node) => node.closest("[data-slot=item]"))
    .find(Boolean);
  if (!found) throw new Error(`no row titled ${title}`);
  return found as HTMLElement;
}

test("the list names each team, what it is for, how many people it has, where it comes from and the reader's role", async () => {
  const { view } = open();
  const sales = within(
    await view.findByRole("link", { name: /^Sales\b(?! EMEA)/ }),
  );
  expect(sales.getByText("Everybody who sells.")).toBeTruthy();
  expect(sales.getByText("2 people · You're a maintainer")).toBeTruthy();
  // A team under another says which, and one from the directory says so.
  expect(row(view, "Sales EMEA").textContent).toContain(
    "1 person · Under Sales",
  );
  expect(row(view, "Finance").textContent).toContain(
    "1 person · From your company's directory",
  );
  expect(view.getByRole("link", { name: /Finance/ }).getAttribute("href")).toBe(
    "/teams/team_finance",
  );
  expect(requests).toContain(`GET ${teamsPath(ACME)}`);
});

test("an admin creates a team on its own screen and lands on the new team's page", async () => {
  const { view, router, person } = open();
  await person.click(await view.findByRole("button", { name: "New team" }));
  await view.findByRole("heading", { level: 1, name: "New team" });
  expect(router.state.location.pathname).toBe("/teams/new");

  // A team needs a name before anything is sent.
  await person.click(view.getByRole("button", { name: "Create team" }));
  expect((await view.findByRole("alert")).textContent).toBe(
    "Give the team a name.",
  );
  expect(writes).toEqual([]);

  await person.type(view.getByLabelText("Name"), "Support");
  await person.type(view.getByLabelText("Description"), "Answers customers.");
  // Under another team: never one from the directory, which can't be a parent.
  await person.click(view.getByRole("combobox", { name: "Parent team" }));
  expect(
    (await view.findAllByRole("option")).map((option) => option.textContent),
  ).toEqual(["None", "Sales", "Sales EMEA"]);
  await person.click(view.getByRole("option", { name: "Sales" }));
  await person.click(view.getByRole("button", { name: "Create team" }));

  await view.findByRole("heading", { level: 1, name: "Support" });
  expect(router.state.location.pathname).toBe("/teams/team_4");
  expect(writes).toEqual([
    {
      method: "POST",
      path: teamsPath(ACME),
      key: KEY,
      body: {
        name: "Support",
        description: "Answers customers.",
        parentTeamId: "team_sales",
      },
    },
  ]);
  // Nobody is in it yet, and the page says how they get there.
  expect(await view.findByText("Nobody is in this team yet")).toBeTruthy();
  expect(row(view, "Parent team").textContent).toContain("Sales.");

  // Back on the list, it is there.
  await person.click(view.getByRole("button", { name: "Teams" }));
  expect(await view.findByRole("link", { name: /Support/ })).toBeTruthy();
});

test("somebody who may not create a team is not offered New team, and an empty list says how the first one arrives", async () => {
  me = SAM;
  const { view } = open();
  await view.findByRole("link", { name: /Sales EMEA/ });
  expect(view.queryByRole("button", { name: "New team" })).toBeNull();
  cleanup();
  queryClient.removeQueries({ queryKey: teamKeys.all });

  (organizations[ACME] as Organization).teams = [];
  const empty = open();
  expect(await empty.view.findByText("No teams yet")).toBeTruthy();
  expect(
    empty.view.getByText(
      "An admin creates teams. Groups from your company's directory show up as teams too.",
    ),
  ).toBeTruthy();
  expect(empty.view.queryByRole("button", { name: "New team" })).toBeNull();
  cleanup();
  queryClient.removeQueries({ queryKey: teamKeys.all });

  // The same empty list, for an admin, offers the first one.
  me = DANA;
  const admin = open();
  expect(await admin.view.findByText("No teams yet")).toBeTruthy();
  expect(admin.view.getAllByRole("button", { name: "New team" })).toHaveLength(
    2,
  );
});

test("a member who isn't an admin opens Teams from the menu under their name, sees which teams they're in, reads one and can leave it", async () => {
  me = SAM;
  const { view, router, person } = open("/", { sidebar: true });
  await person.click(await view.findByRole("button", { name: /Sam Ortiz/ }));
  const menu = await view.findByRole("menu");
  // No Admin for them, and Teams all the same.
  expect(within(menu).queryByRole("menuitem", { name: "Admin" })).toBeNull();
  const entry = within(menu).getByRole("menuitem", { name: "Teams" });
  expect(entry.getAttribute("href")).toBe("/teams");
  await person.click(entry);
  await view.findByRole("heading", { level: 1, name: "Teams" });
  expect(router.state.location.pathname).toBe("/teams");

  // Every team of the organization, and their own role on the ones they are in.
  await view.findByRole("link", { name: /Finance/ });
  expect(row(view, "Sales").textContent).toContain("You're a member");
  expect(row(view, "Sales EMEA").textContent).toContain("You're a maintainer");
  expect(row(view, "Finance").textContent).not.toContain("You're");
  expect(view.queryByRole("button", { name: "New team" })).toBeNull();

  await person.click(view.getByRole("link", { name: /^Sales\b(?! EMEA)/ }));
  await view.findByRole("heading", { level: 1, name: "Sales" });
  expect(router.state.location.pathname).toBe("/teams/team_sales");
  await view.findByText("Dana Whitfield");
  // Roles are read, not chosen; nobody is added or removed; the team is not renamed or deleted.
  expect(
    within(row(view, "Dana Whitfield")).getByText("Maintainer"),
  ).toBeTruthy();
  expect(within(row(view, "Sam Ortiz")).getByText("Member")).toBeTruthy();
  expect(view.queryByRole("combobox")).toBeNull();
  expect(view.queryByRole("button", { name: "Add person" })).toBeNull();
  expect(view.queryByRole("button", { name: /^Remove/ })).toBeNull();
  expect(
    view.queryByRole("button", { name: /Name and description/ }),
  ).toBeNull();
  expect(view.queryByRole("button", { name: /Parent team/ })).toBeNull();
  expect(view.queryByRole("button", { name: "Delete team" })).toBeNull();
  // Only their own row offers anything: to leave.
  expect(view.getAllByRole("button", { name: "Leave team" })).toHaveLength(1);
  expect(row(view, "Sam Ortiz").textContent).toContain("You");

  await person.click(view.getByRole("button", { name: "Leave team" }));
  const dialog = await view.findByRole("dialog", { name: "Leave “Sales”?" });
  expect(writes).toEqual([]);
  await person.click(
    within(dialog).getByRole("button", { name: "Leave team" }),
  );
  // Gone from the team's people (the sidebar still names them, as the person signed in).
  const page = within(view.getByRole("main"));
  await waitFor(() => expect(page.queryByText("Sam Ortiz")).toBeNull());
  expect(page.getByText("Dana Whitfield")).toBeTruthy();
  expect(writes).toEqual([
    {
      method: "DELETE",
      path: `${teamsPath(ACME)}/team_sales/members/sam`,
      key: KEY,
      body: undefined,
    },
  ]);
  expect(view.queryByRole("button", { name: "Leave team" })).toBeNull();
});

test("a maintainer who isn't an admin renames their team, adds a person, makes them a maintainer and removes another, and is offered nothing else", async () => {
  me = SAM;
  (organizations[ACME] as Organization).teams
    .find((team) => team.id === "team_emea")
    ?.members.push({ id: TOM.id, role: "member" });
  const { view, person } = open("/teams/team_emea");
  await view.findByRole("heading", { level: 1, name: "Sales EMEA" });
  await view.findByText("Tom Becker");
  // The team's parent is read, not changed, and the team is not deleted: those are an admin's.
  expect(row(view, "Parent team").textContent).toContain("Sales.");
  expect(view.queryByRole("button", { name: /Parent team/ })).toBeNull();
  expect(view.queryByRole("button", { name: "Delete team" })).toBeNull();
  expect(view.queryByRole("heading", { name: "Delete" })).toBeNull();

  await person.click(
    view.getByRole("button", { name: /Name and description/ }),
  );
  const details = await view.findByRole("dialog", {
    name: "Name and description",
  });
  const name = within(details).getByLabelText("Name");
  await person.clear(name);
  await person.type(name, "Sales Europe");
  await person.click(within(details).getByRole("button", { name: "Save" }));
  await view.findByRole("heading", { level: 1, name: "Sales Europe" });

  await person.click(view.getByRole("button", { name: "Add person" }));
  const dialog = await view.findByRole("dialog", {
    name: "Add people to Sales Europe",
  });
  await addThroughTheBox(dialog, person, "priya", "Priya Nair");
  await person.click(within(dialog).getByRole("button", { name: "Done" }));
  await waitFor(() => expect(view.queryByRole("dialog")).toBeNull());

  await person.click(
    await view.findByRole("combobox", { name: "Role of Priya Nair" }),
  );
  await person.click(await view.findByRole("option", { name: "Maintainer" }));
  await waitFor(() =>
    expect(
      view.getByRole("combobox", { name: "Role of Priya Nair" }).textContent,
    ).toContain("Maintainer"),
  );
  await person.click(view.getByRole("button", { name: "Remove Tom Becker" }));
  await waitFor(() => expect(view.queryByText("Tom Becker")).toBeNull());
  // Their own row offers leaving, never removing.
  expect(view.queryByRole("button", { name: "Remove Sam Ortiz" })).toBeNull();
  expect(view.getAllByRole("button", { name: "Leave team" })).toHaveLength(1);

  const team = `${teamsPath(ACME)}/team_emea`;
  expect(writes).toEqual([
    {
      method: "PATCH",
      path: team,
      key: KEY,
      body: { name: "Sales Europe", description: null },
    },
    {
      method: "PUT",
      path: `${team}/members/priya`,
      key: KEY,
      body: { role: "member" },
    },
    {
      method: "PUT",
      path: `${team}/members/priya`,
      key: KEY,
      body: { role: "maintainer" },
    },
    {
      method: "DELETE",
      path: `${team}/members/tom`,
      key: KEY,
      body: undefined,
    },
  ]);

  // Back on the list, creating a team is still not theirs.
  await person.click(view.getByRole("button", { name: "Teams" }));
  await view.findByRole("link", { name: /Sales Europe/ });
  expect(view.queryByRole("button", { name: "New team" })).toBeNull();
});

test("what a team's page offers is the server's verdict on it, whoever the person is", async () => {
  // An admin the server lets do nothing to this team is offered nothing.
  server.use(
    getGetTeamMockHandler(({ params }) => {
      const { organization, team } = teamOf(
        params.organizationId,
        params.teamId,
      );
      return {
        team: {
          ...seen(organization, team),
          canManage: false,
          canMove: false,
          canDelete: false,
        },
      };
    }),
  );
  const admin = open("/teams/team_emea");
  await admin.view.findByText("Sam Ortiz");
  expect(
    admin.view.queryByRole("button", { name: /Name and description/ }),
  ).toBeNull();
  expect(admin.view.queryByRole("button", { name: "Add person" })).toBeNull();
  expect(admin.view.queryByRole("combobox")).toBeNull();
  expect(admin.view.queryByRole("button", { name: /Parent team/ })).toBeNull();
  expect(admin.view.queryByRole("button", { name: "Delete team" })).toBeNull();
  cleanup();
  queryClient.removeQueries({ queryKey: teamKeys.all });

  // Somebody who creates no teams, let to move and delete this one, is offered exactly those; and
  // "you" is the person the server says is asking, whoever is signed in.
  me = SAM;
  server.use(
    getGetTeamMockHandler(({ params }) => {
      const { organization, team } = teamOf(
        params.organizationId,
        params.teamId,
      );
      return {
        team: {
          ...seen(organization, team),
          canManage: false,
          canMove: true,
          canDelete: true,
        },
      };
    }),
    getListTeamMembersMockHandler(() => ({
      members: [
        { ...memberOf(DANA, "maintainer"), isCaller: false },
        { ...memberOf(SAM, "member"), isCaller: false },
        { ...memberOf(TOM, "member"), isCaller: true },
      ],
      nextCursor: null,
    })),
  );
  const { view, person } = open("/teams/team_sales");
  await view.findByText("Tom Becker");
  expect(view.getByRole("button", { name: /Parent team/ })).toBeTruthy();
  expect(view.getByRole("button", { name: "Delete team" })).toBeTruthy();
  expect(
    view.queryByRole("button", { name: /Name and description/ }),
  ).toBeNull();
  expect(view.queryByRole("button", { name: "Add person" })).toBeNull();
  expect(row(view, "Tom Becker").textContent).toContain("You");
  expect(row(view, "Sam Ortiz").textContent).not.toContain("You");
  await person.click(
    within(row(view, "Tom Becker")).getByRole("button", { name: "Leave team" }),
  );
  const leave = await view.findByRole("dialog", { name: "Leave “Sales”?" });
  await person.click(within(leave).getByRole("button", { name: "Leave team" }));
  await waitFor(() => expect(writes).toHaveLength(1));
  expect(writes[0]).toMatchObject({
    method: "DELETE",
    path: `${teamsPath(ACME)}/team_sales/members/tom`,
  });
});

test("an admin has Teams in the same menu, beside Admin, and is offered New team there", async () => {
  const { view, router, person } = open("/", { sidebar: true });
  await person.click(
    await view.findByRole("button", { name: /Dana Whitfield/ }),
  );
  const menu = await view.findByRole("menu");
  expect(within(menu).getByRole("menuitem", { name: "Admin" })).toBeTruthy();
  await person.click(within(menu).getByRole("menuitem", { name: "Teams" }));
  await view.findByRole("link", { name: /Sales EMEA/ });
  expect(router.state.location.pathname).toBe("/teams");
  expect(view.getByRole("button", { name: "New team" })).toBeTruthy();
});

test("an admin who opens Teams from Admin's sidebar stays in Admin through the list, a team, New team and back, and the app's Teams stays in the app", async () => {
  // Admin's sidebar reads whether Managed updates applies; here it does not.
  queryClient.setQueryData(managementKeys.status(), { applies: false });
  const { view, router, person } = openBothFrames("/admin");
  const backToApp = () => view.queryByRole("link", { name: "Back to app" });
  const adminTeams = () =>
    view
      .getAllByRole("link", { name: "Teams" })
      .find((link) => link.closest('[data-slot="sidebar"]'));
  const inAdmin = (path: string) => {
    expect(router.state.location.pathname).toBe(path);
    expect(backToApp()).toBeTruthy();
    // Teams is the sidebar's current entry, on the list and on every page under it.
    expect(adminTeams()?.getAttribute("data-status")).toBe("active");
  };

  await view.findByRole("link", { name: "Back to app" });
  const entry = adminTeams();
  expect(entry?.getAttribute("href")).toBe("/admin/teams");
  await person.click(entry as HTMLElement);
  await view.findByRole("heading", { level: 1, name: "Teams" });
  await view.findByRole("link", { name: /Finance/ });
  inAdmin("/admin/teams");

  // A team opens under Admin, and its back button returns to Admin's list.
  const sales = view.getByRole("link", { name: /^Sales\b(?! EMEA)/ });
  expect(sales.getAttribute("href")).toBe("/admin/teams/team_sales");
  await person.click(sales);
  await view.findByRole("heading", { level: 1, name: "Sales" });
  inAdmin("/admin/teams/team_sales");
  await person.click(view.getByRole("button", { name: "Teams" }));
  await view.findByRole("link", { name: /Finance/ });
  inAdmin("/admin/teams");

  // New team too: Cancel goes back to Admin's list, and a new team opens under Admin.
  await person.click(view.getByRole("button", { name: "New team" }));
  await view.findByRole("heading", { level: 1, name: "New team" });
  inAdmin("/admin/teams/new");
  await person.click(view.getByRole("button", { name: "Cancel" }));
  await view.findByRole("link", { name: /Finance/ });
  inAdmin("/admin/teams");
  await person.click(view.getByRole("button", { name: "New team" }));
  await person.type(await view.findByLabelText("Name"), "Support");
  await person.click(view.getByRole("button", { name: "Create team" }));
  await view.findByRole("heading", { level: 1, name: "Support" });
  inAdmin("/admin/teams/team_4");

  // Deleting a team from Admin lands on Admin's list.
  await person.click(view.getByRole("button", { name: "Delete team" }));
  const confirm = await view.findByRole("dialog", {
    name: "Delete “Support”?",
  });
  await person.click(
    within(confirm).getByRole("button", { name: "Delete team" }),
  );
  await waitFor(() =>
    expect(router.state.location.pathname).toBe("/admin/teams"),
  );
  await view.findByRole("link", { name: /Finance/ });
  inAdmin("/admin/teams");

  // The app's Teams, from the menu under the person's name, is still the app's page.
  await person.click(view.getByRole("link", { name: "Back to app" }));
  await person.click(
    await view.findByRole("button", { name: /Dana Whitfield/ }),
  );
  const menu = await view.findByRole("menu");
  const appEntry = within(menu).getByRole("menuitem", { name: "Teams" });
  expect(appEntry.getAttribute("href")).toBe("/teams");
  await person.click(appEntry);
  await view.findByRole("link", { name: /Finance/ });
  expect(router.state.location.pathname).toBe("/teams");
  expect(backToApp()).toBeNull();
  expect(view.getByRole("link", { name: /Finance/ }).getAttribute("href")).toBe(
    "/teams/team_finance",
  );
});

test("somebody who may not create a team and opens New team by its address is told an admin does", async () => {
  me = SAM;
  const { view } = open("/teams/new");
  await view.findByRole("heading", { level: 1, name: "New team" });
  expect(await view.findByText("Only an admin can create a team")).toBeTruthy();
  expect(view.queryByRole("button", { name: "Create team" })).toBeNull();
  expect(view.queryByLabelText("Name")).toBeNull();
});

test("somebody who manages a team adds a person from the organization, makes them a maintainer and removes another", async () => {
  const { view, person } = open("/teams/team_sales");
  await view.findByText("Sam Ortiz");
  await person.click(view.getByRole("button", { name: "Add person" }));
  const dialog = await view.findByRole("dialog", {
    name: "Add people to Sales",
  });
  // Chosen with the pointer this time: typed, then pressed in the list.
  await person.type(box(dialog), "pri");
  await person.click(
    await within(dialog).findByRole("option", { name: /Priya Nair/ }),
  );
  // She is in, and listed as added.
  expect(
    await within(
      within(dialog).getByRole("region", { name: "Added to Sales" }),
    ).findByText("Priya Nair"),
  ).toBeTruthy();
  await person.click(within(dialog).getByRole("button", { name: "Done" }));
  await waitFor(() => expect(view.queryByRole("dialog")).toBeNull());
  expect(await view.findByText("Priya Nair")).toBeTruthy();

  await person.click(
    view.getByRole("combobox", { name: "Role of Priya Nair" }),
  );
  await person.click(await view.findByRole("option", { name: "Maintainer" }));
  await waitFor(() =>
    expect(
      view.getByRole("combobox", { name: "Role of Priya Nair" }).textContent,
    ).toContain("Maintainer"),
  );

  await person.click(view.getByRole("button", { name: "Remove Sam Ortiz" }));
  await waitFor(() => expect(view.queryByText("Sam Ortiz")).toBeNull());

  const members = `${teamsPath(ACME)}/team_sales/members`;
  expect(writes).toEqual([
    {
      method: "PUT",
      path: `${members}/priya`,
      key: KEY,
      body: { role: "member" },
    },
    {
      method: "PUT",
      path: `${members}/priya`,
      key: KEY,
      body: { role: "maintainer" },
    },
    { method: "DELETE", path: `${members}/sam`, key: KEY, body: undefined },
  ]);
  // Each write is its own, so a retry of one is never taken for another.
  expect(new Set(writes.map((write) => write.key)).size).toBe(3);
});

test("a team from the company's directory says so, and an admin changes nothing about it but the team it is under", async () => {
  const { view } = open("/teams/team_finance");
  await view.findByRole("heading", { level: 1, name: "Finance" });
  await view.findByText("Tom Becker");
  expect(view.getByText("From your company's directory")).toBeTruthy();
  expect(
    view.getByText(
      "Its name and people come from the directory. Change them there.",
    ),
  ).toBeTruthy();
  expect(view.queryByRole("button", { name: "Add person" })).toBeNull();
  expect(view.queryByRole("combobox")).toBeNull();
  expect(view.queryByRole("button", { name: /^Remove/ })).toBeNull();
  expect(view.queryByRole("button", { name: "Leave team" })).toBeNull();
  expect(
    view.queryByRole("button", { name: /Name and description/ }),
  ).toBeNull();
  // The server lets an admin put it under another team, and never delete it.
  expect(view.getByRole("button", { name: /Parent team/ })).toBeTruthy();
  expect(view.queryByRole("button", { name: "Delete team" })).toBeNull();
  expect(view.queryByRole("heading", { name: "Delete" })).toBeNull();
});

test("somebody in a directory team can't leave it here: the directory decides", async () => {
  me = TOM;
  const { view } = open("/teams/team_finance");
  await view.findByText("Tom Becker");
  expect(row(view, "Tom Becker").textContent).toContain("You");
  expect(view.queryByRole("button", { name: "Leave team" })).toBeNull();
});

test("an admin renames a team, moves it under another, and deletes it only after confirming", async () => {
  const { view, router, person } = open("/teams/team_emea");
  await view.findByRole("heading", { level: 1, name: "Sales EMEA" });

  await person.click(
    view.getByRole("button", { name: /Name and description/ }),
  );
  const details = await view.findByRole("dialog", {
    name: "Name and description",
  });
  const name = within(details).getByLabelText("Name");
  await person.clear(name);
  await person.type(name, "Sales Europe");
  await person.click(within(details).getByRole("button", { name: "Save" }));
  await view.findByRole("heading", { level: 1, name: "Sales Europe" });

  // The teams it may sit under: not itself, and never one from the directory.
  await person.click(view.getByRole("button", { name: /Parent team/ }));
  const parent = await view.findByRole("dialog", { name: "Parent team" });
  await person.click(
    within(parent).getByRole("combobox", { name: "Parent team" }),
  );
  expect(
    (await view.findAllByRole("option")).map((option) => option.textContent),
  ).toEqual(["None", "Sales"]);
  await person.click(view.getByRole("option", { name: "None" }));
  await person.click(within(parent).getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(row(view, "Parent team").textContent).toContain("None"),
  );

  await person.click(view.getByRole("button", { name: "Delete team" }));
  const confirm = await view.findByRole("dialog", {
    name: "Delete “Sales Europe”?",
  });
  // Nothing is deleted until the dialog's own button is pressed.
  expect(writes.filter((write) => write.method === "DELETE")).toEqual([]);
  await person.click(
    within(confirm).getByRole("button", { name: "Delete team" }),
  );
  await waitFor(() => expect(router.state.location.pathname).toBe("/teams"));
  await view.findByRole("link", { name: /^Sales\b/ });
  expect(view.queryByText("Sales Europe")).toBeNull();

  const team = `${teamsPath(ACME)}/team_emea`;
  expect(writes).toEqual([
    {
      method: "PATCH",
      path: team,
      key: KEY,
      body: { name: "Sales Europe", description: null },
    },
    { method: "PATCH", path: team, key: KEY, body: { parentTeamId: null } },
    { method: "DELETE", path: team, key: KEY, body: undefined },
  ]);
});

test("deleting a team goes to the list without ever saying the team can't be found", async () => {
  const { view, router, person } = open("/teams/team_emea");
  await view.findByRole("heading", { level: 1, name: "Sales EMEA" });
  // Everything the page says from the moment Delete is pressed until the list is there.
  const said: string[] = [];
  const watcher = new MutationObserver(() => {
    said.push(document.body.textContent ?? "");
  });
  watcher.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
  });
  try {
    await person.click(view.getByRole("button", { name: "Delete team" }));
    const confirm = await view.findByRole("dialog", {
      name: "Delete “Sales EMEA”?",
    });
    await person.click(
      within(confirm).getByRole("button", { name: "Delete team" }),
    );
    await waitFor(() => expect(router.state.location.pathname).toBe("/teams"));
    await view.findByRole("link", { name: /^Sales\b/ });
  } finally {
    watcher.disconnect();
  }
  // The person deleted it on purpose: no error for that, not even for a moment.
  expect(
    said.filter((text) => text.includes("Couldn't find that team")),
  ).toEqual([]);
  // And nothing of the deleted team's page stays read.
  expect(
    requests.filter(
      (request) => request === `GET ${teamsPath(ACME)}/team_emea`,
    ),
  ).toHaveLength(1);
});

test("a team is never offered itself, a team under it, or a directory team as its parent", () => {
  const team = (id: string, rest: Partial<Team> = {}): Team => ({
    id,
    name: id,
    description: null,
    parentTeamId: null,
    source: "openbot",
    memberCount: 0,
    role: null,
    canManage: true,
    canMove: true,
    canDelete: true,
    createdAt: "2026-11-15T09:12:40.000Z",
    ...rest,
  });
  const teams = [
    team("sales"),
    team("emea", { parentTeamId: "sales" }),
    team("dach", { parentTeamId: "emea" }),
    team("support"),
    team("finance", { source: "directory" }),
  ];
  const ids = (found: Team[]) => found.map((one) => one.id);
  // Under Sales at any depth is out, as Sales itself is.
  expect(ids(possibleParents(teams, "sales"))).toEqual(["support"]);
  expect(ids(possibleParents(teams, "emea"))).toEqual(["sales", "support"]);
  expect(ids(possibleParents(teams, "dach"))).toEqual([
    "sales",
    "emea",
    "support",
  ]);
  // A new team may go under any team that is not the directory's.
  expect(ids(possibleParents(teams))).toEqual([
    "sales",
    "emea",
    "dach",
    "support",
  ]);
});

/** Everything the app holds in its cache, as text, to look for a row that should not be there. */
const everythingCached = () =>
  JSON.stringify(
    queryClient
      .getQueryCache()
      .getAll()
      .map((query) => query.state.data),
  );

test("switching organization drops the other organization's teams, and a team of another organization is not found", async () => {
  // Dana is in both. In Acme she sees Acme's teams.
  const { view } = open();
  await view.findByRole("link", { name: /Sales EMEA/ });
  expect(everythingCached()).toContain("Sales EMEA");
  expect(everythingCached()).not.toContain("Litigation");

  // She switches to Harbor Legal: nothing of Acme's teams is held or drawn, and Harbor's are asked for.
  setCurrentOrganization(HARBOR);
  await view.findByRole("link", { name: /Litigation/ });
  expect(everythingCached()).not.toContain("Sales");
  expect(document.body.textContent).not.toContain("Sales");
  expect(document.body.textContent).not.toContain("Finance");
  expect(requests).toContain(`GET ${teamsPath(HARBOR)}`);
  expect(
    (await queryClient.fetchQuery(teamListQueryOptions())).teams.map(
      (team) => team.name,
    ),
  ).toEqual(["Litigation"]);
  cleanup();

  // An Acme team opened by its address while working in Harbor Legal is not found, as one that
  // does not exist is.
  const other = open("/teams/team_sales");
  // The app asks once more before it gives up, as it does for every read.
  const refused = { timeout: 5_000 };
  expect((await other.view.findByRole("alert", {}, refused)).textContent).toBe(
    "Couldn't find that team.",
  );
  expect(document.body.textContent).not.toContain("Everybody who sells.");
  cleanup();
  const missing = open("/teams/team_nowhere");
  expect(
    (await missing.view.findByRole("alert", {}, refused)).textContent,
  ).toBe("Couldn't find that team.");

  // Back in Acme, Harbor's team is gone in turn.
  setCurrentOrganization(ACME);
  expect(everythingCached()).not.toContain("Litigation");
}, 20_000);

/** Opens a team's Add people dialog, as somebody who manages it. */
async function openAddPeople(path: string, team: string) {
  const opened = open(path);
  await opened.view.findByRole("heading", { level: 1, name: team });
  await opened.person.click(
    await opened.view.findByRole("button", { name: "Add person" }),
  );
  const dialog = await opened.view.findByRole("dialog", {
    name: `Add people to ${team}`,
  });
  return { ...opened, dialog };
}

test("typing in Add people asks the server for this organization's members that match, from the first letter, best first, with what matched in bold", async () => {
  const { dialog, person } = await openAddPeople("/teams/team_sales", "Sales");
  // Nothing is loaded before anything is typed: the box asks as it is typed into.
  expect(within(dialog).queryByRole("listbox")).toBeNull();
  expect(box(dialog).getAttribute("aria-expanded")).toBe("false");

  // One letter is enough. "o" starts Sam's last name and is inside Tom's first.
  await person.type(box(dialog), "o");
  await waitFor(() =>
    expect(offered(dialog)).toEqual(["Sam Ortiz", "Tom Becker"]),
  );
  expect(box(dialog).getAttribute("aria-expanded")).toBe("true");
  expect(box(dialog).getAttribute("aria-autocomplete")).toBe("both");
  expect(box(dialog).getAttribute("aria-controls")).toBe(
    within(dialog).getByRole("listbox").id,
  );
  // What matched is drawn in bold: the start of "Ortiz", the "o" in "Tom".
  const marks = within(dialog)
    .getAllByRole("option")
    .map((option) => option.querySelector("mark")?.textContent);
  expect(marks).toEqual(["O", "o"]);
  // How many were found is said to a screen reader.
  expect(within(dialog).getByRole("status").textContent).toBe("2 people found");

  await person.type(box(dialog), "rt");
  await waitFor(() => expect(offered(dialog)).toEqual(["Sam Ortiz"]));

  // Every read was a search of this organization, a page of eight at most: nobody was loaded
  // whole, and no other organization was asked.
  expect(searches.length).toBeGreaterThan(0);
  for (const read of searches) {
    expect(read.organization).toBe(ACME);
    expect(read.search?.length).toBeGreaterThan(0);
    expect(read.limit).toBe(8);
  }
  expect(searches.at(-1)?.search).toBe("ort");
});

test("Add people is driven from the keyboard: the best match completes in the box, Enter adds, Tab takes the completion, Escape closes then clears, and the box keeps focus throughout", async () => {
  const { dialog, person, view } = await openAddPeople(
    "/teams/team_sales",
    "Sales",
  );
  const input = box(dialog);
  expect(document.activeElement).toBe(input);

  // "pr": Priya is highlighted, and the box completes to her name, written as hers, with the part
  // not typed selected after the caret.
  await person.type(input, "pr");
  await waitFor(() => expect(input.value).toBe("Priya Nair"));
  expect([input.selectionStart, input.selectionEnd]).toEqual([2, 10]);
  expect(highlighted(dialog)?.textContent).toContain("Priya Nair");
  expect(highlighted(dialog)?.getAttribute("aria-selected")).toBe("true");

  // Deleting never completes: Backspace takes away the completion, and it doesn't come back.
  await person.keyboard("{Backspace}");
  expect(input.value).toBe("Pr");
  await new Promise((settle) => setTimeout(settle, 300));
  expect(input.value).toBe("Pr");
  // Typing on completes again, and the next letter keeps the same person.
  await person.keyboard("i");
  await waitFor(() => expect(input.value).toBe("Priya Nair"));
  expect([input.selectionStart, input.selectionEnd]).toEqual([3, 10]);

  // Enter adds her, empties the box and keeps it focused, ready for the next person.
  await person.keyboard("{Enter}");
  expect(
    await within(
      within(dialog).getByRole("region", { name: "Added to Sales" }),
    ).findByText("Priya Nair"),
  ).toBeTruthy();
  expect(input.value).toBe("");
  expect(document.activeElement).toBe(input);
  expect(within(dialog).getByRole("status").textContent).toBe(
    "Priya Nair added to Sales",
  );

  // "to": Tab takes the completion into the box; Enter then adds Tom.
  await person.type(input, "to");
  await waitFor(() => expect(input.value).toBe("Tom Becker"));
  await person.keyboard("{Tab}");
  expect(input.value).toBe("Tom Becker");
  expect([input.selectionStart, input.selectionEnd]).toEqual([10, 10]);
  expect(document.activeElement).toBe(input);
  await waitFor(() => expect(searches.at(-1)?.search).toBe("tom becker"));
  await waitFor(() =>
    expect(highlighted(dialog)?.textContent).toContain("Tom Becker"),
  );
  await person.keyboard("{Enter}");
  await waitFor(() => expect(input.value).toBe(""));
  expect(document.activeElement).toBe(input);

  await person.type(input, "zz");
  expect(
    await within(dialog).findByText(
      "Nobody in this organization matches “zz”.",
    ),
  ).toBeTruthy();
  // Escape closes the list and keeps what was typed, then empties the box, then closes the dialog.
  await person.keyboard("{Escape}");
  expect(input.getAttribute("aria-expanded")).toBe("false");
  expect(input.value).toBe("zz");
  expect(view.getByRole("dialog")).toBeTruthy();
  await person.keyboard("{Escape}");
  expect(input.value).toBe("");
  expect(view.getByRole("dialog")).toBeTruthy();
  await person.keyboard("{Escape}");
  await waitFor(() => expect(view.queryByRole("dialog")).toBeNull());

  const members = `${teamsPath(ACME)}/team_sales/members`;
  expect(writes).toEqual([
    {
      method: "PUT",
      path: `${members}/priya`,
      key: KEY,
      body: { role: "member" },
    },
    {
      method: "PUT",
      path: `${members}/tom`,
      key: KEY,
      body: { role: "member" },
    },
  ]);
  // Both are in the team.
  expect(await view.findByText("Tom Becker")).toBeTruthy();
});

test("Add people lists who is in the team already as such, never highlights or adds them, and arrows move only between the people who can be added", async () => {
  const { dialog, person } = await openAddPeople("/teams/team_sales", "Sales");
  const input = box(dialog);
  // "o": Sam is in Sales, Tom is not.
  await person.type(input, "o");
  await waitFor(() =>
    expect(offered(dialog)).toEqual(["Sam Ortiz", "Tom Becker"]),
  );
  const sam = within(dialog).getByRole("option", { name: /Sam Ortiz/ });
  expect(sam.getAttribute("aria-disabled")).toBe("true");
  expect(sam.textContent).toContain("In this team");
  // The highlight starts on Tom, the first who can be added, and the arrows keep it there.
  expect(highlighted(dialog)?.textContent).toContain("Tom Becker");
  await person.keyboard("{ArrowDown}");
  expect(highlighted(dialog)?.textContent).toContain("Tom Becker");
  await person.keyboard("{ArrowUp}");
  expect(highlighted(dialog)?.textContent).toContain("Tom Becker");
  // Pressing Sam does nothing.
  await person.click(sam);
  expect(writes).toEqual([]);

  // Once Tom is added, both are in the team, and Enter adds nobody.
  await person.keyboard("{Enter}");
  await waitFor(() => expect(writes).toHaveLength(1));
  await person.type(input, "o");
  await waitFor(() =>
    expect(
      within(dialog)
        .getAllByRole("option")
        .map((option) => option.getAttribute("aria-disabled")),
    ).toEqual(["true", "true"]),
  );
  expect(input.getAttribute("aria-activedescendant")).toBeNull();
  await person.keyboard("{Enter}");
  expect(writes).toHaveLength(1);
});

test("Add people never offers somebody from another organization: each organization's box searches its own members", async () => {
  // Acme's box: Ines is in Harbor Legal only, and is not found.
  const acme = await openAddPeople("/teams/team_sales", "Sales");
  await acme.person.type(box(acme.dialog), "ines");
  expect(
    await within(acme.dialog).findByText(
      "Nobody in this organization matches “ines”.",
    ),
  ).toBeTruthy();
  expect(offered(acme.dialog)).toEqual([]);
  cleanup();

  // Harbor Legal's box, as Ines who runs it: Sam is in Acme only, and is not found; Dana, who is
  // in both, is found here as Harbor's own.
  me = INES;
  setCurrentOrganization(HARBOR);
  const harbor = await openAddPeople("/teams/team_litigation", "Litigation");
  await harbor.person.type(box(harbor.dialog), "sam");
  expect(
    await within(harbor.dialog).findByText(
      "Nobody in this organization matches “sam”.",
    ),
  ).toBeTruthy();
  await harbor.person.clear(box(harbor.dialog));
  await harbor.person.type(box(harbor.dialog), "da");
  await waitFor(() =>
    expect(offered(harbor.dialog)).toEqual(["Dana Whitfield"]),
  );

  expect(
    searches
      .filter((read) => read.search === "ines")
      .map((read) => read.organization),
  ).toEqual([ACME]);
  expect(
    new Set(
      searches
        .filter((read) => read.search === "sam" || read.search === "da")
        .map((read) => read.organization),
    ),
  ).toEqual(new Set([HARBOR]));
});

test("Add people says when the search fails, and in words", async () => {
  server.use(
    getListOrganizationMembersMockHandler(() => {
      throw HttpResponse.json(
        {
          type: "about:blank",
          title: "Service unavailable",
          status: 503,
          detail: "Couldn't search people. Try again in a moment.",
        },
        {
          status: 503,
          headers: { "content-type": "application/problem+json" },
        },
      );
    }),
  );
  const { dialog, person } = await openAddPeople("/teams/team_sales", "Sales");
  await person.type(box(dialog), "pr");
  expect(
    (await within(dialog).findByRole("alert", {}, { timeout: 5_000 }))
      .textContent,
  ).toBe("Couldn't search people. Try again in a moment.");
  expect(writes).toEqual([]);
}, 10_000);

test("Tab takes the completion as the person's own name and leaves the caret at its end, so typing on adds to it", async () => {
  const { dialog, person } = await openAddPeople("/teams/team_sales", "Sales");
  const input = box(dialog);
  await person.type(input, "to");
  // Completed to Tom's name as he writes it, the part not typed selected.
  await waitFor(() => expect(input.value).toBe("Tom Becker"));
  expect([input.selectionStart, input.selectionEnd]).toEqual([2, 10]);

  await person.keyboard("{Tab}");
  // Taken: the whole name stays, nothing is selected, the caret is at the end, the box keeps focus.
  expect(input.value).toBe("Tom Becker");
  expect([input.selectionStart, input.selectionEnd]).toEqual([10, 10]);
  expect(document.activeElement).toBe(input);

  // A letter typed now goes after the name; it doesn't replace what was completed.
  await person.keyboard("x");
  expect(input.value).toBe("Tom Beckerx");
});
