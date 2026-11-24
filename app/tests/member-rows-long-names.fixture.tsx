import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import type { JSX } from "react";
import { createRoot } from "react-dom/client";
import { OrganizationSettingsPage } from "@/components/organizations/organization-settings-page";
import { TeamDetailPage } from "@/components/teams/team-page";
import { deploymentKeys } from "@/lib/deployment/queries";
import { setCurrentOrganization } from "@/lib/organizations/current";
import { organizationKeys } from "@/lib/organizations/queries";
import { queryClient } from "@/query-client";
import { Route as PeopleRoute } from "@/routes/_authed/admin/people";
import { ME_PATH, meResponse, PEOPLE_PATH, personBody } from "./accounts-api";

/**
 * The lists of people with a long name and a long address among them, as a page of its own for
 * member-rows-long-names.test.tsx to bundle and load in a browser: Organization settings' Members
 * (`?screen=organization`), Admin's People (`?screen=people`) and a team's people
 * (`?screen=team`), and Organization settings' Invitations, whose rows are named by an address.
 * Dana is an owner, so every row offers what it can. The server's answers come
 * from a fetch here, as the API gives them, so nothing is asked of a server.
 */
const screen = new URLSearchParams(location.search).get("screen");
const ORGANIZATION = "/api/v2/organizations/default";

setCurrentOrganization("default");
queryClient.setDefaultOptions({
  queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
});
queryClient.setQueryData(deploymentKeys.capabilities(), {
  generativeUi: true,
  selfHostBanner: false,
  localEvaluation: false,
  edition: "team",
});
const MINE = {
  organizations: [
    {
      id: "default",
      slug: "northwind",
      name: "Northwind Freight",
      role: "owner",
      personal: false,
      active: true,
    },
  ],
  canCreate: true,
  nextCursor: null,
};
queryClient.setQueryData(organizationKeys.mine(), {
  ...MINE,
  currentId: "default",
});

const DANA = {
  id: "dana",
  name: "Dana Whitfield",
  email: "dana.whitfield@northwind.example",
};
const SAM = {
  id: "sam",
  name: "Sam Ortiz",
  email: "sam.ortiz@northwind.example",
};
// A long name and a long address, which is what a row has to give way to.
const ALEX = {
  id: "alex",
  name: "Alexandria Montgomery-Fitzwilliam",
  email:
    "alexandria.montgomery-fitzwilliam@northwind-freight-logistics.example",
};
// A name of one long word, which no line break can help.
const BARTHOLOMEW = {
  id: "bart",
  name: "Bartholomew-Wolfeschlegelsteinhausenbergerdorff",
  email: "bart@northwind.example",
};
const PEOPLE = [DANA, SAM, ALEX, BARTHOLOMEW];
// Organization settings' Invitations list draws an invited address as its row's title.
const INVITED =
  "maximilian.featherstonehaugh-cholmondeley@northwind-freight-logistics.example";

const DAY = 24 * 60 * 60 * 1000;
const roleOf = (id: string) => (id === "dana" ? "owner" : "member");

window.fetch = (async (input: RequestInfo | URL) => {
  const path = new URL(String(input), location.origin).pathname;
  if (path === ME_PATH) return meResponse({ user: { ...DANA, role: "owner" } });
  if (path === "/api/v2/people/me/organizations") return Response.json(MINE);
  if (path === `${ORGANIZATION}/members`)
    return Response.json({
      members: PEOPLE.map((one) => ({
        ...one,
        image: null,
        role: roleOf(one.id),
        joinedAt: "2026-11-01T09:00:00.000Z",
        removable: one.id !== "dana",
        assignableRoles: one.id === "dana" ? [] : ["owner", "admin"],
      })),
      nextCursor: null,
    });
  if (path === `${ORGANIZATION}/invitations`)
    return Response.json({
      invitations: [
        {
          id: "invitation_1",
          email: INVITED,
          role: "member",
          status: "pending",
          invitedBy: { name: DANA.name, email: DANA.email },
          createdAt: new Date(Date.now() - DAY).toISOString(),
          expiresAt: new Date(Date.now() + 6 * DAY).toISOString(),
        },
      ],
      nextCursor: null,
    });
  if (path === PEOPLE_PATH)
    return Response.json({
      people: PEOPLE.map((one) => ({
        ...personBody({ ...one, role: roleOf(one.id) }),
        revoked: false,
      })),
      nextCursor: null,
    });
  const team = {
    id: "team_sales",
    name: "Sales",
    description: "Everybody who sells.",
    parentTeamId: null,
    source: "openbot",
    memberCount: PEOPLE.length,
    role: "maintainer",
    canManage: true,
    canMove: true,
    canDelete: true,
    createdAt: "2026-11-15T09:12:40.000Z",
  };
  if (path === `${ORGANIZATION}/teams`)
    return Response.json({ teams: [team], canCreate: true, nextCursor: null });
  if (path === `${ORGANIZATION}/teams/team_sales`)
    return Response.json({ team });
  if (path === `${ORGANIZATION}/teams/team_sales/members`)
    return Response.json({
      members: PEOPLE.map((one) => ({
        ...one,
        image: null,
        role: one.id === "dana" ? "maintainer" : "member",
        isCaller: one.id === "dana",
        joinedAt: "2026-11-15T09:13:02.000Z",
      })),
      nextCursor: null,
    });
  return Response.json({ detail: "not served" }, { status: 404 });
}) as typeof fetch;

const People = PeopleRoute.options.component as () => JSX.Element;

const router = createRouter({
  routeTree: createRootRoute({
    component: () => (
      // The page scrolls, not a box in it, so a screenshot of the page holds every row.
      <div className="min-h-svh bg-background text-foreground">
        {screen === "people" ? (
          <People />
        ) : screen === "team" ? (
          <TeamDetailPage shell="admin" teamId="team_sales" />
        ) : (
          <OrganizationSettingsPage />
        )}
      </div>
    ),
  }),
  history: createMemoryHistory({ initialEntries: ["/"] }),
});

const root = document.getElementById("root");
if (root)
  createRoot(root).render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
