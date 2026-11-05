import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * The old Enterprise controls page. Its sections now sit beside what they govern: Permissions,
 * Models, Identity providers, Computers, Plugins, Automatic learning and Audit. An old link or
 * bookmark lands on the Admin overview, which lists all of them.
 */
export const Route = createFileRoute("/_authed/admin/enterprise")({
  beforeLoad: () => {
    throw redirect({ to: "/admin", replace: true });
  },
});
