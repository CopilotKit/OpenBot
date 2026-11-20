import { createFileRoute, redirect } from "@tanstack/react-router";
import { LEGACY_PAGES } from "@/lib/agents/legacy-routes";

/** Groups are started from the new-conversation screen, with two or more Bots in To:. */
export const Route = createFileRoute("/_authed/_app/group/new")({
  beforeLoad: () => {
    throw redirect({ to: LEGACY_PAGES["/group/new"], replace: true });
  },
});
