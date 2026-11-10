import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * Every Bot's routines are under Settings now, with their goals and check-ins in the same list.
 * New routine keeps its own screen at `/routines/new` (`routines_.new.tsx`).
 */
export const Route = createFileRoute("/_authed/_app/routines")({
  beforeLoad: () => {
    throw redirect({ to: "/settings/routines", replace: true });
  },
});
