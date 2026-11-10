import { createFileRoute, redirect } from "@tanstack/react-router";

/** Capabilities → Memory is Settings → Memory now, which sends the personal edition on itself. */
export const Route = createFileRoute("/_authed/_app/capabilities/memory")({
  beforeLoad: () => {
    throw redirect({ to: "/settings/memory", replace: true });
  },
});
