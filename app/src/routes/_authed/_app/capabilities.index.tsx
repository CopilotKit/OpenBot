import { createFileRoute, redirect } from "@tanstack/react-router";

/** Capabilities is gone: its Skills and Memory are under Settings. `/capabilities` opened Skills. */
export const Route = createFileRoute("/_authed/_app/capabilities/")({
  beforeLoad: () => {
    throw redirect({ to: "/settings/skills", replace: true });
  },
});
