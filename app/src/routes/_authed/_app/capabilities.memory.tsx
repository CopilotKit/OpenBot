import { createFileRoute, redirect } from "@tanstack/react-router";

/** Capabilities → Memory is Memory now, which sends the personal edition on itself. */
export const Route = createFileRoute("/_authed/_app/capabilities/memory")({
  beforeLoad: () => {
    throw redirect({ to: "/memory", replace: true });
  },
});
