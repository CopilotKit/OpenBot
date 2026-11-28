import { QueryClientProvider } from "@tanstack/react-query";
import {
  createBrowserHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
  useParams,
} from "@tanstack/react-router";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { BotSubpage } from "@/components/bot-profile/bot-subpage";
import { SharingSections } from "@/components/bot-profile/sharing";
import { GroupPeopleButton } from "@/components/channels/group-people";
import { OrganizationSettingsPage } from "@/components/organizations/organization-settings-page";
import { TeamDetailPage } from "@/components/teams/team-page";
import { TeamsPage } from "@/components/teams/teams-page";
import { setCurrentOrganization } from "@/lib/organizations/current";
import { queryClient } from "@/query-client";
import { Route as PeopleRoute } from "@/routes/_authed/admin/people";

/**
 * The lists of people that page and search, and the places a person is picked from the
 * organization, as a page of their own for people-lists.test.tsx to bundle and load in a browser:
 * Organization settings (Members and Invitations), the Teams list, a team's page with its people
 * and Add person, Admin's People beside them, a Bot's Sharing page with its Publish dialog, and a
 * group conversation's people. Each is the real screen; what the server answers comes from the
 * test's routes at the API's addresses (people-lists-api.ts).
 */
setCurrentOrganization("default");
queryClient.setDefaultOptions({ queries: { retry: false } });

const component = (route: { options: { component?: unknown } }) =>
  route.options.component as () => ReactNode;

/** A page as the app's frame scrolls it: the window's height, its own scroll. */
const frame = (page: () => ReactNode) => () => (
  <div className="h-svh overflow-auto bg-background text-foreground">
    {page()}
  </div>
);

function TeamDetail() {
  const { teamId } = useParams({ strict: false }) as { teamId: string };
  return <TeamDetailPage key={teamId} teamId={teamId} />;
}

function Sharing() {
  const { agentId } = useParams({ strict: false }) as { agentId: string };
  return (
    <BotSubpage
      agentId={agentId}
      description="Choose who can use this Bot. Each person’s conversations with it are private."
      title="Sharing"
    >
      {(agent) => <SharingSections agent={agent} />}
    </BotSubpage>
  );
}

const rootRoute = createRootRoute({ component: () => <Outlet /> });
const page = (path: string, draw: () => ReactNode) =>
  createRoute({ getParentRoute: () => rootRoute, path, component: draw });

const router = createRouter({
  history: createBrowserHistory(),
  routeTree: rootRoute.addChildren([
    page(
      "/organization",
      frame(() => <OrganizationSettingsPage />),
    ),
    page(
      "/teams",
      frame(() => <TeamsPage />),
    ),
    page(
      "/teams/$teamId",
      frame(() => <TeamDetail />),
    ),
    page("/admin/people", frame(component(PeopleRoute))),
    page("/bots/$agentId/sharing", () => (
      <div className="flex h-svh flex-col overflow-hidden bg-background text-foreground">
        <Sharing />
      </div>
    )),
    page("/bots/$agentId", () => null),
    // A group's top bar, with its people button, as the conversation draws it.
    page(
      "/group",
      frame(() => (
        <div className="flex h-12 items-center border-border border-b px-2">
          <span className="text-sm">Launch plan</span>
          <GroupPeopleButton channelId="grp" />
        </div>
      )),
    ),
    page("/", () => null),
  ]),
});

const root = document.getElementById("root");
if (root)
  createRoot(root).render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
