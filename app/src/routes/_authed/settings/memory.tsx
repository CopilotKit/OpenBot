import { createFileRoute, redirect } from "@tanstack/react-router";

/** Memory moved from Settings to Capabilities. */
export const Route = createFileRoute("/_authed/settings/memory")({
  beforeLoad: () => {
    throw redirect({ to: "/capabilities/memory", replace: true });
  },
});
