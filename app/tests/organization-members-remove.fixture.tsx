import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { createRoot } from "react-dom/client";
import { OrganizationSettingsPage } from "@/components/organizations/organization-settings-page";
import { deploymentKeys } from "@/lib/deployment/queries";
import { setCurrentOrganization } from "@/lib/organizations/current";
import { organizationKeys } from "@/lib/organizations/queries";
import { queryClient } from "@/query-client";
import { ME_PATH, meResponse } from "./accounts-api";

/**
 * Organization settings for Acme Freight, which has two owners, as a page of its own for
 * organization-members-remove.test.tsx to bundle and load in a browser. `?viewer=owner` opens it as
 * Dana when she is an owner too; anything else, as Dana when she is an admin. The server's answers
 * come from a fetch here, as the API gives them, so nothing is asked of a server.
 */
const viewerRole =
  new URLSearchParams(location.search).get("viewer") === "owner"
    ? "owner"
    : "admin";

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
      slug: "acme",
      name: "Acme Freight",
      role: viewerRole,
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

type Role = "owner" | "admin" | "member";
const ROLES: Role[] = ["owner", "admin", "member"];

/**
 * A member as the list says them to Dana: with two owners and more, any of them can leave or be
 * removed (`removable`), and the roles Dana may give them. An owner gives any role; an admin moves
 * people between admin and member and changes no owner.
 */
function listed(id: string, name: string, role: Role, joined: number) {
  const others = ROLES.filter((one) => one !== role);
  const assignableRoles =
    id === "dana"
      ? []
      : viewerRole === "owner"
        ? others
        : role === "owner"
          ? []
          : others.filter((one) => one !== "owner");
  return {
    id,
    email: `${id}@acme.test`,
    name,
    image: null,
    role,
    joinedAt: `2026-11-0${joined}T09:00:00.000Z`,
    removable: true,
    assignableRoles,
  };
}

const MEMBERS = [
  listed("ona", "Ona Lindqvist", "owner", 1),
  listed("priya", "Priya Raman", "owner", 2),
  listed("dana", "Dana Whitfield", viewerRole, 3),
  listed("sam", "Sam Ortiz", "member", 4),
];

window.fetch = (async (input: RequestInfo | URL) => {
  const path = new URL(String(input), location.origin).pathname;
  if (path === ME_PATH)
    return meResponse({
      user: {
        id: "dana",
        email: "dana@acme.test",
        name: "Dana Whitfield",
        role: viewerRole,
      },
    });
  if (path === "/api/v2/people/me/organizations") return Response.json(MINE);
  if (path === "/api/v2/organizations/default/members")
    return Response.json({ members: MEMBERS, nextCursor: null });
  if (path === "/api/v2/organizations/default/invitations")
    return Response.json({ invitations: [], nextCursor: null });
  return Response.json({ detail: "not served" }, { status: 404 });
}) as typeof fetch;

const router = createRouter({
  routeTree: createRootRoute({
    component: () => (
      <div className="h-svh overflow-auto bg-background text-foreground">
        <OrganizationSettingsPage />
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
