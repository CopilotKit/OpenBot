import { createFileRoute } from "@tanstack/react-router";
import { GoalRoutePage } from "@/components/responsibilities/goal-page";
import { searchTextEntry } from "@/lib/search-text";

/**
 * One goal, on a page of its own: opened from its row on a Routines list. `?agentId=` is the Bot
 * whose Routines page it came from, so its back link returns there rather than to every Bot's.
 */
export const Route = createFileRoute("/_authed/_app/routines_/goals/$goalId")({
  validateSearch: (
    search: Record<string, unknown>,
  ): { agentId?: string; from?: string } => ({
    ...searchTextEntry("agentId", search.agentId),
    ...searchTextEntry("from", search.from),
  }),
  component: GoalRoute,
});

function GoalRoute() {
  const { goalId } = Route.useParams();
  const { agentId, from } = Route.useSearch();
  return <GoalRoutePage agentId={agentId} from={from} goalId={goalId} />;
}
