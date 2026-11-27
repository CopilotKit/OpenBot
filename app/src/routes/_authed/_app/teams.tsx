import { createFileRoute } from "@tanstack/react-router";
import { TeamsPage } from "@/components/teams/teams-page";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";
import { loadFirstScreen } from "@/lib/route-data";
import { teamListPagesQueryOptions } from "@/lib/teams/queries";

/**
 * The organization's teams, for everybody in it. What each person may do here is the server's
 * verdict on them, so the one page serves a member, a team's maintainer and an admin.
 */
export const Route = createFileRoute("/_authed/_app/teams")({
  /*
   * The personal edition has no teams API, and its page deliberately never asks for the list
   * (`TeamPage`), so the list is warmed only where the page would read it: `ensureQueryData`
   * ignores the page's own conditions. A capabilities read that failed counts as the team edition,
   * as the page reads it.
   */
  loader: async ({ context }) => {
    // A router built without the app's context, as some tests build, has nothing to warm.
    if (!context.queryClient) return;
    const capabilities = await context.queryClient
      .ensureQueryData(deploymentCapabilitiesQueryOptions())
      .catch(() => undefined);
    if (capabilities?.edition === "personal") return;
    await loadFirstScreen(context.queryClient, [teamListPagesQueryOptions("")]);
  },
  component: TeamsPage,
});
