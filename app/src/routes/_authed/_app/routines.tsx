import { createFileRoute } from "@tanstack/react-router";
import { RoutinesHome } from "@/components/routines/routines-home";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { proactiveSettingsQueryOptions } from "@/lib/proactive";
import { responsibilitiesQueryOptions } from "@/lib/responsibilities";
import { loadFirstScreen } from "@/lib/route-data";
import { routinesQueryOptions } from "@/lib/routines/queries";

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
  loader: ({ context }) =>
    loadFirstScreen(context.queryClient, [
      routinesQueryOptions(),
      responsibilitiesQueryOptions(),
      proactiveSettingsQueryOptions(),
      agentListQueryOptions(),
      agentListQueryOptions(true),
    ]),
  component: RoutinesHome,
});
