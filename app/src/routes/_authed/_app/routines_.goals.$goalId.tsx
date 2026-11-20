import { createFileRoute } from "@tanstack/react-router";
import { GoalRoutePage } from "@/components/responsibilities/goal-page";
import { searchTextEntry } from "@/lib/search-text";

/**
 * One goal, on a page of its own: opened from its row on a Routines list. `?agentId=` is the Bot
 * whose Routines page it came from, so its back link returns there rather than to every Bot's.
 */
export const Route = createFileRoute("/_authed/_app/routines_/goals/$goalId")({
  validateSearch: (search: Record<string, unknown>): { agentId?: string } =>
    searchTextEntry("agentId", search.agentId),
  component: GoalRoute,
});

function GoalRoute() {
  const { goalId } = Route.useParams();
  const { agentId } = Route.useSearch();
  return <GoalRoutePage agentId={agentId} goalId={goalId} />;
}
