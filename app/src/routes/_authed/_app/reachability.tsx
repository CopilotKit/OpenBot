import { createFileRoute, redirect } from "@tanstack/react-router";
import { LEGACY_PAGES } from "@/lib/agents/legacy-routes";

/** `/reachability` left the sidebar. Linking is on each Bot's page; devices and deliveries are in Settings. */
export const Route = createFileRoute("/_authed/_app/reachability")({
  beforeLoad: () => {
    throw redirect({ to: LEGACY_PAGES["/reachability"], replace: true });
  },
});
