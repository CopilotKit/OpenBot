import { createFileRoute, redirect } from "@tanstack/react-router";
import { LEGACY_PAGES } from "@/lib/agents/legacy-routes";

/** `/responsibilities` left the sidebar. Each Bot's responsibilities are on its own page. */
export const Route = createFileRoute("/_authed/_app/responsibilities")({
  beforeLoad: () => {
    throw redirect({ to: LEGACY_PAGES["/responsibilities"], replace: true });
  },
});
