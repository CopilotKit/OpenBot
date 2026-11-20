import { createFileRoute } from "@tanstack/react-router";
import { CheckInRoutePage } from "@/components/suggestions/check-in-page";
import { searchTextEntry } from "@/lib/search-text";

/**
 * One check-in, on a page of its own: opened from its row on a Routines list. `?agentId=` is the
 * Bot whose Routines page it came from, so its back link returns there.
 */
export const Route = createFileRoute(
  "/_authed/_app/routines_/check-ins/$checkInId",
)({
  validateSearch: (search: Record<string, unknown>): { agentId?: string } =>
    searchTextEntry("agentId", search.agentId),
  component: CheckInRoute,
});

function CheckInRoute() {
  const { checkInId } = Route.useParams();
  const { agentId } = Route.useSearch();
  return <CheckInRoutePage agentId={agentId} checkInId={checkInId} />;
}
