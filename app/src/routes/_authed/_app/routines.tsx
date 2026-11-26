import { createFileRoute } from "@tanstack/react-router";
import { RoutinesHome } from "@/components/routines/routines-home";

/**
 * Every Bot's routines on one page: one box that makes a routine from a sentence, then the routines,
 * goals and check-ins grouped by Bot, and the switch for every Bot's check-ins at the foot. The
 * every-Bot scope of Routines, in the main menu beside Bots; each Bot's own are on its page
 * (`bots.$agentId.routines.tsx`). New routine keeps its own screen at `/routines/new`, as the box's
 * "Use the form" link opens it.
 *
 * Not Admin: a routine is something anybody has, scoped to the signed-in person on every read and
 * write.
 */
export const Route = createFileRoute("/_authed/_app/routines")({
  component: RoutinesHome,
});
