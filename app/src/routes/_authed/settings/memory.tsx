import { createFileRoute, redirect } from "@tanstack/react-router";

/** Settings → Memory is Memory in the main menu now, which sends the personal edition on itself. */
export const Route = createFileRoute("/_authed/settings/memory")({
  beforeLoad: () => {
    throw redirect({ to: "/memory", replace: true });
  },
});
