import { createFileRoute, redirect } from "@tanstack/react-router";

/** `/capabilities` on its own opens the first tab, Skills. */
export const Route = createFileRoute("/_authed/_app/capabilities/")({
  beforeLoad: () => {
    throw redirect({ to: "/capabilities/skills", replace: true });
  },
});
