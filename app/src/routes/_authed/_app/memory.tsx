import { createFileRoute, redirect } from "@tanstack/react-router";
import { LEGACY_PAGES } from "@/lib/agents/legacy-routes";

/** `/memory` left the sidebar. Memories are in Settings; sources and research are on each Bot's page. */
export const Route = createFileRoute("/_authed/_app/memory")({
  beforeLoad: () => {
    throw redirect({ to: LEGACY_PAGES["/memory"], replace: true });
  },
});
