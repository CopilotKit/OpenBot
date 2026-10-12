import { createFileRoute, redirect } from "@tanstack/react-router";
import { LEGACY_PAGES } from "@/lib/agents/legacy-routes";

/** `/approvals` left the sidebar. What waits on you is on each Bot's page; preferences and rules for every Bot are in Settings. */
export const Route = createFileRoute("/_authed/_app/approvals")({
  beforeLoad: () => {
    throw redirect({ to: LEGACY_PAGES["/approvals"], replace: true });
  },
});
