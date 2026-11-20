import { createFileRoute, redirect } from "@tanstack/react-router";

/** Teams moved out of Admin, to where everybody in the organization can open them. */
export const Route = createFileRoute("/_authed/admin/teams")({
  beforeLoad: () => {
    throw redirect({ to: "/teams", replace: true });
  },
});
