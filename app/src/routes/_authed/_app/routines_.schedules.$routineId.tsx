import { createFileRoute } from "@tanstack/react-router";
import { RoutineRoutePage } from "@/components/routines/routine-page";
import { searchTextEntry } from "@/lib/search-text";

/**
 * One scheduled routine, on a page of its own: opened from its row on a Routines list. `?agentId=`
 * is the Bot whose Routines page it came from, so its back link returns there.
 */
export const Route = createFileRoute(
  "/_authed/_app/routines_/schedules/$routineId",
)({
  validateSearch: (
    search: Record<string, unknown>,
  ): { agentId?: string; from?: string } => ({
    ...searchTextEntry("agentId", search.agentId),
    ...searchTextEntry("from", search.from),
  }),
  component: RoutineRoute,
});

function RoutineRoute() {
  const { routineId } = Route.useParams();
  const { agentId, from } = Route.useSearch();
  return (
    <RoutineRoutePage agentId={agentId} from={from} routineId={routineId} />
  );
}
