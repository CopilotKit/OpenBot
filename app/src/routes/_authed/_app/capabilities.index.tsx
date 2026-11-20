import { createFileRoute, redirect } from "@tanstack/react-router";

/** Capabilities is gone: its Skills and Memory are pages of their own. `/capabilities` opened Skills. */
export const Route = createFileRoute("/_authed/_app/capabilities/")({
  beforeLoad: () => {
    throw redirect({ to: "/skills", replace: true });
  },
});
